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
// drive.file só enxerga arquivos criados pelo próprio app nesta sessão OAuth.
// Se o backup foi criado em outro dispositivo/sessão, a busca retorna vazio.
// Usando drive para ter acesso completo de leitura e escrita.
const SCOPES            = 'https://www.googleapis.com/auth/drive';
const DRIVE_FILE_NAME   = 'backup_sistema.json';
const DRIVE_POLL_MS     = 30000; // verifica atualizações a cada 30s

let _drivePollingTimer        = null;
let _driveUltimaModificacao   = null;

// Inicia o fluxo OAuth — redireciona para o Google
function conectarGoogleDriveMobile() {
    // Salva de onde veio para voltar ao lugar certo após OAuth
    lsSet('agenda_oauth_origem', 'login');
    const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
    const url = `https://accounts.google.com/o/oauth2/v2/auth`
        + `?client_id=${GOOGLE_CLIENT_ID}`
        + `&redirect_uri=${redirectUri}`
        + `&response_type=token`
        + `&scope=${encodeURIComponent(SCOPES)}`;
    window.location.href = url;
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
    const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
    const url = `https://accounts.google.com/o/oauth2/v2/auth`
        + `?client_id=${GOOGLE_CLIENT_ID}`
        + `&redirect_uri=${redirectUri}`
        + `&response_type=token`
        + `&scope=${encodeURIComponent(SCOPES)}`;
    window.location.href = url;
}

// Botão em Configurações: conecta ou desconecta
function conectarOuDesconectarDrive() {
    if (tokenValido()) {
        if (!confirm('Desconectar o Google Drive?')) return;
        S.googleToken = null;
        S.fileIdDrive = null;
        lsSet('agenda_google_token', null);
        lsSet('agenda_google_token_exp', 0);
        lsSet('agenda_drive_file_id', null);
        atualizarStatusDrive();
        toast('Google Drive desconectado.');
        return;
    }
    lsSet('agenda_oauth_origem', 'config');
    lsSet('agenda_oauth_estava_logado', true);
    const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
    const url = `https://accounts.google.com/o/oauth2/v2/auth`
        + `?client_id=${GOOGLE_CLIENT_ID}`
        + `&redirect_uri=${redirectUri}`
        + `&response_type=token`
        + `&scope=${encodeURIComponent(SCOPES)}`;
    window.location.href = url;
}

// Atualiza visual dos botões de Drive em toda a interface
function atualizarStatusDrive() {
    const conectado = tokenValido();

    // Botão no header + banner expansível
    const btnAgenda = document.getElementById('btn-drive-agenda');
    const banner    = document.getElementById('drive-banner');
    if (btnAgenda) {
        if (conectado) {
            btnAgenda.style.color = '#34a853';
            btnAgenda.classList.remove('desconectado');
            btnAgenda.title = '☁️ Agendamentos salvos automaticamente';
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
        ? '☁️ Drive conectado — agendamentos salvos automaticamente'
        : '⚠️ Clique para salvar seus agendamentos no Google Drive';
    if (btnCfg) {
        btnCfg.style.background = conectado ? '#e8f5e9' : '#fff5f9';
        btnCfg.style.color      = conectado ? '#2e7d32' : '#b8256e';
    }

    // Status text em Configurações
    const statusEl = document.getElementById('status-drive');
    if (statusEl) statusEl.textContent = conectado
        ? '✅ Agendamentos sendo salvos automaticamente no Google Drive'
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
    _renovacaoTimer = setTimeout(() => renovarTokenSilencioso(), renovarEm);
}

function renovarTokenSilencioso() {
    console.log('[Drive] Renovando token silenciosamente...');
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
        + `&prompt=none`;  // sem interação do usuário

    iframe.src = url;
    document.body.appendChild(iframe);

    // Captura o token do iframe quando carregar
    iframe.onload = () => {
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
                    agendarRenovacaoToken(); // agenda próxima renovação
                }
            }
        } catch(e) {
            // CORS impede leitura — token expirou, usuário precisará reconectar
            console.warn('[Drive] Renovação silenciosa falhou, usuário precisará reconectar.');
        }
        setTimeout(() => iframe.remove(), 2000);
    };
}

