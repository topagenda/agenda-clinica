/* ============================================================
   SW.JS — Service Worker da Agenda Clínica
   Versão v6 — correções:
     1. "body already used": clone vai para o browser, original no cache
     2. isLocal não depende mais de fetchPromise ser truthy
     3. Protocolo chrome-extension:// (e outros não-http) ignorados
        — a Cache API só aceita http e https
     4. Bump para v6: força reinstalação e download de app.css/app.js
        com correção do tema (paleta de cores no mobile)
   ============================================================ */

const CACHE_NOME    = 'agenda-v7';
const CACHE_EXTERNO = 'agenda-cdn-v7';

const ARQUIVOS_LOCAIS = [
    '/',
    '/index.html',
    '/app.js',
    '/app.css'
];

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
            caches.open(CACHE_NOME).then(cache =>
                Promise.allSettled(ARQUIVOS_LOCAIS.map(url => cache.add(url)))
            ),
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

/* ----------------------------------------------------------
   Função auxiliar: busca na rede e salva no cache.
   RETORNA o clone para o browser; guarda o original no cache.
   Essa é a ordem CORRETA — inverter causa "body already used".
   ---------------------------------------------------------- */
function fetchECache(request, nomecache) {
    return fetch(request).then(r => {
        if (!r || r.status !== 200 || r.type === 'opaque') return r;
        const rParaBrowser = r.clone();          // ← clone vai para o browser
        caches.open(nomecache).then(c => c.put(request, r)); // ← original fica no cache
        return rParaBrowser;
    });
}

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Ignora requisições não-GET
    if (event.request.method !== 'GET') return;

    // Ignora protocolos não suportados pela Cache API (chrome-extension://, etc.)
    if (!url.protocol.startsWith('http')) return;

    // Rotas de API local: sempre rede, fallback JSON vazio
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

    // Google APIs: sempre rede, sem cache
    if (url.hostname === 'www.googleapis.com' ||
        url.hostname === 'accounts.google.com' ||
        url.hostname === 'oauth2.googleapis.com' ||
        url.hostname === 'fonts.googleapis.com' ||
        url.hostname === 'fonts.gstatic.com') {
        event.respondWith(
            fetch(event.request).catch(() => new Response('', { status: 503 }))
        );
        return;
    }

    const isLocal = url.origin === self.location.origin;
    const nomecache = isLocal ? CACHE_NOME : CACHE_EXTERNO;

    if (isLocal) {
        // Arquivos locais: Network First
        // Tenta rede; se falhar, usa cache; se não tiver cache, 503
        event.respondWith(
            fetchECache(event.request, nomecache)
                .catch(() => caches.match(event.request))
                .then(r => {
                    if (r) return r;
                    if (event.request.headers.get('accept')?.includes('text/html')) {
                        return caches.match('/index.html');
                    }
                    return new Response('Offline', { status: 503 });
                })
        );
    } else {
        // CDN: Cache First — entrega imediatamente, atualiza em segundo plano
        event.respondWith(
            caches.match(event.request).then(cached => {
                // Atualiza em segundo plano (stale-while-revalidate)
                fetchECache(event.request, nomecache).catch(() => {});

                if (cached) return cached;

                // Sem cache: vai para a rede (fetchECache já foi chamado acima,
                // mas precisamos de uma nova Promise para retornar a resposta)
                return fetch(event.request).then(r => {
                    if (!r || r.status !== 200 || r.type === 'opaque') return r;
                    const rParaBrowser = r.clone();
                    caches.open(nomecache).then(c => c.put(event.request, r));
                    return rParaBrowser;
                }).catch(() => new Response('Offline', { status: 503 }));
            })
        );
    }
});
