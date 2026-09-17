import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftStore, storageMessage } from '../storage.js';
const { IDBFactory } = await import(process.env.WW_IDB_MODULE || 'fake-indexeddb');
function fixture() {
    const values = new Map();
    const legacy = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const factory = new IDBFactory();
    const store = new DraftStore({ indexedDB: factory, legacy: () => legacy });
    return { values, legacy, factory, store };
}
test('large lorebook saves even when localStorage writes exceed quota', async () => {
    const { store, legacy, factory } = fixture();
    legacy.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    const draft = { body: '设定'.repeat(3 * 1024 * 1024), history: [] };
    await store.set('ww:account:world:large', draft);
    const reopened = new DraftStore({ indexedDB: factory, legacy: () => legacy });
    assert.deepEqual(await reopened.get('ww:account:world:large'), draft);
    (await store.open()).close(); (await reopened.open()).close();
});
test('legacy drafts migrate without clearing unrelated Tavern data', async () => {
    const { store, values } = fixture();
    values.set('ww:a:card', JSON.stringify({ draft: 'unsaved text' })); values.set('other-extension', 'keep');
    assert.deepEqual(await store.get('ww:a:card'), { draft: 'unsaved text' });
    assert.equal(values.has('ww:a:card'), false);
    assert.equal(values.get('other-extension'), 'keep');
    assert.deepEqual(await store.readRecord('ww:a:card'), { draft: 'unsaved text' });
    (await store.open()).close();
});
test('an aborted migration preserves the original and can retry', async () => {
    const { store, values } = fixture();
    values.set('ww:a:card', JSON.stringify({ draft: 'keep me' }));
    const db = await store.open(), transact = db.transaction.bind(db);
    db.transaction = (...args) => { const tx = transact(...args); if (args[1] === 'readwrite') queueMicrotask(() => tx.abort()); return tx; };
    assert.deepEqual(await store.get('ww:a:card'), { draft: 'keep me' });
    assert.ok(values.has('ww:a:card'));
    await assert.rejects(store.set('ww:a:card', { draft: 'new' }));
    db.transaction = transact;
    await store.set('ww:a:card', { draft: 'new' });
    assert.deepEqual(await store.get('ww:a:card'), { draft: 'new' });
    assert.equal(values.has('ww:a:card'), false);
    db.close();
});
test('queued saves preserve newest edits and clone submitted values', async () => {
    const { store } = fixture();
    const first = { draft: 'first' }; const one = store.set('ww:a', first); first.draft = 'mutated after save';
    const two = store.set('ww:a', { draft: 'last' });
    await Promise.all([one, two]); assert.deepEqual(await store.get('ww:a'), { draft: 'last' });
    (await store.open()).close();
});
test('storage error descriptions distinguish quota from browser restrictions', () => {
    assert.match(storageMessage({ name: 'QuotaExceededError' }), /空间不足/);
    assert.match(storageMessage({ name: 'SecurityError' }), /禁止/);
    assert.doesNotMatch(storageMessage(new Error('offline')), /空间不足/);
});
