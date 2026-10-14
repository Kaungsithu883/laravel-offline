/* Plug-and-play invoice form bridge. Application forms stay authoritative. */
(function (root) {
    'use strict';
    if (root.OfflineInvoice) { root.OfflineInvoice.scan(); return; }

    const mounted = new WeakMap();
    const decode = value => JSON.parse(decodeURIComponent(escape(root.atob(value))));
    const wait = milliseconds => new Promise(resolve => root.setTimeout(resolve, milliseconds));

    function serialize(form, submitter) {
        const temporarilyEnabled = [...form.querySelectorAll('[data-offline-include-disabled]:disabled')];
        temporarilyEnabled.forEach(element => { element.disabled = false; });
        try {
            const entries = [];
            for (const [name, value] of new FormData(form)) {
                if (name === '_token') continue;
                if (root.File && value instanceof root.File) {
                    if (value.size) throw new Error('Offline invoice attachments are not supported. Remove the file and try again.');
                    continue;
                }
                entries.push({ name, value: String(value) });
            }
            if (submitter?.name) entries.push({ name: submitter.name, value: submitter.value || '1' });
            return entries;
        } finally {
            temporarilyEnabled.forEach(element => { element.disabled = true; });
        }
    }

    function repeatCounts(form) {
        return [...form.querySelectorAll('[data-offline-repeat]')].map(container => ({
            name: container.dataset.offlineRepeat,
            count: container.querySelectorAll('[data-offline-row]').length,
        }));
    }

    function addButton(form, name) {
        return [...document.querySelectorAll('[data-offline-add-row]')]
            .find(button => button.dataset.offlineAddRow === name && (form.contains(button) || button.form === form));
    }

    async function ensureRepeats(form, repeats) {
        for (const repeat of repeats || []) {
            const container = [...form.querySelectorAll('[data-offline-repeat]')]
                .find(element => element.dataset.offlineRepeat === repeat.name);
            const button = addButton(form, repeat.name);
            if (!container || !button) continue;
            let previous = -1;
            while (container.querySelectorAll('[data-offline-row]').length < repeat.count) {
                const count = container.querySelectorAll('[data-offline-row]').length;
                if (count === previous) throw new Error('The invoice row template could not be restored.');
                previous = count; button.click(); await wait(0);
            }
        }
    }

    async function restore(form, snapshot) {
        if (!snapshot?.entries) return;
        await ensureRepeats(form, snapshot.repeats);
        const values = new Map();
        for (const entry of snapshot.entries) {
            if (!values.has(entry.name)) values.set(entry.name, []);
            values.get(entry.name).push(entry.value);
        }
        const indexes = new Map();
        for (const element of form.elements) {
            if (!element.name || element.name === '_token' || !values.has(element.name) || element.type === 'file') continue;
            const available = values.get(element.name);
            if (element.type === 'checkbox' || element.type === 'radio') {
                element.checked = available.includes(element.value);
                continue;
            }
            const index = indexes.get(element.name) || 0;
            indexes.set(element.name, index + 1);
            if (available[index] === undefined) continue;
            if (element.tagName === 'SELECT' && ![...element.options].some(option => option.value === available[index])) {
                element.add(new Option(available[index], available[index]));
            }
            element.value = available[index];
        }
        form.dispatchEvent(new CustomEvent('offline:invoice-restored', { bubbles: true, detail: snapshot }));
    }

    function hidden(form, name, value) {
        let input = form.elements.namedItem(name);
        if (!input) {
            input = document.createElement('input'); input.type = 'hidden'; input.name = name; form.append(input);
        }
        input.value = value || '';
        return input;
    }

    function interfaceFor(form) {
        const panel = document.createElement('section');
        panel.dataset.offlineInvoiceStatus = '';
        panel.setAttribute('role', 'status'); panel.setAttribute('aria-live', 'polite');
        panel.style.cssText = 'border:1px solid #cbd5e1;border-radius:.35rem;padding:.65rem;margin:.65rem 0;font:14px/1.4 sans-serif;';
        const message = document.createElement('span');
        const sync = document.createElement('button'); sync.type = 'button'; sync.textContent = 'Sync now'; sync.style.marginLeft = '.75rem';
        const details = document.createElement('details'); details.style.marginTop = '.4rem';
        const summary = document.createElement('summary'); summary.textContent = 'Saved invoices';
        const list = document.createElement('div'); details.append(summary, list); panel.append(message, sync, details);
        form.parentNode.insertBefore(panel, form);
        return { panel, message, sync, details, summary, list };
    }

    async function mount(options) {
        const form = document.getElementById(options.formId);
        if (!form || mounted.has(form)) return mounted.get(form);
        const client = new SithuOffline.Client(options);
        const ui = interfaceFor(form);
        const version = hidden(form, '_offline_version', options.version);
        const predecessor = hidden(form, '_offline_predecessor', '');
        const draftId = 'invoice-working:' + options.owner + ':' + new URL(form.action, location.href).pathname + ':' + (options.resource || (options.editing ? 'edit' : 'create'));
        let saving = false, dirty = false, timer, persistence = Promise.resolve();

        const snapshot = submitter => ({ entries: serialize(form, submitter), repeats: repeatCounts(form), savedAt: Date.now() });
        const announce = text => { ui.message.textContent = text; };
        const setBusy = busy => form.querySelectorAll('[type="submit"], [data-offline-save]').forEach(button => { button.disabled = busy; });
        const saveWorking = () => {
            dirty = true;
            persistence = persistence.catch(() => {}).then(() => client.store.put('drafts', { id: draftId, action: form.action, snapshot: snapshot() }))
                .then(() => { dirty = false; }).catch(error => { announce(error.message); throw error; });
            persistence.catch(() => {}); return persistence;
        };
        const schedule = () => { dirty = true; clearTimeout(timer); timer = setTimeout(saveWorking, 200); };

        async function refresh() {
            const pending = await client.pending();
            const ours = pending.filter(entry => entry.action === new URL(form.action, location.href).href);
            ui.summary.textContent = `${pending.length} saved invoice${pending.length === 1 ? '' : 's'} waiting or requiring review`;
            ui.list.replaceChildren();
            for (const entry of ours) {
                const row = document.createElement('div'); row.style.margin = '.35rem 0';
                row.append(document.createTextNode(`${new Date(entry.createdAt).toLocaleString()} — ${entry.state}${entry.error ? ': ' + entry.error : ''} `));
                const restoreButton = document.createElement('button'); restoreButton.type = 'button'; restoreButton.textContent = 'Restore';
                restoreButton.addEventListener('click', async () => { await saveWorking(); await restore(form, entry.snapshot || { entries: entry.entries }); predecessor.value = options.editing && entry.state !== 'rejected' ? entry.id : ''; });
                row.append(restoreButton); ui.list.append(row);
            }
            if (pending.length) announce(`${pending.length} invoice${pending.length === 1 ? '' : 's'} saved on this device. They will sync when the server is reachable.`);
        }

        async function queue(submitter) {
            if (saving) return;
            if (!form.checkValidity()) { form.reportValidity(); return; }
            const statusValue = submitter?.dataset.offlineStatusValue;
            if (statusValue && form.elements.namedItem('status')) form.elements.namedItem('status').value = statusValue;
            const before = new CustomEvent('offline:before-invoice-queue', { bubbles: true, cancelable: true, detail: { submitter } });
            if (!form.dispatchEvent(before)) return;
            saving = true; setBusy(true);
            try {
                clearTimeout(timer); await saveWorking();
                const saved = snapshot(submitter);
                const entry = await client.enqueue({ action: form.action, entries: saved.entries, resource: options.resource || (options.editing ? form.action : null), snapshot: saved });
                if (options.editing) { predecessor.value = entry.id; await saveWorking(); }
                else if (options.resetOnQueue) { form.reset(); await client.store.remove('drafts', draftId); dirty = false; }
                announce('Invoice saved safely on this device. Waiting for server confirmation.');
                form.dispatchEvent(new CustomEvent('offline:invoice-queued', { bubbles: true, detail: entry }));
                navigator.storage?.persist?.().catch(() => {});
                await refresh(); client.sync();
            } catch (error) { announce(error.message || String(error)); }
            finally { saving = false; setBusy(false); }
        }

        form.addEventListener('submit', event => { event.preventDefault(); queue(event.submitter); });
        form.addEventListener('click', event => {
            const button = event.target.closest('[data-offline-save]');
            if (!button || !form.contains(button)) return;
            event.preventDefault(); event.stopImmediatePropagation(); queue(button);
        }, true);
        form.addEventListener('input', schedule); form.addEventListener('change', schedule);
        root.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
        ui.sync.addEventListener('click', () => client.sync());
        client.addEventListener('change', () => refresh().catch(error => announce(error.message)));
        client.addEventListener('error', event => announce(event.detail.message));
        client.addEventListener('synced', event => {
            const result = event.detail.result || {};
            announce(`Invoice synchronized with the server${result.invoice_no ? ': ' + result.invoice_no : ''}.`);
            if (result.version) version.value = result.version;
            form.dispatchEvent(new CustomEvent('offline:invoice-synced', { bubbles: true, detail: event.detail }));
        });

        setBusy(true);
        try {
            await client.store.ready;
            const working = await client.store.get('drafts', draftId);
            if (working) await restore(form, working.snapshot);
            await refresh(); client.start();
            if ('serviceWorker' in navigator && root.isSecureContext) {
                const registration = await navigator.serviceWorker.register(options.workerUrl + '?owner=' + encodeURIComponent(options.owner), { scope: '/' });
                const worker = registration.installing || registration.waiting || registration.active;
                if (worker && worker.state !== 'activated') await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('Offline page preparation timed out.')), 30000);
                    worker.addEventListener('statechange', () => {
                        if (worker.state === 'activated') { clearTimeout(timeout); resolve(); }
                        if (worker.state === 'redundant') { clearTimeout(timeout); reject(new Error('Offline worker installation failed.')); }
                    });
                });
                const active = registration.active || navigator.serviceWorker.controller;
                if (active) active.postMessage({ type: 'CACHE_PAGE', url: location.href, owner: options.owner });
            }
        } catch (error) { announce(error.message || String(error)); }
        finally { setBusy(false); }

        const instance = { client, form, queue, restore: saved => restore(form, saved), refresh, stop: () => client.stop() };
        mounted.set(form, instance); return instance;
    }

    function scan() {
        document.querySelectorAll('[data-offline-invoice-config]').forEach(element => {
            if (element.dataset.offlineMounted) return;
            element.dataset.offlineMounted = '1';
            mount(decode(element.dataset.offlineInvoiceConfig)).catch(error => { element.hidden = false; element.textContent = error.message; });
        });
    }

    root.OfflineInvoice = { mount, scan, serialize, restore };
    scan();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, { once: true });
})(globalThis);
