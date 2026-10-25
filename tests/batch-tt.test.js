import test from 'node:test';
import assert from 'node:assert/strict';
import { TtBatchService, ttHash } from '../src/batch/batch-tt.js';
import { batchHost } from '../src/batch/batch-runtime.js';
import { zipSync } from '../vendor/fflate.js';
import { BatchPanel } from '../src/batch/batch-panel.js';
import { editableFields, setAt } from '../src/batch/batch-adapters.js';
globalThis.__WW_TEST__ = true;
const { Workbench } = await import('../index.js');

function fixture() {
    const values = new Map(), blobs = new Map(); let root = '/current-tt-data', requests = 0;
    const key = options => `${options.table || 'main'}/${options.key}`;
    const store = {
        async tryGetJson(o) { return { found: values.has(key(o)), value: structuredClone(values.get(key(o))) }; },
        async getJson(o) { if (!values.has(key(o))) throw Error('missing'); return structuredClone(values.get(key(o))); },
        async setJson(o) { values.set(key(o), JSON.parse(JSON.stringify(o.value))); },
        async listKeys(o) { return [...values.keys()].filter(k => k.startsWith(`${o.table}/`)).map(k => k.slice(o.table.length + 1)); },
        async getBlob(o) { if (!blobs.has(o.key)) throw Error('missing'); return blobs.get(o.key); },
        async setBlob(o) { blobs.set(o.key, new Blob([o.data])); },
    };
    const host = { __TAURITAVERN_HOST__: { kind: 'desktop' }, __TAURITAVERN__: { abiVersion: 2, ready: Promise.resolve(), api: { extension: { store } }, invoke: { safeInvoke: async () => ({ data_root: root }) } } };
    const service = new TtBatchService({ host, context: () => ({ getRequestHeaders: () => ({}) }), fetcher: async () => { requests++; throw Error('Unexpected business request'); } });
    const resource = { id: 'tt:world:test', adapter: 'world', name: 'test', relative: '世界书 · test' };
    service.inventory = async () => ({ resources: [resource] });
    return { service, host, values, blobs, resource, changeRoot: value => { root = value; }, requestCount: () => requests };
}
async function archive(f, overrides = {}, corrupt = false) {
    const before = { entries: { 0: { content: '顾北辰' } } }, after = { entries: { 0: { content: '沈辞' } } };
    const prefix = 'a'.repeat(36), id = crypto.randomUUID();
    const record = { resource: f.resource, backup: `${prefix}.before.json`, after: `${prefix}.after.json`, beforeHash: await ttHash(before), afterHash: await ttHash(after), state: 'committed' };
    const manifest = { version: 1, host: 'tt', id, root: f.service.root, dataset: f.service.dataset, status: 'complete', files: [record], ...overrides };
    return { record, manifest, blob: new Blob([zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)), [record.backup]: new TextEncoder().encode(JSON.stringify(corrupt ? after : before)), [record.after]: new TextEncoder().encode(JSON.stringify(after)) })]) };
}

