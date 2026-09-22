import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { Window } = await import(process.env.WW_DOM_MODULE || 'happy-dom');
const window = new Window({ url: 'http://localhost:8000/' });
for (const key of ['window', 'document', 'localStorage', 'Event', 'CustomEvent', 'HTMLElement']) globalThis[key] = window[key];
globalThis.__WW_TEST__ = true;
const { Workbench, install } = await import('../index.js');
const { clone, characterContent } = await import('../core.js');

test('editing, draft recovery, save failure, conflicts, AI and resource switching', async () => {
    const state = {
        character: characterContent({ data: { description: '原始人设', personality: '安静', first_mes: '你好', alternate_greetings: ['初次见面'] } }),
        world: { entries: { 0: { uid: 0, comment: '城镇', content: '旧港口', key: ['港口'], displayIndex: 0, order: 100 } } },
        preset: { prompts: [{ identifier: 'main', name: '写作指导', content: '细腻', role: 'system' }, { identifier: 'history', name: '聊天历史', marker: true }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }] },
    };
    const ctx = { accountStorage: localStorage, mainApi: 'openai', onlineStatus: 'connected', stopGeneration() {} };
    let writes = 0, shouldFail = false, active = 'x.png', lastPrompt;
    const bridge = {
        context: () => ctx,
        currentCharacter: () => ({ avatar: active, name: '林舟' }),
        getCharacter: async () => ({ name: '林舟', data: { extensions: { world: '港口' } } }),
        presets: () => ({ api: 'openai', current: '写作', names: ['写作', '试聊'] }),
        activatePreset: async () => {}, worlds: async () => ['港口'],
        assertCharacter: a => { if (a !== active) throw Error('角色已变更'); },
        read: async meta => clone(state[meta.kind]),
        write: async (meta, live, next) => { if (shouldFail) throw Error('保存失败'); state[meta.kind] = clone(next); writes++; },
        generate: async prompt => { lastPrompt = prompt; return '润色后的文字'; }, testChat: async () => {},
    };
    const app = new Workbench(bridge);
    await app.open();
    assert.equal(app.editor.value, '原始人设');
    function type(text) { app.editor.value = text; app.editor.dispatchEvent(new Event('input')); }
    async function action(name) { await app.click({ target: app.$(`[data-action="${name}"]`) }); }
    type('新的人设');
    await app.persist();
    assert.equal(JSON.parse(localStorage.getItem(app.storageKey(app.doc.meta))).draft.description, '新的人设');
    await app.run(() => app.switchTab('greetings'));
    assert.equal(app.editor.value, '你好');
    await action('add'); assert.equal(app.doc.draft.alternate_greetings.length, 2);
    type('新的开场白');
    await app.run(() => app.switchTab('character'));
    assert.equal(app.editor.value, '新的人设');
    await action('save'); assert.equal(state.character.description, '新的人设'); assert.equal(writes, 1);
    type('还没有保存的内容'); shouldFail = true;
    await action('save'); assert.equal(app.doc.base.description, '新的人设'); assert.equal(app.doc.draft.description, '还没有保存的内容');
    shouldFail = false; state.character.description = '外部修改';
    await action('save'); assert.equal(writes, 1); assert.ok(app.$('[data-action="reload"]'));
    await action('reload'); assert.equal(app.editor.value, '外部修改');
    assert.ok(app.doc.history.some(h => h.value.description === '还没有保存的内容'));
    await app.run(() => app.switchTab('world')); assert.equal(app.editor.value, '旧港口');
    await action('duplicate'); assert.equal(Object.keys(app.doc.draft.entries).length, 2);
    type('新港口'); await action('save'); assert.equal(state.world.entries[1].content, '新港口');
    await app.run(() => app.switchTab('preset')); assert.equal(app.editor.value, '细腻');
    await app.click({ target: app.$('[data-field="history"]') }); assert.ok(app.editor.disabled);
    await app.click({ target: app.$('[data-field="main"]') }); assert.ok(!app.editor.disabled);
    app.savedSelection = [0, 2]; await action('polish'); assert.ok(!app.$('[data-action="accept"]').disabled);
    await action('accept'); assert.equal(app.editor.value, '润色后的文字');
    await action('undo'); assert.equal(app.editor.value, '细腻');
    await action('polish'); type('生成后又改了正文'); await action('accept'); assert.equal(app.editor.value, '生成后又改了正文');
    // Mobile workflow: a stale selection must not narrow the default whole-field revision.
    type('前半段和后半段都要保留'); app.savedSelection = [0, 3];
    app.$('.ww-ai-mode').value = 'current'; app.$('.ww-instruction').value = '修改性格，其他不变';
    await action('generate'); assert.ok(lastPrompt.includes('前半段和后半段都要保留'));
    app.$('.ww-ai-mode').value = 'write'; await action('generate');
    assert.ok(lastPrompt.includes('当前写卡预设')); assert.ok(!lastPrompt.includes('前半段和后半段都要保留'));
    assert.ok(app.$('[data-action="accept"]').disabled);
    app.$('.ww-ai-mode').value = 'result'; await action('generate'); assert.ok(lastPrompt.includes('润色后的文字'));
    ctx.chat = [{ is_user: false, mes: '上一份写卡输出' }, { is_user: true, mes: '我的意见' }];
    await action('latest'); assert.equal(app.$('.ww-suggestion').value, '上一份写卡输出');
    await app.run(() => app.switchTab('character'));
    assert.equal(app.$('.ww-suggestion').value, '上一份写卡输出');
    app.$('.ww-destination').value = 'personality'; await action('place');
    assert.equal(app.doc.draft.personality, '上一份写卡输出');
    assert.notEqual(state.character.personality, '上一份写卡输出');
    await action('undo'); assert.equal(app.doc.draft.personality, '安静');
    await app.run(() => app.switchTab('character')); type('关闭后恢复');
    assert.equal(await app.close(), false);
    assert.ok(app.dialog.open); assert.equal(app.$('.ww-exit').hidden, false);
    assert.ok(app.$('.ww-exit-message').textContent.includes('已保存在本地草稿'));
    await action('exit-cancel'); assert.equal(app.$('.ww-exit').hidden, true); assert.ok(app.dialog.open);
    await app.close(); await action('exit-confirm'); assert.equal(app.dialog.open, false);
    const second = new Workbench(bridge); await second.open(); assert.equal(second.editor.value, '关闭后恢复');
    assert.equal(second.$('.ww-suggestion').value, '上一份写卡输出');
    // A failed local backup must not prevent an explicitly requested server save.
    const originalSet = second.store.set.bind(second.store);
    second.store.set = async () => { throw new DOMException('quota', 'QuotaExceededError'); };
    second.doc.draft.description = '仍然可以写入酒馆';
    assert.equal(await second.close(), false);
    assert.ok(second.$('.ww-exit-message').textContent.includes('本地备份未成功'));
    second.cancelExit();
    assert.equal(await second.save(), true);
    assert.equal(state.character.description, '仍然可以写入酒馆');
    assert.ok(second.$('.ww-message').textContent.includes('本地备份未完成'));
    second.store.set = originalSet;
    active = 'other.png'; await action('save'); assert.notEqual(state.character.description, '关闭后恢复');
    await second.close();
    await window.happyDOM.abort();
});

