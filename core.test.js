import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, equal, mergeThreeWay, characterContent, characterPatch, applySuggestion, newEntry, snapshot } from '../core.js';
import { TavernBridge } from '../bridge.js';

test('merge retains unrelated live edits and unknown extension data', () => {
    const base = { entries: { 0: { content: 'old', key: ['a'], extension: { vendor: true } } }, opaque: 12 };
    const draft = clone(base), live = clone(base);
    draft.entries[0].content = 'new'; live.entries[0].key = ['b']; live.extra = { retained: true };
    const merged = mergeThreeWay(base, draft, live);
    assert.deepEqual(merged.conflicts, []);
    assert.equal(merged.value.entries[0].content, 'new');
    assert.deepEqual(merged.value.entries[0].key, ['b']);
    assert.equal(merged.value.entries[0].extension.vendor, true);
    assert.equal(merged.value.extra.retained, true);
    assert.equal(base.entries[0].content, 'old');
});
test('same-field concurrent edits are blocked, equal edits are accepted', () => {
    assert.deepEqual(mergeThreeWay({ text: 'a' }, { text: 'b' }, { text: 'c' }).conflicts, ['text']);
    assert.deepEqual(mergeThreeWay({ text: 'a' }, { text: 'b' }, { text: 'b' }).conflicts, []);
});
test('arrays are atomic to avoid corrupting ordered prompts or greetings', () => {
    assert.deepEqual(mergeThreeWay({ a: ['x', 'y'] }, { a: ['x'] }, { a: ['z', 'y'] }).conflicts, ['a']);
    assert.deepEqual(mergeThreeWay({ a: ['x', 'y'] }, { a: ['x'] }, { a: ['x', 'y'] }).value.a, ['x']);
});
test('card payload contains only edited fields with legacy mirrors', () => {
    const card = { avatar: 'test.png', data: { description: 'old', alternate_greetings: ['a', 'b'], extensions: { secretPlugin: 'keep' } } };
    const live = characterContent(card), next = clone(live);
    next.description = 'new'; next.alternate_greetings = [];
    assert.deepEqual(characterPatch(live, next, card.avatar), { avatar: 'test.png', description: 'new', data: { description: 'new', alternate_greetings: [] } });
    assert.equal(card.data.extensions.secretPlugin, 'keep');
});
test('AI suggestion replaces selection and cannot overwrite newer text', () => {
    assert.equal(applySuggestion('abc def ghi', 'abc def ghi', 4, 7, 'X'), 'abc X ghi');
    assert.equal(applySuggestion('abc', 'abc', 0, 3, 'X', true), 'abc\nX');
    assert.throws(() => applySuggestion('edited', 'original', 0, 8, 'X'), /原文已修改/);
});
test('world duplication preserves unknown fields but allocates fresh identity', () => {
    const entries = { 0: { uid: 0, comment: 'A', displayIndex: 5, content: 'x', unknown: { extension: true } }, 2: { uid: 2, displayIndex: 8 } };
    const uid = newEntry(entries, entries[0]);
    assert.equal(uid, 1); assert.equal(entries[1].displayIndex, 9);
    entries[1].unknown.extension = false;
    assert.equal(entries[0].unknown.extension, true);
});
test('history copies values and is bounded', () => {
    const doc = { draft: { text: 'x' }, history: [] };
    for (let i = 0; i < 15; i++) snapshot(doc, String(i));
    doc.draft.text = 'y';
    assert.equal(doc.history.length, 12); assert.equal(doc.history[0].value.text, 'x');
});
test('object order does not create false conflicts', () => {
    assert.ok(equal({ a: 1, b: 2 }, { b: 2, a: 1 }));
    assert.ok(!equal(['1'], { 0: '1' }));
});
test('bridge never reports a failed HTTP save as success', async () => {
    const bridge = new TavernBridge(); bridge.context = () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) });
    const before = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 500 });
    try { await assert.rejects(bridge.post('/api/characters/merge-attributes', {}), /500/); }
    finally { globalThis.fetch = before; }
});
test('generation uses existing Tavern pipeline and no independent credentials', async () => {
    const bridge = new TavernBridge(); let args;
    bridge.context = () => ({ characters: [{ avatar: 'x.png' }], characterId: 0, onlineStatus: 'connected', generateQuietPrompt: async a => { args = a; return 'answer'; } });
    assert.equal(await bridge.generate('edit this', 'x.png'), 'answer');
    assert.deepEqual(args, { quietPrompt: 'edit this', skipWIAN: false, quietToLoud: false });
    await assert.rejects(bridge.generate('edit this', 'other.png'), /角色已变更/);
});
test('active chat preset reads native prompt changes without storing connection secrets', async () => {
    const bridge = new TavernBridge();
    bridge.context = () => ({ chatCompletionSettings: { prompts: [{ content: 'unsaved native edit' }], prompt_order: [], proxy_password: 'never-store-this' } });
    bridge.manager = () => ({ getCompletionPresetByName: () => ({ prompts: [{ content: 'saved' }], proxy_password: 'also-not-stored' }), getSelectedPresetName: () => 'Writing', getPresetSettings: () => { throw new Error('Generic accessor does not support OpenAI'); } });
    const content = await bridge.read({ kind: 'preset', api: 'openai', id: 'Writing' });
    assert.deepEqual(content, { prompts: [{ content: 'unsaved native edit' }], prompt_order: [] });
    assert.equal(JSON.stringify(content).includes('password'), false);
});
test('world save is verified against the server before success is reported', async () => {
    const bridge = new TavernBridge(); let immediate;
    bridge.context = () => ({ saveWorldInfo: async (name, data, now) => { immediate = now; } });
    bridge.read = async () => ({ entries: {} });
    await assert.rejects(bridge.write({ kind: 'world', id: 'Lore' }, { entries: {} }, { entries: { 0: { content: 'new' } } }), /未能完整保存/);
    assert.equal(immediate, true);
});
