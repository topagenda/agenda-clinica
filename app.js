// ── Lightbox para imagens do Pequeno Príncipe ────────────────
function abrirImagemDia(src) {
    const existing = document.getElementById('pp-lightbox');
    if (existing) existing.remove();
    const lb = document.createElement('div');
    lb.id = 'pp-lightbox';
    lb.style.cssText = `
        position:fixed;inset:0;z-index:9999;
        background:rgba(61,37,53,0.85);
        display:flex;align-items:center;justify-content:center;
        backdrop-filter:blur(8px);
        animation:fadeInLb .2s ease-out;
        cursor:zoom-out;
    `;
    lb.onclick = () => lb.remove();
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = `
        max-width:90vw;max-height:90vh;
        border-radius:16px;
        box-shadow:0 16px 60px rgba(0,0,0,0.5);
        object-fit:contain;
        animation:zoomInLb .25s ease-out;
    `;
    lb.appendChild(img);
    document.body.appendChild(lb);
}

// Rótulo + emoji de cada status de agendamento. 'nao_realizada' marca falta
// do paciente (consulta mantida no histórico, só sem cobrança pendente);
// diferente de 'cancelado', que normalmente é removido da agenda.
function rotuloStatusAgendamento(st) {
    if (st === 'confirmado')    return { label: 'Confirmado',     emoji: '✅' };
    if (st === 'nao_realizada') return { label: 'Não realizada',  emoji: '❌' };
    if (st === 'cancelado')     return { label: 'Cancelado',      emoji: '🚫' };
    return { label: 'Aguardando', emoji: '⏳' };
}

/* ============================================================
   APP.JS — Agenda Clínica PWA
   Armazenamento: Google Drive (fonte principal) + IndexedDB (offline)
   Tailscale/servidor local: REMOVIDO
   ============================================================ */

'use strict';

// ══════════════════════════════════════════════════════
// GOOGLE DRIVE
// ══════════════════════════════════════════════════════

const GOOGLE_CLIENT_ID  = '754062883807-e6itjlfpj9m14rajh6shmilkdm84c4f6.apps.googleusercontent.com';
// Worker do painel admin (admin-heartbeat-worker.js) — recebe heartbeat de
// backup/Drive E, agora, também o log de eventos da agenda (agendado,
// cancelado, substituído, falhas de sync). admin-backups.html lê os dois.
const URL_WORKER_ADMIN  = 'https://psicogestao-admin-heartbeat.topagenda.workers.dev';
// drive.file só enxerga arquivos criados pelo próprio app nesta sessão OAuth.
// Se o backup foi criado em outro dispositivo/sessão, a busca retorna vazio.
// Usando drive para ter acesso completo de leitura e escrita.
const SCOPES            = 'https://www.googleapis.com/auth/drive';
const DRIVE_FILE_NAME   = 'backup_sistema.json';
const DRIVE_POLL_MS     = 30000; // verifica atualizações a cada 30s

let _drivePollingTimer        = null;

// ── Fase 3: um arquivo por escritor ──────────────────────────────────────
// O PC grava só o backup_sistema.json. Cada aparelho grava SÓ o próprio
// agenda_celular_<idDoAparelho>.json (raiz do Drive) — assim nenhum
// escritor sobrescreve o arquivo de outro. Ao ler, juntamos o arquivo do PC
// com o de todos os aparelhos e mesclamos por registro (atualizadoEm).
// Só passamos a gravar no arquivo próprio quando o PC avisa (_fase >= 3)
// que já sabe ler esses arquivos; antes disso o app continua gravando no
// backup_sistema.json, como na Fase 2 (PC antigo não enxerga o arquivo novo).
const DRIVE_PREFIXO_APARELHO = 'agenda_celular_';
const REGEX_ARQ_APARELHO     = /^agenda_celular_[A-Za-z0-9_-]{4,64}\.json$/;

let _driveModPorArquivo = new Map(); // fileId → modifiedTime (ms) já baixado
let _driveCacheArquivos = new Map(); // fileId → conteúdo (objeto) do último download

// Identidade deste aparelho (navegador/PWA). Gerada uma vez e NÃO apagada ao
// trocar de conta: o arquivo do aparelho é sempre o mesmo.
function obterIdAparelho() {
    let id = lsGet('agenda_device_id', null);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) {
        const bytes = new Uint8Array(8);
        (window.crypto || window.msCrypto).getRandomValues(bytes);
        id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        lsSet('agenda_device_id', id);
    }
    return id;
}
function nomeArquivoAparelho() { return `${DRIVE_PREFIXO_APARELHO}${obterIdAparelho()}.json`; }

// true depois que o PC desta clínica anunciou suporte à Fase 3 (não volta atrás).
function modoPorAparelho() { return !!lsGet('agenda_modo_por_aparelho', false); }


// ══════════════════════════════════════════════════════
// IDENTIDADE DA CONTA GOOGLE
// Evita misturar dados de contas diferentes (ex.: conta de testes x conta
// da clínica) no mesmo aparelho.
// ══════════════════════════════════════════════════════

// URL de login: SEMPRE mostra o seletor de contas (prompt=select_account) e,
// se já houver uma conta da clínica salva neste aparelho, pré-seleciona ela.
function urlOAuthGoogle() {
    const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
    const hint = lsGet('agenda_drive_email', null);
    return `https://accounts.google.com/o/oauth2/v2/auth`
        + `?client_id=${GOOGLE_CLIENT_ID}`
        + `&redirect_uri=${redirectUri}`
        + `&response_type=token`
        + `&scope=${encodeURIComponent(SCOPES)}`
        + `&prompt=select_account`
        + (hint ? `&login_hint=${encodeURIComponent(hint)}` : '');
}

// Há algo neste aparelho que ainda NÃO chegou ao Drive/PC?
function haPendenciasDeEnvio() {
    return !!lsGet('agenda_sync_pendente', false) ||
           lsGet('agenda_cancelados_pendentes', []).length > 0 ||
           lsGet('agenda_pacientes_pendentes', []).length > 0;
}

// Guarda uma cópia do que ainda não foi enviado, numa chave que
// limparDadosLocaisConta NÃO apaga (agenda_backup_pre_limpeza), para dar
// para recuperar na mão se a limpeza acontecer com pendências.
function guardarCopiaPreLimpeza(motivo) {
    try {
        lsSet('agenda_backup_pre_limpeza', {
            em:                   new Date().toISOString(),
            motivo:               motivo || '',
            email:                lsGet('agenda_drive_email', null),
            agendamentos:         lsGet('agenda_agendamentos', []),
            canceladosPendentes:  lsGet('agenda_cancelados_pendentes', []),
            pacientesPendentes:   lsGet('agenda_pacientes_pendentes', [])
        });
    } catch (e) {
        console.warn('[Limpeza] Não foi possível guardar a cópia de segurança:', e);
    }
}

// Apaga tudo que veio de uma conta/clínica deste aparelho (localStorage + IndexedDB).
async function limparDadosLocaisConta(incluirPendentes = true) {
    // Se houver algo ainda não enviado, guarda uma cópia ANTES de apagar.
    if (haPendenciasDeEnvio()) guardarCopiaPreLimpeza('limparDadosLocaisConta');
    const chaves = [
        'agenda_pacientes', 'agenda_agendamentos', 'agenda_tokens', 'agenda_config',
        'agenda_cliente_id', 'agenda_drive_file_id', 'agenda_drive_email',
        'agenda_cancelados_pendentes', 'agenda_sync_pendente', 'agenda_lapides',
        // Fase 3: o modo e o arquivo do aparelho dependem da conta/PC. O
        // agenda_device_id NÃO entra aqui de propósito.
        'agenda_modo_por_aparelho', 'agenda_drive_file_id_aparelho'
    ];
    chaves.forEach(k => localStorage.removeItem(k));
    if (incluirPendentes) localStorage.removeItem('agenda_pacientes_pendentes');
    try { await idbClear('pacientes');    } catch (e) {}
    try { await idbClear('agendamentos'); } catch (e) {}
    S.pacientes    = [];
    S.agendamentos = [];
    S.fileIdDrive  = null;
    S.fileIdAparelho = null;
    CLIENTE_ID     = null;
    _driveModPorArquivo.clear();
    _driveCacheArquivos.clear();
}

function _desconectarTokenLocal() {
    S.googleToken = null;
    lsSet('agenda_google_token', null);
    lsSet('agenda_google_token_exp', 0);
    pararPollingDrive();
}

// Confere se o backup baixado pertence à conta/clínica esperada neste aparelho.
// Retorna true se pode usar os dados; false se a conta estava errada
// (nesse caso já limpou tudo e desconectou).
async function verificarIdentidadeConta(banco, silencioso) {
    // A janela da Agenda Local (Electron) lê do SQLite do sistema — não se aplica.
    if (S.abertoPeloSistemaLocal) return true;

    let email = null;
    try {
        const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
            headers: { Authorization: `Bearer ${S.googleToken}` }
        });
        if (r.ok) email = (await r.json())?.user?.emailAddress || null;
    } catch (e) {}

    const emailSalvo   = lsGet('agenda_drive_email', null);
    const clienteSalvo = lsGet('agenda_cliente_id', null);
    const clienteNovo  = banco && banco.clienteId ? banco.clienteId : null;

    const emailDiferente   = !!(email && emailSalvo && email.toLowerCase() !== String(emailSalvo).toLowerCase());
    const clienteDiferente = !!(clienteNovo && clienteSalvo && clienteNovo !== clienteSalvo);

    if (emailDiferente || clienteDiferente) {
        registrarLogAgenda('falha_sync', null,
            `Conta Google diferente da esperada (${emailSalvo || '?'} → ${email || '?'}). Dados locais descartados.`);
        _desconectarTokenLocal();
        await limparDadosLocaisConta(true);
        atualizarStatusDrive();
        alert('⚠️ Você entrou com uma conta Google diferente da conta desta clínica' +
              (email ? ` (${email})` : '') + '.\n\nPor segurança, os dados deste aparelho foram limpos e a conexão foi desfeita.\n\n' +
              'Toque em conectar novamente e escolha a conta correta.');
        return false;
    }

    // Primeira conexão (ou aparelho ainda sem conta registrada): pede confirmação.
    if (email && !emailSalvo) {
        if (silencioso) return true; // não confia numa conta não confirmada; confirma na próxima conexão manual
        const ok = confirm(`Conectado como:\n${email}\n\nEsta é a conta Google da clínica?`);
        if (!ok) {
            _desconectarTokenLocal();
            await limparDadosLocaisConta(true);
            atualizarStatusDrive();
            toast('Conexão cancelada. Conecte de novo escolhendo a conta correta.', 5000);
            return false;
        }
    }
    if (email) lsSet('agenda_drive_email', email);
    return true;
}

// Inicia o fluxo OAuth — redireciona para o Google
function conectarGoogleDriveMobile() {
    // Salva de onde veio para voltar ao lugar certo após OAuth
    lsSet('agenda_oauth_origem', 'login');
    window.location.href = urlOAuthGoogle();
}

// Botão de atalho dentro da agenda
function conectarDriveAgenda() {
    if (tokenValido()) {
        // Já conectado: mostra status
        toast('✅ Google Drive já conectado!');
        return;
    }
    // Salva que estava na agenda e estava logado
    lsSet('agenda_oauth_origem', 'agenda');
    lsSet('agenda_oauth_estava_logado', true);
    window.location.href = urlOAuthGoogle();
}

// Botão em Configurações: conecta ou desconecta
async function conectarOuDesconectarDrive() {
    if (tokenValido()) {
        // Com alterações ainda não enviadas, primeiro tenta enviar; se continuar
        // pendente, NÃO apaga o aparelho (senão o que o celular criou se perde).
        if (haPendenciasDeEnvio()) {
            toast('☁️ Enviando alterações pendentes antes de desconectar...', 3000);
            try { await salvarAlteracoesNoDrive(); } catch (e) {}
            if (haPendenciasDeEnvio()) {
                guardarCopiaPreLimpeza('desconectar com pendências (bloqueado)');
                alert('⚠️ Não foi possível enviar ao Drive as alterações feitas neste aparelho (sem internet ou sessão expirada).\n\n' +
                      'Por segurança, NÃO vou desconectar nem apagar os dados agora.\n\n' +
                      'Tente de novo quando a internet voltar.');
                return;
            }
        }
        if (!confirm('Desconectar o Google Drive?\n\nIsso também apaga os pacientes e agendamentos guardados neste aparelho (eles voltam ao reconectar).')) return;
        _desconectarTokenLocal();
        await limparDadosLocaisConta(true);
        atualizarStatusDrive();
        try { renderizarAgenda(); } catch (e) {}
        toast('Google Drive desconectado e dados locais limpos.');
        return;
    }
    lsSet('agenda_oauth_origem', 'config');
    lsSet('agenda_oauth_estava_logado', true);
    window.location.href = urlOAuthGoogle();
}

// Atualiza visual dos botões de Drive em toda a interface
function atualizarStatusDrive() {
    const conectado = tokenValido();
    const emailConta = lsGet('agenda_drive_email', null);

    // Botão no header + banner expansível
    const btnAgenda = document.getElementById('btn-drive-agenda');
    const banner    = document.getElementById('drive-banner');
    if (btnAgenda) {
        if (conectado) {
            btnAgenda.style.color = '#34a853';
            btnAgenda.classList.remove('desconectado');
            btnAgenda.title = '☁️ Agendamentos salvos automaticamente' + (emailConta ? ' — ' + emailConta : '');
            if (banner) banner.style.display = 'none';
        } else {
            btnAgenda.style.color = '';
            btnAgenda.classList.add('desconectado');
            btnAgenda.title = 'Autorizar acesso à agenda';
            if (banner) banner.style.display = 'flex';
        }
    }

    // Botão em Configurações
    const btnTexto = document.getElementById('btn-drive-texto');
    const btnCfg   = document.getElementById('btn-drive-config');
    if (btnTexto) btnTexto.textContent = conectado
        ? '☁️ Drive conectado' + (emailConta ? ' (' + emailConta + ')' : '') + ' — agendamentos salvos automaticamente'
        : '⚠️ Clique para salvar seus agendamentos no Google Drive';
    if (btnCfg) {
        btnCfg.style.background = conectado ? '#e8f5e9' : '#fff5f9';
        btnCfg.style.color      = conectado ? '#2e7d32' : '#b8256e';
    }

    // Status text em Configurações
    const statusEl = document.getElementById('status-drive');
    if (statusEl) statusEl.textContent = conectado
        ? '✅ Agendamentos sendo salvos automaticamente no Google Drive' + (emailConta ? '\nConta: ' + emailConta : '')
        : '⚠️ Conecte o Google Drive para não perder seus agendamentos';

    // Botão na tela de login
    const btnLogin = document.querySelector('.btn-google');
    if (btnLogin) {
        if (conectado) {
            btnLogin.innerHTML = '<i class="fa-brands fa-google"></i> ☁️ Agendamentos salvos automaticamente';
            btnLogin.style.background = '#e8f5e9';
            btnLogin.style.color = '#2e7d32';
        } else {
            btnLogin.innerHTML = '<i class="fa-brands fa-google"></i> Clique aqui para salvar seus agendamentos';
            btnLogin.style.background = '';
            btnLogin.style.color = '';
        }
    }
}

// Clique no ícone Drive: se conectado mostra toast; se não, inicia OAuth
function toggleDriveBanner() {
    if (tokenValido()) {
        toast('☁️ Agendamentos salvos automaticamente no Google Drive.');
        return;
    }
    conectarDriveAgenda();
}

// Captura token OAuth que volta na URL após login Google
// verificarTokenOAuth é chamado dentro do DOMContentLoaded

// Verifica se o token ainda é válido
function tokenValido() {
    // Restaura token da memória se perdido (ex: internet caiu e voltou)
    const token = S.googleToken || lsGet('agenda_google_token', null);
    if (!token) return false;
    if (!S.googleToken) S.googleToken = token;
    const exp = lsGet('agenda_google_token_exp', 0);
    return exp === 0 || Date.now() < exp;
}

// Renovação silenciosa do token via iframe (antes de expirar)
let _renovacaoTimer = null;
function agendarRenovacaoToken() {
    if (_renovacaoTimer) clearTimeout(_renovacaoTimer);
    const exp = lsGet('agenda_google_token_exp', 0);
    const agora = Date.now();
    const tempoRestante = exp - agora;
    // Renova 5 minutos antes de expirar
    const renovarEm = Math.max(tempoRestante - 5 * 60 * 1000, 10000);
    console.log('[Drive] Renovação do token agendada em', Math.round(renovarEm/60000), 'min');
    // NOTA: em celular, esse setTimeout pode simplesmente não disparar se a
    // tela travar ou o app for pra segundo plano — por isso existe também
    // a checagem em verificarTokenAoRetomar(), ligada a visibilitychange/
    // focus, que não depende deste timer ter sobrevivido.
    _renovacaoTimer = setTimeout(() => renovarTokenSilencioso(), renovarEm);
}

// tentativaAtual: usado internamente pra saber se já tentou e falhou antes
// desta chamada, e decidir se avisa o usuário ou tenta mais uma vez.
function renovarTokenSilencioso(tentativaAtual = 1) {
    const MAX_TENTATIVAS = 2;
    console.log(`[Drive] Renovando token silenciosamente... (tentativa ${tentativaAtual}/${MAX_TENTATIVAS})`);
    // Remove iframe anterior se existir
    const anterior = document.getElementById('oauth-renewal-frame');
    if (anterior) anterior.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'oauth-renewal-frame';
    iframe.style.display = 'none';

    const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
    const url = `https://accounts.google.com/o/oauth2/v2/auth`
        + `?client_id=${GOOGLE_CLIENT_ID}`
        + `&redirect_uri=${redirectUri}`
        + `&response_type=token`
        + `&scope=${encodeURIComponent(SCOPES)}`
        + `&prompt=none`  // sem interação do usuário
        + (lsGet('agenda_drive_email', null) ? `&login_hint=${encodeURIComponent(lsGet('agenda_drive_email', null))}` : '');

    iframe.src = url;
    document.body.appendChild(iframe);

    // Timeout de segurança: se o iframe nunca disparar onload (ex: bloqueado
    // antes mesmo de carregar), não pode ficar esperando pra sempre.
    const timeoutSeguranca = setTimeout(() => {
        _tratarFalhaRenovacaoToken(tentativaAtual, MAX_TENTATIVAS, 'timeout (iframe não respondeu)');
    }, 8000);

    // Captura o token do iframe quando carregar
    iframe.onload = () => {
        clearTimeout(timeoutSeguranca);
        try {
            const hash = iframe.contentWindow.location.hash;
            if (hash) {
                const params = new URLSearchParams(hash.replace('#', ''));
                const token = params.get('access_token');
                if (token) {
                    S.googleToken = token;
                    lsSet('agenda_google_token', token);
                    lsSet('agenda_google_token_exp', Date.now() + 3500 * 1000);
                    console.log('[Drive] Token renovado com sucesso!');
                    registrarLogAgenda('token_renovado', null, 'Renovação silenciosa OK.');
                    agendarRenovacaoToken(); // agenda próxima renovação
                } else {
                    // Voltou do Google sem token no hash — geralmente significa
                    // que a sessão do Google no navegador não está mais ativa.
                    _tratarFalhaRenovacaoToken(tentativaAtual, MAX_TENTATIVAS, 'sem access_token no retorno (sessão Google inativa?)');
                }
            } else {
                _tratarFalhaRenovacaoToken(tentativaAtual, MAX_TENTATIVAS, 'sem hash no retorno do iframe');
            }
        } catch(e) {
            // CORS impede leitura — geralmente cookie de terceiros bloqueado
            // pelo navegador do celular (comum em Chrome/Safari mobile).
            _tratarFalhaRenovacaoToken(tentativaAtual, MAX_TENTATIVAS, 'CORS/cookie de terceiros bloqueado');
        }
        setTimeout(() => iframe.remove(), 2000);
    };
}

function _tratarFalhaRenovacaoToken(tentativaAtual, maxTentativas, motivo) {
    console.warn('[Drive] Renovação silenciosa falhou:', motivo);
    if (tentativaAtual < maxTentativas) {
        // Tenta mais uma vez em alguns segundos antes de desistir e avisar.
        setTimeout(() => renovarTokenSilencioso(tentativaAtual + 1), 4000);
        return;
    }
    // Esgotou as tentativas: marca como expirado, loga e avisa o usuário
    // ATIVAMENTE em vez de deixar a tela "vazia" sem explicação.
    S.googleToken = null;
    lsSet('agenda_google_token', null);
    lsSet('agenda_google_token_exp', 0);
    registrarLogAgenda('token_expirado', null, `Renovação automática falhou após ${maxTentativas} tentativas — motivo: ${motivo}.`);
    atualizarStatusDrive();
    toast('⚠️ Sessão do Google Drive caiu. Toque no ícone do Drive pra reconectar.', 5000);
}

// ── Checagem proativa ao reabrir o app (essencial em celular) ──────
// O setTimeout de agendarRenovacaoToken() pode simplesmente não disparar
// se a tela travar ou o navegador suspender a aba em segundo plano — é
// a causa mais comum de "a agenda deslogou sozinha do Google" no celular.
// Esta função não depende do timer: roda toda vez que o app volta ao
// primeiro plano (destravar tela, trocar de app e voltar, recuperar
// internet) e confere/renova o token na hora.
let _ultimaChecagemToken = 0;
function verificarTokenAoRetomar() {
    if (document.visibilityState !== undefined && document.visibilityState !== 'visible') return;
    const agora = Date.now();
    if (agora - _ultimaChecagemToken < 15000) return; // evita disparos repetidos em sequência
    _ultimaChecagemToken = agora;

    const tinhaTokenSalvo = !!lsGet('agenda_google_token', null);
    if (!tinhaTokenSalvo) return; // nunca conectou nesta sessão — nada a checar

    if (!tokenValido()) {
        console.log('[Drive] App retomado com token expirado — renovando agora.');
        renovarTokenSilencioso();
    } else {
        // Token ainda válido — garante que a próxima renovação está
        // agendada (cobre o caso do timer anterior ter sido perdido
        // quando o navegador suspendeu a aba).
        agendarRenovacaoToken();
    }
}
document.addEventListener('visibilitychange', verificarTokenAoRetomar);
window.addEventListener('focus', verificarTokenAoRetomar);
window.addEventListener('online', verificarTokenAoRetomar);

