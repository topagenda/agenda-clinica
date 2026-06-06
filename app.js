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

/* ============================================================
   APP.JS — Agenda Clínica PWA
   Armazenamento: Google Drive (fonte principal) + IndexedDB (offline)
   Tailscale/servidor local: REMOVIDO
   ============================================================ */

'use strict';

// ══════════════════════════════════════════════════════
// GOOGLE DRIVE
// ══════════════════════════════════════════════════════

const GOOGLE_CLIENT_ID  = '235501323072-0eq60qvktqbsalrp1htt3uqkf26fkq5s.apps.googleusercontent.com';
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

    // Botão no header da agenda
    const btnAgenda = document.getElementById('btn-drive-agenda');
    if (btnAgenda) {
        btnAgenda.style.color = conectado ? '#34a853' : '';
        btnAgenda.title = conectado ? 'Drive conectado ✓' : 'Conectar Google Drive';
    }

    // Botão em Configurações
    const btnTexto = document.getElementById('btn-drive-texto');
    const btnCfg   = document.getElementById('btn-drive-config');
    if (btnTexto) btnTexto.textContent = conectado ? 'Drive conectado ✓ (toque para desconectar)' : 'Conectar com Google Drive';
    if (btnCfg)   { btnCfg.style.background = conectado ? '#e8f5e9' : ''; btnCfg.style.color = conectado ? '#2e7d32' : ''; }

    // Status text em Configurações
    const statusEl = document.getElementById('status-drive');
    if (statusEl) statusEl.textContent = conectado ? '✅ Sincronizado com Google Drive' : '';

    // Botão na tela de login (compatibilidade)
    const btnLogin = document.querySelector('.btn-google');
    if (btnLogin) {
        if (conectado) {
            btnLogin.innerHTML = '<i class="fa-brands fa-google"></i> Google Drive sincronizado ✓';
            btnLogin.style.background = '#e8f5e9';
            btnLogin.style.color = '#2e7d32';
        } else {
            btnLogin.innerHTML = '<i class="fa-brands fa-google"></i> Sincronizar via Google Drive';
            btnLogin.style.background = '';
            btnLogin.style.color = '';
        }
    }
}

// Captura token OAuth que volta na URL após login Google
// verificarTokenOAuth é chamado dentro do DOMContentLoaded

// Verifica se o token ainda é válido
function tokenValido() {
    const exp = lsGet('agenda_google_token_exp', 0);
    return S.googleToken && Date.now() < exp;
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
        console.log('[Drive] Conteúdo baixado — pacientes:', banco.pacientes?.length, '| agendamentos:', banco.agendamentos?.length);

        // Atualiza localStorage e IndexedDB com os dados do Drive
        // Condição: array de pacientes deve existir (mesmo que vazio, substituímos)
        if (Array.isArray(banco.pacientes))    lsSet('agenda_pacientes',    banco.pacientes);
        if (Array.isArray(banco.agendamentos)) lsSet('agenda_agendamentos', banco.agendamentos);
        if (banco.tokens)                      lsSet('agenda_tokens',       banco.tokens);
        if (banco.config)                      lsSet('agenda_config',       banco.config);

        // Atualiza IndexedDB para uso offline
        try {
            const ags = banco.agendamentos || [];
            for (const ag of ags) await idbPut('agendamentos', ag);
            const pacs = banco.pacientes || [];
            for (const p of pacs) await idbPut('pacientes', p);
        } catch(e) {}

        // Sempre atualiza S.pacientes e S.agendamentos na memória após download
        // ✅ CORREÇÃO: sempre atualiza memória após download do Drive
        S.pacientes    = lsGet('agenda_pacientes',    []);
        S.agendamentos = lsGet('agenda_agendamentos', []);

        if (silencioso) {
            // Re-renderiza agenda se houver mudanças
            renderizarAgenda();
        } else {
            toast('✅ Dados sincronizados do Google Drive!');
            irTela('tela-login');
        }
        return true;
    } catch(e) {
        console.error('[Drive] Erro ao baixar backup:', e);
        if (!silencioso) { toast('☁️ Drive conectado!'); irTela('tela-login'); }
        return false;
    }
}

