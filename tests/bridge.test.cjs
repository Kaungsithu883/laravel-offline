const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { indexedDB } = require('fake-indexeddb');
const crypto = require('node:crypto').webcrypto;
const fs = require('node:fs');

const offlineSource = fs.readFileSync(__dirname + '/../resources/offline.js', 'utf8');
const invoiceSource = fs.readFileSync(__dirname + '/../resources/invoice.js', 'utf8');
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const waitFor = async fn => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Condition timed out'); };

function page({ owner = crypto.randomUUID(), editing = false } = {}) {
    const dom = new JSDOM(`<form id="invoice-form" action="${editing ? '/invoice/update/7' : '/invoice/store'}">
        <input name="_token" value="stale"><input name="customer_id" required><input name="status" value="invoice">
        <div data-offline-repeat="lines"><div data-offline-row><input name="item_id[]"><input name="quantity[]"></div></div>
        <button type="button" data-offline-add-row="lines">Add row</button><button type="submit">Save</button>
    </form>`, { url: 'https://example.test/invoice/create', runScripts: 'outside-only' });
    const w = dom.window;
    Object.defineProperty(w, 'indexedDB', { value: indexedDB });
    Object.defineProperty(w, 'crypto', { value: crypto });
    w.Response = Response; w.fetch = async () => { throw new Error('offline'); };
    w.eval(offlineSource); w.eval(invoiceSource);
    const form = w.document.getElementById('invoice-form');
    form.querySelector('[data-offline-add-row]').addEventListener('click', () => {
        form.querySelector('[data-offline-repeat]').insertAdjacentHTML('beforeend', '<div data-offline-row><input name="item_id[]"><input name="quantity[]"></div>');
    });
    return { dom, w, form, owner, options: { owner, sessionUrl: '/session', workerUrl: '/worker', formId: 'invoice-form', editing, resource: editing ? 'invoice:7' : null, version: editing ? 'v1' : '', resetOnQueue: !editing } };
}

test('an offline submit is durably queued in IndexedDB and a create form resets only afterwards', async () => {
    const { dom, w, form, options } = page();
    const bridge = await w.OfflineInvoice.mount(options);
    try {
        form.elements.customer_id.value = '4'; form.elements['item_id[]'].value = '9'; form.elements['quantity[]'].value = '2';
        form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
        await waitFor(async () => (await bridge.client.pending()).length === 1);
        const operation = (await bridge.client.pending())[0];
        assert.equal(operation.entries.find(entry => entry.name === 'customer_id').value, '4');
        assert.equal(operation.entries.some(entry => entry.name === '_token'), false);
        assert.equal(form.elements.customer_id.value, '');
    } finally { bridge.stop(); dom.window.close(); }
});

test('the same queued operation syncs after connectivity returns and is removed from pending work', async () => {
    const { dom, w, form, options } = page();
    const bridge = await w.OfflineInvoice.mount(options);
    try {
        form.elements.customer_id.value = '4';
        form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
        await waitFor(async () => (await bridge.client.pending()).length === 1);
        bridge.client.fetch = async (url, request) => url === '/session'
            ? response({ owner: options.owner, token: 'fresh' })
            : response({ ok: true, operation_id: request.headers['X-Offline-Id'], invoice_no: 'INV-7' });
        await bridge.client.sync();
        assert.equal((await bridge.client.pending()).length, 0);
        assert.match(w.document.querySelector('[data-offline-invoice-status]').textContent, /synchronized/i);
    } finally { bridge.stop(); dom.window.close(); }
});

test('an offline edit records its version and orders a later edit after the first operation', async () => {
    const { dom, w, form, options } = page({ editing: true });
    const bridge = await w.OfflineInvoice.mount(options);
    try {
        form.elements.customer_id.value = '4';
        form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
        await waitFor(async () => (await bridge.client.pending()).length === 1);
        const first = (await bridge.client.pending())[0];
        assert.equal(first.entries.find(entry => entry.name === '_offline_version').value, 'v1');
        assert.equal(form.elements._offline_predecessor.value, first.id);
        form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
        await waitFor(async () => (await bridge.client.pending()).length === 2);
        const second = (await bridge.client.pending())[1];
        assert.equal(second.entries.find(entry => entry.name === '_offline_predecessor').value, first.id);
    } finally { bridge.stop(); dom.window.close(); }
});
