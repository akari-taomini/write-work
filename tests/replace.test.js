import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, readPath } from '../core.js';

globalThis.__WW_TEST__ = true;
const { Workbench } = await import('../index.js');

// Exercise real field enumeration, replacement, click dispatch and undo. Only
// browser rendering and storage are substituted, so these tests need no Tavern.
function workbench(kind, draft, scope = kind) {
    const app = Object.create(Workbench.prototype);
    app.tab = kind;
    app.doc = { meta: { kind, id: 'test' }, base: clone(draft), draft: clone(draft) };
    app.presetGroupIndex = 0;
    app.field = app.fields()[0];
    app.editor = { value: app.field ? readPath(draft, app.field.path) : '' };
    const controls = {
        '.ww-find': { value: '旧称' }, '.ww-replace': { value: '新称' },
        '.ww-replace-scope': { value: scope }, '.ww-filter': { value: '仅显示这一条' },
    };
    app.$ = selector => controls[selector];
    app.message = text => { app.feedback = text; };
    app.persist = async () => { app.saved = clone(app.doc.draft); return true; };
    app.renderList = id => {
        app.renderedId = id;
        app.field = app.fields().find(f => f.id === id) || app.fields()[0];
        app.editor.value = app.field ? readPath(app.doc.draft, app.field.path) : '';
    };
    app.run = task => task();
    app.press = action => app.click({ target: { closest: () => ({ dataset: { action } }) } });
    return app;
}

const world = () => ({ name: '旧称世界', entries: {
    0: { content: '旧称和旧称', comment: '仅显示这一条', key: ['旧称'], disable: false },
    7: { content: '旧称的秘密', comment: '被隐藏', key: [], disable: true, order: 77 },
    9: { content: '没有匹配', comment: '其他' },
} });

test('world scope replaces hidden and disabled bodies, preserves metadata, persists and undoes as one batch', async () => {
    const original = world(), app = workbench('world', original);
    assert.equal(app.visibleFields().length, 1);
    await app.press('replace');
    const expected = clone(original);
    expected.entries[0].content = '新称和新称';
    expected.entries[7].content = '新称的秘密';
    assert.deepEqual(app.doc.draft, expected);
    assert.deepEqual(app.saved, expected);
    assert.deepEqual(app.doc.base, original);
    assert.equal(app.editor.value, '新称和新称');
    assert.equal(app.renderedId, '0');
    assert.match(app.feedback, /3 处.*2 个条目/);
    assert.equal(app.doc.undo.length, 1);
    await app.press('undo');
    assert.deepEqual(app.doc.draft, original);
    assert.deepEqual(app.saved, original);
});

test('preset scope includes disabled, other-group and unreferenced prompts, skips markers', async () => {
    const draft = { prompts: [
        { identifier: 'a', name: '仅显示这一条', content: '旧称', system_prompt: true },
        { identifier: 'b', name: '停用', content: '旧称' },
        { identifier: 'c', name: '其他组', content: '旧称' },
        { identifier: 'd', name: '无引用', content: '旧称' },
        { identifier: 'm', name: '占位', content: '旧称', marker: true },
    ], prompt_order: [
        { character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }] },
        { character_id: 100000, order: [{ identifier: 'c', enabled: true }] },
    ] };
    const app = workbench('preset', draft);
    // Starting on a non-editable marker must still allow all-entry replacement.
    app.field = app.fields().find(f => f.marker);
    await app.press('replace');
    assert.deepEqual(app.doc.draft.prompts.map(p => p.content), ['新称', '新称', '新称', '新称', '旧称']);
    assert.deepEqual(app.doc.draft.prompt_order, draft.prompt_order);
    assert.equal(app.doc.draft.prompts[0].system_prompt, true);
    assert.match(app.feedback, /4 处.*4 个条目/);
});

test('current scope only replaces the selected body', async () => {
    const app = workbench('world', world(), 'current');
    await app.press('replace');
    assert.equal(app.doc.draft.entries[0].content, '新称和新称');
    assert.equal(app.doc.draft.entries[7].content, '旧称的秘密');
    assert.match(app.feedback, /2 处.*1 个条目/);
});

test('text-completion presets use all editable text fields', async () => {
    const app = workbench('preset', { system_prompt: '旧称', input_prefix: '旧称', temperature: 1 });
    await app.replaceAll();
    assert.deepEqual(app.doc.draft, { system_prompt: '新称', input_prefix: '新称', temperature: 1 });
});

test('replacement is literal, case sensitive, non-recursive and accepts empty replacement', async () => {
    const app = workbench('world', { entries: { 0: { content: 'a.* a.* A.*' } } });
    app.$('.ww-find').value = 'a.*';
    app.$('.ww-replace').value = '$& a.*';
    await app.replaceAll();
    assert.equal(app.editor.value, '$& a.* $& a.* A.*');
    app.$('.ww-replace').value = '';
    await app.replaceAll();
    assert.equal(app.editor.value, '$&  $&  A.*');
});

test('empty query and stale scope cannot mutate the draft', async () => {
    const original = world(), app = workbench('world', original);
    app.$('.ww-find').value = '';
    await assert.rejects(app.replaceAll(), /请输入/);
    app.$('.ww-find').value = '旧称';
    app.$('.ww-replace-scope').value = 'preset';
    await assert.rejects(app.replaceAll(), /范围已失效/);
    assert.deepEqual(app.doc.draft, original);
    assert.equal(app.doc.undo, undefined);
});

test('no matches, identical text, empty documents and current markers create no undo entries', async () => {
    const cases = [workbench('world', world()), workbench('world', world()), workbench('world', { entries: {} }),
        workbench('preset', { prompts: [{ identifier: 'm', content: '旧称', marker: true }] }, 'current')];
    cases[0].$('.ww-find').value = '不存在';
    cases[1].$('.ww-replace').value = '旧称';
    for (const app of cases) {
        const before = clone(app.doc.draft);
        await app.replaceAll();
        assert.deepEqual(app.doc.draft, before);
        assert.equal(app.doc.undo, undefined);
        assert.equal(app.saved, undefined);
        assert.match(app.feedback, /未修改/);
    }
});

test('persistence failure keeps changes undoable and preserves the storage error', async () => {
    const app = workbench('world', world());
    app.persist = async () => { app.message('本地草稿未能保存'); return false; };
    await app.replaceAll();
    assert.equal(app.editor.value, '新称和新称');
    assert.equal(app.doc.undo.length, 1);
    assert.equal(app.feedback, '本地草稿未能保存');
});

test('scope choices follow the open resource and reset when changing content type', () => {
    globalThis.document = { createElement: () => ({ setAttribute() {} }) };
    const app = workbench('world', world(), 'current');
    const select = app.$('.ww-replace-scope');
    select.replaceChildren = (...items) => { select.items = items; };
    app.renderReplaceScope();
    assert.deepEqual(select.items.map(o => o.textContent), ['当前条目', '当前世界书所有条目']);
    assert.equal(select.value, 'current');
    select.value = 'world';
    app.renderReplaceScope();
    assert.equal(select.value, 'world');
    app.tab = app.doc.meta.kind = 'preset';
    app.renderReplaceScope();
    assert.equal(select.value, 'current');
    assert.equal(select.items[1].textContent, '当前预设所有条目');
    app.tab = 'character';
    app.renderReplaceScope();
    assert.equal(select.items.length, 1);
    delete globalThis.document;
});