test('preset search, batch transfer, relative insertion, world creation and exit reminders', async () => {
    const books = new Map([['原世界', { entries: {
        0: { uid: 0, comment: 'A', content: 'a', displayIndex: 0, order: 900 },
        1: { uid: 1, comment: 'B', content: 'b', displayIndex: 1, order: 10 },
    } }]]);
    const preset = { prompts: [
        { identifier: 'a', name: '人物', content: '海边 城市', role: 'system' },
        { identifier: 'b', name: '文风', content: '克制', role: 'system' },
    ], prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }] }] };
    const bridge = {
        context: () => ({ accountStorage: localStorage, mainApi: 'openai' }),
        currentCharacter: () => ({ avatar: 'features.png', name: '测试' }),
        getCharacter: async () => ({ name: '测试' }), assertCharacter: () => {},
        presets: () => ({ api: 'openai', current: '功能测试', names: ['功能测试', '目标预设'] }),
        worlds: async () => [...books.keys()],
        createWorld: async name => { books.set(name, { entries: {} }); return name; },
        read: async meta => clone(meta.kind === 'world' ? books.get(meta.id) : meta.kind === 'preset' ? preset : characterContent({})),
    };
    const app = new Workbench(bridge); await app.open();
    const action = name => app.click({ target: app.$(`[data-action="${name}"]`) });
    await app.switchTab('preset');
    app.editor.value = '海边 城市 新改动'; app.editor.dispatchEvent(new Event('input'));
    app.editor.setSelectionRange(2, 4);
    app.$('.ww-filter').value = '海边 新改动'; app.$('.ww-filter').dispatchEvent(new Event('input'));
    assert.equal(app.$('.ww-list').children.length, 1);
    assert.equal(app.editor.selectionStart, 2);
    assert.equal(app.$('.ww-highlight-text').querySelectorAll('mark').length, 2);
    assert.equal(app.$('.ww-highlight-text mark').textContent, '海边');
    await action('hit-next'); assert.equal(app.activeHit, 0);
    await action('hit-prev'); assert.equal(app.activeHit, 1);
    assert.equal(app.editor.value, '海边 城市 新改动');
    await action('select-visible');
    app.$('.ww-filter').value = '文风'; app.$('.ww-filter').dispatchEvent(new Event('input'));
    assert.ok(app.selectedPrompts.has('a'));
    await action('select-visible'); assert.equal(app.selectedPrompts.size, 2);
    let exported;
    app.downloadJson = data => { exported = clone(data); };
    await action('export-prompts'); assert.equal(exported.prompts.length, 2);
    await app.loadResource('目标预设');
    app.$('.ww-anchor').value = 'b'; app.$('.ww-anchor-side').value = 'before';
    await app.importPrompts({ size: 100, text: async () => JSON.stringify(exported) });
    assert.equal(app.doc.draft.prompts.length, 4);
    assert.equal(app.doc.draft.prompts[0].content, '海边 城市');
    assert.equal(app.doc.draft.prompts[2].content, '海边 城市 新改动');
    assert.equal(app.doc.draft.prompt_order[0].order[2].enabled, false);
    await action('undo'); assert.equal(app.doc.draft.prompts.length, 2);
    app.showField(app.fields().find(f => f.id === 'b'));
    await action('delete-entry');
    assert.equal(app.doc.draft.prompts.length, 1);
    assert.ok(app.doc.draft.prompt_order.every(g => !g.order.some(p => p.identifier === 'b')));
    await action('undo'); assert.equal(app.doc.draft.prompts.length, 2);
    app.showField(app.fields().find(f => f.id === 'b'));
    app.$('.ww-anchor').value = 'a'; app.$('.ww-anchor-side').value = 'before';
    await action('move-to'); assert.equal(app.fields()[0].id, 'b');
    assert.equal(app.editor.value, '克制');
    await action('insert-new'); assert.equal(app.fields()[0].id, app.field.id);
    await action('undo'); assert.equal(app.doc.draft.prompts.length, 2);
    await app.switchTab('world');
    app.showField(app.fields().find(f => f.id === '1'));
    app.$('.ww-anchor').value = '0'; app.$('.ww-anchor-side').value = 'before';
    await action('move-to'); assert.equal(app.fields()[0].id, '1');
    assert.equal(app.doc.draft.entries[0].order, 900); assert.equal(app.doc.draft.entries[1].order, 10);
    app.$('.ww-world-name').value = '新世界'; await action('create-world');
    assert.equal(app.doc.meta.id, '新世界'); assert.deepEqual(app.doc.draft.entries, {});
    await action('add'); assert.equal(Object.keys(app.doc.draft.entries).length, 1);
    await action('delete-entry'); assert.equal(Object.keys(app.doc.draft.entries).length, 0);
    assert.equal(app.$('[data-action="delete-entry"]').hidden, true);
    await action('undo'); assert.equal(Object.keys(app.doc.draft.entries).length, 1);
    await app.persist();
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload);
    assert.equal(unload.defaultPrevented, true);
    assert.equal(await app.close(), false);
    assert.ok(app.$('.ww-exit-list').textContent.includes('功能测试'));
    assert.ok(app.$('.ww-exit-list').textContent.includes('原世界'));
    await action('exit-confirm'); assert.equal(app.dialog.open, false);
    await app.open();
    await app.switchTab('greetings');
    await action('add'); await action('delete-entry'); assert.equal(app.doc.draft.alternate_greetings.length, 0);
    assert.equal(app.canDelete(), false);
    await action('undo'); assert.equal(app.doc.draft.alternate_greetings.length, 1);
    await app.close();
    const originalRead = bridge.read, originalSet = app.store.set.bind(app.store);
    bridge.read = async () => { throw Error('离线'); };
    await action('exit-discard'); assert.ok(app.dialog.open); assert.ok(app.unwrittenDocuments().length);
    assert.ok(app.$('.ww-exit-error').textContent.includes('离线'));
    bridge.read = originalRead;
    app.store.set = async () => { throw Error('存储失败'); };
    await action('exit-discard'); assert.ok(app.dialog.open); assert.ok(app.unwrittenDocuments().length);
    app.store.set = originalSet;
    preset.prompts[0].content = '酒馆外部最新版本';
    await action('exit-discard'); assert.equal(app.dialog.open, false);
    assert.equal(app.unwrittenDocuments().length, 0);
    const restored = new Workbench(bridge); await restored.open(); await restored.switchTab('preset');
    assert.equal(restored.doc.draft.prompts[0].content, '酒馆外部最新版本');
    assert.deepEqual(restored.doc.base, restored.doc.draft);
    await restored.switchTab('world'); assert.equal(restored.doc.draft.entries[0].displayIndex, 0);
    await restored.close();
    await window.happyDOM.abort();
});
test('small mobile viewport has one scrolling shell and non-overlapping flow regions', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    document.head.append(style);
    window.happyDOM.setWindowSize({ width: 390, height: 420 });
    const dialog = document.querySelector('dialog.ww');
    assert.equal(window.getComputedStyle(dialog.querySelector('.ww-shell')).display, 'block');
    assert.equal(window.getComputedStyle(dialog.querySelector('.ww-shell')).overflowY, 'auto');
    assert.equal(window.getComputedStyle(dialog.querySelector('.ww-body')).display, 'block');
    assert.equal(window.getComputedStyle(dialog.querySelector('.ww-main')).overflow, 'visible');
    assert.equal(window.getComputedStyle(dialog.querySelector('.ww-footer')).position, 'static');
    assert.equal(window.getComputedStyle(dialog.querySelector('.ww-list')).display, 'none');
    assert.equal(window.getComputedStyle(dialog.querySelector('.ww-mobile-field-label')).display, 'grid');
    assert.equal(dialog.querySelector('.ww-history').parentElement, dialog);
    assert.equal(dialog.querySelector('.ww-primary-actions').children.length, 3);
    window.happyDOM.setWindowSize({ width: 1200, height: 900 });
    assert.equal(window.getComputedStyle(dialog.querySelector('.ww-body')).display, 'flex');
    style.remove();
});
test('launcher has its own full-width container and uses native theme classes', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="extensions_settings2"><div id="other-extension"></div></div>');
    install(); install();
    assert.equal(document.querySelectorAll('#writer-workbench-launch').length, 1);
    const button = document.querySelector('#writer-workbench-launch');
    assert.equal(button.parentElement.id, 'writer-workbench-settings');
    assert.equal(button.parentElement.parentElement.id, 'extensions_settings2');
    assert.equal(button.querySelector('span:last-child').textContent, '写卡工作台');
    assert.ok(button.classList.contains('menu_button'));
});