// Baixa o backup do Drive e atualiza o estado local
async function baixarBackupDrive(silencioso = false) {
    if (!tokenValido()) {
        if (!silencioso) toast('⚠️ Sessão Google expirada. Conecte novamente.');
        registrarLogAgenda('falha_sync', null,
            'Download do backup do Drive abortado: token inválido/expirado (pacientes/agendamentos podem não aparecer até reconectar).');
        S.googleToken = null;
        return false;
    }
    try {
        // Fase 3: uma busca traz o arquivo do PC (backup_sistema.json) e os
        // arquivos de todos os aparelhos (agenda_celular_*.json). Só arquivos
        // da conta conectada (ignora cópias compartilhadas por outras contas).
        const q      = encodeURIComponent(
            `trashed=false and 'me' in owners and (name='${DRIVE_FILE_NAME}' or name contains '${DRIVE_PREFIXO_APARELHO}')`);
        const search = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&spaces=drive&pageSize=100&orderBy=modifiedTime%20desc`,
            { headers: { Authorization: `Bearer ${S.googleToken}` } }
        );
        if (!search.ok) {
            if (search.status === 401) {
                S.googleToken = null;
                lsSet('agenda_google_token', null);
                if (!silencioso) toast('⚠️ Sessão Google expirada. Conecte novamente.');
                registrarLogAgenda('token_expirado', null,
                    'Google Drive recusou o token (401) ao baixar o backup — pacientes/agendamentos não puderam ser atualizados.');
            } else {
                registrarLogAgenda('falha_sync', null,
                    `Download do backup do Drive falhou (status ${search.status}).`);
            }
            return false;
        }

        const result = await search.json();
        console.log('[Drive] Resultado da busca:', JSON.stringify(result));

        // Agenda Local (Electron): o SQLite do PC é a fonte da verdade — só
        // interessa o arquivo do PC (tokens/config/clienteId).
        const modoLocal = !!S.abertoPeloSistemaLocal;

        const nomeProprio = nomeArquivoAparelho();
        const todosArq    = result.files || [];           // mais novos primeiro
        const arqPC       = todosArq.find(f => f.name === DRIVE_FILE_NAME) || null;
        const arqProprio  = modoLocal ? null : (todosArq.find(f => f.name === nomeProprio) || null);
        const arqsOutros  = modoLocal ? [] : todosArq.filter(f => f.name !== nomeProprio && REGEX_ARQ_APARELHO.test(f.name || ''));

        if (!arqPC && !arqProprio && arqsOutros.length === 0) {
            // Nenhum arquivo encontrado — pode ser primeiro uso ou scope insuficiente
            console.warn('[Drive] Arquivo', DRIVE_FILE_NAME, 'não encontrado no Drive.');
            if (!silencioso) toast('☁️ Drive conectado! Nenhum backup encontrado ainda — os dados serão criados no próximo salvamento.');
            return false;
        }

        if (arqPC) {
            S.fileIdDrive = arqPC.id;
            lsSet('agenda_drive_file_id', arqPC.id);
        }
        if (arqProprio) {
            S.fileIdAparelho = arqProprio.id;
            lsSet('agenda_drive_file_id_aparelho', arqProprio.id);
        }

        // Não baixa nada se nenhum arquivo mudou desde a última vez (polling silencioso)
        const relevantes = [arqPC, ...arqsOutros, arqProprio].filter(Boolean);
        const modDe      = f => new Date(f.modifiedTime).getTime();
        const mudou      = f => !_driveModPorArquivo.has(f.id) || modDe(f) > _driveModPorArquivo.get(f.id);
        if (silencioso && _driveModPorArquivo.size > 0 && !relevantes.some(mudou)) {
            return false;
        }

        // Esquece o que sumiu do Drive; baixa só o que mudou (o resto vem do cache).
        const idsAtuais = new Set(relevantes.map(f => f.id));
        Array.from(_driveCacheArquivos.keys()).forEach(id => { if (!idsAtuais.has(id)) { _driveCacheArquivos.delete(id); _driveModPorArquivo.delete(id); } });

        for (const f of relevantes) {
            if (_driveCacheArquivos.has(f.id) && !mudou(f)) continue;
            const fileRes = await fetch(
                `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
                { headers: { Authorization: `Bearer ${S.googleToken}` } }
            );
            if (!fileRes.ok) {
                // Faltando um arquivo, a união ficaria incompleta: aborta o ciclo
                // inteiro (tenta de novo no próximo) em vez de decidir com dados parciais.
                registrarLogAgenda('falha_sync', null, `Download do conteúdo de ${f.name} falhou (status ${fileRes.status}).`);
                return false;
            }
            let conteudo;
            try {
                conteudo = await fileRes.json();
            } catch (e) {
                if (f === arqPC) {
                    registrarLogAgenda('falha_sync', null, `${f.name} não é um JSON válido.`);
                    return false;
                }
                // Arquivo corrompido de outro aparelho: ignora só ele (e não poda nada neste ciclo).
                console.warn('[Drive] Arquivo corrompido ignorado:', f.name);
                conteudo = { _corrompido: true };
            }
            _driveCacheArquivos.set(f.id, conteudo);
        }
        relevantes.forEach(f => _driveModPorArquivo.set(f.id, modDe(f)));

        const bancoPC      = arqPC ? _driveCacheArquivos.get(arqPC.id) : null;
        const outrosTodos  = arqsOutros.map(f => _driveCacheArquivos.get(f.id));
        const algumCorrompido = outrosTodos.some(b => b && b._corrompido);
        const bancoProprioBruto = arqProprio ? _driveCacheArquivos.get(arqProprio.id) : null;

        // Trava de segurança: confirma que este backup é da conta/clínica certa
        // ANTES de mexer em qualquer dado local.
        const bancoRef = bancoPC || outrosTodos.find(b => b && b.clienteId) || {};
        if (!(await verificarIdentidadeConta(bancoRef, silencioso))) return false;

        // O PC já lê os arquivos por aparelho? Então passamos a gravar só no nosso.
        if (bancoPC && bancoPC._origem === 'pc' && Number(bancoPC._fase) >= 3) {
            lsSet('agenda_modo_por_aparelho', true);
        }

        // Arquivos de aparelhos de OUTRA clínica/instalação não entram.
        const clienteRef = (bancoPC && bancoPC.clienteId) || lsGet('agenda_cliente_id', null);
        const mesmoCliente = b => !!b && !b._corrompido && !(b.clienteId && clienteRef && String(b.clienteId) !== String(clienteRef));
        const bancosOutros = outrosTodos.filter(mesmoCliente);
        const bancoProprio = mesmoCliente(bancoProprioBruto) ? bancoProprioBruto : null;

        const banco = bancoPC || {};

        // Suporta dois formatos:
        // - Formato NOVO (desktop ≥ v2): agenda_agendamentos + agenda_tokens (sem pacientes)
        // - Formato LEGADO (PWA salva): agendamentos + pacientes + tokens
        const agendamentos = banco.agenda_agendamentos || banco.agendamentos || [];
        const tokensObj    = banco.agenda_tokens       || banco.tokens       || {};
        const config       = banco.config || null;

        // clienteId desta instalação — vem do backup do desktop (db.js →
        // exportarDadosPublicosAgenda). Persiste em localStorage pra já
        // estar disponível na próxima abertura, sem depender de novo sync.
        if (banco.clienteId) {
            CLIENTE_ID = banco.clienteId;
            lsSet('agenda_cliente_id', banco.clienteId);
        }

        // Pacientes: o desktop novo não exporta mais a lista completa por segurança.
        // Reconstruímos a partir dos tokens (cada token tem pacienteId + nomePaciente).
        // Se o arquivo ainda tiver banco.pacientes (formato legado), usamos ele.
        let pacientes = Array.isArray(banco.pacientes) ? banco.pacientes : [];
        let pacientesDeTokens = false;
        if (!pacientes.length && tokensObj && typeof tokensObj === 'object') {
            // Extrai pacientes únicos dos tokens (nome + id para mostrar na agenda)
            const mapa = {};
            Object.values(tokensObj).forEach(tk => {
                if (tk.pacienteId && tk.nomePaciente && !mapa[tk.pacienteId]) {
                    mapa[tk.pacienteId] = { id: tk.pacienteId, nome: tk.nomePaciente, telefone: '' };
                }
            });
            pacientes = Object.values(mapa);
            pacientesDeTokens = pacientes.length > 0;
        }

        // Agenda Local (Electron): o SQLite do PC é a fonte da verdade. O Drive
        // NÃO é espelhado nele — quem traz as mudanças do celular para o banco é o
        // main.js (verificarAtualizacoesDrive). Aqui só se aproveita o que não é
        // lista de agenda (tokens, config, clienteId) e recarrega a tela do SQLite.

        console.log('[Drive] Conteúdo baixado — pacientes:', pacientes.length, '| agendamentos:', agendamentos.length, '| tokens:', Object.keys(tokensObj).length);

        // tokens/config valem nos dois modos
        if (tokensObj && Object.keys(tokensObj).length)
            lsSet('agenda_tokens', tokensObj);
        if (config)
            lsSet('agenda_config', config);

        let reenviarAoDrive = false;

        if (modoLocal) {
            // Não toca em agendamentos/pacientes locais nem no SQLite: só relê do banco.
            await carregarPacientes_ls();
            await carregarAgendamentos_ls();
        } else {
            // ── Celular / Agenda Online ──
            // Agendamentos (Fase 2): MESCLA por registro (atualizadoEm) em vez de
            // trocar a lista inteira pela do Drive — assim uma cópia velha do
            // arquivo não desfaz um cancelamento/falta feito aqui, e o que o PC
            // cancelou/excluiu chega como lápide.
            // Fase 3: a lista "remota" é a UNIÃO do arquivo do PC, dos arquivos dos
            // outros aparelhos e do nosso próprio (por id, o carimbo mais novo vence).
            // Incluir o nosso arquivo evita achar que "perdemos" algo que já subimos.
            const listasRemotas = [];
            const addLista = b => {
                if (!b) return;
                const l = Array.isArray(b.agenda_agendamentos) ? b.agenda_agendamentos
                        : (Array.isArray(b.agendamentos) ? b.agendamentos : null);
                if (l) listasRemotas.push(l);
            };
            addLista(bancoPC);
            bancosOutros.forEach(addLista);
            addLista(bancoProprio);
            const veioListaAgenda = listasRemotas.length > 0;
            if (veioListaAgenda) {
                const res = mesclarAgendamentos(
                    lsGet('agenda_agendamentos', []), unirPorId(listasRemotas), lerLapides(),
                    // Arquivo do PC já na Fase 2 = lista COMPLETA de vivos. Aí os
                    // restos antigos sem carimbo que ele não tem mais podem sair
                    // (só se não houver nada pendente de envio neste aparelho e
                    // nenhum arquivo de aparelho ficou ilegível neste ciclo).
                    { podarLegadosAusentes: !!bancoPC && bancoPC._origem === 'pc' && Number(bancoPC._fase) >= 2
                                            && !haPendenciasDeEnvio() && !algumCorrompido }
                );
                lsSet('agenda_agendamentos', res.lista);
                lsSet('agenda_lapides', res.lapides);
                reenviarAoDrive = res.reenviar;
            }

            // Pacientes: NUNCA zera a lista local. Se o Drive trouxe pacientes: []
            // (acontece em todo arquivo gravado pelo celular, que só manda os
            // pendentes), a lista local fica como está. Quando veio só um pedaço
            // (arquivo do celular, ou reconstruído dos tokens), mescla por id em vez
            // de substituir; só o arquivo do PC, que traz a lista completa de
            // ativos, substitui.
            let pacientesGravar = null;
            if (pacientes.length) {
                if (pacientesDeTokens || banco._origem === 'celular') {
                    const porId = new Map(lsGet('agenda_pacientes', []).map(p => [String(p.id), p]));
                    pacientes.forEach(p => porId.set(String(p.id), { ...(porId.get(String(p.id)) || {}), ...p }));
                    pacientesGravar = Array.from(porId.values());
                } else {
                    pacientesGravar = pacientes;
                }
                lsSet('agenda_pacientes', pacientesGravar);
            }

            // Pacientes cadastrados em OUTRO aparelho e ainda não importados pelo PC
            // (cada arquivo de aparelho só leva os pendentes dele). Só ACRESCENTA os
            // que faltam — nunca substitui nem remove.
            const pacsDeAparelhos = [];
            [...bancosOutros, bancoProprio].forEach(b => {
                (b && Array.isArray(b.pacientes) ? b.pacientes : []).forEach(p => {
                    if (p && p.id != null && p.nome) pacsDeAparelhos.push(p);
                });
            });
            if (pacsDeAparelhos.length) {
                const base = pacientesGravar || lsGet('agenda_pacientes', []);
                const ids  = new Set(base.map(p => String(p.id)));
                const faltam = pacsDeAparelhos.filter(p => !ids.has(String(p.id)));
                if (faltam.length) {
                    const juntos = base.concat(faltam.filter((p, i, arr) => arr.findIndex(x => String(x.id) === String(p.id)) === i));
                    lsSet('agenda_pacientes', juntos);
                    pacientesGravar = juntos;
                }
            }

            // Atualiza IndexedDB para uso offline
            try {
                // Substitui (não acumula): sobras de outra conta/versão não podem ficar no cache.
                if (veioListaAgenda) {
                    await idbClear('agendamentos');
                    for (const ag of lsGet('agenda_agendamentos', [])) await idbPut('agendamentos', ag);
                }
                if (pacientesGravar) {
                    await idbClear('pacientes');
                    for (const p of pacientesGravar) await idbPut('pacientes', p);
                }
            } catch(e) {}

            // Sempre atualiza S.pacientes e S.agendamentos na memória após download
            S.pacientes    = lsGet('agenda_pacientes',    []);
            S.agendamentos = lsGet('agenda_agendamentos', []);
        }

        // Resolve possíveis duplicatas vindas do Drive (ex: substituição feita
        // offline gerou dois confirmados no mesmo horário)
        resolverDuplicatasAgendamentos();

        // Este aparelho sabe de algo mais novo do que o arquivo trouxe (ou o
        // arquivo perdeu uma alteração recente nossa)? Sobe de volta, em segundo
        // plano. No máx. 1 vez por minuto — nunca vira laço de envio.
        if (reenviarAoDrive && !modoLocal) _curarArquivoDrive();

        if (silencioso) {
            // Re-renderiza agenda se houver mudanças
            renderizarAgenda();
        } else {
            toast('✅ Dados sincronizados do Google Drive!');
            // Só volta para login se o usuário ainda não está autenticado
            if (!S.adminPin) irTela('tela-login');
        }
        return true;
    } catch(e) {
        console.error('[Drive] Erro ao baixar backup:', e);
        registrarLogAgenda('falha_sync', null,
            `Erro de rede/comunicação ao baixar backup do Drive: ${e?.message || e}`);
        if (!silencioso) {
            toast('☁️ Drive conectado!');
            // Só redireciona para login se o usuário não estava autenticado
            if (!S.adminPin) irTela('tela-login');
        }
        return false;
    }
}

let _ultimaCuraDrive = 0;
function _curarArquivoDrive() {
    if (Date.now() - _ultimaCuraDrive < 60000) return;
    _ultimaCuraDrive = Date.now();
    salvarAlteracoesNoDrive().catch(e => console.warn('[Sync] Falha ao reenviar alterações recentes ao Drive:', e));
}

// Fase 3: descobre (ou cria) o arquivo PRÓPRIO deste aparelho no Drive.
// Procura pelo nome antes de criar, para não duplicar se o aparelho perdeu o
// id guardado (ex.: limpou dados do navegador). Se a busca falhar, NÃO cria
// (devolve null e o envio fica pendente).
async function _resolverArquivoAparelho() {
    if (S.fileIdAparelho) return S.fileIdAparelho;
    const nome = nomeArquivoAparelho();
    const q    = encodeURIComponent(`name='${nome}' and trashed=false and 'me' in owners`);
    const busca = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive&orderBy=modifiedTime%20desc`,
        { headers: { Authorization: `Bearer ${S.googleToken}` } }
    );
    if (!busca.ok) {
        if (busca.status === 401) { S.googleToken = null; lsSet('agenda_google_token', null); }
        return null;
    }
    const achados = (await busca.json()).files || [];
    if (achados.length) {
        S.fileIdAparelho = achados[0].id;
    } else {
        const meta = await fetch('https://www.googleapis.com/drive/v3/files', {
            method:  'POST',
            headers: { Authorization: `Bearer ${S.googleToken}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name: nome, mimeType: 'application/json' })
        });
        if (!meta.ok) return null;
        S.fileIdAparelho = (await meta.json()).id;
    }
    lsSet('agenda_drive_file_id_aparelho', S.fileIdAparelho);
    return S.fileIdAparelho;
}

// Salva todos os dados no Drive.
// Fase 3: se o PC já avisou que lê arquivos por aparelho, grava SÓ no arquivo
// próprio (agenda_celular_<id>.json). Senão, grava no backup_sistema.json como antes.
async function salvarAlteracoesNoDrive(listaOverride = null) {
    // Recarrega token salvo caso tenha sido perdido da memória
    if (!S.googleToken) S.googleToken = lsGet('agenda_google_token', null);
    if (!S.fileIdDrive) S.fileIdDrive = lsGet('agenda_drive_file_id', null);
    if (!S.fileIdAparelho) S.fileIdAparelho = lsGet('agenda_drive_file_id_aparelho', null);

    if (!tokenValido()) {
        // Sem token válido: salva apenas localmente e registra como pendente de sync
        if (listaOverride) {
            const canceladosPendentes = listaOverride.filter(a => a.status === 'cancelado');
            if (canceladosPendentes.length) {
                const jaExistentes = lsGet('agenda_cancelados_pendentes', []);
                const todos = [...jaExistentes, ...canceladosPendentes].filter(
                    (a, i, arr) => arr.findIndex(x => x.id === a.id) === i
                );
                lsSet('agenda_cancelados_pendentes', todos);
            }
        }
        lsSet('agenda_sync_pendente', true);
        console.warn('[Drive] Sem token válido — dados salvos localmente, sync pendente.');
        return;
    }

    const porAparelho = modoPorAparelho();

    // Inclui cancelados pendentes offline para garantir que o desktop processe
    // Fase 2: além da lista viva e dos cancelados ainda não enviados, o arquivo
    // leva as LÁPIDES dos últimos 30 dias. Assim, se outro aparelho (ou o PC)
    // sobrescrever o arquivo antes de alguém importar este cancelamento, ele
    // volta no próximo envio. Por id vence o registro de carimbo mais novo.
    const canceladosPendentes = lsGet('agenda_cancelados_pendentes', []);
    const listaBase = listaOverride || S.agendamentos || [];
    const lista = unirPorId([listaBase, canceladosPendentes, Object.values(lerLapides())]);
    // Pacientes novos (cadastrados neste navegador) que ainda não subiram pro
    // Drive. Só manda os pendentes — nunca a base inteira — pra não expor
    // a lista completa de pacientes no arquivo compartilhado.
    const pacientesPendentes = lsGet('agenda_pacientes_pendentes', []);

    const payload = {
        // Formato novo (compatível com desktop): agenda_agendamentos + agenda_tokens
        agenda_agendamentos: lista,
        agenda_tokens:       lsGet('agenda_tokens', {}),
        // Campos legados para retrocompatibilidade
        agendamentos:        lista,
        tokens:              lsGet('agenda_tokens', {}),
        pacientes:           pacientesPendentes,
        config:              S.config,
        _origem:             'celular',
        _salvoEm:            new Date().toISOString()
    };
    if (porAparelho) {
        // O PC e os outros aparelhos conferem a clínica e o autor por estes campos.
        payload.clienteId = CLIENTE_ID || lsGet('agenda_cliente_id', null);
        payload._deviceId = obterIdAparelho();
        payload._fase     = 3;
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });

    try {
        let fileId;
        if (porAparelho) {
            fileId = await _resolverArquivoAparelho();
            if (!fileId) {
                lsSet('agenda_sync_pendente', true);
                console.warn('[Drive] Não foi possível localizar/criar o arquivo deste aparelho — sync pendente.');
                return;
            }
        } else if (S.fileIdDrive) {
            fileId = S.fileIdDrive;
        } else {
            // Cria o arquivo pela primeira vez (modo anterior à Fase 3)
            const meta = await fetch('https://www.googleapis.com/drive/v3/files', {
                method:  'POST',
                headers: { Authorization: `Bearer ${S.googleToken}`, 'Content-Type': 'application/json' },
                body:    JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json' })
            });
            if (!meta.ok) return;
            const metaJson = await meta.json();
            S.fileIdDrive  = metaJson.id;
            lsSet('agenda_drive_file_id', S.fileIdDrive);
            fileId = S.fileIdDrive;
        }

        const enviar = id => fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&fields=id,modifiedTime,trashed`, {
            method:  'PATCH',
            headers: { Authorization: `Bearer ${S.googleToken}`, 'Content-Type': 'application/json' },
            body: blob
        });
        let res = await enviar(fileId);

        // O PC move para a lixeira os arquivos de aparelhos parados há meses. Se o
        // nosso sumiu (404), esquece o id e recria/acha pelo nome — uma vez só.
        if (porAparelho && res.status === 404) {
            S.fileIdAparelho = null;
            lsSet('agenda_drive_file_id_aparelho', null);
            fileId = await _resolverArquivoAparelho();
            if (!fileId) {
                lsSet('agenda_sync_pendente', true);
                console.warn('[Drive] Arquivo do aparelho não existe mais e não foi possível recriá-lo — sync pendente.');
                return;
            }
            res = await enviar(fileId);
        }

        if (res.ok) {
            const updated = await res.json();
            // Gravar num arquivo que está na lixeira "funciona", mas o PC não o enxerga
            // mais. Se o PC mandou o nosso para a lixeira, tira de lá.
            if (porAparelho && updated.trashed) {
                const rest = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
                    method:  'PATCH',
                    headers: { Authorization: `Bearer ${S.googleToken}`, 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ trashed: false })
                });
                if (!rest.ok) {
                    S.fileIdAparelho = null;
                    lsSet('agenda_drive_file_id_aparelho', null);
                    lsSet('agenda_sync_pendente', true);
                    console.warn('[Drive] Arquivo do aparelho estava na lixeira e não foi restaurado — sync pendente.');
                    return;
                }
            }
            if (updated.modifiedTime) {
                // O que acabamos de gravar já é o que sabemos: não baixa de volta no próximo poll.
                _driveModPorArquivo.set(fileId, new Date(updated.modifiedTime).getTime());
                _driveCacheArquivos.set(fileId, JSON.parse(JSON.stringify(payload)));
            }
            lsSet('agenda_sync_pendente', false);
            lsSet('agenda_cancelados_pendentes', []); // limpa cancelados pendentes
            lsSet('agenda_pacientes_pendentes', []);  // limpa pacientes já enviados
            console.log('[Drive] Salvo com sucesso' + (porAparelho ? ' (arquivo do aparelho).' : '.'));
        } else {
            if (res.status === 401) { S.googleToken = null; lsSet('agenda_google_token', null); }
            lsSet('agenda_sync_pendente', true);
            console.warn('[Drive] Falha ao salvar:', res.status);
        }
    } catch(e) {
        lsSet('agenda_sync_pendente', true);
        // Persiste cancelados do listaOverride quando o fetch falha (ex: sem internet
        // mas token ainda válido). Garante que o cancelado não se perde entre sessões.
        if (listaOverride) {
            const _canceladosFalha = listaOverride.filter(a => a.status === 'cancelado');
            if (_canceladosFalha.length) {
                const _existentes = lsGet('agenda_cancelados_pendentes', []);
                const _todos = [..._existentes, ..._canceladosFalha].filter(
                    (a, i, arr) => arr.findIndex(x => x.id === a.id) === i
                );
                lsSet('agenda_cancelados_pendentes', _todos);
            }
        }
        console.error('[Drive] Erro ao salvar:', e);
    }
}

// Quando volta online: sincroniza pendentes com o Drive
async function sincronizarPendentes() {
    const pendente = lsGet('agenda_sync_pendente', false);
    if (!pendente) return;
    if (!tokenValido()) return;
    console.log('[Sync] Enviando dados pendentes para o Drive...');

    // Resolve duplicatas: se dois agendamentos confirmados caírem no mesmo
    // dia+hora (ex: substituição feita offline gerou duplicidade), mantém
    // só o mais recente e cancela o mais antigo.
    resolverDuplicatasAgendamentos();

    await salvarAlteracoesNoDrive();
    if (!lsGet('agenda_sync_pendente', false)) {
        toast('✅ Dados sincronizados com o Google Drive!');
    }
}

// Detecta e resolve agendamentos confirmados duplicados no mesmo dia+hora
function resolverDuplicatasAgendamentos() {
    const ativos = S.agendamentos.filter(a => (a.status || 'confirmado') !== 'cancelado');
    const grupos = {};
    ativos.forEach(a => {
        const chave = `${a.data}_${a.hora}`;
        if (!grupos[chave]) grupos[chave] = [];
        grupos[chave].push(a);
    });

    let houveDuplicata = false;
    const idsParaCancelar = [];

    Object.values(grupos).forEach(grupo => {
        if (grupo.length > 1) {
            houveDuplicata = true;
            // Ordena por id (timestamp) — mantém o mais recente
            grupo.sort((a, b) => {
                const ta = parseInt(String(a.id).replace(/\D/g, '')) || 0;
                const tb = parseInt(String(b.id).replace(/\D/g, '')) || 0;
                return tb - ta;
            });
            // Cancela todos exceto o primeiro (mais recente)
            grupo.slice(1).forEach(a => idsParaCancelar.push(a.id));
        }
    });

    if (houveDuplicata) {
        console.log('[Sync] Duplicatas detectadas, resolvendo:', idsParaCancelar);
        const canceladosPendentes = lsGet('agenda_cancelados_pendentes', []);
        idsParaCancelar.forEach(id => {
            const ag = S.agendamentos.find(a => a.id === id);
            if (ag && !canceladosPendentes.find(c => c.id === id)) {
                const canceladoDup = carimbar({ ...ag, status: 'cancelado' });
                canceladosPendentes.push(canceladoDup);
                registrarLapide(canceladoDup);
            }
        });
        lsSet('agenda_cancelados_pendentes', canceladosPendentes);

        // Remove duplicatas da lista ativa local
        S.agendamentos = S.agendamentos.filter(a => !idsParaCancelar.includes(a.id));
        if (window.sistemaLocal) {
            // Agenda Local: apaga do SQLite só estes ids (antes isso dependia da
            // exclusão implícita em massa, que foi removida).
            salvarAgendamentosAcao_ls({ excluir: idsParaCancelar });
        } else {
            salvarAgendamentos_ls();
        }
        renderizarAgenda();
    }
}

window.addEventListener('online', () => {
    setTimeout(sincronizarPendentes, 2000);
});

// Polling: verifica atualizações no Drive a cada 30s quando a agenda está aberta
function iniciarPollingDrive() {
    if (_drivePollingTimer) clearInterval(_drivePollingTimer);
    if (!tokenValido()) return;
    _drivePollingTimer = setInterval(async () => {
        if (!tokenValido()) { clearInterval(_drivePollingTimer); return; }
        await baixarBackupDrive(true);
    }, DRIVE_POLL_MS);
    console.log(`[Drive] Polling ativo — verificando a cada ${DRIVE_POLL_MS / 1000}s`);
}

function pararPollingDrive() {
    if (_drivePollingTimer) { clearInterval(_drivePollingTimer); _drivePollingTimer = null; }
}

// ══════════════════════════════════════════════════════
// INDEXEDDB — cache offline
// ══════════════════════════════════════════════════════

const IDB_NOME   = 'AgendaClinica';
const IDB_VERSAO = 1;
let _idb = null;

function abrirIDB() {
    if (_idb) return Promise.resolve(_idb);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NOME, IDB_VERSAO);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('agendamentos'))
                db.createObjectStore('agendamentos', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('pacientes'))
                db.createObjectStore('pacientes',    { keyPath: 'id' });
        };
        req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
        req.onerror   = e => reject(e.target.error);
    });
}

async function idbGetAll(store) {
    const db = await abrirIDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function idbPut(store, obj) {
    const db = await abrirIDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).put(obj);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function idbClear(store) {
    const db = await abrirIDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).clear();
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

// ══════════════════════════════════════════════════════
// ESTADO GLOBAL
// ══════════════════════════════════════════════════════

const S = {
    pin:            '',
    adminPin:       null,
    pacientes:      [],
    agendamentos:   [],
    semanaOffset:   0,
    diaSelecionado: null,
    slotStates:     {},
    agDetalhe:      null,
    linkGerado:     null,
    telMedico:      '',
    googleToken:    null,
    fileIdDrive:    null,
    fileIdAparelho: null,
    config: {
        nome_clinica: 'Agenda Clínica', tel_medico: '', admin_pin: '1234', ocultar_fds: false,
        ocultar_sab: false, ocultar_dom: true,
        // Central de Imagens: duas galerias independentes, cada uma com seu
        // próprio upload — sem mais tags compartilhadas por foto.
        imagens_agenda:   [], // [{ id, src }] — tela de login + topo do calendário
        imagens_descanso: [], // [{ id, src }] — carrossel da tela de descanso
        tela_descanso: { ativo: false, apos_inatividade: true, minutos: 30, forcar_padrao: false },
    },
};

const DIAS_ABR  = ['DOM','SEG','TER','QUA','QUI','SEX','SÁB'];
const DIAS_FULL = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
const MESES_ABR = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const INTERVALO_MIN = 30; // granularidade dos horários da agenda (em minutos)
const HORAS_CHEIAS = Array.from({length: 14}, (_, i) => i + 7); // 07:00 – 20:00 (linhas da grade)
const SUB_OFFSETS  = Array.from({length: 60 / INTERVALO_MIN}, (_, i) => i * (INTERVALO_MIN / 60)); // [0, 0.5]
const HORAS     = Array.from(
    { length: Math.round((20 - 7) * (60 / INTERVALO_MIN)) + 1 },
    (_, i) => 7 + i * (INTERVALO_MIN / 60)
); // 07:00 – 20:00, de 30 em 30 min (usado nas grades de disponibilidade/seleção do paciente)

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const horaLabel = h => {
    const hNum = parseFloat(h);
    const hh   = Math.floor(hNum);
    const mm   = Math.round((hNum - hh) * 60);
    return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
};
// Converte Date para "YYYY-MM-DD" no fuso LOCAL da máquina.
// ANTES usava d.toISOString().slice(0,10) — mas toISOString() converte
// pra UTC antes de formatar. Como o Brasil está atrás do UTC (UTC-3),
// entre ~21h e 23h59 do horário local isso já "empurra" a data pro dia
// seguinte em UTC, e o agendamento salvo (ex.: numa segunda-feira) deixa
// de bater com a coluna certa da grade — é exatamente o efeito de
// "segunda virou domingo" sozinha. getFullYear/getMonth/getDate são
// sempre no fuso local, então nunca desalinham com o calendário real.
const isoDate = d => {
    const ano = d.getFullYear();
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
};
const somarDias = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

function lsGet(key, def = []) {
    try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
}
function lsSet(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
}

// ══════════════════════════════════════════════════════
// FASE 2 DA SINCRONIZAÇÃO — carimbo por registro (atualizadoEm)
//
// Cada agendamento carrega `atualizadoEm` (ISO UTC): o momento em que ELE foi
// alterado de verdade. Celular, Drive e PC usam a mesma regra, por id:
// vence o registro de atualizadoEm mais novo; sem carimbo = o mais antigo.
// O carimbo só é gerado em ação real do usuário (agendar, cancelar, falta,
// substituir) — nunca ao simplesmente regravar/ressincronizar a lista.
//
// Cancelar/excluir deixa uma LÁPIDE (registro status 'cancelado' + carimbo)
// por 30 dias. Sem ela, a cópia velha de outro aparelho "ressuscitava" o
// registro, e o PC não tinha como saber que o celular cancelou.
// ══════════════════════════════════════════════════════
const LAPIDES_DIAS = 30; // por quanto tempo lembramos de cancelamentos/exclusões
const REENVIO_DIAS = 14; // só reenviamos ao Drive alterações recentes (não histórico antigo)

let _ultimoCarimboMs = 0;

// Quando o registro foi alterado pela última vez (ms). Sem carimbo = 0.
function carimboMs(ag) {
    const v = ag && (ag.atualizadoEm || ag.atualizado_em);
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : 0;
}

// Carimbo novo, sempre maior que o anterior deste aparelho e que o do próprio
// registro (mesmo que o relógio do aparelho tenha ficado para trás).
function proximoCarimbo(minimoMs = 0) {
    const t = Math.max(Date.now(), _ultimoCarimboMs + 1, minimoMs + 1);
    _ultimoCarimboMs = t;
    return new Date(t).toISOString();
}

// Devolve uma CÓPIA do agendamento com carimbo novo. Só em ação real do usuário.
function carimbar(ag) {
    const { atualizado_em, ...resto } = ag;
    return { ...resto, atualizadoEm: proximoCarimbo(carimboMs(ag)) };
}

function _lapideDe(ag) {
    return {
        id:            ag.id,
        paciente_id:   ag.paciente_id || '',
        nome_paciente: ag.nome_paciente || ag.nomePaciente || ag.paciente || '',
        data:          ag.data,
        hora:          ag.hora,
        obs:           '',
        status:        'cancelado',
        atualizadoEm:  ag.atualizadoEm || ag.atualizado_em || null
    };
}

// Lápides guardadas neste aparelho: { id: registroCancelado }. Poda as velhas.
function lerLapides() {
    const bruto = lsGet('agenda_lapides', {});
    const mapa  = (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) ? bruto : {};
    const limite = Date.now() - LAPIDES_DIAS * 86400000;
    Object.keys(mapa).forEach(id => { if (carimboMs(mapa[id]) < limite) delete mapa[id]; });
    return mapa;
}

function registrarLapide(agCancelado) {
    try {
        const mapa = lerLapides();
        const id   = String(agCancelado.id);
        if (!mapa[id] || carimboMs(agCancelado) >= carimboMs(mapa[id])) mapa[id] = _lapideDe(agCancelado);
        lsSet('agenda_lapides', mapa);
    } catch (e) {
        console.warn('[Sync] Não foi possível guardar a lápide:', e);
    }
}

// Junta várias listas; por id, fica o de carimbo mais novo (empate: o da lista que veio primeiro).
function unirPorId(listas) {
    const mapa = new Map();
    listas.forEach(lista => (lista || []).forEach(a => {
        const k = String(a.id);
        const atual = mapa.get(k);
        if (!atual || carimboMs(a) > carimboMs(atual)) mapa.set(k, a);
    }));
    return Array.from(mapa.values());
}

// Mescla a lista que veio do Drive (remotos) com a deste aparelho, registro a
// registro. NUNCA "substitui a lista": o que só existe aqui fica (pode ser uma
// consulta que o PC ainda não importou).
//  • vivo remoto mais novo que o local            → entra/substitui
//  • vivo remoto mais velho que a lápide local    → ignorado (não ressuscita)
//  • lápide remota mais nova que o local          → remove o local e guarda a lápide
//  • nenhum dos dois tem carimbo (arquivo antigo) → vale o do Drive, como antes
// Retorna { lista, lapides, mudou, reenviar }. `reenviar` = este aparelho sabe
// de algo mais novo (ou recente) que o arquivo não tem → vale subir de volta.
function mesclarAgendamentos(locais, remotos, lapides, { podarLegadosAusentes = false } = {}) {
    const mapa = new Map();
    (locais || []).forEach(a => mapa.set(String(a.id), a));
    const idsRemotos = new Set();
    let mudou = false, reenviar = false;

    for (const r of (remotos || [])) {
        if (!r || r.id == null) continue;
        const id   = String(r.id);
        idsRemotos.add(id);
        const tr   = carimboMs(r);
        const loc  = mapa.get(id);
        const tl   = loc ? carimboMs(loc) : -1;
        const lap  = lapides[id];
        const tlap = lap ? carimboMs(lap) : -1;

        if ((r.status || 'confirmado') === 'cancelado') {
            if (loc && tl > tr) { reenviar = true; continue; } // o local é mais novo que esta lápide
            if (loc) { mapa.delete(id); mudou = true; }
            if (!lap || tr > tlap) lapides[id] = _lapideDe(r);
            continue;
        }

        if (lap && tlap >= tr) { reenviar = true; continue; }  // cópia velha de algo já cancelado/excluído
        if (!loc) { mapa.set(id, r); mudou = true; continue; }
        if (tr > tl || (tr === 0 && tl === 0)) {
            if (JSON.stringify(loc) !== JSON.stringify(r)) { mapa.set(id, r); mudou = true; }
        } else if (tl > tr) {
            reenviar = true;
        }
    }

    // O arquivo não tem registros que ESTE aparelho tem?
    const limiteReenvio = Date.now() - REENVIO_DIAS * 86400000;
    for (const [id, a] of Array.from(mapa.entries())) {
        if (idsRemotos.has(id)) continue;
        const t = carimboMs(a);
        if (t >= limiteReenvio) reenviar = true;            // alteração recente que o arquivo perdeu (ex.: outro aparelho sobrescreveu)
        else if (t === 0 && podarLegadosAusentes) { mapa.delete(id); mudou = true; } // resto antigo que o PC já excluiu
    }
    Object.keys(lapides).forEach(id => {
        if (!idsRemotos.has(id) && carimboMs(lapides[id]) >= limiteReenvio) reenviar = true;
    });

    return { lista: Array.from(mapa.values()), lapides, mudou, reenviar };
}

// Cancelamentos que estavam na fila ANTES desta versão não têm carimbo — e
// sem carimbo perderiam para o PC. Carimba uma vez, agora.
function migrarCarimbosLegados() {
    try {
        const pend = lsGet('agenda_cancelados_pendentes', []);
        if (!pend.some(a => !carimboMs(a))) return;
        const novos = pend.map(a => carimboMs(a) ? a : carimbar(a));
        lsSet('agenda_cancelados_pendentes', novos);
        novos.forEach(registrarLapide);
    } catch (e) { /* migração é só conforto */ }
}

// ══════════════════════════════════════════════════════
// LOG DE EVENTOS DA AGENDA — histórico de ações e falhas
// Guardado localmente (últimos LOG_MAX_EVENTOS) e enviado em segundo
// plano pro Worker, pra aparecer no painel admin. Nunca bloqueia a ação
// do usuário: se o envio falhar (sem internet, Worker fora do ar), o
// evento fica pendente e é reenviado na próxima oportunidade.
// Tipos usados: agendado | cancelado | substituido | nao_realizada |
//   falha_sync | falha_drive | token_expirado | token_renovado
// ══════════════════════════════════════════════════════
const LOG_MAX_EVENTOS = 300;

function registrarLogAgenda(tipo, paciente, detalhe) {
    try {
        const evento = {
            ts:       new Date().toISOString(),
            tipo,
            paciente: paciente || null,
            detalhe:  detalhe  || ''
        };
        const log = lsGet('agenda_log_eventos', []);
        log.push(evento);
        if (log.length > LOG_MAX_EVENTOS) log.splice(0, log.length - LOG_MAX_EVENTOS);
        lsSet('agenda_log_eventos', log);

        // Fila separada só com o que ainda não foi confirmado pelo Worker
        const pendentes = lsGet('agenda_log_pendente_envio', []);
        pendentes.push(evento);
        lsSet('agenda_log_pendente_envio', pendentes);

        _agendarEnvioLogWorker();
    } catch (e) {
        console.warn('[Log] Falha ao registrar evento local:', e);
    }
}

// Envia os eventos pendentes pro Worker com um pequeno debounce — várias
// ações em sequência (ex: substituição = cancelado + agendado) geram um
// único envio em vez de um fetch por evento.
let _logEnvioTimer = null;
function _agendarEnvioLogWorker() {
    if (_logEnvioTimer) clearTimeout(_logEnvioTimer);
    _logEnvioTimer = setTimeout(enviarLogsPendentesWorker, 4000);
}

async function enviarLogsPendentesWorker() {
    const pendentes = lsGet('agenda_log_pendente_envio', []);
    if (!pendentes.length || !CLIENTE_ID) return;
    try {
        const resp = await fetch(`${URL_WORKER_ADMIN}/agenda-log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clienteId: CLIENTE_ID, eventos: pendentes })
        });
        if (resp.ok) {
            lsSet('agenda_log_pendente_envio', []); // só limpa se o Worker confirmou
        }
    } catch (e) {
        // Sem internet ou Worker fora do ar — fica pendente pro próximo envio.
        console.warn('[Log] Falha ao enviar log pro Worker (fica pendente):', e);
    }
}

