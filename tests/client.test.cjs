const { test } = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB } = require('fake-indexeddb');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
global.location = { origin: 'https://example.test', href: 'https://example.test/invoice_reg' };
global.crypto = crypto;
global.indexedDB = indexedDB;
vm.runInThisContext(fs.readFileSync(__dirname + '/../resources/offline.js', 'utf8'));
const { Client, Store } = global.SithuOffline;
const response = (body, status = 200, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
function client(send, store = new Store(crypto.randomUUID())) {
    return new Client({ owner: 'alice', sessionUrl: '/session', store, fetch: async (url, options) => url === '/session' ? response({ owner: 'alice', token: 'fresh' }) : send(url, options) });
}
const enqueue = (c, extra = {}) => c.enqueue({ action: '/save', entries: [{ name: '_token', value: 'stale' }, { name: 'item_id[]', value: '1' }], ...extra });

test('an HTML 200 is not an acknowledgement and the draft survives', async () => {
    const c = client(() => response('<html>Failed</html>', 200, 'text/html'));
    await enqueue(c); await c.sync(); assert.equal((await c.pending()).length, 1);
});
test('the operation survives a dropped response and retries with the same ID and fresh CSRF token', async () => {
    const ids = []; let token;
    const c = client((url, options) => {
        ids.push(options.headers['X-Offline-Id']); token = options.body.get('_token');
        if (ids.length === 1) throw new TypeError('Connection lost');
        return response({ ok: true, operation_id: ids.at(-1) });
    });
    const op = await enqueue(c); await c.sync(); assert.equal((await c.pending()).length, 1);
    await c.sync(); assert.deepEqual(ids, [op.id, op.id]); assert.equal(token, 'fresh'); assert.equal((await c.pending()).length, 0);
});
test('two tabs atomically claim one operation only once', async () => {
    const name = crypto.randomUUID(); let posts = 0;
    const send = async (url, options) => { posts++; await new Promise(r => setTimeout(r, 20)); return response({ ok: true, operation_id: options.headers['X-Offline-Id'] }); };
    const a = client(send, new Store(name)); const b = client(send, new Store(name));
    await enqueue(a); await Promise.all([a.sync(), b.sync()]); assert.equal(posts, 1);
});
test('419 refreshes the session and retries without changing operation identity', async () => {
    let posts = 0; let sessions = 0; const tokens = [];
    const c = new Client({ owner: 'alice', sessionUrl: '/session', store: new Store(crypto.randomUUID()), fetch: async (url, options) => {
        if (url === '/session') return response({ owner: 'alice', token: 'token' + ++sessions });
        tokens.push(options.body.get('_token'));
        return ++posts === 1 ? response({ message: 'Expired' }, 419) : response({ ok: true, operation_id: options.headers['X-Offline-Id'] });
    } });
    await enqueue(c); await c.sync(); assert.deepEqual(tokens, ['token1', 'token2']); assert.equal((await c.pending()).length, 0);
});
test('another signed-in account cannot send this account drafts', async () => {
    let posts = 0;
    const c = new Client({ owner: 'alice', sessionUrl: '/session', store: new Store(crypto.randomUUID()), fetch: async url => {
        if (url === '/session') return response({ owner: 'bob', token: 'bob-token' });
        posts++; return response({ ok: true });
    } });
    await enqueue(c); await c.sync(); assert.equal(posts, 0); assert.equal((await c.pending()).length, 1);
});
test('validation failure remains reviewable and is not retried automatically', async () => {
    let posts = 0; const c = client(() => { posts++; return response({ message: 'Invalid unit' }, 422); });
    const op = await enqueue(c); await c.sync(); await c.sync();
    assert.equal(posts, 1); assert.equal((await c.pending())[0].state, 'rejected');
    await c.discard(op.id); assert.equal((await c.pending()).length, 0);
});
test('a potentially saved request cannot be discarded', async () => {
    const c = client(() => { throw new TypeError('Lost reply'); }); const op = await enqueue(c); await c.sync();
    await assert.rejects(c.discard(op.id), /cannot be discarded/);
});
test('ordered edits wait for their predecessor receipt', async () => {
    const ids = []; const c = client((url, options) => { const id = options.headers['X-Offline-Id']; ids.push(id); return response({ ok: true, operation_id: id }); });
    const first = await enqueue(c);
    const second = await enqueue(c, { entries: [{ name: '_offline_predecessor', value: first.id }] });
    await c.sync(); await c.sync(); assert.deepEqual(ids, [first.id, second.id]);
});
test('transaction failure does not claim a draft was queued', async () => {
    const c = client(() => {}); await c.store.ready;
    c.store.transaction = async () => { throw new Error('Quota exceeded'); };
    await assert.rejects(enqueue(c), /Quota exceeded/);
});
test('reopening the database restores drafts and immutable queue entries', async () => {
    const name = crypto.randomUUID(); const a = client(() => {}, new Store(name));
    const op = await enqueue(a); await a.store.put('drafts', { id: 'editor', snapshot: { entries: [{ name: 'qty', value: '4' }] } });
    const b = client(() => {}, new Store(name));
    assert.equal((await b.pending())[0].id, op.id);
    assert.equal((await b.store.get('drafts', 'editor')).snapshot.entries[0].value, '4');
});
test('wrong operation acknowledgement is retained', async () => {
    const c = client(() => response({ ok: true, operation_id: 'some-other-id' }));
    await enqueue(c); await c.sync(); assert.equal((await c.pending()).length, 1);
});
