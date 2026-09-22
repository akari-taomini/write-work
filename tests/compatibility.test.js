import test from 'node:test';
import assert from 'node:assert/strict';
import { TavernBridge } from '../bridge.js';
import { newRegex, evaluateRegex, previewDocument, RegexRunner } from '../regex-preview.js';

test('older world-list endpoint supports listing and creation without /worldinfo/list', async () => {
    const bridge = new TavernBridge(), books = new Map([['旧书', { entries: {} }]]), calls = [];
    bridge.context = () => ({});
    bridge.post = async (path, data) => {
        calls.push(path);
        if (path === '/api/settings/get') return { json: async () => ({ world_names: [...books.keys()] }) };
        if (path === '/api/worldinfo/edit') { books.set(data.name, data.data); return {}; }
        if (path === '/api/worldinfo/get') return { json: async () => books.get(data.name) };
        throw Error('404');
    };
    assert.deepEqual(await bridge.worlds(), ['旧书']);
    assert.equal(await bridge.createWorld('新书'), '新书');
    assert.deepEqual(await bridge.read({ kind: 'world', id: '新书' }), { entries: {} });
    assert.ok(!calls.includes('/api/worldinfo/list'));
});

test('world-list fallback accepts strings and objects; cached list never authorizes creation', async () => {
    const bridge = new TavernBridge(); bridge.context = () => ({ getWorldInfoNames: () => ['缓存书'] });
    bridge.post = async path => {
        if (path.endsWith('/settings/get')) throw Error('404');
        return { json: async () => ['A', { file_id: 'B', name: '显示名' }, { name: 'C' }] };
    };
    assert.deepEqual(await bridge.worlds(), ['A', 'B', 'C']);
    let edits = 0;
    bridge.post = async path => { if (path.endsWith('/edit')) edits++; throw Error('403'); };
    assert.deepEqual(await bridge.worlds(), ['缓存书']); assert.match(bridge.worldWarning, /刷新失败/);
    await assert.rejects(bridge.createWorld('新书'), /列表加载失败/);
    assert.equal(edits, 0);
    bridge.context = () => ({ getWorldInfoNames: () => [] });
    await assert.rejects(bridge.worlds(), /403/);
});

test('save scoped regex to a different character without changing chat or other extensions', async () => {
    const bridge = new TavernBridge(); let selected = 0; const refreshed = [];
    const scripts = [newRegex()];
    const cards = { 'a.png': { name: '聊天A', data: { extensions: { regex_scripts: [] } } }, 'b.png': { name: '编辑B', data: { extensions: { regex_scripts: scripts, world: '保留', custom: { x: 1 } } } } };
    bridge.context = () => ({ characters: [{ avatar: 'a.png' }, { avatar: 'b.png' }], characterId: 0, getOneCharacter: async avatar => refreshed.push(avatar), selectCharacterById: async () => selected++ });
    let patch;
    bridge.post = async (path, data) => {
        if (path.endsWith('/get')) return { json: async () => structuredClone(cards[data.avatar_url]) };
        patch = data;
        Object.assign(cards[data.avatar].data.extensions, data.data.extensions);
        return {};
    };
    const meta = { kind: 'regex', id: 'b.png' }, live = await bridge.read(meta);
    await bridge.write(meta, live, { scripts: [] });
    assert.deepEqual(patch, { avatar: 'b.png', data: { extensions: { regex_scripts: [] } } });
    assert.deepEqual(cards['b.png'].data.extensions, { regex_scripts: [], world: '保留', custom: { x: 1 } });
    assert.equal(selected, 0); assert.deepEqual(refreshed, ['b.png']);
    await assert.rejects(bridge.testChat('b.png'), /先在酒馆切到/);
});

test('regex preview preserves capture semantics, trim strings and basic bound-card macros', () => {
    const script = { ...newRegex(), findRegex: '/(?<mood>平静):(\\d+)/g', replaceString: '<b>{{char}}:$<mood>:$2:$0:{{match}}</b>', trimStrings: ['静'] };
    assert.deepEqual(evaluateRegex({ script, text: '平静:20', character: '编辑B' }), { html: '<b>编辑B:平:20:平:20:平:20</b>', count: 1, disabled: false });
    script.disabled = true;
    assert.equal(evaluateRegex({ script, text: '原文' }).html, '原文');
    script.disabled = false; script.findRegex = '/[/g';
    assert.throws(() => evaluateRegex({ script, text: 'test' }));
    const macroScript = { ...newRegex(), findRegex: '/{{char}}/g', substituteRegex: 2, replaceString: '匹配' };
    assert.equal(evaluateRegex({ script: macroScript, text: 'A.B AXB', character: 'A.B' }).html, '匹配 AXB');
});

test('preview document confines HTML to its sandbox and disables scripts and connections', () => {
    const html = previewDocument('```html\n<div>状态</div>\n```');
    assert.ok(html.includes('<div>状态</div>')); assert.ok(!html.includes('```'));
    assert.ok(html.includes("script-src 'none'")); assert.ok(html.includes("connect-src 'none'"));
});

test('runaway regex Worker is terminated instead of blocking the editing thread', async () => {
    const { Worker: NodeWorker } = await import('node:worker_threads');
    const oldWorker = globalThis.Worker, oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
    const blobs = new Map(); let terminations = 0;
    URL.createObjectURL = blob => { const id = crypto.randomUUID(); blobs.set(id, blob); return id; };
    URL.revokeObjectURL = id => blobs.delete(id);
    globalThis.Worker = class {
        constructor(url) {
            const blob = blobs.get(url); this.pending = blob.text().then(source => {
                if (this.stopped) return;
                this.worker = new NodeWorker(`const {parentPort}=require('node:worker_threads'); let onmessage; const postMessage = v => parentPort.postMessage(v); ${source}; parentPort.on('message',data=>onmessage({data}));`, { eval: true });
                this.worker.on('message', data => this.onmessage?.({ data }));
                this.worker.on('error', error => this.onerror?.(error));
            });
        }
        postMessage(data) { this.pending.then(() => this.worker?.postMessage(data)); }
        terminate() { this.stopped = true; terminations++; this.worker?.terminate(); }
    };
    const runner = new RegexRunner();
    try {
        await assert.rejects(runner.run({ script: { ...newRegex(), findRegex: '/(a+)+$/' }, text: 'a'.repeat(38) + '!' }), /超时/);
        assert.ok(terminations > 0);
        const result = await runner.run({ script: newRegex(), text: '<status>测试</status>', character: 'B' });
        assert.equal(result.count, 1); assert.ok(result.html.includes('测试'));
    } finally { runner.cancel(); globalThis.Worker = oldWorker; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});