// ══════════════════════════════════════════════════════
// PERSISTÊNCIA — Drive primeiro, IndexedDB como fallback offline
// ══════════════════════════════════════════════════════

function carregarConfig() {
    const saved = lsGet('agenda_config', null);
    if (saved) S.config = { ...S.config, ...saved };
    // Migração: versões antigas só tinham um único toggle "ocultar_fds"
    // (sábado + domingo juntos). Quem já tinha ligado passa a ver o
    // sábado normalmente por padrão nos novos toggles independentes —
    // só o domingo continua oculto até o usuário decidir mudar.
    if (saved && saved.ocultar_fds && saved.ocultar_sab === undefined && saved.ocultar_dom === undefined) {
        S.config.ocultar_sab = false;
        S.config.ocultar_dom = true;
    }
    migrarImagens();
}

// Gera um id curto e único o bastante pra distinguir fotos na galeria.
function _gerarIdImagem() {
    return 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Migração: garante o formato atual (duas listas independentes de objetos
// {id,src}) e traz dados de versões anteriores da Central de Imagens:
//   1) formato bem antigo — imagens_agenda era um array plano de strings (src);
//   2) formato intermediário — galeria única (central_imagens) com flags
//      agenda/descanso por foto. Cada foto marcada pra um uso vira uma
//      entrada própria (com id novo) na lista correspondente.
// Roda toda vez que a config carrega; só altera algo se houver dado no
// formato antigo pra trazer.
function migrarImagens() {
    if (!Array.isArray(S.config.imagens_agenda))   S.config.imagens_agenda = [];
    if (!Array.isArray(S.config.imagens_descanso)) S.config.imagens_descanso = [];
    if (!S.config.tela_descanso || typeof S.config.tela_descanso !== 'object') {
        S.config.tela_descanso = { ativo: false, apos_inatividade: true, minutos: 30, forcar_padrao: false };
    }
    // Migração: quem já tinha tela_descanso salva de antes desse campo
    // existir simplesmente não tem forcar_padrao ainda — assume false
    // (comportamento igual ao de hoje: só cai pro padrão se não tiver
    // fotos enviadas).
    if (S.config.tela_descanso.forcar_padrao === undefined) {
        S.config.tela_descanso.forcar_padrao = false;
    }

    let mudou = false;

    // (1) imagens_agenda antigo era array de strings puras.
    if (S.config.imagens_agenda.length && typeof S.config.imagens_agenda[0] === 'string') {
        S.config.imagens_agenda = S.config.imagens_agenda.map(src => ({ id: _gerarIdImagem(), src }));
        mudou = true;
    }

    // (2) central_imagens (galeria única com tags) — separa em duas listas.
    if (Array.isArray(S.config.central_imagens) && S.config.central_imagens.length) {
        S.config.central_imagens.forEach(img => {
            if (!img || !img.src) return;
            if (img.agenda)   S.config.imagens_agenda.push({ id: _gerarIdImagem(), src: img.src });
            if (img.descanso) S.config.imagens_descanso.push({ id: _gerarIdImagem(), src: img.src });
        });
        delete S.config.central_imagens;
        mudou = true;
    }

    if (mudou) salvarConfig_ls();
}
function salvarConfig_ls() {
    lsSet('agenda_config', S.config);
}

// Oculta/mostra sábado e/ou domingo na grade semanal, de forma
// independente um do outro. Controla apenas a contagem de colunas
// visíveis via CSS var (--ga-dias) — a preferência vem de
// S.config.ocultar_sab / S.config.ocultar_dom, salvas com o resto da
// config (localStorage + sync Drive), então ficam valendo até o usuário
// reverter, em qualquer dispositivo/janela (Online ou Local, mesmo app.js).
function aplicarOcultarFDS() {
    const qtdOcultos = (S.config.ocultar_sab ? 1 : 0) + (S.config.ocultar_dom ? 1 : 0);
    document.documentElement.style.setProperty('--ga-dias', 7 - qtdOcultos);
}

// Retorna as imagens em uso no topo da agenda: as fotos da galeria própria
// da Agenda, ou as 13 padrão do Pequeno Príncipe caso nenhuma tenha sido enviada.
function getImagensAgenda() {
    const lista = Array.isArray(S.config.imagens_agenda) ? S.config.imagens_agenda : [];
    if (lista.length) return lista.map(img => img.src);
    return window.PP_IMGS_PADRAO || window.PP_IMGS || [];
}

// Retorna as imagens em uso no carrossel da Tela de Descanso: se
// "forcar_padrao" estiver marcado, sempre as ilustrações padrão do
// Pequeno Príncipe, mesmo que existam fotos enviadas na galeria própria.
// Caso contrário, mantém o comportamento de sempre: as fotos da galeria
// própria da Tela de Descanso, ou as ilustrações padrão caso nenhuma
// tenha sido enviada.
function getImagensDescanso() {
    if (S.config.tela_descanso && S.config.tela_descanso.forcar_padrao) {
        return window.PP_IMGS_PADRAO || window.PP_IMGS || [];
    }
    const lista = Array.isArray(S.config.imagens_descanso) ? S.config.imagens_descanso : [];
    if (lista.length) return lista.map(img => img.src);
    return window.PP_IMGS_PADRAO || window.PP_IMGS || [];
}

async function carregarPacientes_ls() {
    // Agenda Local: puxa a lista de pacientes já cadastrados no sistema
    // (SQLite) via ponte do preload, em vez do localStorage isolado da
    // agenda — assim os mesmos pacientes do cadastro aparecem aqui.
    if (window.sistemaLocal && typeof window.sistemaLocal.listarPacientes === 'function') {
        try {
            const pacs = await window.sistemaLocal.listarPacientes();
            if (Array.isArray(pacs)) {
                S.pacientes = pacs
                    .filter(p => p.status !== 'inativo')
                    .map(p => ({
                        id:             String(p.id),
                        nome:           p.nome,
                        codigo:         '',
                        convenio:       p.convenio || '',
                        frequencia:     p.frequencia || '',
                        valor_consulta: p.valor_consulta ? Number(p.valor_consulta) : 0
                    }));
                return;
            }
        } catch (e) { /* cai para o fluxo normal abaixo em caso de falha */ }
    }
    // 1. localStorage (já sincronizado pelo Drive)
    const ls = lsGet('agenda_pacientes', []);
    if (ls.length > 0) { S.pacientes = ls; return; }
    // 2. Fallback: IndexedDB (offline)
    try {
        const idb = await idbGetAll('pacientes');
        if (idb.length > 0) { S.pacientes = idb; return; }
    } catch(e) {}
    S.pacientes = [];
}

function salvarPacientes_ls() {
    lsSet('agenda_pacientes', S.pacientes);
    // Atualiza IndexedDB também
    idbClear('pacientes').then(() => {
        S.pacientes.forEach(p => idbPut('pacientes', p).catch(() => {}));
    }).catch(() => {});
}

// Indica se S.agendamentos, no momento, é um retrato confiável e completo
// do banco do sistema (true) ou veio de um fallback — localStorage/IndexedDB
// desta janela — que pode estar desatualizado (false). Só quando é true é
// seguro tratar "o que não está na lista" como "foi excluído de verdade".
let _agendamentosFonteConfiavel = false;

async function carregarAgendamentos_ls() {
    // Agenda Local: lê direto do SQLite do sistema (mesma tabela que a Home,
    // Pacientes e o painel de quinzenais enxergam) via ponte do preload, em
    // vez do localStorage isolado desta janela — assim o que é lançado aqui
    // aparece imediatamente no resto do sistema, sem depender de Drive/Worker.
    if (window.sistemaLocal && typeof window.sistemaLocal.listarAgendamentos === 'function') {
        try {
            const ags = await window.sistemaLocal.listarAgendamentos();
            if (Array.isArray(ags)) { S.agendamentos = ags; _agendamentosFonteConfiavel = true; return; }
        } catch (e) { /* cai para o fluxo normal abaixo em caso de falha */ }
    }
    // A partir daqui, qualquer fonte usada é um retrato potencialmente velho
    // (não reflete o que outras janelas/telas gravaram no sistema depois).
    _agendamentosFonteConfiavel = false;
    // 1. localStorage (já sincronizado pelo Drive)
    const ls = lsGet('agenda_agendamentos', []);
    if (ls.length > 0) { S.agendamentos = ls; return; }
    // 2. Fallback: IndexedDB (offline)
    try {
        const idb = await idbGetAll('agendamentos');
        if (idb.length > 0) {
            S.agendamentos = idb;
            toast('📴 Modo offline — mostrando dados salvos localmente');
            return;
        }
    } catch(e) {}
    S.agendamentos = [];
}

// Fila que serializa as sincronizações com o SQLite do sistema. Antes, cada
// chamada rodava de forma independente e sem esperar a anterior terminar —
// se duas gravações caíssem em sequência rápida (ex: agendar e, logo depois,
// editar/cancelar outro horário), a etapa de "limpeza" de uma delas podia
// apagar do banco um agendamento que a outra tinha acabado de inserir,
// mesmo depois do toast de sucesso já ter sido mostrado. Encadeando tudo
// numa única fila, cada sincronização só começa depois que a anterior
// realmente terminou.
let _filaSyncAgendamentosLocal = Promise.resolve();

// Espelha S.agendamentos no SQLite do sistema (tabela agenda_agendamentos)
// quando a ponte da Agenda Local está disponível. Faz upsert de tudo que
// está na lista atual (num retrato congelado no momento da chamada) e NUNCA
// apaga nada do banco — exclusões só por id explícito (sincronizarAcaoLocal
// com `excluir`). Retorna uma Promise<boolean>: true se sincronizou com sucesso
// (ou não havia nada a fazer, ex: Agenda Online sem a ponte local), false
// se algo falhou na gravação.
function sincronizarAgendamentosComSistemaLocal() {
    if (!window.sistemaLocal || typeof window.sistemaLocal.salvarAgendamento !== 'function') {
        return Promise.resolve(true);
    }
    // Encadeia esta execução depois da anterior — nunca roda em paralelo.
    _filaSyncAgendamentosLocal = _filaSyncAgendamentosLocal.then(async () => {
        const snapshot = S.agendamentos.slice(); // congela a lista atual
        try {
            // SOMENTE upsert. Esta função NÃO apaga mais nada do banco: "o que
            // não está na lista" nunca mais significa "foi excluído". Exclusão
            // só acontece por id explícito, via sincronizarAcaoLocal({ excluir }).
            // (A exclusão em massa que existia aqui foi o que apagou
            // agendamentos legítimos — ex.: Gertrudes e Julio — sempre que a
            // lista em memória estava incompleta.)
            for (const ag of snapshot) {
                await window.sistemaLocal.salvarAgendamento(ag);
            }
            return true;
        } catch (e) {
            console.warn('[Agenda Local] Falha ao sincronizar com o sistema:', e);
            return false;
        }
    });
    return _filaSyncAgendamentosLocal;
}

// Retorna a Promise<boolean> da sincronização, para quem precisar confirmar
// que a gravação no sistema realmente terminou (com sucesso ou não) antes
// de avisar o usuário. Quem só quer disparar e seguir em frente (ex: rotina
// de deduplicação em segundo plano) pode continuar chamando sem "await".
function salvarAgendamentos_ls() {
    lsSet('agenda_agendamentos', S.agendamentos);
    // Atualiza IndexedDB também
    idbClear('agendamentos').then(() => {
        S.agendamentos.forEach(ag => idbPut('agendamentos', ag).catch(() => {}));
    }).catch(() => {});
    // Agenda Local (offline): espelha no SQLite do sistema, se a ponte existir
    return sincronizarAgendamentosComSistemaLocal();
}

// Versão pontual de sincronizarAgendamentosComSistemaLocal(): grava/exclui
// SÓ os agendamentos indicados, em vez de varrer e regravar o S.agendamentos
// inteiro a cada ação. A resync completa (acima) faz sentido nos fluxos em
// lote (download do Drive, dedup) — mas usá-la para uma única ação (cancelar
// UMA consulta, por exemplo) fazia N chamadas IPC (uma por agendamento
// existente) quando só 1 registro tinha mudado. Continua na MESMA fila
// _filaSyncAgendamentosLocal, então nunca roda em paralelo com uma resync
// completa nem com outra ação pontual — a serialização contra corrida
// continua valendo.
function sincronizarAcaoLocal({ upsert = [], excluir = [] } = {}) {
    if (window.sistemaLocal && typeof window.sistemaLocal.salvarAgendamento === 'function') {
        _filaSyncAgendamentosLocal = _filaSyncAgendamentosLocal.then(async () => {
            try {
                for (const ag of upsert) {
                    await window.sistemaLocal.salvarAgendamento(ag);
                }
                if (typeof window.sistemaLocal.excluirAgendamento === 'function') {
                    for (const id of excluir) {
                        await window.sistemaLocal.excluirAgendamento(id);
                    }
                }
                return true;
            } catch (e) {
                console.warn('[Agenda Local] Falha ao sincronizar ação pontual com o sistema:', e);
                return false;
            }
        });
        return _filaSyncAgendamentosLocal;
    }

    // Agenda Online (GitHub Pages) — não tem window.sistemaLocal (sem IPC
    // direto, ver preload-agenda-online.js). Sem este fallback, upsert()
    // aqui só gravava no localStorage/IndexedDB DESTA janela — nunca
    // chegava no clinica.db de verdade, e por isso o Controle de
    // Recorrência (e qualquer outra tela que lê o banco pelo IPC/HTTP)
    // nunca enxergava o agendamento novo. Mesmo servidor local (porta 3131)
    // que _cancelarAgendamentoInterno já usa pra cancelar.
    _filaSyncAgendamentosLocal = _filaSyncAgendamentosLocal.then(async () => {
        try {
            for (const ag of upsert) {
                await fetchServidorLocal('/agenda/agendamentos', { method: 'POST', corpo: ag });
            }
            for (const id of excluir) {
                await fetchServidorLocal(`/agenda/agendamentos/${encodeURIComponent(id)}`, { method: 'DELETE' });
            }
            return true;
        } catch (e) {
            if (!e.inacessivel) {
                // O desktop respondeu, mas NÃO gravou — nunca pode virar "sucesso".
                registrarLogAgenda('falha_sync', null,
                    `Computador da clínica recusou a gravação (${e.status || 'erro'}) mesmo após novas tentativas: ${e.message}`);
                console.warn('[Agenda Online] Servidor local (3131) recusou a gravação:', e);
                return false;
            }
            // Desktop inacessível (ex: celular fora da mesma rede do PC) é o
            // caso NORMAL da Agenda Online — não é falha de gravação. A ação
            // já vale nesta janela e segue pro PC via Drive/GitHub (quem avisa
            // se o Drive falhar é o salvarAlteracoesNoDrive, logo depois).
            // Devolver false aqui fazia aparecer "Não foi possível gravar no
            // sistema" mesmo com o agendamento salvo corretamente.
            console.warn('[Agenda Online] Servidor local (3131) inacessível — seguindo pelo Drive:', e);
            return true;
        }
    });
    return _filaSyncAgendamentosLocal;
}

// Mesmo papel do salvarAgendamentos_ls(), mas delegando pro sync pontual
// acima em vez da resync completa. localStorage/IndexedDB continuam sendo
// regravados por completo (já são baratos — uma escrita local, não IPC por
// item — então não precisam de versão incremental).
function salvarAgendamentosAcao_ls({ upsert = [], excluir = [] } = {}) {
    lsSet('agenda_agendamentos', S.agendamentos);
    idbClear('agendamentos').then(() => {
        S.agendamentos.forEach(ag => idbPut('agendamentos', ag).catch(() => {}));
    }).catch(() => {});
    return sincronizarAcaoLocal({ upsert, excluir });
}

function carregarTokens_ls() {
    return lsGet('agenda_tokens', {});
}
function salvarTokens_ls(tokens) {
    lsSet('agenda_tokens', tokens);
}

// ══════════════════════════════════════════════════════
// SEMANA
// ══════════════════════════════════════════════════════

function segundaFeiraDaSemana(offset = 0) {
    const hoje = new Date();
    const dom  = new Date(hoje);
    dom.setDate(hoje.getDate() - hoje.getDay() + (offset * 7));
    return dom;
}
function semanaLabel(inicio, fimCustom = null) {
    const fim = fimCustom || somarDias(inicio, 6);
    return `${inicio.getDate()} ${MESES_ABR[inicio.getMonth()]} – ${fim.getDate()} ${MESES_ABR[fim.getMonth()]} ${fim.getFullYear()}`;
}

// ══════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════

function toast(msg, dur = 2500) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.style.background = '';
    t.style.color = '';
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.style.display = 'none', dur);
}
// Aviso vermelho e mais demorado: usado quando algo NÃO foi gravado no
// computador da clínica (antes isso passava como "sucesso" em silêncio).
function toastErro(msg, dur = 6000) {
    toast(msg, dur);
    const t = $('toast');
    if (t) { t.style.background = '#c62828'; t.style.color = '#fff'; }
}
// Alias para compatibilidade com chamadas antigas
const mostrarToast = toast;

function irTela(id) {
    document.querySelectorAll('.tela').forEach(t => t.style.display = 'none');
    const tela = $(id);
    if (tela) tela.style.display = 'flex';
    else console.warn(`Tela "${id}" não encontrada.`);

    if (typeof _resetIdleTimer === 'function') _resetIdleTimer(); // navegar entre telas conta como atividade

    clearInterval(window._pollingAgenda);
    pararPollingDrive();

    if (id === 'tela-login') {
        // Mostra card de login automaticamente (ex: após sincronização Drive)
        setTimeout(() => {
            if (typeof window.mostrarCardLogin === 'function') {
                window.mostrarCardLogin();
            } else {
                const splash  = document.getElementById('login-splash');
                const card    = document.getElementById('login-card-wrap');
                const overlay = document.getElementById('login-overlay');
                const bg      = document.getElementById('login-bg');
                if (splash)  splash.style.display = 'none';
                if (overlay) overlay.style.pointerEvents = 'none';
                if (bg)      bg.style.pointerEvents = 'none';
                if (card)    card.style.display = 'flex';
            }
        }, 100);

        // Atualiza botão do Drive
        const btnDrive = document.querySelector('.btn-google');
        if (btnDrive) {
            if (tokenValido()) {
                btnDrive.innerHTML = '<i class="fa-brands fa-google"></i> Google Drive sincronizado ✓';
                btnDrive.style.background = '#e8f5e9';
                btnDrive.style.color = '#2e7d32';
                btnDrive.style.border = '1.5px solid #a5d6a7';
            } else {
                btnDrive.innerHTML = '<i class="fa-brands fa-google"></i> Sincronizar via Google Drive';
                btnDrive.style.background = '';
                btnDrive.style.color = '';
                btnDrive.style.border = '';
            }
        }

        // Reseta PIN para nova entrada
        S.pin = '';
        atualizarPinDisplay();
    }

    if (id === 'tela-config') {
        setTimeout(atualizarStatusDrive, 100);
        setTimeout(injetarToggleOcultarFDS, 100);
        setTimeout(atualizarResumoCentralImagens, 100);
    }

    if (id === 'tela-agenda') {
        setTimeout(atualizarStatusDrive, 100);
        // Polling leve: re-renderiza se localStorage mudar (ex: outra aba)
        window._pollingAgenda = setInterval(async () => {
            const antes = JSON.stringify(S.agendamentos);
            await carregarAgendamentos_ls();
            if (JSON.stringify(S.agendamentos) !== antes) renderizarAgenda();
        }, 15000);
        iniciarPollingDrive();
    }
}

function fecharModal(id) {
    const el = $(id);
    if (el) el.style.display = 'none';
}

// ══════════════════════════════════════════════════════
// PIN
// ══════════════════════════════════════════════════════

function atualizarPinDisplay() {
    const container = $('pin-display') || document.querySelector('.pin-circles');
    let spans = container ? Array.from(container.querySelectorAll('span')) : [];
    if (!spans.length) spans = Array.from(document.querySelectorAll('.pin-dot'));
    spans.forEach((s, i) => { s.className = i < S.pin.length ? 'filled' : ''; });
    const inp = document.querySelector('input[type="password"]') || $('login-pin');
    if (inp) inp.value = S.pin;
}

function pinDigit(num) {
    if (S.pin.length >= 4) return;
    S.pin += String(num);
    atualizarPinDisplay();
    if (S.pin.length === 4) setTimeout(pinEnter, 200);
}

function pinApagar() { S.pin = S.pin.slice(0, -1); atualizarPinDisplay(); }
function pinClear()  { S.pin = ''; atualizarPinDisplay(); }

async function pinEnter() {
    const pinCorreto = S.config.admin_pin || '1234';
    if (S.pin === pinCorreto) {
        S.adminPin = S.pin;
        lsSet('agenda_admin_pin_session', S.pin);
        S.pin = '';
        atualizarPinDisplay();
        await carregarTudo();
        // Após PIN correto, verifica Drive antes de abrir agenda
        await verificarDriveAntesDeEntrar();
    } else {
        const display = $('pin-display') || document.querySelector('.pin-circles');
        const msgErro = $('login-erro');
        if (display) display.classList.add('error');
        if (msgErro) { msgErro.style.display = 'block'; msgErro.textContent = 'PIN incorreto.'; }
        S.pin = '';
        atualizarPinDisplay();
        setTimeout(() => {
            if (display) display.classList.remove('error');
            if (msgErro) msgErro.style.display = 'none';
        }, 2000);
    }
}

// Gate: verifica Drive após PIN correto
async function verificarDriveAntesDeEntrar() {
    // Agenda Local (aberta direto do disco, sem internet por padrão) —
    // entra direto, sem perguntar sobre Drive.
    if (location.protocol === 'file:') {
        abrirAgenda();
        return;
    }
    // Sem internet → aviso offline e entra direto
    if (!navigator.onLine) {
        mostrarGateDrive('offline');
        return;
    }
    // Drive já conectado → sincroniza e abre agenda
    if (tokenValido()) {
        mostrarGateDrive('sincronizando');
        const baixou = await baixarBackupDrive(true).catch(() => false);
        if (baixou) {
            await carregarPacientes_ls();
            await carregarAgendamentos_ls();
        }
        fecharGateDrive();
        abrirAgenda();
        return;
    }
    // Drive não conectado → pede autorização
    mostrarGateDrive('desconectado');
}

// Abre a agenda após gate
function abrirAgenda() {
    irTela('tela-agenda');
    atualizarStatusDrive();
    renderizarAgenda();
    iniciarPollingDrive();
}