// Salva todos os dados no Drive
async function salvarAlteracoesNoDrive() {
    // Recarrega token salvo caso tenha sido perdido da memória
    if (!S.googleToken) S.googleToken = lsGet('agenda_google_token', null);
    if (!S.fileIdDrive) S.fileIdDrive = lsGet('agenda_drive_file_id', null);

    if (!tokenValido()) {
        // Sem token válido: salva apenas localmente e registra como pendente de sync
        lsSet('agenda_sync_pendente', true);
        console.warn('[Drive] Sem token válido — dados salvos localmente, sync pendente.');
        return;
    }

    const payload = {
        pacientes:    S.pacientes    || [],
        agendamentos: S.agendamentos || [],
        tokens:       lsGet('agenda_tokens', {}),
        config:       S.config,
        _origem:      'celular',
        _salvoEm:     new Date().toISOString()
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
            console.log('[Drive] Salvo com sucesso.');
        } else {
            if (res.status === 401) { S.googleToken = null; lsSet('agenda_google_token', null); }
            lsSet('agenda_sync_pendente', true);
            console.warn('[Drive] Falha ao salvar:', res.status);
        }
    } catch(e) {
        lsSet('agenda_sync_pendente', true);
        console.error('[Drive] Erro ao salvar:', e);
    }
}

