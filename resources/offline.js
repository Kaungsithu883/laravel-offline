/* Browser storage is account-scoped. Queued operations are immutable. */
(function (root) {
    'use strict';
    class Store {
        constructor(name, indexedDB = root.indexedDB) {
            this.ready = new Promise((resolve, reject) => {
                if (!indexedDB) return reject(new Error('This browser does not support offline storage.'));
                const request = indexedDB.open(name, 1);
                request.onupgradeneeded = () => {
                    for (const name of ['operations', 'drafts']) request.result.createObjectStore(name, { keyPath: 'id' });
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
                request.onblocked = () => reject(new Error('Close older tabs to upgrade offline storage.'));
            });
        }
        async transaction(name, mode, work) {
            const db = await this.ready;
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(name, mode);
                let result;
                transaction.oncomplete = () => resolve(result);
                transaction.onabort = () => reject(transaction.error || new Error('Offline storage write failed.'));
                transaction.onerror = () => {};
                try { work(transaction.objectStore(name), value => { result = value; }); }
                catch (error) { transaction.abort(); reject(error); }
            });
        }
        all(name) { return this.transaction(name, 'readonly', (store, done) => { store.getAll().onsuccess = e => done(e.target.result); }); }
        get(name, id) { return this.transaction(name, 'readonly', (store, done) => { store.get(id).onsuccess = e => done(e.target.result); }); }
        put(name, value) { return this.transaction(name, 'readwrite', store => store.put(value)); }
        remove(name, id) { return this.transaction(name, 'readwrite', store => store.delete(id)); }
        claim(id, now) {
            return this.transaction('operations', 'readwrite', (store, done) => {
                store.get(id).onsuccess = event => {
                    const entry = event.target.result;
                    if (!entry || !['pending', 'sending'].includes(entry.state) || (entry.leaseUntil || 0) > now) return done(null);
                    entry.state = 'sending'; entry.attempted = true; entry.leaseUntil = now + 60000;
                    store.put(entry); done(entry);
                };
            });
        }
    }
    class SyncError extends Error {
        constructor(message, status = 0) { super(message); this.status = status; }
    }
    function uuid() {
        if (root.crypto.randomUUID) return root.crypto.randomUUID();
        const bytes = root.crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    class Client extends EventTarget {
        constructor(options) {
            super(); this.options = options;
            this.store = options.store || new Store('sithu-offline-v1:' + options.owner);
            this.fetch = options.fetch || root.fetch.bind(root);
            this.running = false; this.delay = 5000;
        }
        notify(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
        async enqueue({ action, entries, resource, snapshot, id = uuid() }) {
            const url = new URL(action, root.location.href);
            if (url.origin !== root.location.origin) throw new Error('Offline actions must use the same origin.');
            if (entries.some(entry => typeof entry.value !== 'string')) throw new Error('File uploads are not supported by this form adapter.');
            const entry = { id, action: url.href, entries: entries.filter(e => e.name !== '_token'), resource,
                snapshot, createdAt: Date.now(), state: 'pending', attempted: false, leaseUntil: 0 };
            const queued = await this.store.transaction('operations', 'readwrite', (store, done) => {
                store.get(id).onsuccess = e => {
                    if (!e.target.result) store.add(entry);
                    done(e.target.result || entry);
                };
            });
            this.notify('change'); return queued;
        }
        async pending() { return (await this.store.all('operations')).filter(op => op.state !== 'synced').sort((a, b) => a.createdAt - b.createdAt); }
        async request(url, options = {}) {
            const abort = new AbortController();
            const timer = root.setTimeout(() => abort.abort(), 20000);
            try { return await this.fetch(url, { ...options, signal: abort.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }); }
            finally { root.clearTimeout(timer); }
        }
        async session() {
            const response = await this.request(this.options.sessionUrl, { headers: { Accept: 'application/json' } });
            if (!response.ok) throw new SyncError('Sign in again to sync your saved drafts.', response.status);
            const data = await response.json();
            if (data.owner !== this.options.owner) throw new SyncError('Sign in as the account that created these drafts.', 403);
            this.notify('session', data);
            return data;
        }
        async send(entry, session) {
            const body = new FormData();
            entry.entries.forEach(({ name, value }) => body.append(name, value));
            body.set('_token', session.token);
            const response = await this.request(entry.action, { method: 'POST', body, headers: {
                Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest',
                'X-Offline-Id': entry.id, 'X-Offline-Owner': this.options.owner,
            } });
            let data = {};
            if ((response.headers.get('content-type') || '').includes('application/json')) data = await response.json();
            if (!response.ok) throw new SyncError(data.message || 'The server could not save this draft.', response.status);
            if (data.ok !== true || data.operation_id !== entry.id) throw new SyncError('The server did not confirm this save. Your draft is retained.');
            return data;
        }
        async sync() {
            if (this.running) return;
            this.running = true;
            try {
                if (!(await this.pending()).length) return;
                let session = await this.session();
                for (const candidate of await this.pending()) {
                    const predecessor = candidate.entries.find(e => e.name === '_offline_predecessor')?.value;
                    if (predecessor && (await this.store.get('operations', predecessor))?.state !== 'synced') continue;
                    const entry = await this.store.claim(candidate.id, Date.now());
                    if (!entry) continue;
                    try {
                        let result;
                        try { result = await this.send(entry, session); }
                        catch (error) {
                            if (error.status !== 419) throw error;
                            session = await this.session(); result = await this.send(entry, session);
                        }
                        entry.state = 'synced'; entry.result = result; entry.error = null; entry.leaseUntil = 0;
                        await this.store.put('operations', entry);
                        this.notify('synced', entry);
                    } catch (error) {
                        entry.state = [400, 409, 422, 404].includes(error.status) ? 'rejected' : 'pending';
                        entry.error = error.message; entry.leaseUntil = 0;
                        await this.store.put('operations', entry);
                        this.notify('error', error);
                        if (entry.state === 'pending') { this.delay = Math.min(this.delay * 2, 60000); return; }
                    }
                    this.notify('change');
                }
                this.delay = 5000;
            } catch (error) {
                this.delay = Math.min(this.delay * 2, 60000); this.notify('error', error);
            } finally { this.running = false; this.notify('change'); }
        }
        start() {
            const tick = async () => { await this.sync(); this.timer = root.setTimeout(tick, this.delay); };
            this.online = () => this.sync(); root.addEventListener('online', this.online); tick();
        }
        stop() { root.clearTimeout(this.timer); root.removeEventListener('online', this.online); }
        async discard(id) {
            const entry = await this.store.get('operations', id);
            if (!entry || (entry.attempted && entry.state !== 'rejected')) throw new Error('A possibly saved operation cannot be discarded. Retry it to obtain its receipt.');
            if ((await this.pending()).some(op => op.entries.some(e => e.name === '_offline_predecessor' && e.value === id))) throw new Error('Remove the newer edits for this invoice first.');
            await this.store.remove('operations', id); this.notify('change');
        }
    }
    root.SithuOffline = { Client, Store, SyncError, uuid };
})(globalThis);