// Mostra o overlay do gate conforme estado
function mostrarGateDrive(estado) {
    let gate = $('drive-gate');
    if (!gate) {
        gate = document.createElement('div');
        gate.id = 'drive-gate';
        document.body.appendChild(gate);
    }

    if (estado === 'sincronizando') {
        gate.innerHTML = `
            <div class="drive-gate-card">
                <div class="drive-gate-icon spin"><i class="fa-brands fa-google-drive"></i></div>
                <h3>Sincronizando...</h3>
                <p>Baixando dados do Google Drive</p>
            </div>`;
        gate.style.display = 'flex';
        return;
    }

    if (estado === 'offline') {
        gate.innerHTML = `
            <div class="drive-gate-card">
                <div class="drive-gate-icon offline"><i class="fa-solid fa-wifi-slash"></i></div>
                <h3>Sem conexão</h3>
                <p>Você está offline. Os agendamentos serão salvos no celular e enviados ao sistema quando conectar ao Google Drive.</p>
                <button class="btn-pri" style="width:100%;margin-top:1rem;" onclick="fecharGateDrive();abrirAgenda();">
                    <i class="fa-solid fa-arrow-right"></i> Entrar mesmo assim
                </button>
            </div>`;
        gate.style.display = 'flex';
        lsSet('agenda_sync_pendente', true);
        return;
    }

    if (estado === 'desconectado') {
        gate.innerHTML = `
            <div class="drive-gate-card">
                <div class="drive-gate-icon"><i class="fa-brands fa-google-drive"></i></div>
                <h3>Conecte ao Google Drive</h3>
                <p>Para sincronizar seus agendamentos com o sistema, autorize o acesso ao Google Drive.</p>
                <button class="btn-pri" style="width:100%;margin-top:1rem;" onclick="fecharGateDrive();conectarDriveAgenda();">
                    <i class="fa-brands fa-google"></i> Autorizar Google Drive
                </button>
                <button class="btn-sec" style="width:100%;margin-top:.5rem;" onclick="fecharGateDrive();abrirAgenda();lsSet('agenda_sync_pendente',true);">
                    Continuar sem Drive
                    <span style="display:block;font-size:.72rem;opacity:.7;margin-top:.2rem;">Dados ficam só no celular</span>
                </button>
            </div>`;
        gate.style.display = 'flex';
        return;
    }
}

function fecharGateDrive() {
    const gate = $('drive-gate');
    if (gate) gate.style.display = 'none';
}

function logout() {
    S.pin = '';
    pararPollingDrive();
    if (S.abertoPeloSistemaLocal) {
        // Agenda Local não usa PIN — "sair" só volta pra tela da agenda,
        // sem pedir PIN de novo (não há PIN a digitar aqui).
        abrirAgenda();
        return;
    }
    S.adminPin = null;
    atualizarPinDisplay();
    irTela('tela-login');
}

async function carregarTudo() {
    migrarCarimbosLegados();
    carregarConfig();
    aplicarOcultarFDS();
    configurarMonitorInatividade();
    await carregarPacientes_ls();
    await carregarAgendamentos_ls();
    if ($('menu-clinica-nome')) $('menu-clinica-nome').textContent = S.config.nome_clinica;
    if ($('cfg-nome-clinica')) $('cfg-nome-clinica').value = S.config.nome_clinica;
    if ($('cfg-tel'))          $('cfg-tel').value = S.config.tel_medico || '';
    if ($('cfg-pin'))          $('cfg-pin').value = '';
}

// ══════════════════════════════════════════════════════
// AGENDA
// ══════════════════════════════════════════════════════

// ── Ajusta a altura das linhas da grade (07h–20h) para caberem
//    inteiras na área visível, SEMPRE — não importa se a janela foi
//    minimizada, maximizada ou redimensionada pra qualquer tamanho.
//    Em celular (media queries com altura fixa) essa variável é
//    ignorada pelo CSS, então não precisa de gate de largura aqui. ──
const GA_MIN_LINHA_PX = 16; // piso só pra nunca chegar a 0/negativo — mas NUNCA desiste e volta a cortar
function ajustarAlturaGradeAgenda() {
    const wrap = document.querySelector('.agenda-wrap');
    const headerLinha = document.querySelector('.ga-hora-header');
    if (!wrap || !headerLinha) return;

    const alturaDisponivel = wrap.clientHeight;
    const alturaHeader = headerLinha.getBoundingClientRect().height;
    const numLinhas = HORAS_CHEIAS.length;
    if (!numLinhas || alturaDisponivel <= 0) return;

    // Antes: se desse menos de 26px por linha, a função "desistia" e
    // removia a variável --ga-row-h, voltando pro valor fixo do CSS
    // (42px) — que é MAIOR que o espaço disponível, e é exatamente
    // isso que fazia a grade estourar embaixo e cortar as últimas
    // horas (17h em diante, no seu caso). Agora ela sempre calcula e
    // sempre aplica — na pior das hipóteses fica compacta, mas nunca
    // corta uma linha inteira pra fora da tela.
    let alturaLinha = Math.floor((alturaDisponivel - alturaHeader) / numLinhas);
    alturaLinha = Math.max(alturaLinha, GA_MIN_LINHA_PX);

    document.documentElement.style.setProperty('--ga-row-h', alturaLinha + 'px');
}

// ResizeObserver reage a QUALQUER mudança de tamanho da área da grade —
// minimizar, maximizar, arrastar a borda, ou até o layout ao redor
// (header, nav) mudar de altura — não só o evento "resize" da janela,
// que não cobre todos esses casos.
let _gaResizeTimer = null;
function _agendarAjusteAlturaGrade() {
    clearTimeout(_gaResizeTimer);
    _gaResizeTimer = setTimeout(ajustarAlturaGradeAgenda, 80);
}
window.addEventListener('resize', _agendarAjusteAlturaGrade);
window.addEventListener('load', _agendarAjusteAlturaGrade);
// Em alguns PCs (mais lentos, ou onde a janela abre já maximizada antes do
// conteúdo terminar de carregar) o layout final só assenta bem depois do
// 'load' — e como nada mais dispara um resize nesse caso, a grade ficava
// presa no cálculo antigo (menor) até o usuário mexer manualmente na
// janela. 'focus' cobre esse caso: ao voltar pra janela, reconfere.
window.addEventListener('focus', _agendarAjusteAlturaGrade);

// ── Agenda Local: atualiza a grade sozinha quando o banco muda por fora ──
// O main.js avisa (via preload) quando importa algo do celular/Drive/link do
// paciente. Também reconfere ao voltar o foco pra janela. Antes só havia o
// polling de 15s, que não cobria esses casos e dependia de reentrar na tela.
let _atualizarAgendaLocalTimer = null;
function _atualizarAgendaLocalAgora() {
    if (!window.sistemaLocal) return;
    clearTimeout(_atualizarAgendaLocalTimer);
    _atualizarAgendaLocalTimer = setTimeout(async () => {
        const tela = $('tela-agenda');
        if (!tela || tela.style.display === 'none') return;
        try {
            // espera as gravações em andamento terminarem, pra não ler o
            // banco no meio de uma sincronização
            await _filaSyncAgendamentosLocal.catch(() => {});
            await renderizarAgenda(); // já recarrega do SQLite
        } catch (e) {
            console.warn('[Agenda Local] Falha ao atualizar a grade:', e);
        }
    }, 300);
}
window.sistemaLocal?.aoAtualizarAgenda?.(_atualizarAgendaLocalAgora);
window.addEventListener('focus', _atualizarAgendaLocalAgora);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) _atualizarAgendaLocalAgora();
});
const _gaResizeObserver = new ResizeObserver(_agendarAjusteAlturaGrade);
document.addEventListener('DOMContentLoaded', () => {
    const wrapEl = document.querySelector('.agenda-wrap');
    if (wrapEl) _gaResizeObserver.observe(wrapEl);
});

async function renderizarAgenda() {
    await carregarAgendamentos_ls();
    aplicarOcultarFDS();
    const inicio = segundaFeiraDaSemana(S.semanaOffset);
    const diasTodos = Array.from({length: 7}, (_, i) => somarDias(inicio, i));
    // Se sábado e/ou domingo estiverem marcados pra ocultar (de forma
    // independente um do outro), a grade mostra menos colunas (5, 6 ou 7).
    // O cabeçalho, as células de horário e o grid-template-columns (via
    // --ga-dias, ajustado em aplicarOcultarFDS) seguem todos essa mesma
    // lista filtrada.
    const algumOculto = S.config.ocultar_sab || S.config.ocultar_dom;
    const dias   = algumOculto
        ? diasTodos.filter(d => !(S.config.ocultar_dom && d.getDay() === 0) && !(S.config.ocultar_sab && d.getDay() === 6))
        : diasTodos;
    const hoje   = isoDate(new Date());

    // Se o dia selecionado ficou escondido (era sábado/domingo e a
    // preferência acabou de ser ligada), cai pra segunda-feira da mesma
    // semana em vez de continuar apontando pra uma coluna que não existe.
    if (algumOculto && S.diaSelecionado && !dias.some(d => isoDate(d) === S.diaSelecionado)) {
        S.diaSelecionado = isoDate(dias[0]);
    }

    const labelEl1 = $('header-semana-label');
    const labelEl2 = $('semana-nav-label');
    const labelTexto = semanaLabel(inicio, dias[dias.length - 1]);
    if (labelEl1) labelEl1.textContent = labelTexto;
    if (labelEl2) labelEl2.textContent = labelTexto;

    const grade = $('grade-agenda');
    if (!grade) return;
    grade.innerHTML = '';

    const hh = document.createElement('div');
    hh.className = 'ga-hora-header';
    grade.appendChild(hh);

    dias.forEach(d => {
        const iso = isoDate(d);
        const div = document.createElement('div');
        div.className = 'ga-dia-header'
            + (iso === hoje ? ' hoje' : '')
            + (iso === S.diaSelecionado ? ' selecionado' : '');
        const imgs   = getImagensAgenda();
        const imgIdx = (d.getDay() + S.semanaOffset * 7 + Math.floor(d.getDate() / 7)) % (imgs.length || 1);
        const imgSrc = imgs.length ? imgs[imgIdx] : '';
        const imgTag = imgSrc ? `<img src="${imgSrc}" class="ga-dia-img" alt="✿" onclick="event.stopPropagation();abrirImagemDia('${imgSrc}')" onerror="this.style.display='none'" title="Clique para ampliar" style="cursor:zoom-in;">` : '✿';
        div.innerHTML = `<div class="ga-dia-nome">${DIAS_ABR[d.getDay()]}</div><div class="ga-dia-num">${d.getDate()}</div>${imgTag}`;
        div.onclick = () => selecionarDia(iso);
        grade.appendChild(div);
    });

    HORAS_CHEIAS.forEach(h => {
        const lbl = document.createElement('div');
        lbl.className = 'ga-hora-label';
        lbl.textContent = horaLabel(h);
        grade.appendChild(lbl);

        dias.forEach(d => {
            const iso = isoDate(d);
            const slotsHora = SUB_OFFSETS.map(offset => {
                const hSlot = offset + h;
                return { hSlot, ag: S.agendamentos.find(a => a.data === iso && parseFloat(a.hora) === hSlot) };
            });
            const ocupados = slotsHora.filter(s => s.ag);

            const cel = document.createElement('div');
            cel.className = 'ga-celula ' + (ocupados.length ? 'agendado' : 'livre');

            if (!ocupados.length) {
                const chipVago = document.createElement('div');
                chipVago.className = 'ga-chip vago';
                chipVago.textContent = 'Vago';
                cel.appendChild(chipVago);
                cel.onclick = () => abrirModalAdd(iso, h);
            } else if (ocupados.length === 1) {
                const { ag, hSlot } = ocupados[0];
                const chip = document.createElement('div');
                chip.className = `ga-chip ${ag.status || 'confirmado'}`;
                const nomeChip = (ag.nome_paciente || ag.paciente || '').split(' ')[0];
                chip.innerHTML = `<span class="ga-chip-nome">${nomeChip}</span><span class="ga-chip-hora">${horaLabel(hSlot)}</span>`;
                chip.title = horaLabel(hSlot);
                cel.appendChild(chip);
                cel.onclick = () => abrirModalDetalhe(ag.id);
            } else {
                const wrap = document.createElement('div');
                wrap.className = 'ga-chip-duplo';
                ocupados.forEach(({ ag, hSlot }) => {
                    const mini = document.createElement('div');
                    mini.className = `ga-chip-mini ${ag.status || 'confirmado'}`;
                    const nomeMini = (ag.nome_paciente || ag.paciente || '').split(' ')[0];
                    mini.innerHTML = `<span class="ga-chip-nome">${nomeMini}</span><span class="ga-chip-hora">${horaLabel(hSlot)}</span>`;
                    mini.title = horaLabel(hSlot);
                    mini.onclick = (e) => { e.stopPropagation(); abrirModalDetalhe(ag.id); };
                    wrap.appendChild(mini);
                });
                cel.appendChild(wrap);
            }

            grade.appendChild(cel);
        });

    });

    S.diaSelecionado = S.diaSelecionado || hoje;
    renderizarListaDia();

    // Espera o layout assentar (header, nav e lista do dia já ocupando seu
    // espaço real) antes de medir quanto sobrou pra grade.
    requestAnimationFrame(ajustarAlturaGradeAgenda);

    // Na primeira abertura, as fotinhos dos pacientes no cabeçalho de cada
    // dia carregam de forma assíncrona e podem aumentar a altura do
    // cabeçalho DEPOIS que a conta acima já rodou — sobrando menos espaço
    // do que o previsto e cortando as últimas horas embaixo (só corrigia
    // ao arrastar a janela, que dispara o ResizeObserver de novo). Reconfere
    // mais algumas vezes logo em seguida pra já abrir certo, sem precisar
    // mexer na janela.
    [80, 250, 600, 1200, 2000, 3200, 5000].forEach(ms => setTimeout(ajustarAlturaGradeAgenda, ms));
}

function selecionarDia(iso) { S.diaSelecionado = iso; renderizarAgenda(); }



function renderizarListaDia() {
    const iso = S.diaSelecionado || isoDate(new Date());
    const d   = new Date(iso + 'T00:00:00');
    const headerEl = $('dia-lista-header');
    if (headerEl) headerEl.textContent = `${DIAS_FULL[d.getDay()]}, ${d.getDate()} de ${MESES_ABR[d.getMonth()]}`;

    const lista  = $('dia-lista');
    if (!lista) return;
    const agsDia = S.agendamentos.filter(a => a.data === iso).sort((a, b) => a.hora - b.hora);
    lista.innerHTML = '';

    if (!agsDia.length) {
        lista.innerHTML = `<div class="lista-vazio"><i class="fa-regular fa-calendar"></i> Nenhuma consulta este dia</div>`;
        return;
    }

    agsDia.forEach(ag => {
        const div  = document.createElement('div');
        div.className = 'ag-item';
        const cod  = ag.codigo_paciente ? `#${String(ag.codigo_paciente).padStart(3,'0')}` : '';
        const nome = ag.nome_paciente || ag.paciente || 'Paciente';
        const st   = ag.status || 'confirmado';
        div.innerHTML = `
            <div class="ag-hora">${horaLabel(ag.hora)}</div>
            <div class="ag-info">
                <div class="ag-nome">${nome}</div>
                ${cod ? `<div class="ag-cod">${cod}</div>` : ''}
            </div>
            <span class="ag-badge ${st}">${rotuloStatusAgendamento(st).label}</span>
        `;
        div.onclick = () => abrirModalDetalhe(ag.id);
        lista.appendChild(div);
    });
}

function semanaAnterior() { S.semanaOffset--; renderizarAgenda(); }
function semanaProxima()  { S.semanaOffset++; renderizarAgenda(); }
function irHoje()         { S.semanaOffset = 0; S.diaSelecionado = isoDate(new Date()); renderizarAgenda(); }

// ══════════════════════════════════════════════════════
// MODAL: IMPRIMIR AGENDA
// ══════════════════════════════════════════════════════

function abrirModalImprimir() {
    const hoje = isoDate(new Date());
    const campoData = $('imp-data');
    const campoMes  = $('imp-mes');
    if (campoData) campoData.value = S.diaSelecionado || hoje;
    if (campoMes) {
        const agora = new Date();
        campoMes.value = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
    }
    selecionarPeriodoImprimir('dia');
    const modal = $('modal-imprimir');
    if (modal) modal.style.display = 'flex';
}

function selecionarPeriodoImprimir(tipo) {
    S.impPeriodo = tipo;
    document.querySelectorAll('#imp-periodo-grupo .toggle-horario-btn').forEach(b => {
        b.classList.toggle('ativo', b.dataset.periodo === tipo);
    });
    const campoDia = $('imp-campo-dia');
    const campoMes = $('imp-campo-mes');
    if (campoDia) campoDia.style.display = tipo === 'dia' ? 'block' : 'none';
    if (campoMes) campoMes.style.display = tipo === 'mes' ? 'block' : 'none';

    const resumo = $('imp-resumo');
    if (!resumo) return;
    if (tipo === 'semana') {
        const inicio = segundaFeiraDaSemana(S.semanaOffset);
        resumo.textContent = `Semana exibida atualmente na agenda: ${semanaLabel(inicio)}`;
    } else {
        resumo.textContent = '';
    }
}

function _formatarDataLongaImp(iso) {
    const d = new Date(iso + 'T00:00:00');
    return `${DIAS_FULL[d.getDay()]}, ${d.getDate()} de ${MESES_ABR[d.getMonth()]} de ${d.getFullYear()}`;
}

function _formatarDataCurtaImp(iso) {
    const d = new Date(iso + 'T00:00:00');
    return `${DIAS_ABR[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function gerarImpressaoAgenda() {
    const tipo = S.impPeriodo || 'dia';
    let lista = [];
    let tituloPeriodo = '';

    if (tipo === 'dia') {
        const iso = $('imp-data')?.value || isoDate(new Date());
        lista = S.agendamentos.filter(a => a.data === iso);
        tituloPeriodo = _formatarDataLongaImp(iso);
    } else if (tipo === 'semana') {
        const inicio = segundaFeiraDaSemana(S.semanaOffset);
        const diasIso = Array.from({ length: 7 }, (_, i) => isoDate(somarDias(inicio, i)));
        lista = S.agendamentos.filter(a => diasIso.includes(a.data));
        tituloPeriodo = `Semana de ${semanaLabel(inicio)}`;
    } else if (tipo === 'mes') {
        const valor = $('imp-mes')?.value;
        if (!valor) { toast('Selecione um mês.'); return; }
        lista = S.agendamentos.filter(a => a.data && a.data.startsWith(valor));
        const [ano, mes] = valor.split('-');
        tituloPeriodo = `${MESES_ABR[parseInt(mes, 10) - 1]} de ${ano}`;
    }

    lista = [...lista].sort((a, b) => {
        if (a.data !== b.data) return a.data < b.data ? -1 : 1;
        return parseFloat(a.hora) - parseFloat(b.hora);
    });

    const mostrarColunaData = tipo !== 'dia';

    const linhas = lista.length
        ? lista.map(ag => {
            const nome    = ag.nome_paciente || ag.paciente || 'Paciente';
            const cod     = ag.codigo_paciente ? `#${String(ag.codigo_paciente).padStart(3, '0')} ` : '';
            const st      = ag.status || 'confirmado';
            const stLabel = rotuloStatusAgendamento(st).label;
            return `<tr>
                ${mostrarColunaData ? `<td>${_formatarDataCurtaImp(ag.data)}</td>` : ''}
                <td>${horaLabel(ag.hora)}</td>
                <td>${cod}${nome}</td>
                <td>${stLabel}</td>
                <td>${ag.obs || ''}</td>
            </tr>`;
        }).join('')
        : `<tr><td colspan="${mostrarColunaData ? 5 : 4}" style="text-align:center;color:#666;">Nenhuma consulta neste período</td></tr>`;

    const cabecalhoCols = (mostrarColunaData ? '<th>Data</th>' : '')
        + '<th>Horário</th><th>Paciente</th><th>Status</th><th>Obs.</th>';

    const agora    = new Date();
    const geradoEm = `${agora.toLocaleDateString('pt-BR')} às ${agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

    const area = $('area-impressao');
    if (!area) return;
    area.innerHTML = `
        <div class="imp-cabecalho">
            <h1>${S.config.nome_clinica || 'Agenda Clínica'}</h1>
            <h2>${tituloPeriodo}</h2>
        </div>
        <table class="imp-tabela">
            <thead><tr>${cabecalhoCols}</tr></thead>
            <tbody>${linhas}</tbody>
        </table>
        <p class="imp-rodape">Gerado em ${geradoEm} — ${lista.length} consulta${lista.length === 1 ? '' : 's'}</p>
    `;

    fecharModal('modal-imprimir');
    area.style.display = 'block';
    setTimeout(() => window.print(), 50);
}

window.addEventListener('afterprint', () => {
    const area = $('area-impressao');
    if (area) area.style.display = 'none';
});

// ══════════════════════════════════════════════════════
// MODAL: DETALHE
// ══════════════════════════════════════════════════════

function abrirModalDetalhe(id) {
    const ag = S.agendamentos.find(a => a.id === id);
    if (!ag) return;
    S.agDetalhe = ag;
    const d    = new Date(ag.data + 'T00:00:00');
    const nome = ag.nome_paciente || ag.paciente || 'Paciente';
    const st   = ag.status || 'confirmado';
    const cod  = ag.codigo_paciente ? `<span class="pac-codigo">#${String(ag.codigo_paciente).padStart(3,'0')}</span>` : '';
    $('modal-detalhe-corpo').innerHTML = `
        <div class="detalhe-row"><span class="dr-label">Paciente</span><span class="dr-val">${cod} ${nome}</span></div>
        <div class="detalhe-row"><span class="dr-label">Data</span><span class="dr-val">${DIAS_FULL[d.getDay()]}, ${d.getDate()} de ${MESES_ABR[d.getMonth()]}</span></div>
        <div class="detalhe-row"><span class="dr-label">Horário</span><span class="dr-val">${horaLabel(ag.hora)} – ${horaLabel(parseFloat(ag.hora)+1)}</span></div>
        <div class="detalhe-row"><span class="dr-label">Status</span><span class="dr-val"><span class="ag-badge ${st}">${rotuloStatusAgendamento(st).emoji} ${rotuloStatusAgendamento(st).label}</span></span></div>
        ${ag.obs ? `<div class="detalhe-row"><span class="dr-label">Obs</span><span class="dr-val">${ag.obs}</span></div>` : ''}
    `;
    const btnPron = $('btn-prontuario');
    if (btnPron) btnPron.style.display = 'none';
    $('modal-detalhe').style.display = 'flex';
}

function abrirModalSubstituir() {
    if (!S.agDetalhe) return;
    const ag = S.agDetalhe;
    const d  = new Date(ag.data + 'T00:00:00');

    const info = $('modal-sub-info');
    if (info) info.textContent = `${DIAS_FULL[d.getDay()]}, ${d.getDate()} de ${MESES_ABR[d.getMonth()]} — ${horaLabel(ag.hora)}`;

    const sel = $('sub-pac-sel');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Selecione —</option>';
    [...S.pacientes]
        .filter(p => String(p.id) !== String(ag.paciente_id))
        .sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR', { sensitivity: 'base' }))
        .forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            const cod = p.codigo ? `#${String(p.codigo).padStart(3,'0')} — ` : '';
            opt.textContent = `${cod}${p.nome}`;
            sel.appendChild(opt);
        });

    fecharModal('modal-detalhe');
    if ($('sub-cobranca-opcao')) $('sub-cobranca-opcao').value = 'transferir';
    $('modal-substituir').style.display = 'flex';

    // Mesmo motivo do abrirModalAdd: força repaint pra lista de pacientes
    // não ficar "presa" em branco depois de fechar o modal de detalhe.
    forcarRepaintElemento($('modal-substituir'));
    window.sistemaLocal?.corrigirRepaint?.();
    window.agendaOnline?.corrigirRepaint?.();
}

// ── Fila que serializa o CICLO COMPLETO das ações de agenda (cancelar,
// substituir, agendar) — não só a etapa de gravação no banco, que já era
// protegida por _filaSyncAgendamentosLocal. Antes, se o usuário disparasse
// várias ações rápido (ex: vários cancelamentos seguidos), cada uma corria
// em paralelo: enquanto uma ainda esperava o IPC de exclusão e o push pro
// GitHub terminarem, outra já podia chegar no seu próprio
// renderizarAgenda() — e como essa função sempre recarrega S.agendamentos
// do ZERO direto do banco, ela podia "trazer de volta" um agendamento que
// a ação anterior já tinha tirado da tela mas ainda não tinha persistido
// por completo. Resultado: parecia que o cancelamento "não pegou" e o
// agendamento voltava sozinho. Encadeando o ciclo inteiro (do clique até o
// renderizarAgenda final) numa fila só, cada ação começa apenas depois que
// a anterior já terminou de verdade — igual ao padrão que já corrigiu o
// bug dos quinzenais na sincronização com o sistema local.
let _filaAcoesAgenda = Promise.resolve();
function _enfileirarAcaoAgenda(executar) {
    const proxima = _filaAcoesAgenda.then(executar, executar);
    // Se uma ação falhar, a fila não pode travar: a próxima tem que rodar.
    _filaAcoesAgenda = proxima.catch(() => {});
    return proxima;
}

// Dispara a substituição, mas serializada na fila de ações da agenda.
// Os dados são capturados AGORA (antes de entrar na fila), não no momento
// em que a fila efetivamente rodar — senão, se o usuário já tiver aberto
// outro modal enquanto esperava a vez, a ação executaria com dados errados.
function confirmarSubstituicao() {
    const ag    = S.agDetalhe;
    const pacId = $('sub-pac-sel')?.value;
    if (!pacId) { toast('Selecione um paciente.'); return; }
    if (!ag)    { toast('Erro: agendamento não encontrado.'); return; }

    const pac = S.pacientes.find(p => String(p.id) === String(pacId));
    if (!pac) { toast('Paciente não encontrado.'); return; }

    const opcaoCobranca = $('sub-cobranca-opcao')?.value || 'transferir';

    return _enfileirarAcaoAgenda(() => _confirmarSubstituicaoInterno(ag, pac, opcaoCobranca));
}