// Baixa o backup do Drive e atualiza o estado local
async function baixarBackupDrive(silencioso = false) {
    if (!tokenValido()) {
        if (!silencioso) toast('⚠️ Sessão Google expirada. Conecte novamente.');
        S.googleToken = null;
        return false;
    }
    try {
        // Busca arquivo pelo nome padronizado
        const q      = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
        const search = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,modifiedTime)&spaces=drive`,
            { headers: { Authorization: `Bearer ${S.googleToken}` } }
        );
        if (!search.ok) {
            if (search.status === 401) {
                S.googleToken = null;
                lsSet('agenda_google_token', null);
                if (!silencioso) toast('⚠️ Sessão Google expirada. Conecte novamente.');
            }
            return false;
        }

        const result = await search.json();
        console.log('[Drive] Resultado da busca:', JSON.stringify(result));
        if (!result.files || result.files.length === 0) {
            // Nenhum arquivo encontrado — pode ser primeiro uso ou scope insuficiente
            console.warn('[Drive] Arquivo', DRIVE_FILE_NAME, 'não encontrado no Drive.');
            if (!silencioso) toast('☁️ Drive conectado! Nenhum backup encontrado ainda — os dados serão criados no próximo salvamento.');
            return false;
        }

        const arquivo = result.files[0];
        S.fileIdDrive = arquivo.id;
        lsSet('agenda_drive_file_id', arquivo.id);

        // Não baixa se nada mudou desde a última vez (polling silencioso)
        const modDrive = new Date(arquivo.modifiedTime).getTime();
        if (silencioso && _driveUltimaModificacao && modDrive <= _driveUltimaModificacao) {
            return false;
        }
        _driveUltimaModificacao = modDrive;

        const fileRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${arquivo.id}?alt=media`,
            { headers: { Authorization: `Bearer ${S.googleToken}` } }
        );
        const banco = await fileRes.json();

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
        if (!pacientes.length && tokensObj && typeof tokensObj === 'object') {
            // Extrai pacientes únicos dos tokens (nome + id para mostrar na agenda)
            const mapa = {};
            Object.values(tokensObj).forEach(tk => {
                if (tk.pacienteId && tk.nomePaciente && !mapa[tk.pacienteId]) {
                    mapa[tk.pacienteId] = { id: tk.pacienteId, nome: tk.nomePaciente, telefone: '' };
                }
            });
            pacientes = Object.values(mapa);
        }

        console.log('[Drive] Conteúdo baixado — pacientes:', pacientes.length, '| agendamentos:', agendamentos.length, '| tokens:', Object.keys(tokensObj).length);

        // Atualiza localStorage e IndexedDB com os dados do Drive
        if (agendamentos.length || Array.isArray(banco.agenda_agendamentos))
            lsSet('agenda_agendamentos', agendamentos);
        if (pacientes.length || Array.isArray(banco.pacientes))
            lsSet('agenda_pacientes', pacientes);
        if (tokensObj && Object.keys(tokensObj).length)
            lsSet('agenda_tokens', tokensObj);
        if (config)
            lsSet('agenda_config', config);

        // Atualiza IndexedDB para uso offline
        try {
            for (const ag of agendamentos) await idbPut('agendamentos', ag);
            for (const p  of pacientes)    await idbPut('pacientes', p);
        } catch(e) {}

        // Sempre atualiza S.pacientes e S.agendamentos na memória após download
        S.pacientes    = lsGet('agenda_pacientes',    []);
        S.agendamentos = lsGet('agenda_agendamentos', []);

        // Resolve possíveis duplicatas vindas do Drive (ex: substituição feita
        // offline gerou dois confirmados no mesmo horário)
        resolverDuplicatasAgendamentos();

        // Garante que o que acabou de vir do Drive também chegue no sistema
        // local (SQLite), quando a ponte da Agenda Local estiver disponível.
        // Antes, isso só acontecia "de carona" quando resolverDuplicatasAgendamentos
        // encontrava duplicatas — se não encontrasse, o download ficava só
        // no localStorage desta janela e nunca era espelhado no sistema.
        if (window.sistemaLocal && typeof window.sistemaLocal.salvarAgendamento === 'function') {
            await salvarAgendamentos_ls();
        }

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
        if (!silencioso) {
            toast('☁️ Drive conectado!');
            // Só redireciona para login se o usuário não estava autenticado
            if (!S.adminPin) irTela('tela-login');
        }
        return false;
    }
}

