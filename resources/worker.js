/* settings is supplied by the authenticated Laravel worker endpoint. */
const PREFIX = 'sithu-offline-v1:';
const PAGES = PREFIX + settings.owner + ':pages';
const ASSETS = PREFIX + 'assets';
const pageAllowed = url => settings.pages.some(path => path.endsWith('*') ? url.pathname.startsWith(path.slice(0, -1)) : url.pathname === path);
const owned = response => response.ok && !response.redirected && response.headers.get('X-Offline-Owner') === settings.owner;
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(ASSETS);
        await Promise.allSettled(settings.assets.map(async path => {
            const response = await fetch(path, { cache: 'reload' });
            if (response.ok && !response.redirected) await cache.put(path, response);
        }));
        await self.skipWaiting();
    })());
});
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key === 'invoice-offline-cache-v1' || (key.startsWith(PREFIX) && key !== PAGES && key !== ASSETS)) await caches.delete(key);
        }
        await self.clients.claim();
    })());
});
self.addEventListener('message', event => {
    if (event.data?.type === 'CACHE_PAGE') event.waitUntil((async () => {
        try {
            const url = new URL(event.data.url, self.location.origin);
            if (event.data.owner !== settings.owner || url.origin !== self.location.origin || !pageAllowed(url)) return;
            const response = await fetch(url.href, { credentials: 'same-origin', cache: 'no-store' });
            if (!owned(response)) throw new Error('Page could not be cached for this account.');
            await (await caches.open(PAGES)).put(url.href, response);
            event.ports[0]?.postMessage({ ok: true });
        } catch (error) { event.ports[0]?.postMessage({ ok: false, message: error.message }); }
    })());
    if (event.data?.type === 'LOGOUT') event.waitUntil(caches.delete(PAGES));
});
self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.method !== 'GET') {
        if (url.pathname === '/logout') event.respondWith((async () => { await caches.delete(PAGES); return fetch(request); })());
        return;
    }
    if (request.mode === 'navigate' && pageAllowed(url)) {
        event.respondWith((async () => {
            const cache = await caches.open(PAGES);
            try {
                const response = await fetch(request);
                if (owned(response)) await cache.put(request, response.clone());
                else if (response.status === 401 || response.status === 403 || response.redirected) await cache.delete(request);
                return response;
            } catch (_) {
                return await cache.match(request) || new Response('This page has not been prepared for offline use. Reconnect and open it once. Saved drafts remain in this browser.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
            }
        })());
    } else if (settings.assets.some(path => new URL(path, self.location.origin).href === url.href)) {
        event.respondWith((async () => {
            const cache = await caches.open(ASSETS);
            try {
                const response = await fetch(request);
                if (response.ok) await cache.put(request, response.clone());
                return response;
            } catch (_) { return await cache.match(request) || Response.error(); }
        })());
    }
});