async function _confirmarSubstituicaoInterno(ag, pac, opcaoCobranca) {

    // Se o usuário escolheu TRANSFERIR a cobrança pendente da consulta
    // original pro novo paciente (em vez de cancelá-la e lançar uma nova),
    // isso precisa acontecer ANTES de excluir o agendamento antigo — senão a
    // exclusão dispara a cascata normal de cancelamento (ver db.js:
    // excluirAgendamento → cancelarPagamentoPendenteDoAgendamento) e a
    // cobrança já era antes de poder ser movida. Se opcaoCobranca === 'cancelar',
    // não faz nada aqui: a cobrança do paciente antigo é cancelada normalmente
    // mais abaixo, junto com a exclusão do agendamento antigo.
    // `cobrancaTransferida` só vira true quando a transferência foi mesmo
    // confirmada — o aviso final (toast/log) depende disso. No celular o
    // servidor 3131 é inalcançável, então a transferência não acontece ali:
    // o PC receberá o novo + o antigo cancelado e recriará a cobrança.
    let cobrancaTransferida = false;
    if (opcaoCobranca === 'transferir') {
        try {
            if (window.sistemaLocal && typeof window.sistemaLocal.transferirPagamentoPendente === 'function') {
                const resTransf = await window.sistemaLocal.transferirPagamentoPendente(ag.paciente_id, ag.data, pac.id);
                cobrancaTransferida = (resTransf !== false);
            } else {
                // Agenda Online: mesmo servidor HTTP local (porta 3131) usado pelo
                // cancelamento/exclusão de agendamentos — precisa de uma rota
                // equivalente no main.js (ex: POST /agenda/transferir-cobranca,
                // chamando db.transferirPagamentoPendenteDoAgendamento) pra
                // funcionar quando o desktop está alcançável na mesma rede.
                const respTransf = await fetchServidorLocal('/agenda/transferir-cobranca', {
                    method: 'POST',
                    corpo: { pacienteIdAntigo: ag.paciente_id, data: ag.data, pacienteIdNovo: pac.id }
                });
                const dadosTransf = await respTransf.json().catch(() => ({}));
                cobrancaTransferida = (dadosTransf.transferiu === true);
            }
        } catch (e) {
            console.warn('[Substituição] Falha ao transferir cobrança pendente:', e);
            if (!e.inacessivel) {
                toastErro('⚠️ O computador da clínica não confirmou a transferência da cobrança. Confira em Pagamentos.');
                registrarLogAgenda('falha_sync', pac.nome, `Transferência de cobrança não confirmada pelo computador (${e.status || 'erro'}).`);
            }
        }
    }

    // Novo agendamento no mesmo horário
    const novo = carimbar({
        id:              'ag_' + Date.now(),
        paciente_id:     pac.id,
        nome_paciente:   pac.nome,
        nomePaciente:    pac.nome,
        paciente:        pac.nome,
        codigo_paciente: pac.codigo || null,
        data:            ag.data,
        hora:            ag.hora,
        obs:             ag.obs || '',
        status:          'confirmado',
        // Só quando o usuário escolheu TRANSFERIR a cobrança: avisa o PC de
        // qual agendamento/paciente saiu, para ele mover o pendente ao importar
        // (o celular não alcança a porta 3131). Sem isso o PC cancela a
        // cobrança antiga e gera uma nova com o valor padrão.
        ...(opcaoCobranca === 'transferir'
            ? { substituiAgendamentoId: ag.id, substituiPacienteId: ag.paciente_id }
            : {})
    });
    const antigoCancelado = carimbar({ ...ag, status: 'cancelado' });
    registrarLapide(antigoCancelado);

    // Remove antigo, adiciona novo
    S.agendamentos = S.agendamentos.filter(a => a.id !== ag.id);
    S.agendamentos.push(novo);
    // Sync pontual: só grava o novo e exclui o antigo, sem varrer o resto
    // da agenda (que pode ter centenas de outros registros inalterados).
    // Só tem efeito de verdade quando esta janela É a Agenda Local
    // (window.sistemaLocal) — quando é a Agenda Online, cai no mesmo caso
    // do cancelamento simples e precisa dos reforços abaixo.
    const sincronizouOk = await salvarAgendamentosAcao_ls({ upsert: [novo], excluir: [ag.id] });

    // GitHub/Worker (fila que o desktop consulta a cada 30s, mesmo raciocínio
    // de cancelarAgendamento/marcarNaoRealizada) e o fallback HTTP local são
    // independentes entre si e da gravação acima — cobrem justamente o caso
    // em que esta janela é a Agenda Online, sem window.sistemaLocal: sem eles,
    // o pendente do paciente substituído nunca era cancelado no clinica.db
    // (a mescla via backup do Drive só importa ids novos, nunca atualiza um
    // agendamento que já existia — por isso não basta esperar o Drive aqui).
    const tokenAtivo = S.tokenAtivo || (S.tokens && Object.keys(S.tokens)[0]);
    const tarefasParalelas = [];

    if (tokenAtivo) {
        tarefasParalelas.push(
            _pushAgendamentoGithub(novo, tokenAtivo)
                .catch(e => console.warn('[Substituição] Erro ao notificar GitHub (novo):', e))
        );
        tarefasParalelas.push(
            _pushAgendamentoGithub(antigoCancelado, tokenAtivo)
                .catch(e => console.warn('[Substituição] Erro ao notificar GitHub (cancelado):', e))
        );
    }

    // Fallback HTTP local (porta 3131) — só faz sentido quando NÃO há
    // window.sistemaLocal, isto é, esta janela é a Agenda Online e o desktop
    // pode estar alcançável na mesma rede agora mesmo (ver cancelarAgendamento,
    // que usa exatamente este mesmo servidor pro mesmo fim).
    if (!window.sistemaLocal) {
        tarefasParalelas.push((async () => {
            try {
                // Cria o novo primeiro (gera o pendente do paciente que entrou),
                // só depois exclui o antigo (cancela o pendente de quem saiu) —
                // mesma ordem já usada no caminho window.sistemaLocal acima.
                // Se o POST do novo falhar, o fetchServidorLocal lança e o DELETE
                // do antigo NÃO roda (antes rodava, e a consulta sumia do PC).
                await fetchServidorLocal('/agenda/agendamentos', { method: 'POST', corpo: novo });
                await fetchServidorLocal(`/agenda/agendamentos/${encodeURIComponent(ag.id)}`, { method: 'DELETE' });
            } catch(e) {
                if (e.inacessivel) {
                    // Normal se o desktop não estiver na mesma rede agora — o push
                    // pro Worker acima garante que a atualização chega de qualquer
                    // forma no próximo polling (a cada 30s) quando ele se conectar.
                    console.warn('[Substituição] Servidor local (3131) indisponível:', e);
                    registrarLogAgenda('falha_sync', pac.nome,
                        'Sem comunicação com o computador da clínica (porta 3131) ao substituir paciente — provavelmente fora da mesma rede. Sincroniza pelo Drive/GitHub quando o desktop reabrir.');
                } else {
                    console.error('[Substituição] Computador respondeu com erro:', e);
                    toastErro('⚠️ O computador da clínica NÃO gravou a substituição. Confira a agenda no PC.');
                    registrarLogAgenda('falha_sync', pac.nome,
                        `Computador da clínica respondeu com erro (${e.status || 'erro'}) ao substituir paciente, mesmo após novas tentativas.`);
                }
            }
        })());
    }

    await Promise.all(tarefasParalelas);

    // Garante que o cancelado está em cancelados_pendentes ANTES de tentar o Drive.
    // Se o fetch falhar por falta de internet (token ainda válido mas sem conexão),
    // o cancelado não se perde e será enviado na próxima sincronização.
    const _canceladosSub = lsGet('agenda_cancelados_pendentes', []);
    if (!_canceladosSub.find(c => c.id === ag.id)) {
        lsSet('agenda_cancelados_pendentes', [..._canceladosSub, antigoCancelado]);
        lsSet('agenda_sync_pendente', true);
    }

    fecharModal('modal-substituir');
    const complementoCobranca = opcaoCobranca !== 'transferir'
        ? ' (cobrança original cancelada)'
        : (cobrancaTransferida
            ? ' (cobrança transferida)'
            : ' (cobrança antiga cancelada; o PC gera a nova com o valor padrão — confira em Pagamentos)');
    if (sincronizouOk) toast(`Paciente substituído por ${pac.nome}!${complementoCobranca}`);
    else toastErro('⚠️ Não foi possível gravar no sistema. Tente novamente.');
    registrarLogAgenda('substituido', pac.nome,
        `Substituiu ${ag.nome_paciente || ag.nomePaciente || ag.paciente || 'paciente anterior'} em ${ag.data} ${ag.hora}h${complementoCobranca}.`
        + (sincronizouOk ? '' : ' ⚠️ Falha ao gravar no sistema local.'));
    // Aguarda o render (que recarrega S.agendamentos do banco) terminar de
    // verdade antes de seguir — senão a fila liberaria a próxima ação antes
    // do recarregamento completar, reabrindo a mesma brecha de corrida.
    await renderizarAgenda();

    // Drive fica fora do await que a fila espera: não precisa bloquear a
    // próxima ação, só terminar eventualmente (loga erro se falhar, e o
    // cancelado já está em cancelados_pendentes pra não se perder).
    salvarAlteracoesNoDrive([...S.agendamentos, antigoCancelado])
        .catch(e => {
            console.warn('[Substituição] Falha ao salvar no Drive:', e);
            registrarLogAgenda('falha_drive', pac.nome,
                `Substituição salva localmente, mas falhou ao sincronizar com o Google Drive: ${e?.message || e}`);
        });
}


// ── Token do servidor local (porta 3131) ────────────────────────────
// Protege as rotas /agenda/* — sem ele o servidor recusa a requisição.
// Cada uma das duas janelas do app recebe o mesmo token por um caminho
// diferente (ambos via IPC, nunca por URL nem hardcoded no código): a
// Agenda Local tem window.sistemaLocal (arquivo local, preload próprio);
// a Agenda Online tem window.agendaOnline (página remota, preload
// mais restrito — só entrega o token, não dá acesso direto ao banco).
// Busca uma vez só e guarda em cache pro resto da sessão.
let _tokenServidorAgendaCache = null;
async function obterTokenServidorAgenda() {
    if (_tokenServidorAgendaCache) return _tokenServidorAgendaCache;
    try {
        if (window.sistemaLocal && typeof window.sistemaLocal.obterTokenServidor === 'function') {
            _tokenServidorAgendaCache = await window.sistemaLocal.obterTokenServidor();
        } else if (window.agendaOnline && typeof window.agendaOnline.obterTokenServidor === 'function') {
            _tokenServidorAgendaCache = await window.agendaOnline.obterTokenServidor();
        }
    } catch(e) {
        console.warn('[Agenda] Falha ao obter token do servidor local:', e);
    }
    return _tokenServidorAgendaCache;
}

// Chamada ao servidor local (porta 3131) que CONFERE a resposta.
// Antes, o fetch resolvia com status 401/500 e o código seguia como se tivesse
// gravado. Agora:
//  - servidor inacessível (outra rede, desktop fechado): falha na hora, com
//    err.inacessivel = true (é o caso "normal" — sem retentativa);
//  - servidor respondeu mas NÃO gravou (resp.ok falso): tenta de novo até
//    `tentativas` vezes e, se continuar falhando, lança erro com err.status.
// `corpo` (objeto) vira JSON; omita para DELETE/GET.
async function fetchServidorLocal(caminho, { method = 'GET', corpo = null, tentativas = 3 } = {}) {
    const token = await obterTokenServidorAgenda();
    const headers = {
        ...(corpo !== null ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-Agenda-Token': token } : {})
    };
    let ultimoErro = null;
    for (let i = 1; i <= tentativas; i++) {
        let resp;
        try {
            resp = await fetch('http://127.0.0.1:3131' + caminho, {
                method,
                headers,
                body: corpo !== null ? JSON.stringify(corpo) : undefined
            });
        } catch (e) {
            const err = new Error('Servidor local (3131) inacessível');
            err.inacessivel = true;
            throw err;
        }
        if (resp.ok) return resp;
        ultimoErro = new Error(`Servidor local (3131) respondeu ${resp.status} em ${method} ${caminho}`);
        ultimoErro.status = resp.status;
        console.warn(`[3131] ${method} ${caminho} → ${resp.status} (tentativa ${i}/${tentativas})`);
        if (i < tentativas) await new Promise(r => setTimeout(r, 700 * i));
    }
    throw ultimoErro;
}

// Dispara o cancelamento, mas serializado na fila de ações da agenda —
// mesmo raciocínio de confirmarSubstituicao: captura o agendamento AGORA,
// antes de esperar a vez na fila.
function cancelarAgendamento() {
    if (!S.agDetalhe) return;
    if (!confirm('Cancelar esta consulta?')) return;

    const ag = S.agDetalhe;
    return _enfileirarAcaoAgenda(() => _cancelarAgendamentoInterno(ag));
}

async function _cancelarAgendamentoInterno(ag) {
    // Fase 2: o cancelamento é um registro com carimbo próprio (lápide). É ele
    // que vence qualquer cópia velha deste agendamento em outro aparelho/PC.
    const cancelado = carimbar({ ...ag, status: 'cancelado' });
    registrarLapide(cancelado);

    // GitHub (notifica o desktop) e a exclusão via servidor HTTP local (rota
    // usada só pela Agenda Online, que não tem IPC direto) são independentes
    // entre si — rodam em paralelo em vez de um esperar o outro terminar.
    // A exclusão no SQLite da Agenda Local (quando window.sistemaLocal existe)
    // fica por conta do sync pontual mais abaixo, junto com a atualização de
    // S.agendamentos — evita fazer a mesma chamada IPC duas vezes.
    const tokenAtivo = S.tokenAtivo || (S.tokens && Object.keys(S.tokens)[0]);
    const tarefasParalelas = [];

    if (tokenAtivo) {
        tarefasParalelas.push(
            _pushAgendamentoGithub(cancelado, tokenAtivo)
                .catch(e => console.warn('[Cancelamento] Erro ao notificar GitHub:', e))
        );
    }

    // Agenda Online carrega uma página remota (GitHub Pages) — NÃO expõe IPC
    // direto por segurança (ver preload-agenda-online.js), então usa o
    // servidor HTTP local na porta 3131 que o main.js já disponibiliza pra
    // esse fim exato (rota DELETE /agenda/agendamentos/:id). Só é necessário
    // quando NÃO há window.sistemaLocal (ou seja, esta janela é a Online).
    if (!window.sistemaLocal) {
        tarefasParalelas.push((async () => {
            try {
                await fetchServidorLocal(`/agenda/agendamentos/${encodeURIComponent(ag.id)}`, { method: 'DELETE' });
            } catch(e) {
                if (e.inacessivel) {
                    // Normal se o app desktop não estiver rodando na mesma rede (ex: paciente
                    // acessando de fora) — nesse caso o cancelamento ainda vale localmente
                    // e via GitHub/Drive; só não reflete no clinica.db até o desktop
                    // reabrir a agenda com os dados já sincronizados pelo Drive.
                    console.warn('[Cancelamento] Servidor local (3131) indisponível:', e);
                    registrarLogAgenda('falha_sync', ag.nome_paciente || ag.nomePaciente || ag.paciente,
                        'Sem comunicação com o computador da clínica (porta 3131) ao cancelar — provavelmente fora da mesma rede. Sincroniza pelo Drive quando o desktop reabrir.');
                } else {
                    console.error('[Cancelamento] Computador respondeu com erro:', e);
                    registrarLogAgenda('falha_sync', ag.nome_paciente || ag.nomePaciente || ag.paciente,
                        `Computador da clínica respondeu com erro (${e.status || 'erro'}) ao cancelar, mesmo após novas tentativas.`);
                }
            }
        })());
    }

    await Promise.all(tarefasParalelas);

    // Remove localmente. Sync pontual: só exclui este id no SQLite do
    // sistema (Agenda Local), sem varrer nem regravar o resto da agenda.
    S.agendamentos = S.agendamentos.filter(a => a.id !== ag.id);
    const sincronizouOk = await salvarAgendamentosAcao_ls({ excluir: [ag.id] });
    fecharModal('modal-detalhe');
    if (sincronizouOk) toast('Consulta cancelada.');
    else toastErro('⚠️ Cancelado aqui, mas NÃO foi gravado no sistema do computador. Confira a agenda no PC.');
    registrarLogAgenda('cancelado', ag.nome_paciente || ag.nomePaciente || ag.paciente,
        `Data: ${ag.data} ${ag.hora}h.` + (sincronizouOk ? '' : ' ⚠️ Falha ao gravar no sistema local.'));
    // Aguarda o render (que recarrega S.agendamentos do banco) terminar de
    // verdade antes de seguir — senão a fila liberaria a próxima ação antes
    // do recarregamento completar, reabrindo a mesma brecha de corrida.
    await renderizarAgenda();

    // Drive fica fora do await que a fila espera: não precisa bloquear a
    // próxima ação (cancelamentos em sequência não ficam mais esperando a
    // rede), só terminar eventualmente — loga erro se falhar.
    salvarAlteracoesNoDrive([...S.agendamentos, cancelado])
        .catch(e => {
            console.warn('[Cancelamento] Falha ao salvar no Drive:', e);
            registrarLogAgenda('falha_drive', ag.nome_paciente || ag.nomePaciente || ag.paciente,
                `Cancelamento salvo localmente, mas falhou ao sincronizar com o Google Drive: ${e?.message || e}`);
        });
}

// ── Marcar consulta como "não realizada" (falta do paciente) ────────────
// Diferente de cancelarAgendamento(): NÃO exclui o registro — mantém a
// consulta no histórico (registro de comparecimento), só troca o status.
// O valor pendente gerado automaticamente pra essa consulta (ver
// gerarPagamentoPendenteAoAgendar/cascata em db.salvarAgendamento no lado
// desktop) é cancelado sozinho quando esse status chega lá, casando pelo
// mesmo paciente + mesma data do agendamento.
function marcarNaoRealizada() {
    if (!S.agDetalhe) return;
    const ag  = S.agDetalhe;
    const pac = S.pacientes.find(p => String(p.id) === String(ag.paciente_id));
    const cobraFalta = !!Number(pac?.cobra_falta || 0);
    const aviso = cobraFalta
        ? 'Marcar esta consulta como não realizada (falta)? Como o cadastro deste paciente está configurado para cobrar falta, o valor pendente será MANTIDO em aberto.'
        : 'Marcar esta consulta como não realizada (falta)? O valor pendente gerado pra ela será cancelado automaticamente.';
    if (!confirm(aviso)) return;

    return _enfileirarAcaoAgenda(() => _marcarNaoRealizadaInterno(ag));
}

async function _marcarNaoRealizadaInterno(ag) {
    const atualizado = carimbar({ ...ag, status: 'nao_realizada' });
    S.agendamentos = S.agendamentos.map(a => a.id === ag.id ? atualizado : a);

    // Agenda Online (GitHub Pages) não tem window.sistemaLocal — mesmo caso
    // de _cancelarAgendamentoInterno. Sem este fallback, sincronizarAcaoLocal
    // via IPC simplesmente não existe pra chamar, "resolve true" sem fazer
    // nada, e a consulta fica marcada só localmente (nesta aba) — o
    // clinica.db nunca soube que virou falta, então o pendente gerado pra
    // essa consulta nunca é cancelado. Usa a mesma rota HTTP local (porta
    // 3131) que o cancelamento já usa: POST /agenda/agendamentos regrava o
    // agendamento com o novo status, e db.salvarAgendamento (main.js) já
    // dispara a cascata de cancelar o pendente por lá.
    if (!window.sistemaLocal) {
        try {
            await fetchServidorLocal('/agenda/agendamentos', { method: 'POST', corpo: atualizado });
        } catch (e) {
            if (e.inacessivel) {
                // Normal se o desktop não estiver na mesma rede — a marcação ainda
                // vale localmente e via GitHub/Drive; só não reflete no clinica.db
                // (e portanto não cancela o pendente) até o desktop reabrir a
                // agenda com os dados já sincronizados pelo Drive.
                console.warn('[Não realizada] Servidor local (3131) indisponível:', e);
                registrarLogAgenda('falha_sync', ag.nome_paciente || ag.nomePaciente || ag.paciente,
                    'Sem comunicação com o computador da clínica (porta 3131) ao marcar falta — provavelmente fora da mesma rede. Sincroniza pelo Drive quando o desktop reabrir.');
            } else {
                console.error('[Não realizada] Computador respondeu com erro:', e);
                registrarLogAgenda('falha_sync', ag.nome_paciente || ag.nomePaciente || ag.paciente,
                    `Computador da clínica respondeu com erro (${e.status || 'erro'}) ao marcar falta, mesmo após novas tentativas.`);
            }
        }
    }

    // Sync pontual: só regrava este registro (upsert), sem varrer o resto da agenda.
    const sincronizouOk = await salvarAgendamentosAcao_ls({ upsert: [atualizado] });

    const tokenAtivo = S.tokenAtivo || (S.tokens && Object.keys(S.tokens)[0]);
    if (tokenAtivo) {
        _pushAgendamentoGithub(atualizado, tokenAtivo)
            .catch(e => console.warn('[Não realizada] Erro ao notificar GitHub:', e));
    }

    fecharModal('modal-detalhe');
    if (sincronizouOk) toast('Consulta marcada como não realizada.');
    else toastErro('⚠️ Marcado aqui, mas NÃO foi gravado no sistema do computador. Confira a agenda no PC.');
    registrarLogAgenda('nao_realizada', ag.nome_paciente || ag.nomePaciente || ag.paciente,
        `Data: ${ag.data} ${ag.hora}h.` + (sincronizouOk ? '' : ' ⚠️ Falha ao gravar no sistema local.'));
    await renderizarAgenda();

    salvarAlteracoesNoDrive(S.agendamentos)
        .catch(e => {
            console.warn('[Não realizada] Falha ao salvar no Drive:', e);
            registrarLogAgenda('falha_drive', ag.nome_paciente || ag.nomePaciente || ag.paciente,
                `Marcação de falta salva localmente, mas falhou ao sincronizar com o Google Drive: ${e?.message || e}`);
        });
}

function irProntuario() {}

// Reflow forçado no próprio elemento, além do nudge de janela via IPC —
// cobre o caso de blur()/focus() do processo principal não bastar sozinho.
// void offsetHeight lê o layout, obrigando o navegador a recalcular ali na
// hora em vez de esperar o próximo frame.
function forcarRepaintElemento(el) {
    if (!el) return;
    const anterior = el.style.transform;
    el.style.transform = 'translateZ(0)';
    void el.offsetHeight;
    el.style.transform = anterior;
}

// ══════════════════════════════════════════════════════
// MODAL: ADICIONAR MANUAL
// ══════════════════════════════════════════════════════

function abrirModalAdd(data, hora) {
    const horaBase = Math.floor(parseFloat(hora)); // o quadrado sempre representa a hora cheia
    const d = new Date(data + 'T00:00:00');
    const sel = $('add-pac-sel');
    if (!sel) return;

    // Toda vez que o modal "Novo Agendamento" é aberto do zero, zera o
    // sinalizador de "cadastro de paciente pendente" — evita que um estado
    // esquecido de uma sessão anterior interfira aqui.
    _agendamentoAguardandoNovoPaciente = false;

    sel._data     = data;
    sel._horaBase = horaBase;
    sel._hora     = horaBase; // padrão: hora cheia

    const btnCheia = $('add-hora-cheia-btn');
    const btnMeia  = $('add-hora-meia-btn');
    if (btnCheia && btnMeia) {
        btnCheia.textContent = horaLabel(horaBase);
        btnMeia.textContent  = horaLabel(horaBase + 0.5);
        btnCheia.classList.add('ativo');
        btnMeia.classList.remove('ativo');
    }

    atualizarLabelHorarioAdd(d);

    const obsEl = $('add-obs');
    if (obsEl) obsEl.value = '';

    sel.innerHTML = '<option value="">— Selecione um paciente —</option>';
    [...S.pacientes].sort((a,b) => (a.nome||'').localeCompare(b.nome||'', 'pt-BR', { sensitivity: 'base' })).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        const cod = p.codigo ? `#${String(p.codigo).padStart(3,'0')} — ` : '';
        opt.textContent = `${cod}${p.nome}`;
        sel.appendChild(opt);
    });

    // Reset recorrência
    const recSel = $('add-recorrencia');
    if (recSel) recSel.value = 'nao';
    const recOpts = $('recorrencia-opcoes');
    if (recOpts) recOpts.style.display = 'none';
    const recQtd = $('add-recorr-qtd');
    if (recQtd) {
        recQtd.value = 8;
        recQtd.oninput = function() {
            const label = $('recorr-qtd-label');
            if (label) label.textContent = this.value;
            atualizarPreviewRecorrencia();
        };
    }
    const recLabel = $('recorr-qtd-label');
    if (recLabel) recLabel.textContent = '8';

    $('modal-add').style.display = 'flex';

    // Força um repaint: abrir este modal logo depois de fechar outro
    // (ex.: cancelar → remarcar) às vezes deixa o <select> de pacientes
    // "em branco" na tela até minimizar/maximizar a janela na mão.
    forcarRepaintElemento($('modal-add'));
    window.sistemaLocal?.corrigirRepaint?.();
    window.agendaOnline?.corrigirRepaint?.();
}

// Alterna entre hora cheia (offset 0) e meia hora (offset 0.5) dentro do modal de agendar
function selecionarSubHorarioAdd(offset) {
    const sel = $('add-pac-sel');
    if (!sel || sel._horaBase === undefined) return;
    sel._hora = sel._horaBase + offset;

    const btnCheia = $('add-hora-cheia-btn');
    const btnMeia  = $('add-hora-meia-btn');
    if (btnCheia) btnCheia.classList.toggle('ativo', offset === 0);
    if (btnMeia)  btnMeia.classList.toggle('ativo', offset === 0.5);

    atualizarLabelHorarioAdd(new Date(sel._data + 'T00:00:00'));
}

function atualizarLabelHorarioAdd(d) {
    const sel = $('add-pac-sel');
    const horarioEl = $('modal-add-horario');
    if (!horarioEl || !sel) return;
    horarioEl.innerHTML = `<i class="fa-solid fa-calendar-day"></i> ${DIAS_FULL[d.getDay()]}, ${d.getDate()} de ${MESES_ABR[d.getMonth()]} — ${horaLabel(sel._hora)}`;
}

// Dispara o agendamento, mas serializado na fila de ações da agenda — os
// dados do formulário são lidos AGORA (o modal fecha logo depois de
// enfileirar), não quando a fila efetivamente chegar a vez desta ação.
function salvarAgendamentoManual() {
    const sel   = $('add-pac-sel');
    const pacId = sel.value;
    if (!pacId) { toast('Selecione um paciente.'); return; }
    const pac  = S.pacientes.find(p => String(p.id) === String(pacId));
    const data = sel._data;
    const hora = sel._hora;
    const obs  = ($('add-obs')?.value || '').trim();
    const recorrencia = $('add-recorrencia')?.value || 'nao';
    const qtd = recorrencia !== 'nao' ? parseInt($('add-recorr-qtd')?.value || 1) : 1;

    // Aviso de ciclo só faz sentido pra um agendamento avulso — se a psicóloga
    // já está gerando uma série (semanal/quinzenal/mensal) aqui no modal, a
    // série em si já respeita o intervalo escolhido.
    if (recorrencia === 'nao') {
        const avisoCiclo = checarCicloRecorrencia(pac, data);
        if (avisoCiclo && !confirm(avisoCiclo)) return;
    }

    return _enfileirarAcaoAgenda(() => _salvarAgendamentoManualInterno(pac, pacId, data, hora, obs, recorrencia, qtd));
}

async function _salvarAgendamentoManualInterno(pac, pacId, data, hora, obs, recorrencia, qtd) {
    // Gera lista de datas conforme recorrência
    const datas = gerarDatasRecorrencia(data, recorrencia, qtd);

    const grupoid = recorrencia !== 'nao' ? ('grp_' + Date.now()) : null;
    const novos = datas.map((dt, i) => carimbar({
        id:              'ag_' + Date.now() + '_' + i,
        paciente_id:     pacId,
        nome_paciente:   pac.nome,
        codigo_paciente: pac.codigo || null,
        data:            dt,
        hora, obs,
        status:          'confirmado',
        ...(grupoid ? { grupo_recorrencia: grupoid, sessao_num: i + 1, total_sessoes: datas.length } : {})
    }));

    S.agendamentos.push(...novos);
    // Sync pontual: grava só os agendamentos novos (1 ou vários, se for uma
    // série recorrente), sem regravar o resto da agenda.
    const sincronizouOk = await salvarAgendamentosAcao_ls({ upsert: novos });
    fecharModal('modal-add');

    if (!sincronizouOk) {
        toastErro('⚠️ Não foi possível gravar no sistema. Tente agendar novamente.');
    } else if (novos.length === 1) {
        toast(`Consulta de ${pac.nome} agendada!`);
    } else {
        toast(`${novos.length} sessões de ${pac.nome} agendadas!`);
    }
    registrarLogAgenda('agendado', pac.nome,
        (novos.length === 1
            ? `Data: ${novos[0].data} ${novos[0].hora}h.`
            : `${novos.length} sessões (recorrência ${recorrencia}), a partir de ${novos[0].data}.`)
        + (sincronizouOk ? '' : ' ⚠️ Falha ao gravar no sistema local.'));

    // Aguarda o render (que recarrega S.agendamentos do banco) terminar de
    // verdade antes de seguir — senão a fila liberaria a próxima ação antes
    // do recarregamento completar, reabrindo a mesma brecha de corrida.
    await renderizarAgenda();

    // Drive fica fora do await que a fila espera — não bloqueia a próxima ação.
    salvarAlteracoesNoDrive().catch(e => {
        console.warn('[Agendamento] Falha ao salvar no Drive:', e);
        registrarLogAgenda('falha_drive', pac.nome,
            `Agendamento salvo localmente, mas falhou ao sincronizar com o Google Drive: ${e?.message || e}`);
    });
}

// ══════════════════════════════════════════════════════
// CONTROLE DE RECORRÊNCIA — aviso de "fora do ciclo"
// (mesma lógica usada na Agenda Local, adaptada pro S.agendamentos)
// ══════════════════════════════════════════════════════
const REC_INTERVALO_DIAS  = { semanal: 7, quinzenal: 14, mensal: 30 };
const REC_LABEL_FREQ      = { semanal: 'semanal', quinzenal: 'quinzenal', mensal: 'mensal' };
const REC_TOLERANCIA_DIAS = 3; // folga p/ reagendamentos (feriados, imprevistos, etc.)

function _recFormatarDataBR(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('pt-BR');
}

// Verifica se `dataEscolhida` respeita o ciclo do paciente, comparando com
// o agendamento existente mais próximo dele (exceto os do próprio grupo,
// quando já se está gerando uma série de recorrência).
// Retorna null se não há o que checar, ou uma mensagem de aviso.
function checarCicloRecorrencia(pac, dataEscolhida) {
    if (!pac || !pac.frequencia) return null;
    const intervalo = REC_INTERVALO_DIAS[pac.frequencia];
    if (!intervalo) return null;

    const outrosAg = (S.agendamentos || []).filter(a =>
        String(a.paciente_id) === String(pac.id) &&
        (a.status || 'confirmado') !== 'cancelado'
    );
    if (!outrosAg.length) return null; // sem histórico ainda, nada a comparar

    const alvo = new Date(dataEscolhida + 'T12:00:00');
    let maisProximo = null, menorDiff = Infinity;
    outrosAg.forEach(a => {
        const d = new Date(a.data + 'T12:00:00');
        const diff = Math.abs(Math.round((alvo - d) / 86400000));
        if (diff < menorDiff) { menorDiff = diff; maisProximo = a; }
    });
    if (!maisProximo || menorDiff === 0) return null; // mesma data já existente, sem o que avisar

    const anchor = new Date(maisProximo.data + 'T12:00:00');
    const diffDias = Math.round((alvo - anchor) / 86400000);
    const resto = ((diffDias % intervalo) + intervalo) % intervalo;
    const foraDoCiclo = resto > REC_TOLERANCIA_DIAS && resto < (intervalo - REC_TOLERANCIA_DIAS);
    if (!foraDoCiclo) return null;

    return `${pac.nome} é paciente ${REC_LABEL_FREQ[pac.frequencia]} (a cada ${intervalo} dias). `
         + `O agendamento mais próximo dele é em ${_recFormatarDataBR(maisProximo.data)}, `
         + `e a data escolhida (${_recFormatarDataBR(dataEscolhida)}) está fora desse ciclo. `
         + `Deseja agendar mesmo assim?`;
}