test('TT markers cannot select the PC server adapter and unknown Tauri fails closed', () => {
    assert.equal(batchHost({ __TAURITAVERN__: {} }), 'tt');
    assert.equal(batchHost({ __TAURI_RUNNING__: true }), 'tt');
    assert.throws(() => batchHost({ __TAURI_INTERNALS__: {} }));
    assert.equal(batchHost({}), 'st');
});
test('workbench loading preserves TT scope restrictions and Select All cannot re-enable unsupported scopes', async () => {
    const supported = ['persona', 'chats', 'character', 'greetings', 'world'];
    const inputs = [...supported, 'prompts', 'presets', 'regex', 'other'].map(value => ({ value, checked: false, disabled: false }));
    const batch = Object.assign(Object.create(BatchPanel.prototype), { inventory: { supportedScopes: supported }, panel: { querySelectorAll: selector => selector.includes(':checked') ? inputs.filter(i => i.checked) : inputs }, $: () => ({}), invalidate() {}, async persist() {} });
    const app = Object.assign(Object.create(Workbench.prototype), { batch, message() {}, dialog: { querySelectorAll: () => inputs, setAttribute() {}, removeAttribute() {} }, $: () => ({}), editor: {}, doc: {} });
    await app.run(async () => batch.syncScopeCapabilities());
    assert(inputs.filter(i => !supported.includes(i.value)).every(i => i.disabled && !i.checked));
    await batch.action('all-scopes', {}); assert.deepEqual(batch.scopes(), supported);
});
test('changed TT data root blocks writes without any fallback request', async () => {
    const f = fixture(); await f.service.init(); f.changeRoot('/another-tt-dataset');
    await assert.rejects(f.service.assertTarget(), /目录已改变/); assert.equal(f.requestCount(), 0);
});
test('imported dataset requires registration, archives its marker, isolates old recovery and permits a new batch', async () => {
    const f = fixture(), old = { id: crypto.randomUUID(), root: '/old-tt-data' };
    f.values.set('main/dataset', old); await f.service.init(); delete f.service.inventory;
    const inventory = await f.service.inventory(); assert.equal(inventory.datasetBinding.previousRoot, old.root);
    await assert.rejects(f.service.scan({}), /登记/); await assert.rejects(f.service.apply({ id: 'old-job' }), /登记/);
    await assert.rejects(f.service.registerDataset({ confirm: false, previousId: old.id, root: f.service.root }));
    const a = await archive(f, { dataset: old.id, root: old.root });
    f.values.set(`transactions/${a.manifest.id}`, a.manifest);
    const entries = (await import('../vendor/fflate.js')).unzipSync(new Uint8Array(await a.blob.arrayBuffer()));
    for (const key of [a.record.backup, a.record.after]) f.blobs.set(key, new Blob([entries[key]]));
    const registered = await f.service.registerDataset({ confirm: true, previousId: old.id, root: f.service.root });
    assert.notEqual(registered.id, old.id); assert.equal(f.values.get(`datasets/${registered.id}`).previous.id, old.id);
    assert.equal((await f.service.backups())[0].status, 'foreign');
    await assert.rejects(f.service.restore({ id: a.manifest.id }), /禁止直接恢复/);
    await assert.rejects(f.service.importBackup(a.blob), /不属于/);
    assert((await f.service.download(a.manifest.id)).size > 0); assert.equal(f.requestCount(), 0);
    let world = { entries: { 0: { content: '顾北辰' } } };
    f.service.inventory = async () => ({ resources: [f.resource] });
    f.service.fetcher = async (url, options) => {
        if (url === '/api/settings/get') return Response.json({ settings: '{}', world_names: ['test'] });
        if (url === '/api/worldinfo/get') return Response.json(world);
        assert.equal(url, '/api/worldinfo/edit'); world = JSON.parse(options.body).data; return Response.json({ ok: true });
    };
    const scan = await f.service.scan({ rules: [{ find: '顾北辰', replace: '沈辞' }], mode: 'local', fileIds: [f.resource.id], scopes: ['world'] });
    await f.service.job(scan.id).done; const applied = await f.service.apply({ id: scan.id });
    assert.equal(world.entries[0].content, '沈辞'); await f.service.restore({ id: applied.id }); assert.equal(world.entries[0].content, '顾北辰');
    assert.equal(await f.blobs.get(a.record.backup).text(), new TextDecoder().decode(entries[a.record.backup]));
});
test('dataset registration stops on a changed target, concurrent marker or failed provenance archive', async () => {
    for (const fault of ['directory', 'marker', 'archive']) {
        const f = fixture(), old = { id: crypto.randomUUID(), root: '/old-tt-data' };
        f.values.set('main/dataset', old); await f.service.init();
        if (fault === 'directory') f.changeRoot('/different-data');
        if (fault === 'marker') f.values.set('main/dataset', { ...old, id: crypto.randomUUID() });
        if (fault === 'archive') { const store = f.host.__TAURITAVERN__.api.extension.store; store.setJson = async () => { throw Error('storage failure'); }; }
        const before = structuredClone(f.values.get('main/dataset'));
        await assert.rejects(f.service.registerDataset({ confirm: true, previousId: old.id, root: f.service.root }));
        assert.deepEqual(f.values.get('main/dataset'), before); assert.equal(f.requestCount(), 0);
    }
});
test('mobile import registers only its current sandbox without calling desktop path commands', async () => {
    const f = fixture(), old = { id: crypto.randomUUID(), root: '/desktop-data' };
    f.values.set('main/dataset', old); f.host.__TAURITAVERN_HOST__.kind = 'mobile';
    f.host.__TAURITAVERN__.invoke.safeInvoke = async () => { throw Error('desktop command must not run'); };
    await f.service.init(); assert(f.service.bindingConflict);
    await f.service.registerDataset({ confirm: true, previousId: old.id, root: 'tt-current-mobile-sandbox' });
    await f.service.assertTarget(); assert.equal(f.values.get('main/dataset').root, 'tt-current-mobile-sandbox');
});
test('orphan chat branches retain a stable identity and a persistable backup manifest', async () => {
    const f = fixture(); await f.service.init(); delete f.service.inventory;
    f.host.__TAURITAVERN__.invoke.safeInvoke = async command => command === 'get_runtime_paths' ? { data_root: '/current-tt-data' } : [{ character_name: 'orphan', file_name: 'branch.jsonl' }];
    f.service.fetcher = async path => new Response(JSON.stringify(path === '/api/settings/get' ? { settings: JSON.stringify({ power_user: { personas: {} } }), world_names: [] } : []));
    const { resources } = await f.service.inventory(); assert.equal(resources.length, 1);
    assert.equal(resources[0].id, 'tt:chat:orphan:branch');
    const manifest = { version: 1, host: 'tt', id: crypto.randomUUID(), dataset: f.service.dataset, root: f.service.root, files: [{ resource: resources[0] }] };
    await f.service.saveManifest(manifest); assert.equal((await f.service.manifest(manifest.id)).files[0].resource.id, resources[0].id);
});
test('active persona changes include its explicit username cache and restore without touching another identity', async () => {
    const f = fixture(); await f.service.init();
    let state = { user_avatar: 'selected.png', username: '顾北辰', power_user: { persona_description: '顾北辰的身份', personas: { 'selected.png': '顾北辰', 'other.png': '顾北辰' }, persona_descriptions: { 'selected.png': { description: '顾北辰的身份', keep: 'unknown' }, 'other.png': { description: '顾北辰的身份' } } } };
    f.service.fetcher = async (path, options) => {
        if (path === '/api/settings/get') return Response.json({ settings: JSON.stringify(state), tauritavern_settings_revision: { version: 1 } });
        assert.equal(path, '/api/settings/save');
        const saved = JSON.parse(options.body), names = { ...state.power_user.personas, ...saved.power_user.personas }, desc = { ...state.power_user.persona_descriptions, ...saved.power_user.persona_descriptions };
        state = saved; state.power_user.personas = names; state.power_user.persona_descriptions = desc;
        return Response.json({ result: 'ok' });
    };
    const resource = { avatarId: 'selected.png', adapter: 'settings', id: 'selected', relative: 'selected' }, before = await f.service.read(resource), after = structuredClone(before);
    const fields = editableFields(after, resource).filter(f => f.scope === 'persona'); assert.equal(fields.length, 4);
    for (const field of fields) setAt(after, field.path, field.text.replaceAll('顾北辰', '沈辞'));
    await f.service.write(resource, after, await ttHash(before));
    assert.equal(state.username, '沈辞'); assert.equal(state.power_user.persona_description, '沈辞的身份');
    assert.equal(state.power_user.personas['other.png'], '顾北辰'); assert.equal(state.power_user.persona_descriptions['selected.png'].keep, 'unknown');
    await f.service.write(resource, before, await ttHash(after)); assert.equal(state.username, '顾北辰');
});
test('linked lorebook cards use stored data, back up raw PNG and roll back a save with lost response', async () => {
    const f = fixture(); await f.service.init();
    const stored = { spec: 'chara_card_v2', data: { name: 'card', description: '顾北辰', extensions: { world: 'linked', private_data: { keep: true } }, character_book: { entries: [{ id: 1, content: '顾北辰的旧条目' }] } } };
    const paths = [], png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    f.service.fetcher = async (url, options) => {
        paths.push(url);
        if (url === '/api/characters/get') return Response.json({ data: { character_book: { entries: [{ content: 'different projected value' }] } }, json_data: JSON.stringify(stored) });
        if (url === '/characters/card.png') return new Response(png);
        if (url === '/api/characters/merge-attributes') { stored.data = JSON.parse(options.body).data; return Response.json({ ok: true }); }
        throw Error(`Unexpected endpoint ${url}`);
    };
    const resource = { adapter: 'character', id: 'card', avatar: 'card.png', relative: 'card' };
    const before = await f.service.read(resource), after = structuredClone(before); after.data.character_book.entries[0].content = '沈辞的旧条目';
    assert.equal(before.data.extensions.private_data.keep, true);
    assert.deepEqual(new Uint8Array(await (await f.service.originalBlob(resource)).arrayBuffer()), png);
    await f.service.write(resource, after, await ttHash(before)); assert.equal(stored.data.character_book.entries[0].content, '沈辞的旧条目');
    await f.service.write(resource, before, await ttHash(after)); assert.equal(stored.data.character_book.entries[0].content, '顾北辰的旧条目');
    f.service.inventory = async () => ({ resources: [resource] });
    const scan = await f.service.scan({ rules: [{ find: '顾北辰', replace: '沈辞' }], scopes: ['world'], mode: 'local', fileIds: ['card'] });
    await f.service.job(scan.id).done;
    const actual = f.service.fetcher; let interrupted = false;
    f.service.fetcher = async (...args) => {
        const response = await actual(...args);
        if (args[0] === '/api/characters/merge-attributes' && !interrupted) { interrupted = true; throw Error('saved, response interrupted'); }
        return response;
    };
    await assert.rejects(f.service.apply({ id: scan.id }), /已提交项已恢复/);
    assert.equal(await ttHash(await f.service.read(resource)), await ttHash(before));
    const backups = await f.service.backups(); assert.equal(backups[0].files[0].state, 'restored');
    assert.equal(paths.some(p => p.includes('/export')), false);
});
test('backup import isolates payload keys, verifies disk readback and leaves existing backups intact', async () => {
    const f = fixture(); await f.service.init(); const a = await archive(f);
    await f.host.__TAURITAVERN__.api.extension.store.setBlob({ key: a.record.backup, data: 'existing recovery data' });
    const result = await f.service.importBackup(a.blob), imported = await f.service.manifest(result.id);
    assert.notEqual(imported.files[0].backup, a.record.backup);
    assert.equal(await f.blobs.get(a.record.backup).text(), 'existing recovery data');
    assert.equal(await ttHash(await f.service.getValue(imported.files[0].backup)), a.record.beforeHash);
    assert.equal(f.requestCount(), 0);
    await assert.rejects(f.service.importBackup(a.blob), /已存在/);
});
test('corrupt or foreign backup never publishes a recovery manifest or changes business data', async () => {
    for (const foreign of [false, true]) {
        const f = fixture(); await f.service.init(); const a = await archive(f, foreign ? { dataset: 'foreign' } : {}, !foreign);
        await assert.rejects(f.service.importBackup(a.blob), foreign ? /不属于/ : /校验失败/);
        assert.equal(f.values.has(`transactions/${a.manifest.id}`), false); assert.equal(f.blobs.size, 0); assert.equal(f.requestCount(), 0);
    }
});