// Salva todos os dados no Drive
async function salvarAlteracoesNoDrive(listaOverride = null) {
    // Recarrega token salvo caso tenha sido perdido da memória
    if (!S.googleToken) S.googleToken = lsGet('agenda_google_token', null);
    if (!S.fileIdDrive) S.fileIdDrive = lsGet('agenda_drive_file_id', null);

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

    // Inclui cancelados pendentes offline para garantir que o desktop processe
    const canceladosPendentes = lsGet('agenda_cancelados_pendentes', []);
    const listaBase = listaOverride || S.agendamentos || [];
    const lista = [...listaBase, ...canceladosPendentes.filter(
        c => !listaBase.find(a => a.id === c.id)
    )];
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
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });

    try {
        let url, method;

        if (S.fileIdDrive) {
            url    = `https://www.googleapis.com/upload/drive/v3/files/${S.fileIdDrive}?uploadType=media`;
            method = 'PATCH';
        } else {
            // Cria o arquivo pela primeira vez
            const meta = await fetch('https://www.googleapis.com/drive/v3/files', {
                method:  'POST',
                headers: { Authorization: `Bearer ${S.googleToken}`, 'Content-Type': 'application/json' },
                body:    JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json' })
            });
            if (!meta.ok) return;
            const metaJson = await meta.json();
            S.fileIdDrive  = metaJson.id;
            lsSet('agenda_drive_file_id', S.fileIdDrive);
            url    = `https://www.googleapis.com/upload/drive/v3/files/${S.fileIdDrive}?uploadType=media`;
            method = 'PATCH';
        }

        const res = await fetch(url, {
            method,
            headers: { Authorization: `Bearer ${S.googleToken}`, 'Content-Type': 'application/json' },
            body: blob
        });

        if (res.ok) {
            const updated = await res.json();
            if (updated.modifiedTime) {
                _driveUltimaModificacao = new Date(updated.modifiedTime).getTime();
            }
            lsSet('agenda_sync_pendente', false);
            lsSet('agenda_cancelados_pendentes', []); // limpa cancelados pendentes
            lsSet('agenda_pacientes_pendentes', []);  // limpa pacientes já enviados
            console.log('[Drive] Salvo com sucesso.');
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
                canceladosPendentes.push({ ...ag, status: 'cancelado' });
            }
        });
        lsSet('agenda_cancelados_pendentes', canceladosPendentes);

        // Remove duplicatas da lista ativa local
        S.agendamentos = S.agendamentos.filter(a => !idsParaCancelar.includes(a.id));
        salvarAgendamentos_ls();
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
    config: { nome_clinica: 'Agenda Clínica', tel_medico: '', admin_pin: '1234', ocultar_fds: false },
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
// PERSISTÊNCIA — Drive primeiro, IndexedDB como fallback offline
// ══════════════════════════════════════════════════════

function carregarConfig() {
    const saved = lsGet('agenda_config', null);
    if (saved) S.config = { ...S.config, ...saved };
}
function salvarConfig_ls() {
    lsSet('agenda_config', S.config);
}

