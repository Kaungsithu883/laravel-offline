const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function worker() {
    const events = {}; const buckets = new Map(); let network = async () => new Response('network');
    const caches = {
        keys: async () => [...buckets.keys()], delete: async key => buckets.delete(key),
        open: async name => {
            if (!buckets.has(name)) buckets.set(name, new Map());
            const map = buckets.get(name); const key = request => typeof request === 'string' ? request : request.url;
            return { put: async (req, res) => map.set(key(req), res.clone()), match: async req => map.get(key(req))?.clone(), delete: async req => map.delete(key(req)) };
        },
    };
    const context = { settings: { owner: 'alice', pages: ['/invoice_reg', '/invoice_edit/*'], assets: ['/client.js'] }, caches, URL, Response,
        fetch: (...args) => network(...args), self: { location: { origin: 'https://example.test' }, addEventListener: (name, fn) => events[name] = fn, skipWaiting: async () => {}, clients: { claim: async () => {} } } };
    vm.runInNewContext(fs.readFileSync(__dirname + '/../resources/worker.js', 'utf8'), context);
    return { events, caches, setNetwork: fn => network = fn };
}
function fetchEvent(w, path, method = 'GET', mode = 'navigate') {
    let response;
    w.events.fetch({ request: { url: 'https://example.test' + path, method, mode }, respondWith: promise => response = promise });
    return response;
}
test('POST saves and API GETs never enter the page/asset cache', () => {
    const w = worker(); assert.equal(fetchEvent(w, '/invoice_register', 'POST'), undefined);
    assert.equal(fetchEvent(w, '/customer_service_search', 'GET', 'cors'), undefined);
});
test('explicitly preparing the current page makes the first offline refresh work', async () => {
    const w = worker(); w.setNetwork(async () => new Response('invoice page', { headers: { 'X-Offline-Owner': 'alice' } }));
    let done; let acknowledgement;
    w.events.message({ data: { type: 'CACHE_PAGE', owner: 'alice', url: 'https://example.test/invoice_reg' }, ports: [{ postMessage: message => acknowledgement = message }], waitUntil: p => done = p });
    await done; assert.equal(acknowledgement.ok, true);
    w.setNetwork(async () => { throw new Error('offline'); });
    assert.equal(await (await fetchEvent(w, '/invoice_reg')).text(), 'invoice page');
});
test('a page belonging to another account is never cached', async () => {
    const w = worker(); w.setNetwork(async () => new Response('bob invoice', { headers: { 'X-Offline-Owner': 'bob' } }));
    await fetchEvent(w, '/invoice_reg'); w.setNetwork(async () => { throw new Error('offline'); });
    assert.equal((await fetchEvent(w, '/invoice_reg')).status, 503);
});
test('logout removes cached private pages before its network request', async () => {
    const w = worker(); w.setNetwork(async () => new Response('invoice', { headers: { 'X-Offline-Owner': 'alice' } }));
    await fetchEvent(w, '/invoice_reg'); await fetchEvent(w, '/logout', 'POST');
    w.setNetwork(async () => { throw new Error('offline'); });
    assert.equal((await fetchEvent(w, '/invoice_reg')).status, 503);
});
test('activation removes only this package and legacy invoice caches', async () => {
    const w = worker(); await w.caches.open('another-application'); await w.caches.open('invoice-offline-cache-v1'); await w.caches.open('sithu-offline-v1:bob:pages');
    let done; w.events.activate({ waitUntil: p => done = p }); await done;
    assert.deepEqual(await w.caches.keys(), ['another-application']);
});
