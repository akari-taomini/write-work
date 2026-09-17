import test from 'node:test';
import assert from 'node:assert/strict';
import { exportPromptPack, importPromptPack, movePrompt } from '../preset-tools.js';
import { TavernBridge } from '../bridge.js';

const preset = () => ({ prompts: [
    { identifier: 'a', name: 'A', content: 'first', role: 'system', system_prompt: true, injection_depth: 8 },
    { identifier: 'b', name: 'B', content: 'second', role: 'user' },
    { identifier: 'history', name: 'history', marker: true },
], prompt_order: [
    { character_id: 100001, order: [{ identifier: 'b', enabled: false }, { identifier: 'a', enabled: true }] },
    { character_id: 100000, order: [{ identifier: 'a', enabled: false }] },
] });

test('selected pack imports fresh copies in source group order without overwriting target slots', () => {
    const source = preset(), target = preset(), before = structuredClone(target);
    const pack = exportPromptPack(source, ['a', 'b', 'history']);
    assert.equal(pack.prompts.length, 2);
    let n = 0;
    const { value, ids } = importPromptPack(target, pack, { anchor: 'a', side: 'before', idFactory: () => `new-${++n}` });
    assert.deepEqual(target, before);
    assert.deepEqual(value.prompts.slice(0, 3), before.prompts);
    assert.deepEqual(value.prompt_order[0].order.map(p => p.identifier), ['b', ...ids, 'a']);
    assert.deepEqual(value.prompt_order[0].order.map(p => p.enabled), [false, false, true, true]);
    assert.deepEqual(value.prompt_order[1], before.prompt_order[1]);
    assert.equal(value.prompts[3].content, 'second');
    assert.equal(value.prompts[4].injection_depth, 8);
    assert.equal(value.prompts[4].system_prompt, false);
});

test('malformed packs, ID collisions and missing anchors leave the target unchanged', () => {
    const target = preset(), before = structuredClone(target), pack = exportPromptPack(target, ['a']);
    assert.throws(() => importPromptPack(target, { ...pack, prompts: [...pack.prompts, ...pack.prompts] }), /重复编号/);
    assert.throws(() => importPromptPack(target, pack, { idFactory: () => 'a' }), /编号/);
    assert.throws(() => importPromptPack(target, pack, { anchor: 'missing' }), /目标条目不存在/);
    assert.throws(() => exportPromptPack(target, ['history']), /勾选/);
    assert.deepEqual(target, before);
});

test('moving a prompt changes only the selected group and keeps enabled flags', () => {
    const value = preset(), before = structuredClone(value);
    movePrompt(value, 'b', 'a', 'after', 0);
    assert.deepEqual(value.prompt_order[0].order, [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }]);
    assert.deepEqual(value.prompt_order[1], before.prompt_order[1]);
    assert.deepEqual(value.prompts, before.prompts);
});

test('new world creation blocks invalid or existing names and verifies the saved book', async () => {
    const bridge = new TavernBridge(); let refreshed = false;
    const calls = [];
    bridge.context = () => ({ updateWorldInfoList: async () => { refreshed = true; } });
    bridge.post = async (path, data) => {
        calls.push({ path, data });
        return { json: async () => path.endsWith('/list') ? [{ file_id: 'Existing' }] : { entries: {} } };
    };
    await assert.rejects(bridge.createWorld('../bad'), /有效/);
    assert.equal(calls.length, 0);
    await assert.rejects(bridge.createWorld('existing'), /同名/);
    assert.ok(!calls.some(c => c.path.endsWith('/edit')));
    assert.equal(await bridge.createWorld(' 新世界 '), '新世界');
    assert.equal(refreshed, true);
    assert.deepEqual(calls.find(c => c.path.endsWith('/edit')).data, { name: '新世界', data: { entries: {} } });
    assert.equal(calls.at(-1).path, '/api/worldinfo/get');
});