test('unbound entry, searchable independent target, scoped regex preview and minimize keep chat separate', async () => {
    const storeData = new Map(), account = new Map();
    const store = { get: async key => clone(storeData.get(key)), set: async (key, value) => storeData.set(key, clone(value)) };
    const ctx = { accountStorage: { getItem: k => account.get(k), setItem: (k, v) => account.set(k, v) }, mainApi: 'openai', name1: '读者' };
    let current = null, lastWrite, worldFail = false, lastPrompt;
    const cards = [{ avatar: 'independent-a.png', name: '聊天A' }, { avatar: 'independent-b.png', name: '编辑B' }];
    const state = {
        'independent-a.png': { character: characterContent({ data: { description: 'A设定' } }), regex: { scripts: [] } },
        'independent-b.png': { character: characterContent({ data: { description: 'B设定' } }), regex: { scripts: [] } },
    };
    const bridge = {
        context: () => ctx, characters: () => cards, currentCharacter: () => current,
        getCharacter: async avatar => ({ name: cards.find(c => c.avatar === avatar).name, data: {} }),
        presets: () => ({ api: 'openai', current: '写作', names: ['写作'] }),
        worlds: async () => { if (worldFail) throw Error('列表加载失败：404'); return ['旧书', '海港设定']; },
        read: async meta => clone(meta.kind === 'world' ? { entries: {} } : state[meta.id][meta.kind]),
        write: async (meta, live, next) => { lastWrite = clone(meta); state[meta.id][meta.kind] = clone(next); },
        generate: async prompt => { lastPrompt = prompt; return '<div>修改后的状态栏</div>'; },
    };
    const app = new Workbench(bridge, store);
    const action = name => app.click({ target: app.$(`[data-action="${name}"]`) });
    await app.open(); assert.equal(app.avatar, null); assert.equal(app.doc, null); assert.ok(app.dialog.open);
    app.$('.ww-card-search').value = '编辑B'; app.$('.ww-card-search').dispatchEvent(new Event('input'));
    assert.equal(app.$('.ww-card-select').options.length, 2);
    app.$('.ww-card-select').value = 'independent-b.png'; await action('bind-card');
    assert.equal(app.editor.value, 'B设定'); assert.equal(current, null);
    current = cards[0];
    app.editor.value = '修改B'; app.editor.dispatchEvent(new Event('input')); await action('save');
    assert.equal(lastWrite.id, 'independent-b.png'); assert.equal(state['independent-a.png'].character.description, 'A设定');
    await app.switchTab('regex'); await action('add');
    assert.equal(app.doc.meta.kind, 'regex'); assert.equal(app.doc.meta.id, 'independent-b.png');
    app.$('.ww-preview-mode').value = 'html';
    app.editor.value = '<style>div{color:red}</style><div>测试</div>'; app.editor.dispatchEvent(new Event('input'));
    await action('preview-refresh');
    assert.equal(app.$('.ww-preview-frame').getAttribute('sandbox'), '');
    assert.ok(app.$('.ww-preview-frame').srcdoc.includes('<div>测试</div>'));
    app.$('.ww-instruction').value = '改成两列，保留宏'; await action('generate');
    assert.ok(lastPrompt.includes('局部正则的替换 HTML')); assert.ok(lastPrompt.includes('编辑B'));
    assert.equal(app.editor.value, '<style>div{color:red}</style><div>测试</div>');
    await action('accept'); assert.equal(app.editor.value, '<div>修改后的状态栏</div>');
    await action('save'); assert.equal(lastWrite.kind, 'regex');
    await action('delete-entry'); await action('undo'); assert.equal(app.doc.draft.scripts.length, 1);
    await action('minimize'); assert.equal(app.dialog.open, false); assert.equal(app.resumeButton.hidden, false);
    await app.open(); assert.equal(app.avatar, 'independent-b.png'); assert.equal(app.tab, 'regex'); assert.equal(current.avatar, 'independent-a.png');
    await app.switchTab('world');
    app.$('.ww-resource-search').value = '海港'; app.$('.ww-resource-search').dispatchEvent(new Event('input'));
    assert.equal(app.$('.ww-resource').options.length, 2);
    worldFail = true; await action('refresh-resources');
    assert.ok(app.$('.ww-message').textContent.includes('404')); assert.equal(app.$('.ww-new-world').hidden, false);
    assert.equal(app.$('.ww-resource-tools').hidden, false);
    await app.close({ confirmed: true }); await window.happyDOM.abort();
});
