/* ============================================================
   SW.JS — Service Worker da Agenda Clínica
   Versão corrigida — problemas resolvidos:
     1. Nomes dos arquivos corrigidos (index.html, app.js, app.css)
     2. Fontes corretas (Playfair Display + Nunito, não Sora/DM Sans)
     3. manifest.json removido (arquivo não existe no projeto)
     4. Font Awesome adicionado ao cache CDN
   ============================================================ */

const CACHE_NOME    = 'agenda-v3';
const CACHE_EXTERNO = 'agenda-cdn-v3';

// CORREÇÃO 1: nomes reais dos arquivos do projeto
const ARQUIVOS_LOCAIS = [
    '/',
    '/index.html',
    '/app.js',
    '/app.css'
];

// CORREÇÃO 2 e 4: fontes corretas + Font Awesome incluído
const ARQUIVOS_CDN = [
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.woff2',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-brands-400.woff2',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-regular-400.woff2',
    'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Nunito:wght@300;400;500;600;700&display=swap'
];

self.addEventListener('install', event => {
    event.waitUntil(
        Promise.all([
            // Arquivos locais: falha silenciosa por arquivo (não derruba tudo)
            caches.open(CACHE_NOME).then(cache =>
                Promise.allSettled(ARQUIVOS_LOCAIS.map(url => cache.add(url)))
            ),
            // CDN: também falha silenciosa (rede pode estar fora)
            caches.open(CACHE_EXTERNO).then(cache =>
                Promise.allSettled(ARQUIVOS_CDN.map(url => cache.add(url)))
            )
        ]).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(nomes => Promise.all(
                nomes
                    .filter(n => n !== CACHE_NOME && n !== CACHE_EXTERNO)
                    .map(n => caches.delete(n))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Ignora requisições não-GET (POST, DELETE etc. do IndexedDB/API)
    if (event.request.method !== 'GET') return;

    // Rotas de API do servidor Electron/Tailscale: sempre rede
    // Se offline, retorna JSON vazio para não quebrar o app
    const isApiLocal = url.pathname.startsWith('/agenda/') &&
        !url.pathname.endsWith('.html') &&
        !url.pathname.endsWith('.js') &&
        !url.pathname.endsWith('.css');

    if (isApiLocal) {
        event.respondWith(
            fetch(event.request).catch(() =>
                new Response(JSON.stringify([]), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                })
            )
        );
        return;
    }

    // API do Google Drive: sempre rede, sem fallback (requer autenticação)
    if (url.hostname === 'www.googleapis.com' ||
        url.hostname === 'accounts.google.com') {
        event.respondWith(fetch(event.request));
        return;
    }

    // Tudo mais: Cache First com atualização em segundo plano (Stale-While-Revalidate)
    event.respondWith(
        caches.match(event.request).then(cached => {
            const fetchPromise = fetch(event.request)
                .then(r => {
                    if (!r || r.status !== 200 || r.type === 'opaque') return r;
                    const nomecache = url.origin === self.location.origin
                        ? CACHE_NOME : CACHE_EXTERNO;
                    caches.open(nomecache).then(c => c.put(event.request, r.clone()));
                    return r;
                })
                .catch(() => null);

            // Arquivos locais: Network First (sempre tenta rede primeiro)
            const isLocal = url.origin === self.location.origin;
            if (isLocal && fetchPromise) {
                return fetchPromise.then(r => r || cached).catch(() => cached);
            }

            // CDN: Cache First (entrega imediatamente e atualiza em segundo plano)
            if (cached) {
                fetchPromise.catch(() => {});
                return cached;
            }

            // Se não tiver no cache: busca da rede
            return fetchPromise.then(r => {
                if (r) return r;

                // Offline e sem cache: fallback para a página principal
                if (event.request.headers.get('accept')?.includes('text/html')) {
                    return caches.match('/index.html');
                }
                return new Response('Offline', { status: 503 });
            });
        })
    );
});
