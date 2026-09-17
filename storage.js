// IndexedDB avoids localStorage's small, shared string quota for large lorebooks.
// Old keys are removed only after the new transaction has committed successfully.
export class DraftStore {
    constructor({ indexedDB = globalThis.indexedDB, legacy = () => globalThis.localStorage } = {}) {
        this.factory = indexedDB;
        this.legacy = legacy;
        this.queues = new Map();
    }
    open() {
        if (!this.factory) return Promise.resolve(null);
        if (!this.opening) this.opening = new Promise((resolve, reject) => {
            const request = this.factory.open('writer-workbench', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('drafts');
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('本地草稿库被其他页面占用，请关闭其他酒馆标签页后重试。'));
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { db.close(); this.opening = null; };
                resolve(db);
            };
        }).catch(error => { this.opening = null; throw error; });
        return this.opening;
    }
    async readRecord(key) {
        const db = await this.open();
        if (!db) return undefined;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction('drafts', 'readonly');
            const request = transaction.objectStore('drafts').get(key);
            transaction.oncomplete = () => resolve(request.result);
            transaction.onabort = () => reject(transaction.error || request.error || new Error('读取本地草稿失败'));
            transaction.onerror = () => {};
        });
    }
    async writeRecord(key, value) {
        const db = await this.open();
        if (!db) { this.legacy().setItem(key, JSON.stringify(value)); return; }
        await new Promise((resolve, reject) => {
            const transaction = db.transaction('drafts', 'readwrite');
            const request = transaction.objectStore('drafts').put(value, key);
            transaction.oncomplete = resolve;
            transaction.onabort = () => reject(transaction.error || request.error || new Error('保存本地草稿失败'));
            transaction.onerror = () => {};
        });
        try { this.legacy().removeItem(key); } catch { /* A committed DB write is already durable. */ }
    }
    set(key, value) {
        const copy = structuredClone(value);
        const previous = this.queues.get(key) || Promise.resolve();
        const next = previous.catch(() => {}).then(() => this.writeRecord(key, copy));
        this.queues.set(key, next);
        const cleanup = () => { if (this.queues.get(key) === next) this.queues.delete(key); };
        next.then(cleanup, cleanup);
        return next;
    }
    async get(key) {
        await this.queues.get(key)?.catch(() => {});
        const stored = await this.readRecord(key);
        if (stored !== undefined) return stored;
        let raw;
        try { raw = this.legacy().getItem(key); }
        catch (error) { if (!this.factory) throw error; return null; }
        if (!raw) return null;
        const old = JSON.parse(raw);
        // A failed migration keeps the original intact and still permits editing/export.
        if (this.factory) { try { await this.set(key, old); } catch { /* Retry on next edit. */ } }
        return old;
    }
}

export function storageMessage(error) {
    if (error?.name === 'QuotaExceededError') return '本地草稿空间不足；内容仍在当前页面，可导出或直接写入酒馆。';
    if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') return '浏览器禁止本地草稿存储；内容仍在当前页面，可导出或直接写入酒馆。';
    return '本地草稿未能保存；内容仍在当前页面，可导出或直接写入酒馆。';
}