// Oculta/mostra sábado e domingo na grade semanal. Controla apenas a
// contagem de colunas visíveis via CSS var (--ga-dias) — a preferência
// vem de S.config.ocultar_fds, que é salva com o resto da config
// (localStorage + sync Drive), então fica valendo até o usuário reverter,
// em qualquer dispositivo/janela (Online ou Local, mesmo app.js).
function aplicarOcultarFDS() {
    const ativo = !!S.config.ocultar_fds;
    document.documentElement.style.setProperty('--ga-dias', ativo ? 5 : 7);
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
// está na lista atual (num retrato congelado no momento da chamada) e apaga
// do banco o que não existe mais nela (cancelamentos/exclusões feitos aqui
// dentro). Retorna uma Promise<boolean>: true se sincronizou com sucesso
// (ou não havia nada a fazer, ex: Agenda Online sem a ponte local), false
// se algo falhou na gravação.
function sincronizarAgendamentosComSistemaLocal() {
    if (!window.sistemaLocal || typeof window.sistemaLocal.salvarAgendamento !== 'function') {
        return Promise.resolve(true);
    }
    // Encadeia esta execução depois da anterior — nunca roda em paralelo.
    _filaSyncAgendamentosLocal = _filaSyncAgendamentosLocal.then(async () => {
        const snapshot = S.agendamentos.slice(); // congela a lista atual
        const fonteEraConfiavel = _agendamentosFonteConfiavel;
        try {
            for (const ag of snapshot) {
                await window.sistemaLocal.salvarAgendamento(ag);
            }
            // Só apaga do banco o que "sobrou" quando temos certeza de que o
            // snapshot é um retrato completo e atual do sistema. Se ele veio
            // de um fallback (localStorage/IndexedDB desatualizado por causa
            // de uma falha de IPC, por exemplo), tratar "ausente no snapshot"
            // como "foi excluído" apagaria agendamentos legítimos que só não
            // chegaram a essa cópia local — foi isso que fez a Gertrudes e o
            // Julio sumirem do painel de quinzenais mesmo estando agendados.
            if (fonteEraConfiavel &&
                typeof window.sistemaLocal.listarAgendamentos === 'function' &&
                typeof window.sistemaLocal.excluirAgendamento === 'function') {
                const idsAtuais = new Set(snapshot.map(a => String(a.id)));
                const doBanco = await window.sistemaLocal.listarAgendamentos();
                for (const ag of doBanco) {
                    if (!idsAtuais.has(String(ag.id))) {
                        await window.sistemaLocal.excluirAgendamento(ag.id);
                    }
                }
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
    if (!window.sistemaLocal || typeof window.sistemaLocal.salvarAgendamento !== 'function') {
        return Promise.resolve(true);
    }
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
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.style.display = 'none', dur);
}
// Alias para compatibilidade com chamadas antigas
const mostrarToast = toast;

function irTela(id) {
    document.querySelectorAll('.tela').forEach(t => t.style.display = 'none');
    const tela = $(id);
    if (tela) tela.style.display = 'flex';
    else console.warn(`Tela "${id}" não encontrada.`);

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
    carregarConfig();
    aplicarOcultarFDS();
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
    // Se a preferência "ocultar fins de semana" estiver ativa, a grade
    // mostra só Segunda–Sexta (5 colunas em vez de 7). O cabeçalho, as
    // células de horário e o grid-template-columns (via --ga-dias, ajustado
    // em aplicarOcultarFDS) seguem todos essa mesma lista filtrada.
    const dias   = S.config.ocultar_fds
        ? diasTodos.filter(d => d.getDay() !== 0 && d.getDay() !== 6)
        : diasTodos;
    const hoje   = isoDate(new Date());

    // Se o dia selecionado ficou escondido (era sábado/domingo e a
    // preferência acabou de ser ligada), cai pra segunda-feira da mesma
    // semana em vez de continuar apontando pra uma coluna que não existe.
    if (S.config.ocultar_fds && S.diaSelecionado && !dias.some(d => isoDate(d) === S.diaSelecionado)) {
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
        const imgs   = window.PP_IMGS || [];
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
    [80, 250, 600, 1200].forEach(ms => setTimeout(ajustarAlturaGradeAgenda, ms));
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
    if (opcaoCobranca === 'transferir') {
        try {
            if (window.sistemaLocal && typeof window.sistemaLocal.transferirPagamentoPendente === 'function') {
                await window.sistemaLocal.transferirPagamentoPendente(ag.paciente_id, ag.data, pac.id);
            } else {
                // Agenda Online: mesmo servidor HTTP local (porta 3131) usado pelo
                // cancelamento/exclusão de agendamentos — precisa de uma rota
                // equivalente no main.js (ex: POST /agenda/transferir-cobranca,
                // chamando db.transferirPagamentoPendenteDoAgendamento) pra
                // funcionar quando o desktop está alcançável na mesma rede.
                const token = await obterTokenServidorAgenda();
                await fetch('http://127.0.0.1:3131/agenda/transferir-cobranca', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Agenda-Token': token } : {}) },
                    body: JSON.stringify({ pacienteIdAntigo: ag.paciente_id, data: ag.data, pacienteIdNovo: pac.id })
                });
            }
        } catch (e) {
            console.warn('[Substituição] Falha ao transferir cobrança pendente:', e);
        }
    }

    // Novo agendamento no mesmo horário
    const novo = {
        id:              'ag_' + Date.now(),
        paciente_id:     pac.id,
        nome_paciente:   pac.nome,
        nomePaciente:    pac.nome,
        paciente:        pac.nome,
        codigo_paciente: pac.codigo || null,
        data:            ag.data,
        hora:            ag.hora,
        obs:             ag.obs || '',
        status:          'confirmado'
    };
    const antigoCancelado = { ...ag, status: 'cancelado' };

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
                const token = await obterTokenServidorAgenda();
                const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-Agenda-Token': token } : {}) };
                // Cria o novo primeiro (gera o pendente do paciente que entrou),
                // só depois exclui o antigo (cancela o pendente de quem saiu) —
                // mesma ordem já usada no caminho window.sistemaLocal acima.
                await fetch('http://127.0.0.1:3131/agenda/agendamentos', {
                    method: 'POST', headers, body: JSON.stringify(novo)
                });
                await fetch(`http://127.0.0.1:3131/agenda/agendamentos/${encodeURIComponent(ag.id)}`, {
                    method: 'DELETE',
                    headers: token ? { 'X-Agenda-Token': token } : {}
                });
            } catch(e) {
                // Normal se o desktop não estiver na mesma rede agora — o push
                // pro Worker acima garante que a atualização chega de qualquer
                // forma no próximo polling (a cada 30s) quando ele se conectar.
                console.warn('[Substituição] Servidor local (3131) indisponível:', e);
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
    const complementoCobranca = opcaoCobranca === 'transferir' ? ' (cobrança transferida)' : ' (cobrança original cancelada)';
    toast(sincronizouOk
        ? `Paciente substituído por ${pac.nome}!${complementoCobranca}`
        : '⚠️ Não foi possível gravar no sistema. Tente novamente.');
    // Aguarda o render (que recarrega S.agendamentos do banco) terminar de
    // verdade antes de seguir — senão a fila liberaria a próxima ação antes
    // do recarregamento completar, reabrindo a mesma brecha de corrida.
    await renderizarAgenda();

    // Drive fica fora do await que a fila espera: não precisa bloquear a
    // próxima ação, só terminar eventualmente (loga erro se falhar, e o
    // cancelado já está em cancelados_pendentes pra não se perder).
    salvarAlteracoesNoDrive([...S.agendamentos, antigoCancelado])
        .catch(e => console.warn('[Substituição] Falha ao salvar no Drive:', e));
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
            _pushAgendamentoGithub({ ...ag, status: 'cancelado' }, tokenAtivo)
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
                const token = await obterTokenServidorAgenda();
                await fetch(`http://127.0.0.1:3131/agenda/agendamentos/${encodeURIComponent(ag.id)}`, {
                    method: 'DELETE',
                    headers: token ? { 'X-Agenda-Token': token } : {}
                });
            } catch(e) {
                // Normal se o app desktop não estiver rodando na mesma rede (ex: paciente
                // acessando de fora) — nesse caso o cancelamento ainda vale localmente
                // e via GitHub/Drive; só não reflete no clinica.db até o desktop
                // reabrir a agenda com os dados já sincronizados pelo Drive.
                console.warn('[Cancelamento] Servidor local (3131) indisponível:', e);
            }
        })());
    }

    await Promise.all(tarefasParalelas);

    // Remove localmente. Sync pontual: só exclui este id no SQLite do
    // sistema (Agenda Local), sem varrer nem regravar o resto da agenda.
    S.agendamentos = S.agendamentos.filter(a => a.id !== ag.id);
    const sincronizouOk = await salvarAgendamentosAcao_ls({ excluir: [ag.id] });
    fecharModal('modal-detalhe');
    toast(sincronizouOk
        ? 'Consulta cancelada.'
        : '⚠️ Cancelado aqui, mas houve falha ao gravar no sistema.');
    // Aguarda o render (que recarrega S.agendamentos do banco) terminar de
    // verdade antes de seguir — senão a fila liberaria a próxima ação antes
    // do recarregamento completar, reabrindo a mesma brecha de corrida.
    await renderizarAgenda();

    // Drive fica fora do await que a fila espera: não precisa bloquear a
    // próxima ação (cancelamentos em sequência não ficam mais esperando a
    // rede), só terminar eventualmente — loga erro se falhar.
    salvarAlteracoesNoDrive([...S.agendamentos, { ...ag, status: 'cancelado' }])
        .catch(e => console.warn('[Cancelamento] Falha ao salvar no Drive:', e));
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
    const atualizado = { ...ag, status: 'nao_realizada' };
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
            const token = await obterTokenServidorAgenda();
            await fetch('http://127.0.0.1:3131/agenda/agendamentos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Agenda-Token': token } : {}) },
                body: JSON.stringify(atualizado)
            });
        } catch (e) {
            // Normal se o desktop não estiver na mesma rede — a marcação ainda
            // vale localmente e via GitHub/Drive; só não reflete no clinica.db
            // (e portanto não cancela o pendente) até o desktop reabrir a
            // agenda com os dados já sincronizados pelo Drive.
            console.warn('[Não realizada] Servidor local (3131) indisponível:', e);
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
    toast(sincronizouOk
        ? 'Consulta marcada como não realizada.'
        : '⚠️ Marcado aqui, mas houve falha ao gravar no sistema.');
    await renderizarAgenda();

    salvarAlteracoesNoDrive(S.agendamentos)
        .catch(e => console.warn('[Não realizada] Falha ao salvar no Drive:', e));
}