// ── Gera array de datas ISO conforme tipo de recorrência ──
function gerarDatasRecorrencia(dataInicio, tipo, quantidade) {
    const datas = [];
    const [ano, mes, dia] = dataInicio.split('-').map(Number);
    for (let i = 0; i < quantidade; i++) {
        let d = new Date(ano, mes - 1, dia);
        if (tipo === 'semanal')    d = new Date(ano, mes - 1, dia + i * 7);
        else if (tipo === 'quinzenal') d = new Date(ano, mes - 1, dia + i * 14);
        else if (tipo === 'mensal')    d = new Date(ano, mes - 1 + i, dia);
        else d = new Date(ano, mes - 1, dia); // nao = só a original
        datas.push(isoDate(d));
        if (tipo === 'nao') break;
    }
    return datas;
}

// ── Mostra/oculta opções de recorrência e atualiza preview ──
function toggleRecorrenciaOpcoes() {
    const tipo = $('add-recorrencia')?.value;
    const wrap = $('recorrencia-opcoes');
    if (!wrap) return;
    wrap.style.display = tipo === 'nao' ? 'none' : 'block';
    atualizarPreviewRecorrencia();
}

function atualizarPreviewRecorrencia() {
    const sel  = $('add-pac-sel');
    const tipo = $('add-recorrencia')?.value;
    const qtd  = parseInt($('add-recorr-qtd')?.value || 1);
    const prev = $('recorr-preview');
    if (!prev || !sel) return;
    if (tipo === 'nao') { prev.innerHTML = ''; return; }

    const data = sel._data;
    if (!data) { prev.innerHTML = ''; return; }
    const datas = gerarDatasRecorrencia(data, tipo, qtd);
    const linhas = datas.slice(0, 5).map((dt, i) => {
        const d = new Date(dt + 'T00:00:00');
        return `<span style="display:block;">📅 Sessão ${i+1} — ${DIAS_FULL[d.getDay()]}, ${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}</span>`;
    });
    if (datas.length > 5) linhas.push(`<span style="color:#c4506d;font-weight:600;">+ ${datas.length - 5} mais...</span>`);
    prev.innerHTML = linhas.join('');
}

// ══════════════════════════════════════════════════════
// MODAL: GERAR LINK
// ══════════════════════════════════════════════════════

function abrirModalGerarLink() {
    S.slotStates = {};
    const lrEl = $('ml-link-resultado');
    if (lrEl) lrEl.style.display = 'none';
    const piEl = $('ml-pac-info');
    if (piEl) piEl.style.display = 'none';
    const obsEl = $('ml-obs');
    if (obsEl) obsEl.value = '';

    const sel = $('ml-paciente');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Selecione —</option>';
    [...S.pacientes].sort((a,b) => (a.nome||'').localeCompare(b.nome||'', 'pt-BR', { sensitivity: 'base' })).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        const cod = p.codigo ? `#${String(p.codigo).padStart(3,'0')} — ` : '';
        opt.textContent = `${cod}${p.nome}`;
        sel.appendChild(opt);
    });

    const selSem = $('ml-semana');
    if (selSem) {
        selSem.innerHTML = '';
        for (let i = 0; i <= 3; i++) {
            const ini = segundaFeiraDaSemana(S.semanaOffset + i);
            const opt = document.createElement('option');
            opt.value = isoDate(ini);
            opt.textContent = semanaLabel(ini);
            selSem.appendChild(opt);
        }
    }

    renderizarGradeModal();
    $('modal-link').style.display = 'flex';
}

function onModalPacienteChange() {
    const pacId = $('ml-paciente').value;
    const info  = $('ml-pac-info');
    const pac   = S.pacientes.find(p => String(p.id) === String(pacId));
    if (!pac || !info) { if(info) info.style.display = 'none'; return; }
    const cod = pac.codigo ? `<span class="pac-codigo">#${String(pac.codigo).padStart(3,'0')}</span>` : '';
    info.style.display = 'flex';
    info.innerHTML = `
        ${cod}
        <span class="pac-info-nome">${pac.nome}</span>
        ${pac.telefone ? `<span class="pac-info-tel"><i class="fa-solid fa-phone"></i> ${pac.telefone}</span>` : ''}
    `;
}

// Dia (iso) atualmente sendo editado no modal "Gerar Link". Em vez de
// mostrar a semana inteira numa grade só, o psicólogo escolhe o dia (pill)
// e marca só os horários daquele dia — mesmo padrão visual/interação do
// modal "Novo Agendamento". Os estados continuam em S.slotStates, com a
// mesma chave `${iso}_${hora}` de sempre, então gerarLink() não muda.
let mlDiaAtual = null;

function renderizarGradeModal() {
    S.slotStates = {};
    mlDiaAtual   = null;
    const selSem = $('ml-semana');
    if (!selSem) return;
    const isoInicio = selSem.value;
    const inicio    = new Date(isoInicio + 'T00:00:00');
    const dias      = Array.from({length: 7}, (_, i) => somarDias(inicio, i));

    // Popula S.slotStates com 'neutro' pra cada horário livre da semana —
    // assim o "ponto" de resumo em cada dia funciona mesmo sem abrir o dia.
    dias.forEach(d => {
        const iso = isoDate(d);
        HORAS_CHEIAS.forEach(h => SUB_OFFSETS.forEach(offset => {
            const hSlot   = h + offset;
            const chave   = `${iso}_${hSlot}`;
            const ocupado = S.agendamentos.some(a => a.data === iso && parseFloat(a.hora) === hSlot);
            if (!ocupado) S.slotStates[chave] = 'neutro';
        }));
    });

    mlDiaAtual = isoDate(dias[0]);
    renderizarMlDias(dias);
    renderizarMlHoras(dias);
}

// Resumo de um dia (pra colorir o "ponto" na pill do dia): disponível,
// indisponível, misto (tem os dois) ou neutro (nada marcado ainda).
function resumoDia(iso) {
    let temDisp = false, temIndisp = false;
    HORAS_CHEIAS.forEach(h => SUB_OFFSETS.forEach(offset => {
        const estado = S.slotStates[`${iso}_${h + offset}`];
        if (estado === 'disponivel')   temDisp   = true;
        if (estado === 'indisponivel') temIndisp = true;
    }));
    if (temDisp && temIndisp) return 'misto';
    if (temDisp)              return 'disponivel';
    if (temIndisp)             return 'indisponivel';
    return 'neutro';
}

function renderizarMlDias(dias) {
    const grupo = $('ml-dias-grupo');
    if (!grupo) return;
    grupo.innerHTML = '';

    dias.forEach(d => {
        const iso    = isoDate(d);
        const resumo = resumoDia(iso);
        const btn    = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toggle-horario-btn dia-pill' + (iso === mlDiaAtual ? ' ativo' : '');
        btn.innerHTML = `${DIAS_ABR[d.getDay()]}<br>${d.getDate()}/${d.getMonth() + 1}` +
            (resumo !== 'neutro' ? `<i class="dia-dot dia-dot-${resumo}"></i>` : '');
        btn.onclick = () => {
            mlDiaAtual = iso;
            renderizarMlDias(dias);
            renderizarMlHoras(dias);
        };
        grupo.appendChild(btn);
    });
}

function renderizarMlHoras(dias) {
    const grupo = $('ml-horas-grupo');
    if (!grupo || !mlDiaAtual) return;
    grupo.innerHTML = '';

    const iso = mlDiaAtual;
    HORAS_CHEIAS.forEach(h => SUB_OFFSETS.forEach(offset => {
        const hSlot   = h + offset;
        const chave   = `${iso}_${hSlot}`;
        const ocupado = S.agendamentos.some(a => a.data === iso && parseFloat(a.hora) === hSlot);
        const btn     = document.createElement('button');
        btn.type = 'button';

        if (ocupado) {
            btn.className = 'toggle-horario-btn bloqueado';
            btn.textContent = horaLabel(hSlot);
            btn.disabled = true;
        } else {
            const atual = S.slotStates[chave] || 'neutro';
            btn.className = 'toggle-horario-btn' +
                (atual === 'disponivel' ? ' ativo' : atual === 'indisponivel' ? ' indisponivel' : '');
            btn.textContent = (atual === 'disponivel' ? '✓ ' : atual === 'indisponivel' ? '✕ ' : '') + horaLabel(hSlot);
            btn.onclick = () => {
                const estados = ['neutro', 'disponivel', 'indisponivel'];
                S.slotStates[chave] = estados[(estados.indexOf(atual) + 1) % 3];
                renderizarMlHoras(dias);
                renderizarMlDias(dias); // atualiza o pontinho de resumo do dia
            };
        }
        grupo.appendChild(btn);
    }));
}

async function gerarLink() {
    const pacId = $('ml-paciente').value;
    if (!pacId) { toast('Selecione um paciente.'); return; }
    const pac = S.pacientes.find(p => String(p.id) === String(pacId));

    const slots = [], bloqueados = [];
    Object.entries(S.slotStates).forEach(([chave, estado]) => {
        const [data, hora] = chave.split('_');
        if (estado === 'disponivel')   slots.push({ data, hora: parseFloat(hora) });
        if (estado === 'indisponivel') bloqueados.push({ data, hora: parseFloat(hora) });
    });
    if (!slots.length) { toast('Marque ao menos um horário disponível (✓).'); return; }

    const token = 'tk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const dadosToken = {
        pacienteId:   pac.id,
        nomePaciente: pac.nome,
        slots,
        bloqueados,
        obs:          ($('ml-obs')?.value || '').trim(),
        criadoEm:     new Date().toISOString(),
        usado:        false
    };

    const tokens = carregarTokens_ls();
    tokens[token] = dadosToken;
    salvarTokens_ls(tokens);

    // Publica no Worker via ponte IPC (só existe se esta janela for a
    // Agenda Online do Electron, com preload-agenda-online.js). A chave
    // X-Client-Key nunca chega aqui — quem publica é o main.js. Se a ponte
    // não existir (ex.: aberto direto num navegador comum), o token ainda
    // sobe pro Drive normalmente e é publicado depois, no próximo sync do
    // desktop (ver republicarTokensPendentes em main.js).
    if (window.agendaOnline?.publicarToken) {
        try {
            const resultado = await window.agendaOnline.publicarToken(token, dadosToken);
            if (!resultado?.ok) console.warn('[Agenda] Worker não confirmou a publicação do token — deve ser republicado no próximo sync.');
        } catch (e) {
            console.warn('[Agenda] Falha ao publicar token via IPC:', e);
        }
    }

    if (!CLIENTE_ID) {
        console.warn('[Agenda] clienteId não configurado ainda — o link vai funcionar só localmente até o próximo sync com o Drive.');
    }
    const link = `${window.location.origin}${window.location.pathname}?t=${token}` +
        (CLIENTE_ID ? `&c=${encodeURIComponent(CLIENTE_ID)}` : '');
    S.linkGerado = { link, pac };

    const lv = $('ml-link-valor');
    if (lv) {
        lv.value = link;
        let linkEl = $('ml-link-ancora');
        if (!linkEl) {
            linkEl = document.createElement('a');
            linkEl.id = 'ml-link-ancora';
            linkEl.target = '_blank';
            linkEl.style.cssText = 'display:block;word-break:break-all;color:var(--accent2);font-size:.8rem;margin-top:.5rem;text-decoration:underline;cursor:pointer;';
            const lr2 = $('ml-link-resultado');
            if (lr2) lr2.appendChild(linkEl);
        }
        linkEl.href = link;
        linkEl.textContent = link;
    }

    const lr = $('ml-link-resultado');
    if (lr) lr.style.display = 'flex';
    toast('Link gerado!');
    await salvarAlteracoesNoDrive();
}

function copiarLink() {
    const inp = $('ml-link-valor');
    if (!inp) return;
    const texto = inp.value;
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(texto).then(() => toast('Link copiado!'));
        return;
    }
    inp.select();
    inp.setSelectionRange(0, 99999);
    try { document.execCommand('copy'); toast('Link copiado!'); }
    catch(e) { toast('Selecione e copie manualmente (Ctrl+C)'); }
}

// ── Endereço de acesso da agenda (para abrir no celular) ──
function preencherUrlAgenda() {
    const span = $('header-url-texto');
    if (!span) return;
    // Remove protocolo e barra final só para exibição — mais curto e fácil de digitar
    const endereco = (window.location.origin + window.location.pathname)
        .replace(/^https?:\/\//, '')
        .replace(/\/index\.html$/, '/')
        .replace(/\/+$/, '/');
    span.textContent = endereco;
}

function copiarUrlAgenda() {
    const texto = window.location.origin + window.location.pathname.replace(/index\.html$/, '');
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(texto).then(() => toast('📋 Endereço copiado! Cole no navegador do celular.'));
        return;
    }
    const tmp = document.createElement('input');
    tmp.value = texto;
    document.body.appendChild(tmp);
    tmp.select();
    tmp.setSelectionRange(0, 99999);
    try { document.execCommand('copy'); toast('📋 Endereço copiado! Cole no navegador do celular.'); }
    catch(e) { toast('Copie manualmente: ' + texto, 4000); }
    document.body.removeChild(tmp);
}

// ══════════════════════════════════════════════════════
// MODAL: LINKS FIXOS
// ══════════════════════════════════════════════════════

async function abrirModalFixos() {
    const corpo = $('modal-fixos-corpo');
    if (!corpo) return;
    $('modal-fixos').style.display = 'flex';
    corpo.innerHTML = '<p style="color:var(--text2);padding:1rem;">Gerando links...</p>';

    const inicio   = segundaFeiraDaSemana(S.semanaOffset);
    const pacFixos = S.pacientes.filter(p => p.horario_fixo);

    if (!pacFixos.length) {
        corpo.innerHTML = '<p style="color:var(--text2);padding:1rem;text-align:center;">Nenhum paciente com horário fixo cadastrado.</p>';
        return;
    }

    corpo.innerHTML = '';
    const tokens = carregarTokens_ls();

    pacFixos.forEach(p => {
        const hf       = typeof p.horario_fixo === 'string' ? JSON.parse(p.horario_fixo) : p.horario_fixo;
        const diaOffset = (hf.diaSemana - inicio.getDay() + 7) % 7;
        const dataFixa  = somarDias(inicio, diaOffset);
        const iso       = isoDate(dataFixa);

        const token = 'tk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        tokens[token] = {
            pacienteId:   p.id,
            nomePaciente: p.nome,
            slots:        [{ data: iso, hora: hf.hora }],
            bloqueados:   [],
            horarioFixo:  true,
            criadoEm:     new Date().toISOString(),
            usado:        false
        };
        const link = `${window.location.origin}${window.location.pathname}?t=${token}`;

        const div = document.createElement('div');
        div.className = 'fixo-item';
        div.innerHTML = `
            <div class="fixo-item-info">
                <div class="fixo-item-nome">${p.nome}</div>
                <div class="fixo-item-horario">${DIAS_FULL[hf.diaSemana]}, ${dataFixa.getDate()} de ${MESES_ABR[dataFixa.getMonth()]} — ${horaLabel(hf.hora)}</div>
            </div>
            <a class="fixo-item-link" href="https://wa.me/${(p.telefone||'').replace(/\D/g,'')}?text=${encodeURIComponent(`Olá, ${p.nome}! Confirme sua consulta:\n\n${link}`)}" target="_blank">
                <i class="fa-brands fa-whatsapp"></i> Enviar
            </a>
        `;
        corpo.appendChild(div);
    });

    salvarTokens_ls(tokens);
    await salvarAlteracoesNoDrive();
}

// ══════════════════════════════════════════════════════
// PACIENTES
// ══════════════════════════════════════════════════════

async function abrirTelaPacientes() {
    await carregarPacientes_ls();
    renderizarListaPacientes();
    irTela('tela-pacientes');
}

function renderizarListaPacientes(filtro = '') {
    const lista = $('lista-pacientes');
    if (!lista) return;
    lista.innerHTML = '';
    const arr = S.pacientes.filter(p =>
        (p.nome||'').toLowerCase().includes(filtro.toLowerCase()) ||
        String(p.codigo||'').includes(filtro)
    ).sort((a,b) => (a.nome||'').localeCompare(b.nome||'', 'pt-BR', { sensitivity: 'base' }));

    if (!arr.length) {
        lista.innerHTML = `<div class="lista-vazio"><i class="fa-solid fa-users-slash"></i> Nenhum paciente encontrado</div>`;
        return;
    }
    arr.forEach(p => {
        const hf  = p.horario_fixo ? (typeof p.horario_fixo === 'string' ? JSON.parse(p.horario_fixo) : p.horario_fixo) : null;
        const cod = p.codigo ? `#${String(p.codigo).padStart(3,'0')}` : '';
        const div = document.createElement('div');
        div.className = 'pac-item';
        div.innerHTML = `
            <div class="pac-avatar">${(p.nome||'?')[0].toUpperCase()}</div>
            <div class="pac-item-info">
                <div class="pac-item-nome">${p.nome}</div>
                <div class="pac-item-sub" style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.25rem;">
                    ${cod ? `<span class="pac-codigo-tag">${cod}</span>` : ''}
                    ${p.telefone ? `<span style="font-size:.75rem;color:var(--text2);">${p.telefone}</span>` : ''}
                    ${hf ? `<span class="pac-fixo-tag"><i class="fa-solid fa-rotate"></i> Fixo ${DIAS_ABR[hf.diaSemana]} ${horaLabel(hf.hora)}</span>` : ''}
                </div>
            </div>
            <button onclick="editarPaciente('${p.id}')" style="background:none;border:none;color:var(--text2);cursor:pointer;padding:.5rem;"><i class="fa-solid fa-pen"></i></button>
        `;
        lista.appendChild(div);
    });
}

function filtrarPacientes() { renderizarListaPacientes($('busca-pac')?.value || ''); }

// Sinalizador: true quando o modal "Novo Paciente" foi aberto a partir do
// botão "+" dentro do modal "Novo Agendamento" (fluxo 100% mouse, sem
// depender do microfone). Quando true, salvarPaciente() sabe que precisa
// devolver o paciente recém-criado pro seletor do agendamento, em vez de
// só fechar e voltar pra lista de pacientes.
let _agendamentoAguardandoNovoPaciente = false;

// ── Botão "+" ao lado do seletor de paciente, dentro do modal "Novo
//    Agendamento" — abre o cadastro de paciente por cima, sem fechar o
//    agendamento que já estava sendo preenchido (data/hora ficam guardadas
//    no próprio <select>, em sel._data/_horaBase/_hora). ──
function abrirNovoPacienteViaAgendamento() {
    _agendamentoAguardandoNovoPaciente = true;
    abrirModalPaciente();
}

// Recria as <option> do seletor de paciente do modal "Novo Agendamento",
// preservando a data/hora já escolhidas no slot, e deixa o paciente
// indicado (normalmente o que acabou de ser cadastrado) já selecionado.
function repovoarSelectAddPaciente(selecionarId) {
    const sel = $('add-pac-sel');
    if (!sel) return;
    const dataSalva     = sel._data;
    const horaBaseSalva = sel._horaBase;
    const horaSalva      = sel._hora;

    sel.innerHTML = '<option value="">— Selecione um paciente —</option>';
    [...S.pacientes].sort((a,b) => (a.nome||'').localeCompare(b.nome||'', 'pt-BR', { sensitivity: 'base' })).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        const cod = p.codigo ? `#${String(p.codigo).padStart(3,'0')} — ` : '';
        opt.textContent = `${cod}${p.nome}`;
        sel.appendChild(opt);
    });

    sel._data     = dataSalva;
    sel._horaBase = horaBaseSalva;
    sel._hora     = horaSalva;
    if (selecionarId) sel.value = String(selecionarId);
}

function abrirModalPaciente(p = null) {
    if ($('pac-edit-id'))    $('pac-edit-id').value    = p?.id || '';
    if ($('pac-nome'))       $('pac-nome').value       = p?.nome || '';
    if ($('pac-tel'))        $('pac-tel').value        = p?.telefone || '';
    if ($('pac-email'))      $('pac-email').value      = p?.email || '';
    if ($('pac-valor-consulta')) $('pac-valor-consulta').value = p?.valor_consulta ? Number(p.valor_consulta) : '';
    if ($('pac-cobra-falta'))    $('pac-cobra-falta').checked  = !!Number(p?.cobra_falta || 0);
    const hf = p?.horario_fixo ? (typeof p.horario_fixo === 'string' ? JSON.parse(p.horario_fixo) : p.horario_fixo) : null;
    if ($('pac-fixo-check')) $('pac-fixo-check').checked = !!hf;
    toggleHorarioFixo();
    if (hf) {
        if ($('pac-fixo-dia'))  $('pac-fixo-dia').value  = hf.diaSemana;
        if ($('pac-fixo-hora')) $('pac-fixo-hora').value = hf.hora;
    }
    if ($('pac-frequencia')) $('pac-frequencia').value = p?.frequencia || '';
    const titulo = $('modal-pac-titulo');
    if (titulo) titulo.innerHTML = p
        ? `<i class="fa-solid fa-user-pen"></i> Editar Paciente`
        : `<i class="fa-solid fa-user-plus"></i> Novo Paciente`;
    $('modal-pac').style.display = 'flex';
}

function editarPaciente(id) {
    const p = S.pacientes.find(p => String(p.id) === String(id));
    if (p) abrirModalPaciente(p);
}

function toggleHorarioFixo() {
    const fixoOpts = $('fixo-opcoes');
    const check    = $('pac-fixo-check');
    if (fixoOpts && check) fixoOpts.style.display = check.checked ? 'grid' : 'none';
}

async function salvarPaciente() {
    // Se o usuário chegou aqui pelo botão "+" do modal "Novo Agendamento",
    // guarda essa informação numa variável local antes de mais nada — o
    // sinalizador global é zerado logo abaixo, assim que for consumido.
    const vindoDoAgendamento = _agendamentoAguardandoNovoPaciente;

    const nome = ($('pac-nome')?.value || '').trim();
    if (!nome) { toast('Informe o nome do paciente.'); return; }
    const hf = $('pac-fixo-check')?.checked
        ? { diaSemana: parseInt($('pac-fixo-dia').value), hora: parseFloat($('pac-fixo-hora').value) }
        : null;
    const editId = $('pac-edit-id')?.value;
    const dados = {
        id:           editId || Date.now(),
        nome,
        telefone:     ($('pac-tel')?.value || '').trim(),
        email:        ($('pac-email')?.value || '').trim(),
        valor_consulta: parseFloat((($('pac-valor-consulta')?.value || '0')).toString().replace(',', '.')) || 0,
        cobra_falta:  $('pac-cobra-falta')?.checked ? 1 : 0,
        horario_fixo: hf,
        frequencia:   $('pac-frequencia')?.value || '',
        codigo:       editId
            ? (S.pacientes.find(p => String(p.id) === editId)?.codigo || S.pacientes.length + 1)
            : (S.pacientes.length + 1)
    };

    // Agenda Local: grava direto no SQLite do sistema via IPC — é a MESMA
    // base que a tela "Cadastro de Pacientes" lê, então o paciente aparece
    // lá na hora, sem depender do vaivém pelo Google Drive (esse vaivém
    // continua existindo, mas serve só pra sincronizar a Agenda Online
    // rodando fora do Electron, ex: no celular).
    let salvouDireto = false;
    if (window.sistemaLocal && typeof window.sistemaLocal.salvarPaciente === 'function') {
        try {
            const idReal = await window.sistemaLocal.salvarPaciente(dados);
            // O SQLite pode normalizar o id (ex: string -> number) — usa o
            // id real do banco daqui pra frente, tanto na lista local quanto
            // na seleção do agendamento.
            if (idReal != null) dados.id = idReal;
            salvouDireto = true;
        } catch (e) {
            console.warn('[Paciente] Falha ao salvar direto no SQLite local — mantém só a fila do Drive:', e);
        }
    }

    if (editId) {
        const idx = S.pacientes.findIndex(p => String(p.id) === editId);
        if (idx >= 0) S.pacientes[idx] = dados;
        else S.pacientes.push(dados);
    } else {
        S.pacientes.push(dados);
        if (!salvouDireto) {
            // Sem acesso direto ao SQLite (Agenda Online/celular, sem
            // window.sistemaLocal): entra na fila de pendentes pra subir
            // pro Drive no próximo salvarAlteracoesNoDrive() — o desktop já
            // sabe importar pacientes novos vindos do celular
            // (verificarAtualizacoesDrive).
            const pendentes = lsGet('agenda_pacientes_pendentes', []);
            pendentes.push(dados);
            lsSet('agenda_pacientes_pendentes', pendentes);
        }
    }

    salvarPacientes_ls();
    fecharModal('modal-pac');
    renderizarListaPacientes($('busca-pac')?.value || '');

    if (vindoDoAgendamento && !editId) {
        // Cadastro feito pelo botão "+" do modal de agendamento: zera o
        // sinalizador, repovoa o seletor (a data/hora do slot continuam
        // guardadas em add-pac-sel._data/_horaBase/_hora) e já deixa o
        // paciente recém-criado selecionado — o modal "Novo Agendamento"
        // nunca chegou a fechar, então o usuário só precisa terminar de
        // preencher e clicar em "Agendar".
        _agendamentoAguardandoNovoPaciente = false;
        repovoarSelectAddPaciente(dados.id);
        toast(`Paciente "${dados.nome}" cadastrado e selecionado. Agora é só clicar em "Agendar".`, 4000);
    } else {
        toast(`Paciente ${editId ? 'atualizado' : 'cadastrado'}!`);
    }

    await salvarAlteracoesNoDrive();
}

// ══════════════════════════════════════════════════════
// CONFIGURAÇÕES — Tailscale removido
// ══════════════════════════════════════════════════════

// Injeta os toggles "Ocultar sábado" e "Ocultar domingo" (independentes)
// na tela de Configurações via JS (em vez de editar o index.html na
// mão) — assim funciona tanto na Agenda Online quanto na Agenda Local,
// já que as duas carregam o mesmo index.html/app.js. Roda toda vez que a
// tela de config é aberta, mas só insere os elementos uma vez (checa se
// já existem antes).
function injetarToggleOcultarFDS() {
    if ($('cfg-ocultar-sab') && $('cfg-ocultar-dom')) {
        $('cfg-ocultar-sab').checked = !!S.config.ocultar_sab;
        $('cfg-ocultar-dom').checked = !!S.config.ocultar_dom;
        return;
    }
    const anchor = $('cfg-tel') || $('cfg-nome-clinica') || $('cfg-pin');
    if (!anchor) return;
    const anchorGroup = anchor.closest('.field-group') || anchor.parentElement;
    if (!anchorGroup || !anchorGroup.parentElement) return;

    const row = document.createElement('div');
    row.className = 'toggle-row';
    row.style.margin = '.9rem 0';
    row.innerHTML = `
        <div style="display:flex;align-items:center;gap:.4rem;">
            <input type="checkbox" id="cfg-ocultar-sab">
            <label for="cfg-ocultar-sab" style="cursor:pointer;">Ocultar sábado na agenda</label>
        </div>
        <div style="display:flex;align-items:center;gap:.4rem;margin-top:.5rem;">
            <input type="checkbox" id="cfg-ocultar-dom">
            <label for="cfg-ocultar-dom" style="cursor:pointer;">Ocultar domingo na agenda</label>
        </div>
    `;
    anchorGroup.parentElement.insertBefore(row, anchorGroup.nextSibling);

    const aplicarMudanca = (chave, ativo, nomeDia) => {
        S.config[chave] = ativo;
        salvarConfig_ls();
        aplicarOcultarFDS();
        if ($('grade-agenda')) renderizarAgenda();
        salvarAlteracoesNoDrive();
        toast(ativo ? `${nomeDia} ocultado.` : `${nomeDia} visível novamente.`);
    };

    $('cfg-ocultar-sab').checked = !!S.config.ocultar_sab;
    $('cfg-ocultar-sab').addEventListener('change', (e) => aplicarMudanca('ocultar_sab', e.target.checked, 'Sábado'));

    $('cfg-ocultar-dom').checked = !!S.config.ocultar_dom;
    $('cfg-ocultar-dom').addEventListener('change', (e) => aplicarMudanca('ocultar_dom', e.target.checked, 'Domingo'));
}