// Quando volta online: sincroniza pendentes com o Drive
async function sincronizarPendentes() {
    const pendente = lsGet('agenda_sync_pendente', false);
    if (!pendente) return;
    if (!tokenValido()) return;
    console.log('[Sync] Enviando dados pendentes para o Drive...');
    await salvarAlteracoesNoDrive();
    if (!lsGet('agenda_sync_pendente', false)) {
        toast('✅ Dados sincronizados com o Google Drive!');
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
    config: { nome_clinica: 'Agenda Clínica', tel_medico: '', admin_pin: '1234' },
};

const DIAS_ABR  = ['DOM','SEG','TER','QUA','QUI','SEX','SÁB'];
const DIAS_FULL = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
const MESES_ABR = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const HORAS     = Array.from({length: 14}, (_, i) => i + 7); // 07:00 – 20:00

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const horaLabel = h => `${String(h).padStart(2,'0')}:00`;
const isoDate   = d => d.toISOString().slice(0, 10);
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

async function carregarPacientes_ls() {
    // 1. localStorage (já sincronizado pelo Drive)
    const ls = lsGet('agenda_pacientes', []);
    if (ls.length > 0) { S.pacientes = ls; return; }
    // 2. Fallback: IndexedDB
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

async function carregarAgendamentos_ls() {
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

function salvarAgendamentos_ls() {
    lsSet('agenda_agendamentos', S.agendamentos);
    // Atualiza IndexedDB também
    idbClear('agendamentos').then(() => {
        S.agendamentos.forEach(ag => idbPut('agendamentos', ag).catch(() => {}));
    }).catch(() => {});
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
function semanaLabel(inicio) {
    const fim = somarDias(inicio, 6);
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
        lsSet('agenda_admin_pin_session', S.pin); // salva para restaurar após OAuth
        S.pin = '';
        atualizarPinDisplay();
        await carregarTudo();
        irTela('tela-agenda');
        atualizarStatusDrive();
        await renderizarAgenda();
        // ✅ CORREÇÃO: após entrar, baixa Drive para garantir dados atualizados
        if (tokenValido()) {
            baixarBackupDrive(true).then(async (baixou) => {
                if (baixou) {
                    await carregarPacientes_ls();
                    await carregarAgendamentos_ls();
                    renderizarAgenda();
                }
            }).catch(() => {});
        }
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

function logout() {
    S.adminPin = null;
    S.pin = '';
    atualizarPinDisplay();
    pararPollingDrive();
    irTela('tela-login');
}

async function carregarTudo() {
    carregarConfig();
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

async function renderizarAgenda() {
    await carregarAgendamentos_ls();
    const inicio = segundaFeiraDaSemana(S.semanaOffset);
    const dias   = Array.from({length: 7}, (_, i) => somarDias(inicio, i));
    const hoje   = isoDate(new Date());

    const labelEl1 = $('header-semana-label');
    const labelEl2 = $('semana-nav-label');
    if (labelEl1) labelEl1.textContent = semanaLabel(inicio);
    if (labelEl2) labelEl2.textContent = semanaLabel(inicio);

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

    HORAS.forEach(h => {
        const lbl = document.createElement('div');
        lbl.className = 'ga-hora-label';
        lbl.textContent = horaLabel(h);
        grade.appendChild(lbl);

        dias.forEach(d => {
            const iso = isoDate(d);
            const ag  = S.agendamentos.find(a => a.data === iso && parseInt(a.hora) === h);
            const cel = document.createElement('div');
            cel.className = 'ga-celula ' + (ag ? 'agendado' : 'livre');
            if (ag) {
                const chip = document.createElement('div');
                chip.className = `ga-chip ${ag.status || 'confirmado'}`;
                chip.textContent = (ag.nome_paciente || ag.paciente || '').split(' ')[0];
                cel.appendChild(chip);
                cel.onclick = () => abrirModalDetalhe(ag.id);
            } else {
                cel.onclick = () => abrirModalAdd(iso, h);
            }
            grade.appendChild(cel);
        });
    });

    S.diaSelecionado = S.diaSelecionado || hoje;
    renderizarListaDia();
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
            <span class="ag-badge ${st}">${st === 'confirmado' ? 'Confirmado' : 'Aguardando'}</span>
        `;
        div.onclick = () => abrirModalDetalhe(ag.id);
        lista.appendChild(div);
    });
}

function semanaAnterior() { S.semanaOffset--; renderizarAgenda(); }
function semanaProxima()  { S.semanaOffset++; renderizarAgenda(); }
function irHoje()         { S.semanaOffset = 0; S.diaSelecionado = isoDate(new Date()); renderizarAgenda(); }

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
        <div class="detalhe-row"><span class="dr-label">Horário</span><span class="dr-val">${horaLabel(ag.hora)} – ${horaLabel(parseInt(ag.hora)+1)}</span></div>
        <div class="detalhe-row"><span class="dr-label">Status</span><span class="dr-val"><span class="ag-badge ${st}">${st === 'confirmado' ? '✅ Confirmado' : '⏳ Aguardando'}</span></span></div>
        ${ag.obs ? `<div class="detalhe-row"><span class="dr-label">Obs</span><span class="dr-val">${ag.obs}</span></div>` : ''}
    `;
    const btnPron = $('btn-prontuario');
    if (btnPron) btnPron.style.display = 'none';
    $('modal-detalhe').style.display = 'flex';
}

async function cancelarAgendamento() {
    if (!S.agDetalhe) return;
    if (!confirm('Cancelar esta consulta?')) return;
    S.agendamentos = S.agendamentos.filter(a => a.id !== S.agDetalhe.id);
    salvarAgendamentos_ls();
    fecharModal('modal-detalhe');
    toast('Consulta cancelada.');
    renderizarAgenda();
    await salvarAlteracoesNoDrive();
}

function irProntuario() {}

// ══════════════════════════════════════════════════════
// MODAL: ADICIONAR MANUAL
// ══════════════════════════════════════════════════════

function abrirModalAdd(data, hora) {
    const d = new Date(data + 'T00:00:00');
    const horarioEl = $('modal-add-horario');
    if (horarioEl) horarioEl.innerHTML = `<i class="fa-solid fa-calendar-day"></i> ${DIAS_FULL[d.getDay()]}, ${d.getDate()} de ${MESES_ABR[d.getMonth()]} — ${horaLabel(hora)}`;
    const obsEl = $('add-obs');
    if (obsEl) obsEl.value = '';

    const sel = $('add-pac-sel');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Selecione um paciente —</option>';
    [...S.pacientes].sort((a,b) => (a.nome||'').localeCompare(b.nome||'')).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        const cod = p.codigo ? `#${String(p.codigo).padStart(3,'0')} — ` : '';
        opt.textContent = `${cod}${p.nome}`;
        sel.appendChild(opt);
    });

    sel._data = data;
    sel._hora = hora;
    $('modal-add').style.display = 'flex';
}

async function salvarAgendamentoManual() {
    const sel   = $('add-pac-sel');
    const pacId = sel.value;
    if (!pacId) { toast('Selecione um paciente.'); return; }
    const pac  = S.pacientes.find(p => String(p.id) === String(pacId));
    const data = sel._data;
    const hora = sel._hora;
    const obs  = ($('add-obs')?.value || '').trim();

    const novo = {
        id:              'ag_' + Date.now(),
        paciente_id:     pacId,
        nome_paciente:   pac.nome,
        codigo_paciente: pac.codigo || null,
        data, hora, obs,
        status: 'confirmado'
    };

    S.agendamentos.push(novo);
    salvarAgendamentos_ls();
    fecharModal('modal-add');
    toast(`Consulta de ${pac.nome} agendada!`);
    renderizarAgenda();
    await salvarAlteracoesNoDrive();
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
    [...S.pacientes].sort((a,b) => (a.nome||'').localeCompare(b.nome||'')).forEach(p => {
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

function renderizarGradeModal() {
    S.slotStates = {};
    const selSem = $('ml-semana');
    if (!selSem) return;
    const isoInicio = selSem.value;
    const inicio    = new Date(isoInicio + 'T00:00:00');
    const dias      = Array.from({length:7}, (_, i) => somarDias(inicio, i));
    const container = $('ml-grade');
    if (!container) return;
    container.innerHTML = '';

    const grid = document.createElement('div');
    grid.className = 'modal-grade-grid';
    container.appendChild(grid);

    dias.forEach(d => {
        const iso = isoDate(d);
        const col = document.createElement('div');
        col.className = 'modal-grade-col';

        const hdr = document.createElement('div');
        hdr.className = 'modal-grade-col-header';
        hdr.textContent = `${DIAS_ABR[d.getDay()]} ${d.getDate()}`;
        col.appendChild(hdr);

        HORAS.forEach(h => {
            const chave   = `${iso}_${h}`;
            const ocupado = S.agendamentos.some(a => a.data === iso && parseInt(a.hora) === h);
            const btn     = document.createElement('button');
            btn.type      = 'button';
            btn.dataset.chave = chave;

            if (ocupado) {
                btn.className = 'mg-slot slot-ocupado';
                btn.textContent = horaLabel(h);
                btn.disabled = true;
            } else {
                S.slotStates[chave] = 'neutro';
                btn.className = 'mg-slot slot-neutro';
                btn.textContent = horaLabel(h);
                btn.onclick = () => {
                    const estados = ['neutro', 'disponivel', 'indisponivel'];
                    const atual   = S.slotStates[chave] || 'neutro';
                    const prox    = estados[(estados.indexOf(atual) + 1) % 3];
                    S.slotStates[chave] = prox;
                    btn.className = `mg-slot slot-${prox}`;
                    if (prox === 'disponivel')        btn.textContent = '✓ ' + horaLabel(h);
                    else if (prox === 'indisponivel') btn.textContent = '✕ ' + horaLabel(h);
                    else                              btn.textContent = horaLabel(h);
                };
            }
            col.appendChild(btn);
        });
        grid.appendChild(col);
    });
}

async function gerarLink() {
    const pacId = $('ml-paciente').value;
    if (!pacId) { toast('Selecione um paciente.'); return; }
    const pac = S.pacientes.find(p => String(p.id) === String(pacId));

    const slots = [], bloqueados = [];
    Object.entries(S.slotStates).forEach(([chave, estado]) => {
        const [data, hora] = chave.split('_');
        if (estado === 'disponivel')   slots.push({ data, hora: parseInt(hora) });
        if (estado === 'indisponivel') bloqueados.push({ data, hora: parseInt(hora) });
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

    const link = `${window.location.origin}${window.location.pathname}?t=${token}`;
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
    ).sort((a,b) => (a.nome||'').localeCompare(b.nome||''));

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
        ? { diaSemana: parseInt($('pac-fixo-dia').value), hora: parseInt($('pac-fixo-hora').value) }
        : null;
    const editId = $('pac-edit-id')?.value;
    const dados = {
        id:           editId || ('pac_' + Date.now()),
        nome,
        telefone:     ($('pac-tel')?.value || '').trim(),
        email:        ($('pac-email')?.value || '').trim(),
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
    salvarConfig_ls();
    if ($('menu-clinica-nome')) $('menu-clinica-nome').textContent = S.config.nome_clinica;
    toast('Configurações salvas!');
    salvarAlteracoesNoDrive();
}

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

    pacToken = t;
    irTela('tela-paciente');

    // Tenta buscar tokens do Drive para garantir dados atualizados
    if (tokenValido()) {
        await baixarBackupDrive(true);
    }

    const tokens = carregarTokens_ls();
    const cfg    = tokens[t];

    if (!cfg) { renderizarPacErro('Link inválido ou expirado.'); return; }
    if (cfg.usado) { renderizarPacErro('Este link já foi utilizado.'); return; }

    pacConfig = cfg;
    const subtituloEl = $('pac-subtitulo');
    if (subtituloEl) subtituloEl.textContent = `Olá, ${cfg.nomePaciente}! Confirme seu horário.`;
    renderizarPacGrade();
}

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

    corpo.innerHTML = '';
    const grade  = document.createElement('div');
    grade.className = 'pac-grade-wrap';
    const gridEl = document.createElement('div');
    gridEl.className = 'pac-grade';

    datas.forEach(iso => {
        const d   = new Date(iso + 'T00:00:00');
        const col = document.createElement('div');
        col.className = 'pac-col';

        const hdr = document.createElement('div');
        hdr.className = 'pac-col-header' + (iso === isoDate(new Date()) ? ' hoje' : '');
        hdr.innerHTML = `${DIAS_ABR[d.getDay()]}<br>${d.getDate()}`;
        col.appendChild(hdr);

        const horasDia = [...new Set([
            ...slots.filter(s => s.data === iso).map(s => s.hora),
            ...bloqueados.filter(s => s.data === iso).map(s => s.hora)
        ])].sort((a,b) => a-b);

        horasDia.forEach(h => {
            const isBloq = bloqueados.some(s => s.data === iso && s.hora === h);
            const btn    = document.createElement('button');
            btn.className = 'pac-slot ' + (isBloq ? 'bloqueado' : 'disponivel');
            btn.textContent = horaLabel(h);
            btn.disabled = isBloq;
            if (!isBloq) {
                btn.onclick = () => {
                    document.querySelectorAll('.pac-slot.selecionado').forEach(b => b.classList.remove('selecionado'));
                    btn.classList.add('selecionado');
                    pacSlot = { data: iso, hora: h };
                    renderizarPacConfirmacao();
                };
            }
            col.appendChild(btn);
        });
        gridEl.appendChild(col);
    });

    grade.appendChild(gridEl);
    corpo.appendChild(grade);
}

function renderizarPacConfirmacao() {
    const corpo = $('pac-corpo');
    if (!corpo) return;
    const d    = new Date(pacSlot.data + 'T00:00:00');
    const data = `${DIAS_PT[d.getDay()]}, ${d.getDate()} de ${MESES_ABR[d.getMonth()]}`;
    corpo.innerHTML = `
        <div class="pac-confirmacao">
            <i class="fa-solid fa-calendar-check" style="font-size:2.5rem;color:var(--accent2);display:block;margin-bottom:1rem;"></i>
            <h3>Confirmar consulta?</h3>
            <p>Você está confirmando:</p>
            <div class="pac-confirm-slot">📅 ${data} às ${horaLabel(pacSlot.hora)}</div>
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
        a => a.data === pacSlot.data && parseInt(a.hora) === parseInt(pacSlot.hora)
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
            if ((origem === 'agenda' || origem === 'config') && estavLogado) {
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
            }
            return;
        }
    }

    const params = new URLSearchParams(location.search);
    if (params.get('t')) {
        await iniciarTelaPaciente();
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
