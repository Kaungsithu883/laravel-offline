const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { indexedDB } = require('fake-indexeddb');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const integrationAvailable = fs.existsSync(root + '/public/js/invoice-offline.js');
const integrationTest = integrationAvailable ? test : test.skip;
const row = `<tr><td><input class="item_id" name="item_id[]"><input class="productname" name="part_number[]"><input name="part_description[]" class="description"><input name="product_qty[]" class="amnt" value="1"><select class="unit" name="item_unit[]"><option value="piece">piece</option></select><select class="price_category" name="price_category[]" disabled><option value="retail1">Retail</option><option value="wholesale">Wholesale</option></select><input class="price" name="product_price[]" value="0"><input class="retail_price" name="retail_price[]" value="0"><input class="buy_price" name="buy_price[]" value="0"><input class="retail2_price" name="retail2_price[]"><input class="retail3_price" name="retail3_price[]"></td></tr>`;
const deposit = `<div class="deposit-payment-row"><input class="deposit_payment_amount" name="deposit_payment_amount[]"><select name="deposit_payment_method[]"><option>Cash</option><option>Bank</option></select></div>`;
function page(editing = false) {
    const dom = new JSDOM(`<div id="connectionStatusTitle"></div><div id="connectionStatusMessage"></div><div id="offlineDraftNotice"><b id="offlineDraftTitle"></b><span id="offlineDraftMessage"></span></div><form id="test-form" action="${editing ? '/invoice_update/1' : '/invoice_register'}"><input name="_token" value="old"><input id="name" name="customer_name"><input name="customer_id"><input name="status" value="invoice"><input name="total" value="0"><input name="deposit" value="0"><input name="balance" value="0"><table><tbody id="showitem123">${row}</tbody></table><div id="deposit_payment_rows">${deposit}</div><button id="addproduct" type="button">Add</button><button id="submitButton" type="button">Save</button><button id="suspend" type="button">Suspend</button></form>`, { url: 'https://example.test/invoice_reg', runScripts: 'outside-only' });
    const w = dom.window; w.indexedDB = indexedDB;
    w.fetch = async () => { throw new Error('Server unavailable'); };
    w.eval(fs.readFileSync(root + '/public/backend/js/jquery191.js', 'utf8'));
    w.eval(fs.readFileSync(__dirname + '/../resources/offline.js', 'utf8'));
    w.eval(fs.readFileSync(root + '/public/js/invoice-offline.js', 'utf8'));
    w.Swal = { fire: async () => ({ isConfirmed: true }) };
    w.buildDepositPaymentRow = () => deposit;
    w.updateDepositPaymentTotal = () => {};
    w.document.getElementById('addproduct').onclick = () => w.document.getElementById('showitem123').insertAdjacentHTML('beforeend', row);
    const options = { owner: require('node:crypto').randomUUID(), formId: 'test-form', sessionUrl: '/session', version: editing ? 'version1' : '', editing };
    const fill = () => {
        w.document.getElementById('name').value = 'Customer';
        w.document.querySelector('[name="customer_id"]').value = '3';
        w.document.querySelector('.item_id').value = '5';
        w.document.querySelector('.productname').value = 'Item';
        w.document.querySelector('.amnt').value = '2';
    };
    return { dom, w, options, fill };
}
async function waitFor(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Condition timed out'); }

integrationTest('save with an unreachable server queues exactly once, preserves disabled price categories, then clears the form', async () => {
    const { dom, w, options, fill } = page();
    try {
        await w.InvoiceOffline.mount(options); fill();
        w.document.getElementById('submitButton').click(); w.document.getElementById('submitButton').click();
        await waitFor(async () => (await w.invoiceOfflineClient.pending()).length === 1 && w.document.getElementById('name').value === '');
        const pending = await w.invoiceOfflineClient.pending();
        assert.equal(pending.length, 1); assert.equal(pending[0].entries.find(e => e.name === 'price_category[]').value, 'retail1');
        assert.equal(pending[0].entries.some(e => e.name === '_token'), false);
        assert.equal(w.location.pathname, '/invoice_reg');
    } finally { w.invoiceOfflineClient.stop(); dom.window.close(); }
});
integrationTest('storage failure keeps entered values and never reports the form saved', async () => {
    const { dom, w, options, fill } = page();
    try {
        await w.InvoiceOffline.mount(options); fill();
        const original = w.invoiceOfflineClient.store.transaction.bind(w.invoiceOfflineClient.store);
        w.invoiceOfflineClient.store.transaction = (name, mode, callback) => name === 'operations' && mode === 'readwrite' ? Promise.reject(new Error('Quota exceeded')) : original(name, mode, callback);
        w.document.getElementById('submitButton').click();
        await waitFor(() => w.document.getElementById('offlineDraftMessage').textContent.includes('Quota exceeded'));
        assert.equal(w.document.getElementById('name').value, 'Customer'); assert.equal((await w.invoiceOfflineClient.pending()).length, 0);
    } finally { w.invoiceOfflineClient.stop(); dom.window.close(); }
});
integrationTest('refresh restores two item rows, units, split payments and edit predecessor', async () => {
    const { dom, w, options } = page(true);
    try {
        const action = w.document.querySelector('form').action;
        w.sessionStorage.setItem('invoice-editor:' + options.owner + ':' + action, 'editor1');
        const store = new w.SithuOffline.Store('sithu-offline-v1:' + options.owner);
        await store.put('drafts', { id: 'editor1', action, snapshot: { entries: [
            { name: 'customer_name', value: 'Restored customer' }, { name: 'customer_id', value: '3' },
            { name: 'item_id[]', value: '5' }, { name: 'item_id[]', value: '6' },
            { name: 'item_unit[]', value: 'box' }, { name: 'item_unit[]', value: 'piece' },
            { name: 'product_qty[]', value: '2' }, { name: 'product_qty[]', value: '7' },
            { name: 'deposit_payment_amount[]', value: '10' }, { name: 'deposit_payment_amount[]', value: '20' },
            { name: 'deposit_payment_method[]', value: 'Bank' }, { name: 'deposit_payment_method[]', value: 'Cash' },
            { name: '_offline_predecessor', value: 'earlier-operation' },
        ], rows: [{ stock: { id: 5 }, units: [{ value: 'box', text: 'box' }] }, { stock: { id: 6 }, units: [{ value: 'piece', text: 'piece' }] }], deposits: 2 } });
        await w.InvoiceOffline.mount(options);
        assert.equal(w.document.querySelectorAll('#showitem123 tr').length, 2);
        assert.deepEqual([...w.document.querySelectorAll('.amnt')].map(el => el.value), ['2', '7']);
        assert.equal(w.document.querySelector('.unit').value, 'box');
        assert.deepEqual([...w.document.querySelectorAll('.deposit_payment_amount')].map(el => el.value), ['10', '20']);
        assert.equal(w.document.querySelector('[name="_offline_predecessor"]').value, 'earlier-operation');
        assert.equal(w.$('#showitem123 tr:first').data('stock-item').id, 5);
    } finally { w.invoiceOfflineClient.stop(); dom.window.close(); }
});
integrationTest('offline unit prices use the selected price category and retain zero prices', () => {
    const { dom, w } = page();
    try {
        const r = w.$('#showitem123 tr:first');
        r.data('stock-item', { name1: 'piece', name2: 'box', retail1: 7, wholesale1: 0, price1: 2, retail2_1: 9, retail3_1: 11 });
        r.find('.price_category').append('<option value="retail2">Retail 2</option>').val('retail2');
        w.InvoiceOffline.applyUnitPrices(r); assert.equal(r.find('.retail_price').val(), '9'); assert.equal(r.find('.price').val(), '0'); assert.equal(r.find('.buy_price').val(), '2');
    } finally { dom.window.close(); }
});