function irProntuario() {}

// ══════════════════════════════════════════════════════
// MODAL: ADICIONAR MANUAL
// ══════════════════════════════════════════════════════

function abrirModalAdd(data, hora) {
    const horaBase = Math.floor(parseFloat(hora)); // o quadrado sempre representa a hora cheia
    const d = new Date(data + 'T00:00:00');
    const sel = $('add-pac-sel');
    if (!sel) return;

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
    const novos = datas.map((dt, i) => ({
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
        toast('⚠️ Não foi possível gravar no sistema. Tente agendar novamente.');
    } else if (novos.length === 1) {
        toast(`Consulta de ${pac.nome} agendada!`);
    } else {
        toast(`${novos.length} sessões de ${pac.nome} agendadas!`);
    }

    // Aguarda o render (que recarrega S.agendamentos do banco) terminar de
    // verdade antes de seguir — senão a fila liberaria a próxima ação antes
    // do recarregamento completar, reabrindo a mesma brecha de corrida.
    await renderizarAgenda();

    // Drive fica fora do await que a fila espera — não bloqueia a próxima ação.
    salvarAlteracoesNoDrive().catch(e => console.warn('[Agendamento] Falha ao salvar no Drive:', e));
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
        codigo:       editId
            ? (S.pacientes.find(p => String(p.id) === editId)?.codigo || S.pacientes.length + 1)
            : (S.pacientes.length + 1)
    };

    if (editId) {
        const idx = S.pacientes.findIndex(p => String(p.id) === editId);
        if (idx >= 0) S.pacientes[idx] = dados;
        else S.pacientes.push(dados);
    } else {
        S.pacientes.push(dados);
        // Paciente novo (não edição): entra na fila de pendentes pra subir
        // pro Drive no próximo salvarAlteracoesNoDrive() — o desktop já sabe
        // importar pacientes novos vindos do celular (verificarAtualizacoesDrive).
        const pendentes = lsGet('agenda_pacientes_pendentes', []);
        pendentes.push(dados);
        lsSet('agenda_pacientes_pendentes', pendentes);
    }

    salvarPacientes_ls();
    fecharModal('modal-pac');
    toast(`Paciente ${editId ? 'atualizado' : 'cadastrado'}!`);
    renderizarListaPacientes($('busca-pac')?.value || '');
    await salvarAlteracoesNoDrive();
}

// ══════════════════════════════════════════════════════
// CONFIGURAÇÕES — Tailscale removido
// ══════════════════════════════════════════════════════

// Injeta o toggle "Ocultar sábado e domingo" na tela de Configurações via
// JS (em vez de editar o index.html na mão) — assim funciona tanto na
// Agenda Online quanto na Agenda Local, já que as duas carregam o mesmo
// index.html/app.js. Roda toda vez que a tela de config é aberta, mas só
// insere o elemento uma vez (checa se já existe antes).
function injetarToggleOcultarFDS() {
    if ($('cfg-ocultar-fds')) {
        $('cfg-ocultar-fds').checked = !!S.config.ocultar_fds;
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
        <input type="checkbox" id="cfg-ocultar-fds">
        <label for="cfg-ocultar-fds" style="cursor:pointer;">Ocultar sábado e domingo na agenda</label>
    `;
    anchorGroup.parentElement.insertBefore(row, anchorGroup.nextSibling);

    $('cfg-ocultar-fds').checked = !!S.config.ocultar_fds;
    $('cfg-ocultar-fds').addEventListener('change', (e) => {
        S.config.ocultar_fds = e.target.checked;
        salvarConfig_ls();
        aplicarOcultarFDS();
        if ($('grade-agenda')) renderizarAgenda();
        salvarAlteracoesNoDrive();
        toast(e.target.checked ? 'Sábado e domingo ocultados.' : 'Sábado e domingo visíveis novamente.');
    });
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
        renderizarPacErro('Este horário acabou de ser reservado por outra pessoa. Por favor, escolha outro.');
        return;
    }

    const novo = {
        id:            'ag_' + Date.now(),
        paciente_id:   pacConfig.pacienteId,
        nome_paciente: pacConfig.nomePaciente,
        nomePaciente:  pacConfig.nomePaciente,
        paciente:      pacConfig.nomePaciente,
        data:          pacSlot.data,
        hora:          pacSlot.hora,
        obs:           pacConfig.obs || '',
        status:        'confirmado'
    };

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

    await salvarAlteracoesNoDrive();

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

document.addEventListener('DOMContentLoaded', async () => {
    carregarConfig();
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

    // Restaura token Google salvo (se ainda válido)
    const savedToken = lsGet('agenda_google_token', null);
    if (savedToken && tokenValido()) {
        S.googleToken = savedToken;
    }
    const savedFileId = lsGet('agenda_drive_file_id', null);
    if (savedFileId) S.fileIdDrive = savedFileId;

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
                toast('✅ Google Drive conectado! ' + S.pacientes.length + ' pacientes carregados.');
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
        toast('Não consegui captar o áudio. Verifique o microfone e tente de novo.');
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
