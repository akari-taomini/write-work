import { TavernBridge } from './bridge.js';
import { DraftStore, storageMessage } from './storage.js';
import { CHARACTER_FIELDS, clone, equal, mergeThreeWay, readPath, writePath, snapshot, newEntry, applySuggestion, opaqueThemeColor } from './core.js';

const bridge = new TavernBridge();
let app;
const element = (tag, attrs = {}, text = '') => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else node.setAttribute(key, value);
    }
    node.textContent = text;
    if (tag === 'button') { node.classList.add('menu_button'); node.type = 'button'; }
    if (['input', 'textarea'].includes(tag) && attrs.type !== 'checkbox') node.classList.add('text_pole');
    return node;
};
const option = (value, label) => element('option', { value }, label);

export class Workbench {
    constructor(adapter = bridge, store = new DraftStore()) {
        this.bridge = adapter;
        this.store = store;
        this.pendingPersistence = 0;
        this.failedPersistence = new Set();
        this.persistenceSequence = new Map();
        this.docs = new Map();
        this.tab = 'character';
        this.busy = false;
        this.savedSelection = [0, 0];
        const ctx = adapter.context();
        if (!ctx.accountStorage) throw new Error('需要支持账号存储的 SillyTavern 版本，请先更新酒馆。');
        this.namespace = ctx.accountStorage.getItem('writer-workbench-browser-key');
        if (!this.namespace) {
            this.namespace = crypto.randomUUID();
            ctx.accountStorage.setItem('writer-workbench-browser-key', this.namespace);
        }
        this.dialog = element('dialog', { class: 'ww', 'aria-label': '写卡工作台' });
        this.dialog.innerHTML = `
          <div class="ww-shell">
            <header class="ww-header">
              <div class="ww-brand"><span class="ww-mark">✎</span><div><strong>写卡工作台</strong><small>把时间留给故事</small></div></div>
              <span class="ww-character"></span>
              <button type="button" data-action="close" aria-label="关闭工作台">✕</button>
            </header>
            <div class="ww-connection"><span class="ww-api"></span><label>写作预设 <select class="ww-writing-preset" aria-label="写作使用的预设"></select></label><small>与酒馆同步 · 无需另填 API</small></div>
            <nav class="ww-tabs" aria-label="内容类型"><button data-tab="character">人物设定</button><button data-tab="greetings">开场白</button><button data-tab="world">世界书</button><button data-tab="preset">预设</button></nav>
            <div class="ww-body">
              <aside class="ww-sidebar"><label class="ww-resource-label">编辑对象<select class="ww-resource" aria-label="正在编辑的对象"></select></label><div class="ww-list"></div><label class="ww-mobile-field-label">当前栏目<select class="ww-mobile-field" aria-label="当前栏目或世界书条目"></select></label><button data-action="add" class="ww-add">＋ 新增</button></aside>
              <main class="ww-main">
                <div class="ww-editor-heading"><div><h2 class="ww-title">开始写作</h2><small class="ww-hint"></small></div><button data-action="search" title="查找与替换">查找替换</button></div>
                <div class="ww-search" hidden><input class="ww-find" placeholder="查找文字" aria-label="查找文字"><input class="ww-replace" placeholder="替换为" aria-label="替换文字"><button data-action="find">查找下一个</button><button data-action="replace">全部替换</button></div>
                <div class="ww-fields"></div>
                <textarea class="ww-editor" aria-label="正文编辑区" spellcheck="false" placeholder="从这里开始，写下你的角色……"></textarea>
                <div class="ww-editor-meta"><span class="ww-count">0 字</span><span>Ctrl / ⌘ + S 写入酒馆</span><button data-action="duplicate" hidden>复制条目</button></div>
                <details class="ww-notes"><summary>创作备注 <small>仅自己可见，不加入角色提示词</small></summary><textarea class="ww-note" aria-label="创作备注" placeholder="灵感、待办、还没想好的伏笔……"></textarea></details>
                <section class="ww-assistant" aria-label="写卡与修改">
                  <div class="ww-row"><strong>写卡与修改</strong><button data-action="ai-close" aria-label="收起写卡与修改">✕</button></div>
                  <p class="ww-help">使用酒馆当前连接、预设和聊天上下文；结果只放在这里，采用后才修改草稿。</p>
                  <label class="ww-mode-label">这次要做什么<select class="ww-ai-mode" aria-label="写作方式"><option value="current">按意见修改当前栏目（不用选字）</option><option value="write">按写卡预设起草新内容</option><option value="result">继续修改下面的输出稿</option><option value="selection">只修改选中的文字</option></select></label>
                  <div class="ww-row"><button data-action="polish">润色</button><button data-action="expand">扩写</button><button data-action="shorten">精简</button></div>
                  <textarea class="ww-instruction" rows="3" aria-label="写作或修改意见" placeholder="直接写意见，例如：把性格里的冷漠改成慢热，保留其他设定。也可以描述你想写的新角色。"></textarea>
                  <div class="ww-row"><button data-action="generate" class="ww-primary">按意见生成</button><button data-action="stop" hidden>停止生成</button><button data-action="latest">读取聊天最新回复</button></div>
                  <textarea class="ww-suggestion" aria-label="写卡输出，可粘贴或继续编辑" placeholder="写卡预设的输出会放在这里，也可以粘贴已有内容。切换栏目后仍会保留。" spellcheck="false"></textarea>
                  <div class="ww-row"><button data-action="accept" disabled>替换原文</button><button data-action="append" disabled>插在后面</button><span class="ww-ai-message" role="status"></span></div>
                  <div class="ww-placement"><label>放到哪里<select class="ww-destination" aria-label="输出稿目标栏目"></select></label><select class="ww-placement-mode" aria-label="放入方式"><option value="replace">替换该栏正文</option><option value="append">追加到该栏末尾</option></select><button data-action="place">放入该栏草稿</button></div>
                </section>
              </main>
            </div>
            <div class="ww-message" role="status" aria-live="polite"></div>
            <footer class="ww-footer"><span class="ww-status">准备就绪</span><div class="ww-row ww-primary-actions"><button data-action="save" class="ww-primary">写入酒馆</button><button data-action="ai">✧ AI 辅助</button><button data-action="export">导出草稿</button></div><details class="ww-more"><summary>更多操作</summary><div class="ww-row"><button data-action="undo">撤回</button><button data-action="history">历史版本</button><button data-action="import">导入草稿</button><button data-action="test">保存并新开试聊</button></div></details><input class="ww-import" type="file" accept=".json,application/json" hidden></footer>
            <section class="ww-history" hidden aria-label="历史版本"><div class="ww-row"><h2>历史版本</h2><button data-action="history-close">返回编辑</button></div><div class="ww-history-list"></div><pre class="ww-history-preview"></pre><button data-action="restore" class="ww-primary" disabled>恢复到草稿</button></section>
          </div>`;
        document.body.append(this.dialog);
        this.dialog.querySelectorAll('button').forEach(node => { node.classList.add('menu_button'); node.type = 'button'; });
        this.dialog.querySelectorAll('textarea,input:not([type="checkbox"])').forEach(node => node.classList.add('text_pole'));
        this.$ = selector => this.dialog.querySelector(selector);
        // Keep the history overlay outside the scrolling shell.
        this.dialog.append(this.$('.ww-history'));
        const fitViewport = () => {
            const viewport = window.visualViewport;
            this.dialog.style.setProperty('--ww-viewport-height', `${viewport?.height || window.innerHeight}px`);
            this.dialog.style.setProperty('--ww-viewport-top', `${viewport?.offsetTop || 0}px`);
        };
        window.visualViewport?.addEventListener('resize', fitViewport);
        window.visualViewport?.addEventListener('scroll', fitViewport);
        window.addEventListener('resize', fitViewport);
        fitViewport();
        this.themeProbe = element('span', { hidden: '' });
        this.themeProbe.style.backgroundColor = 'var(--SmartThemeBlurTintColor, Canvas)';
        this.dialog.append(this.themeProbe);
        this.syncTheme();
        this.themeObserver = new window.MutationObserver(() => this.syncTheme());
        this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
        this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
        this.themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
        this.editor = this.$('.ww-editor');
        this.dialog.addEventListener('click', event => this.click(event));
        this.dialog.addEventListener('cancel', event => { event.preventDefault(); if (!this.busy) this.close(); });
        this.dialog.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); this.run(() => this.save()); }
        });
        this.editor.addEventListener('input', () => {
            this.rememberUndo(true);
            writePath(this.doc.draft, this.field.path, this.editor.value);
            this.persist(); this.count();
        });
        const selection = () => { this.savedSelection = [this.editor.selectionStart, this.editor.selectionEnd]; };
        ['select', 'keyup', 'pointerup', 'blur'].forEach(event => this.editor.addEventListener(event, selection));
        this.editor.addEventListener('scroll', () => {
            if (this.doc && this.field) { this.doc.scroll ||= {}; this.doc.scroll[this.field.id] = this.editor.scrollTop; }
        });
        this.$('.ww-note').addEventListener('input', event => { this.doc.note = event.target.value; this.persist(); });
        for (const selector of ['.ww-instruction', '.ww-suggestion']) this.$(selector).addEventListener('input', () => this.persistWriting());
        this.$('.ww-ai-mode').addEventListener('change', () => this.persistWriting());
        this.$('.ww-import').addEventListener('change', event => {
            const file = event.target.files[0]; event.target.value = '';
            if (file) this.run(() => this.importDraft(file));
        });
        this.$('.ww-resource').addEventListener('change', event => this.run(() => this.loadResource(event.target.value)));
        this.$('.ww-mobile-field').addEventListener('change', event => {
            if (this.busy) return;
            this.persist(); this.showField(this.fields().find(field => field.id === event.target.value));
        });
        this.$('.ww-writing-preset').addEventListener('change', event => this.run(async () => {
            await this.bridge.activatePreset(event.target.value);
            this.connection(); this.message('写作预设已与酒馆同步。');
        }));
        window.addEventListener('pagehide', () => { this.persist(); this.persistWriting(); });
        window.addEventListener('beforeunload', event => {
            if (this.pendingPersistence || this.failedPersistence.size) { event.preventDefault(); event.returnValue = ''; }
        });
    }
    syncTheme() {
        const color = window.getComputedStyle(this.themeProbe).backgroundColor;
        this.dialog.style.setProperty('--ww-surface', opaqueThemeColor(color));
    }
    writingKey() { return `ww:${this.namespace}:writing:${this.avatar}`; }
    async persistWriting() {
        if (!this.avatar) return;
        const key = this.writingKey();
        this.pendingPersistence++;
        try { await this.store.set(key, { instruction: this.$('.ww-instruction').value, output: this.$('.ww-suggestion').value, mode: this.$('.ww-ai-mode').value }); this.failedPersistence.delete(key); }
        catch (error) { this.failedPersistence.add(key); console.warn('[Writer Workbench] Writing storage', error); this.message(storageMessage(error), true); }
        finally { this.pendingPersistence--; }
    }
    async loadWriting() {
        const data = await this.store.get(this.writingKey()) || {};
        this.$('.ww-instruction').value = data.instruction || '';
        this.$('.ww-suggestion').value = data.output || '';
        this.$('.ww-ai-mode').value = data.mode || 'current';
    }
    key(meta) { return `${meta.kind}:${meta.api || ''}:${meta.id}`; }
    storageKey(meta) { return `ww:${this.namespace}:${this.key(meta)}`; }
    message(text = '', error = false) { this.$('.ww-message').textContent = text; this.$('.ww-message').classList.toggle('ww-error', error); }
    async run(task) {
        if (this.busy) return;
        this.busy = true;
        this.dialog.setAttribute('aria-busy', 'true');
        const controls = [...this.dialog.querySelectorAll('button,select,input,textarea')];
        const disabled = controls.map(x => x.disabled);
        controls.forEach(x => { x.disabled = true; });
        try { this.message(); await task(); }
        catch (error) { console.error('[Writer Workbench]', error); this.message(error.message || String(error), true); }
        finally {
            controls.forEach((x, i) => { x.disabled = disabled[i]; });
            this.busy = false; this.dialog.removeAttribute('aria-busy');
            this.$('[data-action="accept"]').disabled = !this.suggestion;
            this.$('[data-action="append"]').disabled = !this.suggestion;
            this.editor.disabled = !this.field || !!this.field.marker;
            this.$('.ww-note').disabled = !this.doc;
        }
    }
    async persist() {
        if (!this.doc) return true;
        const doc = this.doc;
        doc.updated = new Date().toISOString();
        const key = this.storageKey(doc.meta);
        const sequence = (this.persistenceSequence.get(key) || 0) + 1;
        this.persistenceSequence.set(key, sequence);
        this.pendingPersistence++;
        const clean = equal(doc.base, doc.draft);
        this.$('.ww-status').textContent = '正在保存草稿…';
        try {
            const { undo, lastEdit, ...stored } = doc;
            await this.store.set(key, stored);
            if (this.persistenceSequence.get(key) === sequence) this.failedPersistence.delete(key);
            if (this.doc === doc && this.persistenceSequence.get(key) === sequence) {
                this.$('.ww-status').textContent = clean ? '✓ 已与酒馆一致 · 草稿已保存' : '● 草稿已保存 · 尚未写入酒馆';
            }
            return true;
        } catch (error) {
            console.warn('[Writer Workbench] Draft storage', error);
            if (this.persistenceSequence.get(key) === sequence) this.failedPersistence.add(key);
            if (this.doc === doc && this.persistenceSequence.get(key) === sequence) {
                this.$('.ww-status').textContent = '本地草稿未保存';
                this.message(storageMessage(error), true);
            }
            return false;
        } finally { this.pendingPersistence--; }
    }
    rememberUndo(typing = false) {
        const now = Date.now();
        if (!typing || !this.doc.lastEdit || now - this.doc.lastEdit > 700) {
            this.doc.undo ||= [];
            this.doc.undo.push(clone(this.doc.draft));
            this.doc.undo = this.doc.undo.slice(-30);
        }
        this.doc.lastEdit = typing ? now : 0;
    }
    async open() {
        const card = this.bridge.currentCharacter();
        if (!card) throw new Error('请先打开一张角色卡的单人聊天，再打开工作台。');
        this.avatar = card.avatar;
        this.syncTheme(); await this.loadWriting();
        this.$('.ww-character').textContent = card.name;
        this.dialog.showModal();
        await this.run(async () => {
            this.connection();
            this.fullCard = await this.bridge.getCharacter(this.avatar);
            await this.switchTab('character');
        });
    }
    async close() { await Promise.all([this.persist(), this.persistWriting()]); this.dialog.close(); }
    connection() {
        const ctx = this.bridge.context();
        this.$('.ww-api').textContent = `● ${ctx.mainApi || '当前连接'} · ${ctx.onlineStatus === 'no_connection' ? '尚未连接' : '使用酒馆配置'}`;
        const select = this.$('.ww-writing-preset');
        select.replaceChildren();
        try {
            const presets = this.bridge.presets();
            presets.names.forEach(name => select.append(option(name, name)));
            select.value = presets.current;
        } catch { select.append(option('', '跟随酒馆当前设置')); }
    }
    async switchTab(tab) {
        await this.persist();
        this.tab = tab;
        this.dialog.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
        const select = this.$('.ww-resource'); select.replaceChildren();
        this.$('.ww-resource-label').hidden = ['character', 'greetings'].includes(tab);
        try { if (tab === 'world') {
            const names = await this.bridge.worlds();
            names.forEach(name => select.append(option(name, name)));
            const linked = this.fullCard.data?.extensions?.world;
            if (names.includes(linked)) select.value = linked;
            if (!names.length) { this.empty('还没有世界书。请在酒馆新建一本后，再打开这里。'); return; }
            await this.loadResource(select.value);
        } else if (tab === 'preset') {
            const p = this.bridge.presets();
            p.names.forEach(name => select.append(option(name, name))); select.value = p.current;
            if (!p.names.length) { this.empty('当前连接没有已保存的预设。'); return; }
            await this.loadResource(select.value);
        } else await this.load({ kind: 'character', id: this.avatar, title: this.fullCard.name });
        } catch (error) { this.empty('未能载入，请重试。已有草稿仍然保留。'); throw error; }
    }
    async loadResource(id) {
        try { await this.load({ kind: this.tab, id, title: id, ...(this.tab === 'preset' ? { api: this.bridge.presets().api } : {}) }); }
        catch (error) { this.empty('未能载入，请重试。已有草稿仍然保留。'); throw error; }
    }
    async load(meta) {
        await this.persist();
        const live = await this.bridge.read(meta);
        let doc = this.docs.get(this.key(meta));
        if (!doc) {
            const raw = await this.store.get(this.storageKey(meta));
            if (raw) {
                try { doc = raw; if (!doc.base || !doc.draft || this.key(doc.meta) !== this.key(meta)) throw Error(); }
                catch { throw new Error('已有草稿无法读取。为避免覆盖，已停止打开；请先备份浏览器数据。'); }
            }
        }
        if (!doc) doc = { meta, base: clone(live), draft: clone(live), history: [], note: '', scroll: {} };
        else if (equal(doc.base, doc.draft)) { doc.base = clone(live); doc.draft = clone(live); }
        else if (!equal(doc.base, live)) this.message('恢复了上次草稿。酒馆原内容也有变化，写入前会检查冲突。');
        this.doc = doc;
        this.docs.set(this.key(meta), doc);
        this.suggestion = null;
        this.$('.ww-note').value = doc.note || '';
        this.renderList(); this.persist();
    }
    empty(text) {
        this.doc = null; this.field = null;
        this.$('.ww-list').replaceChildren(); this.$('.ww-fields').replaceChildren();
        this.$('.ww-mobile-field').replaceChildren();
        this.$('.ww-title').textContent = '这里还是空的'; this.$('.ww-hint').textContent = text;
        this.editor.value = ''; this.editor.disabled = true; this.$('.ww-add').hidden = true;
        this.$('.ww-status').textContent = '未选择内容';
    }
    fields() {
        if (!this.doc) return [];
        const d = this.doc.draft;
        if (this.tab === 'character') return CHARACTER_FIELDS.filter(([k]) => k !== 'first_mes').map(([key, title]) => ({ id: key, title, path: [key] }));
        if (this.tab === 'greetings') return [{ id: 'first_mes', title: '第一条开场白', path: ['first_mes'] }, ...d.alternate_greetings.map((_, i) => ({ id: `alt-${i}`, title: `备选开场白 ${i + 1}`, path: ['alternate_greetings', i] }))];
        if (this.tab === 'world') return Object.entries(d.entries || {}).sort((a, b) => (a[1].displayIndex ?? +a[0]) - (b[1].displayIndex ?? +b[0])).map(([id, entry]) => ({ id, title: entry.comment || entry.key?.join('、') || `条目 ${id}`, path: ['entries', id, 'content'] }));
        if (Array.isArray(d.prompts)) return d.prompts.map((p, i) => ({ id: p.identifier || String(i), title: p.name || '未命名提示词', path: ['prompts', i, 'content'], marker: p.marker }));
        return Object.entries(d).filter(([k, v]) => typeof v === 'string' && /prompt|preamble|content|sequence|suffix|prefix/i.test(k)).map(([key]) => ({ id: key, title: key, path: [key] }));
    }
    renderList(wanted) {
        const fields = this.fields(); const list = this.$('.ww-list'); list.replaceChildren();
        this.$('.ww-mobile-field').replaceChildren(...fields.map(field => option(field.id, field.title)));
        this.$('.ww-add').hidden = !['greetings', 'world'].includes(this.tab) && !(this.tab === 'preset' && Array.isArray(this.doc?.draft.prompts));
        for (const field of fields) {
            const button = element('button', { type: 'button', 'data-field': field.id }, field.title);
            list.append(button);
        }
        this.showField(fields.find(f => f.id === wanted || (!wanted && f.id === this.doc?.lastField?.[this.tab])) || fields[0]);
    }
    showField(field) {
        this.field = field;
        this.$('.ww-mobile-field').value = field?.id || '';
        this.suggestion = null;
        this.savedSelection = [0, 0];
        this.$('[data-action="accept"]').disabled = true; this.$('[data-action="append"]').disabled = true;
        this.$('.ww-fields').replaceChildren();
        const destination = this.$('.ww-destination');
        destination.replaceChildren();
        this.fields().filter(f => !f.marker).forEach(f => destination.append(option(f.id, f.title)));
        if (field && !field.marker) destination.value = field.id;
        if (!field) { this.editor.value = ''; this.editor.disabled = true; this.$('.ww-title').textContent = '暂无可编辑条目'; this.$('.ww-hint').textContent = '可新增条目；参数型预设请在酒馆原面板调整参数。'; return; }
        this.editor.disabled = !!field.marker;
        this.doc.lastField ||= {}; this.doc.lastField[this.tab] = field.id;
        this.doc.lastEdit = 0;
        this.$('.ww-title').textContent = field.title;
        this.$('.ww-hint').textContent = field.marker ? '酒馆自动注入的占位条目，正文由酒馆管理。' : (this.tab === 'preset' ? '编辑提示词正文；保存此预设后，酒馆会同步选中它。' : '直接编辑，草稿会自动保留。');
        this.editor.value = String(readPath(this.doc.draft, field.path) ?? '');
        this.editor.scrollTop = this.doc.scroll?.[field.id] || 0;
        this.dialog.querySelectorAll('[data-field]').forEach(b => b.classList.toggle('ww-active', b.dataset.field === field.id));
        this.$('[data-action="duplicate"]').hidden = this.tab !== 'world';
        if (this.tab === 'world') {
            this.metaInput('条目标题', ['entries', field.id, 'comment']);
            this.metaInput('关键词（逗号分隔）', ['entries', field.id, 'key'], 'array');
            this.metaInput('停用', ['entries', field.id, 'disable'], 'checkbox');
            this.metaInput('常驻', ['entries', field.id, 'constant'], 'checkbox');
            this.metaInput('插入顺序', ['entries', field.id, 'order'], 'number');
            const row = element('div', { class: 'ww-row' });
            row.append(element('button', { 'data-action': 'up' }, '↑ 上移'), element('button', { 'data-action': 'down' }, '↓ 下移'));
            this.$('.ww-fields').append(row);
        } else if (this.tab === 'preset' && field.path[0] === 'prompts') {
            if (!field.marker) {
                this.metaInput('条目标题', ['prompts', field.path[1], 'name']);
                const label = element('label', { class: 'ww-meta-input' }, '角色');
                const select = element('select', { 'aria-label': '提示词角色' });
                ['system', 'user', 'assistant'].forEach(role => select.append(option(role, role)));
                select.value = this.doc.draft.prompts[field.path[1]].role || 'system';
                select.addEventListener('change', () => { this.rememberUndo(); this.doc.draft.prompts[field.path[1]].role = select.value; this.persist(); });
                label.append(select); this.$('.ww-fields').append(label);
            }
            for (const [i, group] of (this.doc.draft.prompt_order || []).entries()) {
                const j = group.order.findIndex(p => p.identifier === field.id);
                const groupName = Number(group.character_id) === 100000 ? '默认预设组' : Number(group.character_id) === 100001 ? '角色聊天组' : `预设组 ${i + 1}`;
                if (j >= 0) this.metaInput(`${groupName}启用`, ['prompt_order', i, 'order', j, 'enabled'], 'checkbox');
            }
        }
        this.count();
    }
    metaInput(label, path, type = 'text') {
        const wrapper = element('label', { class: 'ww-meta-input' }, label);
        const input = element('input', { type: type === 'array' ? 'text' : type });
        const val = readPath(this.doc.draft, path);
        if (type === 'checkbox') input.checked = !!val;
        else input.value = type === 'array' ? (val || []).join(', ') : (val ?? '');
        input.addEventListener('change', () => {
            if (type === 'number' && (!input.value.trim() || !Number.isFinite(Number(input.value)))) { this.message('请输入有效数字。', true); return; }
            this.rememberUndo();
            writePath(this.doc.draft, path, type === 'checkbox' ? input.checked : type === 'number' ? Number(input.value) : type === 'array' ? input.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) : input.value);
            this.persist(); this.renderList(this.field.id);
        });
        wrapper.append(input); this.$('.ww-fields').append(wrapper);
    }
    count() { this.$('.ww-count').textContent = `${Array.from(this.editor.value).length.toLocaleString()} 字`; }
    async save() {
        if (!this.doc) throw new Error('请先选择要编辑的内容。');
        this.bridge.assertCharacter(this.avatar);
        await this.persist();
        const live = await this.bridge.read(this.doc.meta);
        const result = mergeThreeWay(this.doc.base, this.doc.draft, live);
        if (result.conflicts.length) {
            this.conflictLive = clone(live);
            this.message(`同一内容在别处也被修改：${result.conflicts.join('、')}。已停止写入。请导出草稿后，使用下面的“重新载入酒馆版本”合并修改。`, true);
            if (!this.$('[data-action="reload"]')) this.$('.ww-message').append(element('button', { 'data-action': 'reload' }, '保留历史并重新载入酒馆版本'));
            return false;
        }
        snapshot(this.doc, '写入前的酒馆版本');
        this.doc.history[0].value = clone(live);
        this.persist();
        await this.bridge.write(this.doc.meta, live, result.value);
        this.doc.base = clone(result.value); this.doc.draft = clone(result.value);
        snapshot(this.doc, '已写入酒馆');
        const backedUp = await this.persist(); this.renderList(this.field?.id); this.connection();
        this.message(backedUp ? '已写入酒馆。' : '已写入酒馆；本地备份未完成，可以导出一份草稿。', !backedUp); return true;
    }
    add(copy = false) {
        if (!this.doc) return;
        this.rememberUndo(); let wanted;
        if (this.tab === 'greetings') { this.doc.draft.alternate_greetings.push(''); wanted = `alt-${this.doc.draft.alternate_greetings.length - 1}`; }
        else if (this.tab === 'world') wanted = String(newEntry(this.doc.draft.entries, copy ? this.doc.draft.entries[this.field.id] : null));
        else if (this.tab === 'preset' && Array.isArray(this.doc.draft.prompts)) {
            const id = crypto.randomUUID();
            this.doc.draft.prompts.push({ identifier: id, name: '新提示词', role: 'system', content: '', system_prompt: false, marker: false, injection_position: 0, injection_depth: 4, forbid_overrides: false });
            for (const order of this.doc.draft.prompt_order || []) order.order.push({ identifier: id, enabled: true });
            wanted = id;
        }
        this.persist(); this.renderList(wanted);
    }
    move(direction) {
        if (this.tab !== 'world') return;
        const fields = this.fields(); const index = fields.findIndex(x => x.id === this.field.id); const target = index + direction;
        if (target < 0 || target >= fields.length) return;
        this.rememberUndo(); [fields[index], fields[target]] = [fields[target], fields[index]];
        fields.forEach((f, i) => { this.doc.draft.entries[f.id].displayIndex = i; });
        this.persist(); this.renderList(this.field.id);
    }
    async generate(instruction) {
        const mode = this.$('.ww-ai-mode').value;
        if (['current', 'selection'].includes(mode) && (!this.field || this.field.marker)) throw new Error('请先选择可编辑的正文，或选择按预设起草。');
        const [a, b] = this.savedSelection;
        const original = this.editor.value;
        if (mode === 'selection' && a === b) throw new Error('尚未选中文字。手机上可改用“修改当前栏目”，直接输入意见。');
        const start = mode === 'selection' ? a : 0, end = mode === 'selection' ? b : original.length;
        const source = mode === 'result' ? this.$('.ww-suggestion').value : original.slice(start, end);
        if (mode === 'result' && !source.trim()) throw new Error('下面还没有输出稿，可以先生成或读取聊天最新回复。');
        const request = instruction || this.$('.ww-instruction').value.trim();
        if (!request) throw new Error('先写一句你想怎么改。');
        this.$('.ww-assistant').hidden = false;
        this.$('.ww-ai-message').textContent = '正在生成……';
        this.suggestion = null;
        this.generating = true;
        this.$('[data-action="stop"]').hidden = false;
        this.$('[data-action="stop"]').disabled = false;
        try {
            const prompt = mode === 'write'
                ? `请按照当前写卡预设的规则、格式和工作流程完成作者的写作要求。\n作者要求：${request}`
                : `你现在协助作者修改写卡内容，而不是继续角色扮演。请遵循当前写卡预设的格式，按照下面的意见修改原文。只返回完整的修改后正文；作者没有要求修改的部分保持不变，不加解释或代码围栏。保留 {{user}}、{{char}} 等宏。\n编辑对象：${mode === 'result' ? '上一版写卡输出' : this.field.title}\n修改意见：${request}\n原文：\n${source}`;
            const text = await this.bridge.generate(prompt, this.avatar);
            this.suggestion = ['current', 'selection'].includes(mode) ? { original, start, end, key: this.key(this.doc.meta), field: this.field.id } : null;
            this.$('.ww-suggestion').value = text;
            this.persistWriting();
            this.$('.ww-ai-message').textContent = '输出已保留。可以继续提修改意见，或选择栏目放入草稿。';
        } catch (error) { this.$('.ww-ai-message').textContent = '未完成生成，可以重试。'; throw error; }
        finally { this.generating = false; this.$('[data-action="stop"]').hidden = true; }
    }
    accept(append) {
        const s = this.suggestion;
        if (!s || s.key !== this.key(this.doc.meta) || s.field !== this.field.id) throw new Error('这条建议属于另一段内容，请重新生成。');
        const next = applySuggestion(this.editor.value, s.original, s.start, s.end, this.$('.ww-suggestion').value, append);
        this.rememberUndo(); writePath(this.doc.draft, this.field.path, next); this.editor.value = next;
        this.suggestion = null; this.persist(); this.count(); this.message('已采用到草稿，可撤回。');
    }
    placeOutput() {
        const field = this.fields().find(f => f.id === this.$('.ww-destination').value && !f.marker);
        const output = this.$('.ww-suggestion').value;
        if (!field || !output.trim()) throw new Error('请先准备输出稿，并选择要放入的栏目。');
        const old = String(readPath(this.doc.draft, field.path) || '');
        const next = this.$('.ww-placement-mode').value === 'append' && old ? old + '\n\n' + output : output;
        this.rememberUndo(); snapshot(this.doc, `放入${field.title}之前`);
        writePath(this.doc.draft, field.path, next);
        this.persist(); this.renderList(field.id);
        this.message(`已放入“${field.title}”的草稿，可撤回。写入酒馆后才生效。`);
    }
    latestReply() {
        this.bridge.assertCharacter(this.avatar);
        const reply = [...(this.bridge.context().chat || [])].reverse().find(m => !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim());
        if (!reply) throw new Error('当前聊天里没有可读取的 AI 回复。');
        this.$('.ww-suggestion').value = reply.mes;
        this.$('.ww-ai-mode').value = 'result'; this.suggestion = null;
        this.persistWriting(); this.message('已读取聊天最新回复，可直接提修改意见，再放入对应栏目。');
    }
    history() {
        if (!this.doc) return;
        this.$('.ww-history').hidden = false; const list = this.$('.ww-history-list'); list.replaceChildren();
        this.$('.ww-history-preview').textContent = '选择一个版本查看内容。'; this.$('[data-action="restore"]').disabled = true;
        this.doc.history.forEach((h, i) => list.append(element('button', { 'data-version': i }, `${new Date(h.time).toLocaleString()} · ${h.label}`)));
        if (!this.doc.history.length) list.textContent = '写入酒馆后会在这里保留版本。';
    }
    versionText(value) {
        if (this.doc.meta.kind === 'character') return [
            ...CHARACTER_FIELDS.map(([key, title]) => `${title}\n${value[key] || '（空）'}`),
            ...(value.alternate_greetings || []).map((text, i) => `备选开场白 ${i + 1}\n${text || '（空）'}`),
        ].join('\n\n──────────\n\n');
        if (this.doc.meta.kind === 'world') return Object.values(value.entries || {}).map(entry => `${entry.comment || '未命名条目'}\n关键词：${(entry.key || []).join('、')}\n${entry.content || '（空）'}`).join('\n\n──────────\n\n');
        if (Array.isArray(value.prompts)) return value.prompts.map(prompt => `${prompt.name || '未命名提示词'}\n${prompt.marker ? '（酒馆自动注入）' : prompt.content || '（空）'}`).join('\n\n──────────\n\n');
        return Object.entries(value).map(([name, text]) => `${name}\n${text}`).join('\n\n──────────\n\n');
    }
    exportDraft() {
        if (!this.doc) return;
        const payload = { format: 'writer-workbench-draft-v1', meta: this.doc.meta, draft: this.doc.draft, note: this.doc.note, base: this.doc.base, history: this.doc.history };
        const link = element('a', { download: `${this.doc.meta.title.replace(/[\\/:*?"<>|]/g, '_')}-工作台草稿.json`, href: URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })) });
        link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    async importDraft(file) {
        if (!this.doc) throw new Error('请先打开要恢复的角色、世界书或预设。');
        if (file.size > 20 * 1024 * 1024) throw new Error('草稿文件过大，限 20 MB。');
        const data = JSON.parse(await file.text(), (key, value) => {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('草稿含不支持的字段名。');
            return value;
        });
        if (data.format !== 'writer-workbench-draft-v1' || !data.meta || this.key(data.meta) !== this.key(this.doc.meta)) throw new Error('请打开这份草稿对应的角色、世界书或预设后再导入。');
        if (!data.draft || typeof data.draft !== 'object' || Array.isArray(data.draft)) throw new Error('草稿格式不正确。');
        if (data.meta.kind === 'character' && (!CHARACTER_FIELDS.every(([k]) => typeof data.draft[k] === 'string') || !Array.isArray(data.draft.alternate_greetings) || !data.draft.alternate_greetings.every(x => typeof x === 'string'))) throw new Error('角色草稿字段不完整。');
        if (data.meta.kind === 'world' && (!data.draft.entries || Array.isArray(data.draft.entries))) throw new Error('世界书草稿缺少条目。');
        snapshot(this.doc, '导入前的草稿'); this.rememberUndo();
        this.doc.draft = clone(data.draft);
        this.doc.note = typeof data.note === 'string' ? data.note : this.doc.note;
        this.$('.ww-note').value = this.doc.note || '';
        this.persist(); this.renderList(); this.message('已导入到草稿，尚未写入酒馆。');
    }
    async click(event) {
        const button = event.target.closest('button'); if (!button) return;
        if (button.dataset.action === 'stop' && this.generating) { this.bridge.context().stopGeneration?.(); this.$('.ww-ai-message').textContent = '已请求停止生成……'; return; }
        if (this.busy) return;
        if (button.dataset.tab) return this.run(() => this.switchTab(button.dataset.tab));
        if (button.dataset.field !== undefined) { this.persist(); this.showField(this.fields().find(f => f.id === button.dataset.field)); return; }
        if (button.dataset.version !== undefined) {
            this.version = Number(button.dataset.version);
            this.$('.ww-history-preview').textContent = this.versionText(this.doc.history[this.version].value);
            this.$('[data-action="restore"]').disabled = false; return;
        }
        const action = button.dataset.action;
        if (action === 'close') { this.close(); return; }
        if (action === 'ai' || action === 'ai-close') {
            this.$('.ww-assistant').hidden = action === 'ai-close';
            if (action === 'ai') { this.$('.ww-assistant').scrollIntoView?.({ block: 'start', behavior: 'smooth' }); this.$('.ww-instruction').focus({ preventScroll: true }); }
            return;
        }
        if (action === 'search') { this.$('.ww-search').hidden = !this.$('.ww-search').hidden; return; }
        if (action === 'history-close') { this.$('.ww-history').hidden = true; return; }
        if (action === 'import') { this.$('.ww-import').click(); return; }
        await this.run(async () => {
            if (action === 'save') await this.save();
            else if (action === 'test') {
                if (this.doc?.meta.kind !== 'character') throw new Error('请回到人物设定或开场白，保存角色卡后再试聊；世界书和预设请先分别写入。');
                if (await this.save()) { await this.bridge.testChat(this.avatar); await this.close(); }
            } else if (action === 'undo') {
                const previous = this.doc?.undo?.pop();
                if (previous) { this.doc.draft = previous; this.doc.lastEdit = 0; this.persist(); this.renderList(this.field?.id); }
                else this.message('没有可撤回的操作；更早的保存可在历史版本中恢复。');
            } else if (action === 'history') this.history();
            else if (action === 'export') this.exportDraft();
            else if (action === 'add' || action === 'duplicate') this.add(action === 'duplicate');
            else if (action === 'up' || action === 'down') this.move(action === 'up' ? -1 : 1);
            else if (action === 'generate') await this.generate();
            else if (action === 'place') this.placeOutput();
            else if (action === 'latest') this.latestReply();
            else if (action === 'polish') await this.generate('润色语言，让表达自然准确，保留设定与原有格式。');
            else if (action === 'expand') await this.generate('适度扩写，补充可用于角色扮演的具体细节，保留设定与原有格式。');
            else if (action === 'shorten') await this.generate('精简重复表达，保留关键信息与原有格式。');
            else if (action === 'accept' || action === 'append') this.accept(action === 'append');
            else if (action === 'restore') {
                const version = clone(this.doc.history[this.version].value);
                snapshot(this.doc, '恢复历史前的草稿'); this.rememberUndo(); this.doc.draft = version;
                this.$('.ww-history').hidden = true; this.persist(); this.renderList(); this.message('已恢复到草稿，点击写入酒馆后才会生效。');
            } else if (action === 'reload') {
                snapshot(this.doc, '合并冲突前的草稿'); this.rememberUndo();
                const live = await this.bridge.read(this.doc.meta); this.doc.base = clone(live); this.doc.draft = clone(live);
                this.persist(); this.renderList(); this.message('已载入酒馆版本；原草稿在历史版本中，可以查看并取回内容。');
            } else if (action === 'find' || action === 'replace') {
                if (!this.field || this.field.marker) return;
                const needle = this.$('.ww-find').value; if (!needle) throw new Error('请输入要查找的文字。');
                if (action === 'find') {
                    let index = this.editor.value.indexOf(needle, this.editor.selectionEnd);
                    if (index < 0) index = this.editor.value.indexOf(needle);
                    if (index < 0) this.message('当前正文中没有找到。');
                    else { this.editor.disabled = false; this.editor.focus(); this.editor.setSelectionRange(index, index + needle.length); }
                } else {
                    this.rememberUndo(); const next = this.editor.value.split(needle).join(this.$('.ww-replace').value);
                    writePath(this.doc.draft, this.field.path, next); this.editor.value = next; this.persist(); this.count();
                }
            }
        });
    }
}

export function install() {
    if (document.getElementById('writer-workbench-launch')) return;
    const launch = element('button', { id: 'writer-workbench-launch', type: 'button', class: 'menu_button', title: '打开写卡工作台' });
    launch.append(element('span', { class: 'fa-solid fa-pen-to-square', 'aria-hidden': 'true' }), element('span', {}, '写卡工作台'));
    const wrapper = element('div', { id: 'writer-workbench-settings', class: 'extension_container' });
    wrapper.append(launch);
    const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    (target || document.body).append(wrapper);
    if (!target) wrapper.classList.add('ww-launch-floating');
    const open = async () => {
        try { app ||= new Workbench(); if (!app.dialog.open) await app.open(); }
        catch (error) { globalThis.toastr?.error(error.message, '写卡工作台'); console.error(error); }
    };
    launch.addEventListener('click', open);
    const wand = document.querySelector('#extensionsMenu');
    if (wand) { const shortcut = element('div', { class: 'list-group-item flex-container flexGap5 interactable', tabindex: '0', role: 'button' }, '✎ 写卡工作台'); shortcut.addEventListener('click', open); shortcut.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }); wand.append(shortcut); }
}
if (!globalThis.__WW_TEST__) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    else install();
}