// Redimensiona/comprime uma imagem enviada pelo usuário antes de guardar
// como base64 (localStorage + payload do Drive têm limite de tamanho, e
// fotos de celular costumam vir grandes demais sem isso).
function _comprimirImagemParaAgenda(file, maxLado = 900, qualidade = 0.75) {
    return new Promise((resolve, reject) => {
        const leitor = new FileReader();
        leitor.onerror = () => reject(new Error('Falha ao ler o arquivo.'));
        leitor.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('Arquivo não é uma imagem válida.'));
            img.onload = () => {
                let { width, height } = img;
                if (width > maxLado || height > maxLado) {
                    const escala = maxLado / Math.max(width, height);
                    width  = Math.round(width  * escala);
                    height = Math.round(height * escala);
                }
                const canvas = document.createElement('canvas');
                canvas.width = width; canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', qualidade));
            };
            img.src = leitor.result;
        };
        leitor.readAsDataURL(file);
    });
}

// ══════════════════════════════════════════════════════
// CENTRAL DE IMAGENS — duas galerias independentes: fotos da Agenda
// e fotos da Tela de Descanso. Cada uma tem seu próprio upload e sua
// própria lista; nenhuma foto é compartilhada entre as duas.
// ══════════════════════════════════════════════════════

function abrirModalCentralImagens() {
    renderizarCentralImagens();
    const modal = $('modal-central-imagens');
    if (modal) modal.style.display = 'flex';
}

// Atualiza tudo que o modal da Central de Imagens mostra: os controles da
// tela de descanso (com os valores salvos) e as duas galerias (agenda e
// descanso), cada uma com sua própria lista de fotos.
function renderizarCentralImagens() {
    const td = S.config.tela_descanso || { ativo: false, apos_inatividade: true, minutos: 30, forcar_padrao: false };
    if ($('td-ativo'))            $('td-ativo').checked = !!td.ativo;
    if ($('td-apos-inatividade')) $('td-apos-inatividade').checked = !!td.apos_inatividade;
    if ($('td-minutos'))          $('td-minutos').value = String(td.minutos || 30);
    if ($('td-opcoes-wrap'))      $('td-opcoes-wrap').style.opacity = td.ativo ? '1' : '.45';

    injetarToggleForcarPadraoDescanso();
    renderizarGaleria('descanso');
    renderizarGaleria('agenda');
    atualizarResumoCentralImagens();
}

// Injeta (uma única vez) o checkbox "Usar sempre as ilustrações padrão do
// Pequeno Príncipe" logo acima da grade de miniaturas da galeria da Tela
// de Descanso. Quando marcado, getImagensDescanso() ignora completamente
// as fotos enviadas — mesmo que existam — e sempre usa as 13 ilustrações
// padrão. Injeção via JS pelo mesmo motivo do toggle de sábado/domingo:
// funciona sem precisar editar o HTML do modal na mão.
function injetarToggleForcarPadraoDescanso() {
    const wrap = $('ci-galeria-descanso-wrap');
    if (!wrap || !wrap.parentElement) return;

    if (!$('td-forcar-padrao')) {
        const row = document.createElement('div');
        row.className = 'toggle-row';
        row.style.margin = '.2rem 0 .9rem';
        row.innerHTML = `
            <input type="checkbox" id="td-forcar-padrao">
            <label for="td-forcar-padrao" style="cursor:pointer;">Usar sempre as ilustrações padrão do Pequeno Príncipe</label>
        `;
        wrap.parentElement.insertBefore(row, wrap);
        $('td-forcar-padrao').addEventListener('change', async (e) => {
            await salvarConfigTelaDescanso();
            renderizarGaleria('descanso');
            toast(e.target.checked
                ? 'Tela de descanso vai usar sempre as ilustrações padrão.'
                : 'Tela de descanso voltou a usar as fotos enviadas (se houver).');
        });
    }

    const td = S.config.tela_descanso || {};
    $('td-forcar-padrao').checked = !!td.forcar_padrao;
}

// Desenha a grade de miniaturas de uma galeria (tipo = 'agenda' | 'descanso'),
// cada uma com um botão de remoção direto no canto — sem tags, sem escolha
// de "onde usar": a lista em si já define isso.
function renderizarGaleria(tipo) {
    const wrap = $(tipo === 'agenda' ? 'ci-galeria-agenda-wrap' : 'ci-galeria-descanso-wrap');
    if (!wrap) return;
    const chave = tipo === 'agenda' ? 'imagens_agenda' : 'imagens_descanso';
    const lista = Array.isArray(S.config[chave]) ? S.config[chave] : [];

    if (tipo === 'descanso' && S.config.tela_descanso && S.config.tela_descanso.forcar_padrao) {
        wrap.innerHTML = `<p class="ci-thumb-vazio">Ilustrações padrão do Pequeno Príncipe forçadas — mesmo que existam fotos enviadas, elas não serão exibidas na tela de descanso enquanto essa opção estiver marcada.</p>`;
        return;
    }

    if (!lista.length) {
        wrap.innerHTML = `<p class="ci-thumb-vazio">Nenhuma foto enviada ainda — as ilustrações padrão do Pequeno Príncipe estão em uso.</p>`;
        return;
    }

    wrap.innerHTML = lista.map(img => `
        <div class="ci-thumb">
            <img src="${img.src}">
            <button class="ci-thumb-del" title="Remover" onclick="removerImagemGaleria('${tipo}','${img.id}')">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>`).join('');
}

function atualizarResumoCentralImagens() {
    const el = $('cfg-central-imagens-resumo');
    if (!el) return;
    const nAgenda   = Array.isArray(S.config.imagens_agenda)   ? S.config.imagens_agenda.length   : 0;
    const nDescanso = Array.isArray(S.config.imagens_descanso) ? S.config.imagens_descanso.length : 0;
    if (!nAgenda && !nDescanso) { el.textContent = 'Usando as ilustrações padrão do Pequeno Príncipe.'; return; }
    el.textContent = `${nAgenda} foto${nAgenda === 1 ? '' : 's'} na agenda, ${nDescanso} na tela de descanso.`;
}

// Upload de fotos pra uma galeria específica (tipo = 'agenda' | 'descanso').
async function adicionarImagensGaleria(tipo, files) {
    if (!files || !files.length) return;
    const chave = tipo === 'agenda' ? 'imagens_agenda' : 'imagens_descanso';
    if (!Array.isArray(S.config[chave])) S.config[chave] = [];
    let falhas = 0;
    for (const file of files) {
        try {
            const dataUrl = await _comprimirImagemParaAgenda(file);
            S.config[chave].push({ id: _gerarIdImagem(), src: dataUrl });
        } catch (e) {
            falhas++;
        }
    }
    salvarConfig_ls();
    renderizarCentralImagens();
    if (tipo === 'agenda' && $('grade-agenda')) renderizarAgenda();
    await salvarAlteracoesNoDrive();
    toast(falhas ? `Fotos adicionadas (${falhas} falharam).` : 'Fotos adicionadas!');
}

async function removerImagemGaleria(tipo, id) {
    const chave = tipo === 'agenda' ? 'imagens_agenda' : 'imagens_descanso';
    if (!Array.isArray(S.config[chave])) return;
    S.config[chave] = S.config[chave].filter(img => img.id !== id);
    salvarConfig_ls();
    renderizarCentralImagens();
    if (tipo === 'agenda' && $('grade-agenda')) renderizarAgenda();
    await salvarAlteracoesNoDrive();
    toast('Foto removida.');
}

async function restaurarGaleriaPadrao(tipo) {
    const chave = tipo === 'agenda' ? 'imagens_agenda' : 'imagens_descanso';
    S.config[chave] = [];
    salvarConfig_ls();
    renderizarCentralImagens();
    if (tipo === 'agenda' && $('grade-agenda')) renderizarAgenda();
    await salvarAlteracoesNoDrive();
    toast('Voltou pras ilustrações padrão.');
}

// Salva os controles da Tela de Descanso (ativar / após inatividade /
// minutos) sempre que o usuário mexe em algum deles no modal, e
// reconfigura o monitor de inatividade na hora com o novo valor.
async function salvarConfigTelaDescanso() {
    if (!S.config.tela_descanso) S.config.tela_descanso = { ativo: false, apos_inatividade: true, minutos: 30, forcar_padrao: false };
    S.config.tela_descanso.ativo            = !!$('td-ativo')?.checked;
    S.config.tela_descanso.apos_inatividade = !!$('td-apos-inatividade')?.checked;
    S.config.tela_descanso.minutos          = parseInt($('td-minutos')?.value, 10) || 30;
    S.config.tela_descanso.forcar_padrao    = !!$('td-forcar-padrao')?.checked;
    if ($('td-opcoes-wrap')) $('td-opcoes-wrap').style.opacity = S.config.tela_descanso.ativo ? '1' : '.45';
    salvarConfig_ls();
    configurarMonitorInatividade();
    await salvarAlteracoesNoDrive();
}

// ── Monitor de inatividade + exibição da tela de descanso ──────────────

let _idleTimer = null;
let _idleListenersAtivos = false;

function _telasComScreensaverPermitido() {
    // Só entra em tela de descanso nas telas "internas" (admin) — nunca
    // sobre a tela de login ou a página pública de agendamento do paciente.
    return ['tela-agenda', 'tela-pacientes', 'tela-menu', 'tela-config'];
}

function _telaAtualId() {
    const el = Array.from(document.querySelectorAll('.tela')).find(t => t.style.display !== 'none');
    return el ? el.id : null;
}

// Liga/desliga os listeners de atividade do usuário conforme a config
// atual. Chamada no boot do app e sempre que a config da tela de descanso
// muda (salvarConfigTelaDescanso).
function configurarMonitorInatividade() {
    const td = S.config.tela_descanso || {};
    const deveMonitorar = !!td.ativo && !!td.apos_inatividade;

    if (deveMonitorar && !_idleListenersAtivos) {
        ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(ev =>
            document.addEventListener(ev, _resetIdleTimer, { passive: true }));
        _idleListenersAtivos = true;
    }
    if (!deveMonitorar && _idleListenersAtivos) {
        ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(ev =>
            document.removeEventListener(ev, _resetIdleTimer));
        _idleListenersAtivos = false;
        clearTimeout(_idleTimer);
    }
    if (deveMonitorar) _resetIdleTimer();
}

function _resetIdleTimer() {
    clearTimeout(_idleTimer);
    const overlay = $('tela-descanso-overlay');
    if (overlay && overlay.style.display !== 'none') return; // já em descanso, quem tira é o próprio overlay
    const td = S.config.tela_descanso || {};
    if (!td.ativo || !td.apos_inatividade) return;
    const ms = Math.max(1, td.minutos || 30) * 60 * 1000;
    _idleTimer = setTimeout(() => {
        if (_telasComScreensaverPermitido().includes(_telaAtualId())) {
            ativarTelaDescanso();
        } else {
            _resetIdleTimer(); // não é uma tela onde faz sentido — tenta de novo mais tarde
        }
    }, ms);
}

// Monta o collage aleatório das fotos e exibe o overlay em tela cheia.
// Chamada tanto pelo monitor de inatividade quanto pelo botão
// "Visualizar agora" no modal da Central de Imagens.
function ativarTelaDescanso() {
    const overlay = $('tela-descanso-overlay');
    if (!overlay) return;
    const embaralhar = window.shuffleImgs || (arr => {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    });
    const imgs = embaralhar(typeof getImagensDescanso === 'function' ? getImagensDescanso() : []);
    if (!imgs.length) return;

    overlay.innerHTML = imgs.slice(0, 10).map((src, i) => {
        const largura = 16 + Math.random() * 14; // vw
        const top     = Math.random() * 78;      // vh
        const left    = Math.random() * 82;      // vw
        const girar   = (Math.random() * 10 - 5).toFixed(1);
        const atraso  = (Math.random() * 1.2).toFixed(2);
        return `<img class="tdo-foto" src="${src}" style="
            width:${largura.toFixed(1)}vw;
            top:${top.toFixed(1)}vh;
            left:${left.toFixed(1)}vw;
            transform:rotate(${girar}deg);
            animation-delay:${atraso}s, ${atraso}s;
        ">`;
    }).join('') + `<div class="tdo-dica">Toque em qualquer lugar para voltar</div>`;

    overlay.style.display = 'block';
    overlay.addEventListener('click', desativarTelaDescanso, { once: true });
    document.addEventListener('keydown', desativarTelaDescanso, { once: true });
}

function desativarTelaDescanso() {
    const overlay = $('tela-descanso-overlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    overlay.innerHTML = '';
    _resetIdleTimer();
}

// Botão "Visualizar agora" no modal — mostra a tela de descanso na hora,
// independente de estar ativada ou não, pra o usuário conferir o efeito.
function visualizarTelaDescansoAgora() {
    fecharModal('modal-central-imagens');
    setTimeout(ativarTelaDescanso, 200);
}

function salvarConfig() {
    const pin = ($('cfg-pin')?.value || '').trim();
    if (pin) {
        if (pin.length !== 4 || !/^\d{4}$/.test(pin)) { toast('PIN deve ter 4 dígitos.'); return; }
        S.config.admin_pin = pin;
        S.adminPin = pin;
    }
    S.config.nome_clinica = ($('cfg-nome-clinica')?.value || '').trim() || 'Agenda Clínica';
    S.config.tel_medico   = ($('cfg-tel')?.value || '').trim();
    S.telMedico = S.config.tel_medico;
    // Preserva o e-mail do responsável (usado na licença e no backup)
    const emailInput = $('cfg-email');
    if (emailInput && emailInput.value.trim()) {
        S.config.email_responsavel = emailInput.value.trim().toLowerCase();
    }
    salvarConfig_ls();
    if ($('menu-clinica-nome')) $('menu-clinica-nome').textContent = S.config.nome_clinica;
    toast('Configurações salvas!');
    salvarAlteracoesNoDrive();
}

// ── TEMA ──────────────────────────────────────────────────
function aplicarTemaAgenda(tema) {
    // Remove antes para forçar re-aplicação (fix iOS Safari)
    document.documentElement.removeAttribute('data-tema');
    document.body.removeAttribute('data-tema');
    requestAnimationFrame(function() {
        document.documentElement.setAttribute('data-tema', tema);
        document.body.setAttribute('data-tema', tema);
        // Força repaint em mobile
        document.body.style.display = 'none';
        void document.body.offsetHeight;
        document.body.style.display = '';
    });
    localStorage.setItem('tema_agenda', tema);
    const btn = document.getElementById('btn-alternar-tema-agenda');
    if (btn) {
        if (tema === 'azul') {
            btn.title = 'Mudar para tema Verde';
            btn.style.color = '#2563ab';
        } else if (tema === 'verde') {
            btn.title = 'Mudar para tema Rosa';
            btn.style.color = '#22a05a';
        } else {
            btn.title = 'Mudar para tema Azul';
            btn.style.color = '#e87fa0';
        }
    }
}

function alternarTemaAgenda() {
    const atual = localStorage.getItem('tema_agenda') || 'rosa';
    const proximo = atual === 'rosa' ? 'azul' : atual === 'azul' ? 'verde' : 'rosa';
    aplicarTemaAgenda(proximo);
}

// Aplica tema salvo ao carregar
(function() {
    const temaSalvo = localStorage.getItem('tema_agenda') || 'rosa';
    aplicarTemaAgenda(temaSalvo);
})();

// ══════════════════════════════════════════════════════
// TELA PACIENTE (link público de agendamento)
// ══════════════════════════════════════════════════════

let pacToken  = null;
let pacConfig = null;
let pacSlot   = null;
const DIAS_PT = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];

async function iniciarTelaPaciente() {
    const params = new URLSearchParams(location.search);
    const t      = params.get('t');
    if (!t) return;

    // Paciente pode abrir o link num navegador novo, sem nenhum dado local —
    // por isso o clienteId vem embutido no próprio link (&c=), nunca de
    // config salva. Se por algum motivo faltar, mantém o que já houver em
    // localStorage (ex.: link antigo gerado antes desta mudança).
    const c = params.get('c');
    if (c) CLIENTE_ID = c;

    pacToken = t;
    irTela('tela-paciente');

    // 1. Tenta buscar o token direto do GitHub (funciona sem autenticação)
    let cfg = await _buscarTokenGithub(t);

    // 2. Fallback: tenta pelo Drive se a psicóloga estiver autenticada
    if (!cfg && tokenValido()) {
        await baixarBackupDrive(true);
        const tokens = carregarTokens_ls();
        cfg = tokens[t] || null;
    }

    // 3. Fallback: localStorage local (caso já tenha sido baixado antes)
    if (!cfg) {
        const tokens = carregarTokens_ls();
        cfg = tokens[t] || null;
    }

    if (!cfg) { renderizarPacErro('Link inválido ou expirado.'); return; }
    if (cfg.usado) { renderizarPacErro('Este link já foi utilizado.'); return; }

    pacConfig = cfg;
    const subtituloEl = $('pac-subtitulo');
    if (subtituloEl) subtituloEl.textContent = `Olá, ${cfg.nomePaciente}! Confirme seu horário.`;
    renderizarPacGrade();
}

// Identifica esta instalação/cliente no KV do Worker.
// Cada clínica que comprar o sistema recebe um CLIENTE_ID único —
// isso é o que isola os dados de um cliente dos dados de outro.
// NÃO é mais fixo: no lado da psicóloga vem do backup baixado do Drive
// (banco.clienteId, gravado em 'agenda_cliente_id'); no lado do paciente
// (link aberto num navegador novo, sem nenhum dado local) vem direto da
// URL via '&c=', lido em iniciarTelaPaciente().
let CLIENTE_ID = lsGet('agenda_cliente_id', null);

// Busca o token via Worker/KV (público, sem autenticação — apenas leitura)
async function _buscarTokenGithub(token) {
    try {
        const url = `${URL_PROXY_AGENDA}/token?clienteId=${encodeURIComponent(CLIENTE_ID)}&token=${encodeURIComponent(token)}`;
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return await resp.json();
    } catch(e) {
        return null;
    }
}

// Data atualmente em exibição na tela do paciente (quando há mais de uma
// data com horários). Guardada fora da função pra sobreviver a re-renders.
let pacDataAtual = null;

function renderizarPacGrade() {
    const corpo = $('pac-corpo');
    if (!corpo) return;

    if (pacConfig.horarioFixo && pacConfig.slots.length === 1) {
        pacSlot = pacConfig.slots[0];
        renderizarPacConfirmacao();
        return;
    }

    const slots      = pacConfig.slots || [];
    const bloqueados = pacConfig.bloqueados || [];
    const datas      = [...new Set([...slots, ...bloqueados].map(s => s.data))].sort();

    if (!datas.length) { renderizarPacErro('Nenhum horário disponível no momento.'); return; }

    // Mantém a data já escolhida, se ainda existir; senão cai na primeira
    // data que ainda tem horário livre (evita abrir num dia todo bloqueado).
    if (!pacDataAtual || !datas.includes(pacDataAtual)) {
        pacDataAtual = datas.find(iso => slots.some(s => s.data === iso)) || datas[0];
    }

    // Mesmo padrão visual do modal "Novo Agendamento": badge no topo +
    // field-group com pills (.toggle-horario-btn), em vez da gradezinha antiga.
    corpo.innerHTML = `
      <p class="horario-badge" id="pac-badge">
        <i class="fa-solid fa-calendar-day"></i> <span id="pac-badge-txt">Escolha o dia e o horário</span>
      </p>
      ${datas.length > 1 ? `
      <div class="field-group">
        <label>Data</label>
        <div class="toggle-horario-grupo pac-multi" id="pac-datas-grupo"></div>
      </div>` : ''}
      <div class="field-group">
        <label>Horário</label>
        <div class="toggle-horario-grupo pac-multi" id="pac-horas-grupo"></div>
      </div>
    `;

    if (datas.length > 1) renderizarPacDatas(datas);
    renderizarPacHoras();
}

function renderizarPacDatas(datas) {
    const grupo = $('pac-datas-grupo');
    if (!grupo) return;
    grupo.innerHTML = '';

    datas.forEach(iso => {
        const d   = new Date(iso + 'T00:00:00');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toggle-horario-btn' + (iso === pacDataAtual ? ' ativo' : '');
        btn.innerHTML = `${DIAS_ABR[d.getDay()]}<br>${d.getDate()}/${d.getMonth() + 1}`;
        btn.onclick = () => {
            pacDataAtual = iso;
            grupo.querySelectorAll('.toggle-horario-btn').forEach(b => b.classList.remove('ativo'));
            btn.classList.add('ativo');
            renderizarPacHoras();
        };
        grupo.appendChild(btn);
    });
}

function renderizarPacHoras() {
    const grupo = $('pac-horas-grupo');
    if (!grupo) return;
    grupo.innerHTML = '';

    const slots      = pacConfig.slots || [];
    const bloqueados = pacConfig.bloqueados || [];

    const horasDia = [...new Set([
        ...slots.filter(s => s.data === pacDataAtual).map(s => s.hora),
        ...bloqueados.filter(s => s.data === pacDataAtual).map(s => s.hora)
    ])].sort((a, b) => a - b);

    horasDia.forEach(h => {
        const isBloq  = bloqueados.some(s => s.data === pacDataAtual && s.hora === h);
        const isAtiva = pacSlot && pacSlot.data === pacDataAtual && pacSlot.hora === h;
        const btn     = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toggle-horario-btn' + (isBloq ? ' bloqueado' : '') + (isAtiva ? ' ativo' : '');
        btn.textContent = horaLabel(h);
        btn.disabled = isBloq;
        if (!isBloq) {
            btn.onclick = () => {
                grupo.querySelectorAll('.toggle-horario-btn').forEach(b => b.classList.remove('ativo'));
                btn.classList.add('ativo');
                pacSlot = { data: pacDataAtual, hora: h };
                atualizarPacBadge();
                renderizarPacConfirmacao();
            };
        }
        grupo.appendChild(btn);
    });

    atualizarPacBadge();
}

function atualizarPacBadge() {
    const txt = $('pac-badge-txt');
    if (!txt || !pacDataAtual) return;
    const d       = new Date(pacDataAtual + 'T00:00:00');
    const dataFmt = `${DIAS_PT[d.getDay()]}, ${d.getDate()} de ${MESES_ABR[d.getMonth()]}`;
    txt.textContent = (pacSlot && pacSlot.data === pacDataAtual)
        ? `${dataFmt} — ${horaLabel(pacSlot.hora)}`
        : dataFmt;
}

function renderizarPacConfirmacao() {
    const corpo = $('pac-corpo');
    if (!corpo) return;
    const d    = new Date(pacSlot.data + 'T00:00:00');
    const data = `${DIAS_PT[d.getDay()]}, ${d.getDate()} de ${MESES_ABR[d.getMonth()]}`;
    corpo.innerHTML = `
        <div class="pac-confirmacao">
            <i class="fa-solid fa-calendar-check" style="font-size:2.5rem;color:var(--rose-dark);display:block;margin-bottom:1rem;"></i>
            <h3>Confirmar consulta?</h3>
            <p>Você está confirmando:</p>
            <p class="horario-badge" style="justify-content:center;margin:.75rem 0;">
                <i class="fa-solid fa-calendar-day"></i> ${data} — ${horaLabel(pacSlot.hora)}
            </p>
            <div class="pac-btns">
                <button class="btn-sec" onclick="renderizarPacGrade()">Voltar</button>
                <button class="btn-pri" onclick="confirmarConsulta()">
                    <i class="fa-solid fa-check"></i> Confirmar
                </button>
            </div>
        </div>
    `;
}

async function confirmarConsulta() {
    if (!pacToken || !pacSlot) { renderizarPacErro('Nenhum horário selecionado.'); return; }

    await carregarAgendamentos_ls();

    const jaOcupado = S.agendamentos.some(
        a => a.data === pacSlot.data && parseFloat(a.hora) === parseFloat(pacSlot.hora)
    );
    if (jaOcupado) {
        registrarLogAgenda('falha_sync', pacConfig?.nomePaciente,
            `Paciente tentou agendar ${pacSlot.data} ${pacSlot.hora}h via link, mas o horário já estava ocupado.`);
        renderizarPacErro('Este horário acabou de ser reservado por outra pessoa. Por favor, escolha outro.');
        return;
    }

    const novo = carimbar({
        id:            'ag_' + Date.now(),
        paciente_id:   pacConfig.pacienteId,
        nome_paciente: pacConfig.nomePaciente,
        nomePaciente:  pacConfig.nomePaciente,
        paciente:      pacConfig.nomePaciente,
        data:          pacSlot.data,
        hora:          pacSlot.hora,
        obs:           pacConfig.obs || '',
        status:        'confirmado'
    });

    S.agendamentos.push(novo);
    salvarAgendamentos_ls();

    // Marca token como usado
    const tokens = carregarTokens_ls();
    if (tokens[pacToken]) {
        tokens[pacToken].usado    = true;
        tokens[pacToken].usadoEm  = new Date().toISOString();
        tokens[pacToken].slotEscolhido = pacSlot;
        salvarTokens_ls(tokens);
    }

    try {
        await salvarAlteracoesNoDrive();
        registrarLogAgenda('agendado', pacConfig.nomePaciente,
            `Agendado pelo próprio paciente via link — ${pacSlot.data} ${pacSlot.hora}h.`);
    } catch (e) {
        console.warn('[Portal paciente] Falha ao salvar no Drive:', e);
        registrarLogAgenda('falha_drive', pacConfig.nomePaciente,
            `Paciente agendou via link (${pacSlot.data} ${pacSlot.hora}h), mas falhou ao sincronizar com o Google Drive: ${e?.message || e}`);
    }

    const corpo = $('pac-corpo');
    if (corpo) corpo.innerHTML = `
        <div class="pac-sucesso" style="text-align:center;padding:2rem 1rem;">
            <i class="fa-solid fa-circle-check" style="font-size:3.5rem;color:var(--success);display:block;margin-bottom:1rem;"></i>
            <h2>Consulta Confirmada!</h2>
            <p style="color:var(--text2);font-size:0.95rem;margin-bottom:1.5rem;">Seu horário foi reservado com sucesso.</p>
            <div style="background:var(--bg2);padding:1rem;border-radius:8px;text-align:left;border:1px solid var(--border);">
                <div><strong>Nome:</strong> ${pacConfig.nomePaciente}</div>
                <div><strong>Data:</strong> ${pacSlot.data.split('-').reverse().join('/')}</div>
                <div><strong>Horário:</strong> ${horaLabel(pacSlot.hora)}</div>
            </div>
        </div>
    `;
}

function renderizarPacErro(msg) {
    const corpo = $('pac-corpo');
    if (corpo) corpo.innerHTML = `
        <div class="pac-erro">
            <i class="fa-solid fa-circle-exclamation" style="font-size:2.5rem;color:var(--danger);display:block;margin-bottom:1rem;"></i>
            <h2>Ops!</h2>
            <p>${msg || 'Ocorreu um erro. Tente novamente ou entre em contato com a clínica.'}</p>
        </div>
    `;
}

// ══════════════════════════════════════════════════════
// PWA — instalar ícone
// ══════════════════════════════════════════════════════

let _pwaPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _pwaPrompt = e;
});

function _detectarAmbiente() {
    const ua = navigator.userAgent;
    const isIOS     = /iPhone|iPad|iPod/i.test(ua);
    const isSafari  = isIOS && /Safari/i.test(ua) && !/CriOS|FxiOS/i.test(ua);
    const isAndroid = /Android/i.test(ua);
    const isChrome  = /Chrome/i.test(ua) && !/Edg|OPR/i.test(ua);
    const isEdge    = /Edg/i.test(ua);
    const isMobile  = isIOS || isAndroid;
    const jaInstalado = window.matchMedia('(display-mode: standalone)').matches
                     || window.navigator.standalone === true;
    return { isIOS, isSafari, isAndroid, isChrome, isEdge, isMobile, jaInstalado };
}

function verificarInstalacaoPWA() {
    const { jaInstalado } = _detectarAmbiente();
    if (jaInstalado) return;
    const jaRespondeu = lsGet('pwa_respondeu', false);
    if (jaRespondeu) return;
    setTimeout(() => mostrarBannerInstalar(), 2000);
}

function mostrarBannerInstalar() {
    if (document.getElementById('pwa-install-overlay')) return;
    const { isSafari, isIOS, isMobile } = _detectarAmbiente();
    let instrucao = '';
    if (isSafari && isIOS) {
        instrucao = `
            <div class="pwa-instrucao-ios">
                <p>No Safari, toque em <strong><i class="fa-solid fa-arrow-up-from-bracket"></i> Compartilhar</strong> na barra inferior e depois em <strong>"Adicionar à Tela de Início"</strong>.</p>
            </div>`;
    }
    const overlay = document.createElement('div');
    overlay.id = 'pwa-install-overlay';
    overlay.className = 'pwa-install-overlay';
    overlay.innerHTML = `
        <div class="pwa-install-card">
            <div class="pwa-icon"><i class="fa-solid fa-stethoscope"></i></div>
            <h3>Instalar Agenda Clínica</h3>
            <p>Deseja adicionar um ícone na ${isMobile ? 'tela inicial do celular' : 'área de trabalho do computador'} para abrir o app com um clique?</p>
            ${instrucao}
            <div class="pwa-install-btns">
                <button class="btn-pri" onclick="confirmarInstalarPWA()">
                    <i class="fa-solid fa-download"></i> Sim, instalar
                </button>
                <button class="btn-sec" onclick="recusarInstalarPWA()">Agora não</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
}

async function confirmarInstalarPWA() {
    const overlay = document.getElementById('pwa-install-overlay');
    if (overlay) overlay.remove();
    lsSet('pwa_respondeu', true);
    const { isSafari, isIOS } = _detectarAmbiente();

    if (_pwaPrompt) {
        _pwaPrompt.prompt();
        const { outcome } = await _pwaPrompt.userChoice;
        toast(outcome === 'accepted' ? '✓ Ícone criado com sucesso!' : 'Instalação cancelada.');
        _pwaPrompt = null;
    } else if (isSafari && isIOS) {
        const card = document.createElement('div');
        card.id = 'pwa-ios-instrucao';
        card.className = 'pwa-install-overlay';
        card.innerHTML = `
            <div class="pwa-install-card">
                <div class="pwa-icon" style="background:linear-gradient(135deg,#007aff,#0055cc);">
                    <i class="fa-brands fa-safari"></i>
                </div>
                <h3>Como instalar no iPhone/iPad</h3>
                <ol class="pwa-steps">
                    <li>Toque no botão <strong><i class="fa-solid fa-arrow-up-from-bracket"></i></strong> na barra inferior do Safari</li>
                    <li>Role para baixo e toque em <strong>"Adicionar à Tela de Início"</strong></li>
                    <li>Toque em <strong>"Adicionar"</strong> no canto superior direito</li>
                </ol>
                <div class="pwa-install-btns">
                    <button class="btn-pri" onclick="document.getElementById('pwa-ios-instrucao').remove()">
                        <i class="fa-solid fa-check"></i> Entendido
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(card);
    } else {
        const card = document.createElement('div');
        card.id = 'pwa-outros-instrucao';
        card.className = 'pwa-install-overlay';
        card.innerHTML = `
            <div class="pwa-install-card">
                <div class="pwa-icon"><i class="fa-solid fa-globe"></i></div>
                <h3>Como instalar</h3>
                <ol class="pwa-steps">
                    <li>Clique nos <strong>três pontos ⋮</strong> no canto superior direito do navegador</li>
                    <li>Procure por <strong>"Instalar aplicativo"</strong> ou <strong>"Adicionar à tela inicial"</strong></li>
                    <li>Confirme a instalação</li>
                </ol>
                <div class="pwa-install-btns">
                    <button class="btn-pri" onclick="document.getElementById('pwa-outros-instrucao').remove()">
                        <i class="fa-solid fa-check"></i> Entendido
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(card);
    }
}

function recusarInstalarPWA() {
    const overlay = document.getElementById('pwa-install-overlay');
    if (overlay) overlay.remove();
    lsSet('pwa_respondeu', true);
}

// ══════════════════════════════════════════════════════
// INICIALIZAÇÃO
// ══════════════════════════════════════════════════════

// Esconde os pontos de entrada por voz (FAB da agenda e microfone dentro do
// modal "Novo Agendamento") quando esta janela está rodando dentro do
// sistema desktop — seja a Agenda Local (window.sistemaLocal) ou a Agenda
// Online aberta de dentro do Electron (window.agendaOnline). Nesses dois
// casos o reconhecimento de voz do navegador não funciona (limitação do
// próprio Electron, não tem correção de código — ver tratamento do erro
// 'network' em _iniciarEscutaVoz), então melhor nem oferecer o botão do
// que deixar o usuário tentar e cair num erro. Continua aparecendo
// normalmente quando a Agenda Online é acessada direto num navegador de
// verdade (ex: celular), fora do sistema — onde window.sistemaLocal e
// window.agendaOnline simplesmente não existem.
function aplicarVisibilidadeMicrofone() {
    const dentroDoSistema = S.abertoPeloSistemaLocal ||
        !!(window.agendaOnline && typeof window.agendaOnline.publicarToken === 'function');
    const fabVoz = $('fab-voz');
    const btnMic = $('btn-mic-add');
    if (fabVoz) fabVoz.style.display = dentroDoSistema ? 'none' : '';
    if (btnMic) btnMic.style.display = dentroDoSistema ? 'none' : '';
}

document.addEventListener('DOMContentLoaded', async () => {
    carregarConfig();
    configurarMonitorInatividade();
    preencherUrlAgenda();

    // Aberto direto pelo sistema (Electron / Agenda Local, via preload-agenda-local.js)?
    // O acesso já passou pelo login do sistema principal — pedir o PIN de novo
    // aqui seria uma segunda trava redundante. O PIN só faz sentido quando este
    // mesmo app.js é acessado como Agenda Online/PWA, fora do sistema desktop
    // (nesse caso window.sistemaLocal não existe — só window.agendaOnline).
    S.abertoPeloSistemaLocal = !!(window.sistemaLocal && typeof window.sistemaLocal.listarPacientes === 'function');
    if (S.abertoPeloSistemaLocal) {
        S.adminPin = S.config.admin_pin || 'local';
    }
    aplicarVisibilidadeMicrofone();

    // Restaura token Google salvo (se ainda válido)
    const savedToken = lsGet('agenda_google_token', null);
    if (savedToken && tokenValido()) {
        S.googleToken = savedToken;
    }
    const savedFileId = lsGet('agenda_drive_file_id', null);
    if (savedFileId) S.fileIdDrive = savedFileId;
    const savedFileIdAparelho = lsGet('agenda_drive_file_id_aparelho', null);
    if (savedFileIdAparelho) S.fileIdAparelho = savedFileIdAparelho;

    // Verifica se voltou do OAuth com token na URL
    const hash = window.location.hash;
    if (hash) {
        const hashParams = new URLSearchParams(hash.replace('#', ''));
        const oauthToken = hashParams.get('access_token');
        if (oauthToken) {
            S.googleToken = oauthToken;
            lsSet('agenda_google_token', oauthToken);
            lsSet('agenda_google_token_exp', Date.now() + 3500 * 1000);
            history.replaceState(null, '', window.location.pathname);
            console.log('[Drive] Token OAuth recebido.');
            agendarRenovacaoToken();

            const origem        = lsGet('agenda_oauth_origem', 'login');
            const estavLogado   = lsGet('agenda_oauth_estava_logado', false);
            lsSet('agenda_oauth_estava_logado', false);

            // Vai para tela correta primeiro
            if (S.abertoPeloSistemaLocal) {
                irTela(origem === 'config' ? 'tela-config' : 'tela-agenda');
                atualizarStatusDrive();
                toast('🔄 Conectado! Baixando dados...');
            } else if ((origem === 'agenda' || origem === 'config') && estavLogado) {
                S.adminPin = lsGet('agenda_admin_pin_session', null) || '____';
                irTela(origem === 'config' ? 'tela-config' : 'tela-agenda');
                atualizarStatusDrive();
                toast('🔄 Conectado! Baixando dados...');
            } else {
                irTela('tela-login');
                verificarInstalacaoPWA();
            }

            // Baixa dados do Drive e renderiza
            console.log('[Drive] Iniciando download após OAuth...');
            const baixou = await baixarBackupDrive(false);
            console.log('[Drive] Download concluído:', baixou);
            await carregarPacientes_ls();
            await carregarAgendamentos_ls();
            console.log('[Drive] Pacientes carregados:', S.pacientes.length);
            console.log('[Drive] Agendamentos carregados:', S.agendamentos.length);

            if ((origem === 'agenda' || origem === 'config') && estavLogado) {
                await renderizarAgenda();
                iniciarPollingDrive();
                if (tokenValido()) toast('✅ Google Drive conectado! ' + S.pacientes.length + ' pacientes carregados.');
            } else {
                iniciarPollingDrive();
                // Veio do gate: fecha gate e abre agenda
                fecharGateDrive();
                if (S.adminPin) abrirAgenda();
            }
            // Sincroniza dados pendentes salvos offline
            await sincronizarPendentes();
            return;
        }
    }

    const params = new URLSearchParams(location.search);
    if (params.get('t')) {
        await iniciarTelaPaciente();
    } else if (S.abertoPeloSistemaLocal) {
        // Agenda Local: sem PIN — carrega os dados do sistema (SQLite, via
        // preload) e vai direto pra tela da agenda.
        await carregarPacientes_ls();
        await carregarAgendamentos_ls();
        abrirAgenda();
    } else {
        // Se já tem token válido, carrega dados locais imediatamente
        // e depois sincroniza com o Drive em background
        if (tokenValido()) {
            agendarRenovacaoToken();
            // Carrega do localStorage antes de mostrar o PIN
            // para garantir que S.pacientes já está populado quando o usuário entrar
            await carregarPacientes_ls();
            await carregarAgendamentos_ls();
            // Sincroniza com Drive em background (não bloqueia a tela de PIN)
            baixarBackupDrive(true).then(async () => {
                // ✅ CORREÇÃO: após download, força atualização completa na memória
                await carregarPacientes_ls();
                await carregarAgendamentos_ls();
                // Re-renderiza agenda se estiver aberta
                const telaAgenda = document.getElementById('tela-agenda');
                if (telaAgenda && telaAgenda.style.display !== 'none') {
                    renderizarAgenda();
                }
            }).catch(() => {});
            iniciarPollingDrive();
        }
        irTela('tela-login');
        verificarInstalacaoPWA();
    }
});

// ══════════════════════════════════════════════════════════════
// PUSH AGENDAMENTO → GITHUB (via proxy seguro no Cloudflare Worker)
// O sistema local (Electron) lê esses arquivos e importa para o SQLite.
// O PAT do GitHub fica só no Worker — nunca chega no navegador do paciente.
// ══════════════════════════════════════════════════════════════
const URL_PROXY_AGENDA = 'https://agenda-clinica-proxy.topagenda.workers.dev';

async function _pushAgendamentoGithub(agendamento, token) {
    try {
        const resp = await fetch(`${URL_PROXY_AGENDA}/agendamento`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clienteId: CLIENTE_ID, token, agendamento })
        });
        if (!resp.ok) {
            const dados = await resp.json().catch(() => ({}));
            console.warn('[Proxy] Falha ao publicar agendamento:', dados.erro || resp.status);
        }
    } catch(e) {
        console.warn('[Proxy] Erro ao publicar agendamento:', e);
    }
}

// ══════════════════════════════════════════════════════
// COMANDO DE VOZ — agendar / substituir / cancelar / incluir paciente
// ══════════════════════════════════════════════════════
//
// Funciona por reconhecimento de padrões de fala (sem IA externa),
// usando a API nativa do navegador (Chrome/Edge/Electron).
// Não funciona bem no Safari/iPhone.

const ACOES_VOZ = [
    { regex: /\b(cancelar|desmarcar)\b/i,                    tipo: 'cancelar' },
    { regex: /\b(substituir|trocar)\b/i,                     tipo: 'substituir' },
    { regex: /\b(incluir|cadastrar)\b[\s\S]*\bpaciente\b/i,   tipo: 'incluir_paciente' },
    { regex: /\b(marcar|agendar|remarcar)\b/i,                tipo: 'agendar' },
];

const DIAS_SEMANA_VOZ = {
    'domingo': 0,
    'segunda': 1, 'segunda-feira': 1,
    'terca': 2, 'terca-feira': 2,
    'quarta': 3, 'quarta-feira': 3,
    'quinta': 4, 'quinta-feira': 4,
    'sexta': 5, 'sexta-feira': 5,
    'sabado': 6,
};

const NUMEROS_POR_EXTENSO_VOZ = {
    'zero': 0, 'uma': 1, 'um': 1, 'duas': 2, 'dois': 2, 'tres': 3, 'quatro': 4,
    'cinco': 5, 'seis': 6, 'sete': 7, 'oito': 8, 'nove': 9, 'dez': 10, 'onze': 11, 'doze': 12,
};

function _removerAcentosVoz(str) {
    return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ── Cria uma instância do reconhecedor de voz do navegador ──
function _criarReconhecedorVoz() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        toast('🎙️ Reconhecimento de voz não é suportado neste navegador. Use Chrome ou Edge.', 4000);
        return null;
    }
    const rec = new SR();
    rec.lang            = 'pt-BR';
    rec.continuous       = false;
    rec.interimResults    = false;
    rec.maxAlternatives   = 1;
    return rec;
}

// ── Extrai data falada: hoje, amanhã, dia da semana, "dia N" ──
function _extrairDataVoz(texto) {
    const t    = _removerAcentosVoz(texto.toLowerCase());
    const hoje = new Date();

    if (/\bhoje\b/.test(t)) {
        const m = texto.match(/hoje/i);
        return { iso: isoDate(hoje), match: m ? m[0] : 'hoje' };
    }
    if (/\bamanha\b/.test(t)) {
        const m = texto.match(/amanh[aã]/i);
        return { iso: isoDate(somarDias(hoje, 1)), match: m ? m[0] : 'amanhã' };
    }

    for (const [nome, idxSemana] of Object.entries(DIAS_SEMANA_VOZ)) {
        const re = new RegExp('\\b' + nome + '(-feira)?\\b', 'i');
        const m  = t.match(re);
        if (m) {
            let d = new Date(hoje);
            for (let i = 0; i < 8; i++) {
                if (d.getDay() === idxSemana && i > 0) break;
                if (i === 0 && d.getDay() === idxSemana) { d = somarDias(d, 7); continue; }
                d = somarDias(d, 1);
                if (d.getDay() === idxSemana) break;
            }
            const original = texto.match(new RegExp(nome.replace('-', '.'), 'i'));
            return { iso: isoDate(d), match: original ? original[0] : nome };
        }
    }

    const mDia = t.match(/\bdia\s+(\d{1,2})\b/);
    if (mDia) {
        const dia = parseInt(mDia[1], 10);
        let d = new Date(hoje.getFullYear(), hoje.getMonth(), dia);
        if (d < new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) {
            d = new Date(hoje.getFullYear(), hoje.getMonth() + 1, dia);
        }
        return { iso: isoDate(d), match: mDia[0] };
    }

    return null;
}

// ── Extrai horário falado: "15h", "às 3 da tarde", "meio-dia", etc. ──
function _extrairHoraVoz(texto) {
    const t = _removerAcentosVoz(texto.toLowerCase());

    if (/meio-?dia/.test(t))   return { hora: 12, match: 'meio-dia' };
    if (/meia-?noite/.test(t)) return { hora: 0,  match: 'meia-noite' };

    let m = t.match(/\b(\d{1,2})[h:](\d{2})?\b/);
    if (m) {
        const h   = parseInt(m[1], 10);
        const min = m[2] ? parseInt(m[2], 10) : 0;
        return { hora: Math.min(h, 23) + (min >= 30 ? 0.5 : 0), match: m[0] };
    }

    m = t.match(/\b(?:as|às)\s+(\d{1,2})(?:\s*horas?)?(?:\s*e\s*(meia|trinta))?\s*(?:(da manha|da tarde|da noite))?\b/);
    if (m) {
        let h          = parseInt(m[1], 10);
        const temMeia  = !!m[2];
        const periodo  = m[3] || '';
        if (periodo.includes('tarde') && h < 12) h += 12;
        if (periodo.includes('noite') && h < 12) h += 12;
        return { hora: h + (temMeia ? 0.5 : 0), match: m[0] };
    }

    for (const [palavra, num] of Object.entries(NUMEROS_POR_EXTENSO_VOZ)) {
        const re = new RegExp('\\b(?:as|às)\\s+' + palavra + '(?:\\s*horas?)?(?:\\s*(da manha|da tarde|da noite))?\\b', 'i');
        const mm = t.match(re);
        if (mm) {
            let h         = num;
            const periodo = mm[1] || '';
            if ((periodo.includes('tarde') || periodo.includes('noite')) && h < 12) h += 12;
            return { hora: h, match: mm[0] };
        }
    }

    return null;
}

// ── Remove ação, data e hora reconhecidas, sobra o nome do paciente ──
function _extrairNomeVoz(textoOriginal, trechosParaRemover) {
    let limpo = textoOriginal;
    trechosParaRemover.forEach(trecho => {
        if (trecho) {
            try { limpo = limpo.replace(new RegExp(trecho.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' '); }
            catch (e) { /* ignora trecho problemático */ }
        }
    });
    limpo = limpo.replace(/\b(marcar|agendar|remarcar|cancelar|desmarcar|substituir|trocar|incluir|cadastrar)\b/gi, ' ');
    limpo = limpo.replace(/\b(a consulta da|a consulta do|consulta da|consulta do|consulta|paciente|novo|nova|dia|do|da|de|para|pra|no|na|em|com|as|às|a|o)\b/gi, ' ');
    limpo = limpo.replace(/\s+/g, ' ').trim();
    return limpo;
}

function _normalizarNomeVoz(s) {
    return _removerAcentosVoz((s || '').toLowerCase()).replace(/[^a-z\s]/g, '').trim();
}

// ── Busca o paciente falado na lista já cadastrada ──
function _buscarPacientePorNomeVoz(nomeFalado) {
    const alvo = _normalizarNomeVoz(nomeFalado);
    if (!alvo) return null;

    const candidatos = S.pacientes.filter(p => {
        const nome = _normalizarNomeVoz(p.nome || '');
        return nome === alvo || nome.startsWith(alvo) || nome.includes(alvo) || alvo.includes(nome.split(' ')[0]);
    });

    if (candidatos.length === 1) return candidatos[0];
    if (candidatos.length > 1) {
        const porPrimeiroNome = candidatos.find(p =>
            _normalizarNomeVoz(p.nome).split(' ')[0] === alvo.split(' ')[0]
        );
        return porPrimeiroNome || candidatos[0];
    }
    return null;
}

// ── Ponto de entrada: FAB da tela da agenda (comando completo) ──
// ── Motor de escuta compartilhado: espera você TERMINAR de falar ──
// (continuous=true + timer de silêncio, em vez de cortar na primeira pausa)
function _iniciarEscutaVoz(callbackFinal, elementoIndicador) {
    const rec = _criarReconhecedorVoz();
    if (!rec) return;

    rec.continuous      = true;
    rec.interimResults  = true;

    let transcritoFinal = '';
    let timerSilencio    = null;
    let timerMaximo       = null;
    let finalizado        = false;

    const pararEProcessar = () => {
        if (finalizado) return;
        finalizado = true;
        clearTimeout(timerSilencio);
        clearTimeout(timerMaximo);
        try { rec.stop(); } catch (e) {}
        if (elementoIndicador) elementoIndicador.classList.remove('ouvindo');

        const texto = transcritoFinal.trim();
        if (texto) callbackFinal(texto);
        else toast('Não entendi. Tente novamente.');
    };

    rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
            if (e.results[i].isFinal) {
                transcritoFinal += ' ' + e.results[i][0].transcript;
            }
        }
        // Cada vez que detecta fala nova, adia o encerramento —
        // só finaliza depois de ~1.8s de silêncio de verdade.
        clearTimeout(timerSilencio);
        timerSilencio = setTimeout(pararEProcessar, 1800);
    };

    rec.onerror = (e) => {
        if (e.error === 'no-speech') return; // deixa o timer de silêncio/máximo decidir
        finalizado = true;
        clearTimeout(timerSilencio);
        clearTimeout(timerMaximo);
        if (elementoIndicador) elementoIndicador.classList.remove('ouvindo');

        // Mensagens específicas por tipo de erro — sem isso, qualquer falha
        // (permissão negada, rede indisponível, hardware) mostrava o mesmo
        // aviso genérico de "verifique o microfone", o que dificultava saber
        // se era um problema de configuração ou uma limitação do ambiente.
        if (e.error === 'not-allowed' || e.error === 'permission-denied' || e.error === 'service-not-allowed') {
            toast('🎙️ Permissão de microfone negada para esta janela. Autorize o microfone e tente de novo.', 4500);
        } else if (e.error === 'network') {
            // Dentro do Electron (Agenda Local/Online abertas de dentro do
            // sistema), o reconhecimento de voz do navegador não tem acesso
            // ao serviço de nuvem do Google — é uma limitação do próprio
            // Electron, não desta janela específica. Funciona normalmente
            // abrindo a Agenda Online direto num navegador (ex: no celular).
            toast('🎙️ Reconhecimento de voz indisponível aqui dentro do sistema. Use o celular/navegador pra ditar por voz, ou cadastre pelo botão manual.', 6000);
        } else {
            toast('Não consegui captar o áudio. Verifique o microfone e tente de novo.');
        }
    };

    // Se o navegador encerrar sozinho (ex: aba perdeu foco), finaliza com o que já tem
    rec.onend = () => { if (!finalizado) pararEProcessar(); };

    if (elementoIndicador) elementoIndicador.classList.add('ouvindo');
    timerMaximo = setTimeout(pararEProcessar, 12000); // limite de segurança: 12s

    try { rec.start(); }
    catch (e) { if (elementoIndicador) elementoIndicador.classList.remove('ouvindo'); }
}

// ── Escuta uma confirmação por voz ("confirma"/"cancela") após abrir um modal ──
// Usada depois que o comando de voz já abriu a tela de agendamento ou de novo
// paciente com os dados prontos — só falta o usuário confirmar de viva voz.
function _escutarConfirmacaoVoz(aoConfirmar, aoCancelar, elementoIndicador) {
    toast('🎙️ Diga "confirma" para salvar, ou "cancela".', 3500);
    _iniciarEscutaVoz((textoFalado) => {
        const t = _removerAcentosVoz((textoFalado || '').toLowerCase());
        if (/\b(confirma|confirmar|salva|salvar|pode salvar|isso mesmo)\b/.test(t)) {
            aoConfirmar();
        } else if (/\b(cancela|cancelar|nao|volta|voltar)\b/.test(t)) {
            if (aoCancelar) aoCancelar();
            else toast('Ok, cancelado.');
        } else {
            toast('Não entendi. Diga "confirma" para salvar ou toque manualmente.', 4000);
        }
    }, elementoIndicador);
}

// ── Ponto de entrada: FAB da tela da agenda (comando completo) ──
function iniciarComandoVozAgenda() {
    const fab = $('fab-voz');
    toast('🎙️ Ouvindo... fale com calma, o comando completo', 4000);
    _iniciarEscutaVoz(processarComandoVoz, fab);
}

// ── Ponto de entrada: microfone dentro do modal "Novo Agendamento" ──
// (aqui a data/hora já vêm do slot clicado na grade — só falta o nome)
function iniciarComandoVozNomeModal() {
    const btn = $('btn-mic-add');
    toast('🎙️ Diga o nome do paciente...', 3500);
    _iniciarEscutaVoz(_aplicarNomeNoModalAdd, btn);
}

function _aplicarNomeNoModalAdd(textoFalado) {
    const nomeLimpo = _extrairNomeVoz(textoFalado, []) || textoFalado.trim();
    const paciente   = _buscarPacientePorNomeVoz(nomeLimpo);
    const sel = $('add-pac-sel');
    if (!sel) return;

    if (paciente) {
        sel.value = paciente.id;
        toast(`Paciente selecionado: ${paciente.nome}`);
        return;
    }

    const cadastrar = confirm(`Não encontrei nenhum paciente chamado "${nomeLimpo}".\n\nDeseja cadastrar agora?`);
    if (cadastrar) {
        fecharModal('modal-add');
        abrirModalPaciente();
        const campoNome = $('pac-nome');
        if (campoNome) campoNome.value = nomeLimpo;
        toast('Complete o cadastro e depois abra o agendamento de novo.', 4000);
    } else {
        toast('Ok, selecione o paciente manualmente.');
    }
}

// ── Processa o comando completo dito na tela da agenda ──
function processarComandoVoz(textoOriginal) {
    const texto = (textoOriginal || '').trim();
    if (!texto) { toast('Não entendi o comando.'); return; }

    let acao = 'agendar';
    for (const a of ACOES_VOZ) {
        if (a.regex.test(texto)) { acao = a.tipo; break; }
    }

    const dataInfo = _extrairDataVoz(texto);
    const horaInfo = _extrairHoraVoz(texto);
    const nome     = _extrairNomeVoz(texto, [dataInfo?.match, horaInfo?.match]);

    if (acao === 'incluir_paciente') {
        if (!nome) { toast('Não entendi o nome do paciente a cadastrar.'); return; }
        abrirModalPaciente();
        const campoNome = $('pac-nome');
        if (campoNome) campoNome.value = nome;
        toast(`🎙️ Cadastrando "${nome}". Diga "confirma" para salvar.`, 4500);
        setTimeout(() => _escutarConfirmacaoVoz(salvarPaciente, () => fecharModal('modal-pac'), $('fab-voz')), 700);
        return;
    }

    if (!nome) {
        toast('Não entendi o nome do paciente. Ex: "Marcar Maria na quinta às 15h".', 4500);
        return;
    }

    const paciente = _buscarPacientePorNomeVoz(nome);

    if (!paciente) {
        const cadastrar = confirm(`Não encontrei nenhum paciente chamado "${nome}".\n\nDeseja cadastrar agora?`);
        if (cadastrar) {
            abrirModalPaciente();
            const campoNome = $('pac-nome');
            if (campoNome) campoNome.value = nome;
            toast('Complete o cadastro e depois repita o comando de voz.', 4500);
        } else {
            toast('Ok, cancelado.');
        }
        return;
    }

    if (acao === 'cancelar') {
        _iniciarCancelamentoPorVoz(paciente, dataInfo);
    } else if (acao === 'substituir') {
        _iniciarSubstituicaoPorVoz(paciente, dataInfo);
    } else {
        _iniciarAgendamentoPorVoz(paciente, dataInfo, horaInfo);
    }
}

// ── Ação: agendar (abre o modal já pronto, só falta confirmar e salvar) ──
function _iniciarAgendamentoPorVoz(paciente, dataInfo, horaInfo) {
    if (!dataInfo) { toast('Não entendi a data. Ex: "quinta", "amanhã", "dia 15".', 4000); return; }
    if (!horaInfo) { toast('Não entendi o horário. Ex: "às 15h", "às três da tarde".', 4000); return; }

    const horaBase = Math.floor(horaInfo.hora);
    abrirModalAdd(dataInfo.iso, horaBase);

    const sel = $('add-pac-sel');
    if (sel) sel.value = paciente.id;

    if (horaInfo.hora % 1 !== 0) selecionarSubHorarioAdd(0.5);

    toast(`🎙️ Entendi: ${paciente.nome}, ${horaLabel(horaInfo.hora)}. Diga "confirma" para salvar.`, 4500);
    setTimeout(() => _escutarConfirmacaoVoz(salvarAgendamentoManual, () => fecharModal('modal-add'), $('fab-voz')), 700);
}

// ── Ação: cancelar (abre o detalhe da consulta encontrada pra confirmar) ──
function _iniciarCancelamentoPorVoz(paciente, dataInfo) {
    let candidatos = S.agendamentos.filter(a =>
        (a.paciente_id === paciente.id) || _normalizarNomeVoz(a.nome_paciente || a.paciente || '') === _normalizarNomeVoz(paciente.nome)
    );
    if (dataInfo) candidatos = candidatos.filter(a => a.data === dataInfo.iso);
    candidatos = candidatos.filter(a => a.data >= isoDate(new Date()));
    candidatos.sort((a, b) => (a.data + a.hora) < (b.data + b.hora) ? -1 : 1);

    if (!candidatos.length) {
        toast(`Não encontrei consulta futura de ${paciente.nome}${dataInfo ? ' nessa data' : ''}.`, 4000);
        return;
    }

    abrirModalDetalhe(candidatos[0].id);
    toast(`🎙️ Consulta de ${paciente.nome} encontrada. Toque em Cancelar para confirmar.`, 4500);
}

// ── Ação: substituir (abre o detalhe; a troca em si é confirmada na tela) ──
function _iniciarSubstituicaoPorVoz(paciente, dataInfo) {
    let candidatos = S.agendamentos.filter(a =>
        (a.paciente_id === paciente.id) || _normalizarNomeVoz(a.nome_paciente || a.paciente || '') === _normalizarNomeVoz(paciente.nome)
    );
    if (dataInfo) candidatos = candidatos.filter(a => a.data === dataInfo.iso);
    candidatos = candidatos.filter(a => a.data >= isoDate(new Date()));
    candidatos.sort((a, b) => (a.data + a.hora) < (b.data + b.hora) ? -1 : 1);

    if (!candidatos.length) {
        toast(`Não encontrei consulta futura de ${paciente.nome}${dataInfo ? ' nessa data' : ''}.`, 4000);
        return;
    }

    abrirModalDetalhe(candidatos[0].id);
    toast(`🎙️ Consulta encontrada. Toque em "Substituir paciente" e escolha o novo nome.`, 4500);
}
