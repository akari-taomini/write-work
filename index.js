import { TavernBridge } from './bridge.js';
import { searchRanges, highlightText } from './search.js';
import { newRegex, RegexRunner, previewDocument } from './regex-preview.js';
import { DraftStore, storageMessage } from './storage.js';
import { insertRelative, movePrompt, exportPromptPack, importPromptPack } from './preset-tools.js';
import { CHARACTER_FIELDS, clone, createId, equal, mergeThreeWay, readPath, writePath, snapshot, newEntry, applySuggestion, opaqueThemeColor } from './core.js';

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
        this.selectedPrompts = new Set();
        this.presetGroupIndex = 0;
        this.regexRunner = new RegexRunner(); this.previewSequence = 0;
        const ctx = adapter.context();
        if (!ctx.accountStorage) throw new Error('需要支持账号存储的 SillyTavern 版本，请先更新酒馆。');
        this.namespace = ctx.accountStorage.getItem('writer-workbench-browser-key');
        if (!this.namespace) {
            this.namespace = createId();
            ctx.accountStorage.setItem('writer-workbench-browser-key', this.namespace);
        }
        this.dialog = element('dialog', { class: 'ww', 'aria-label': '写卡工作台' });
        this.dialog.innerHTML = `
          <div class="ww-shell">
            <header class="ww-header">
              <div class="ww-brand"><span class="ww-mark">✎</span><div><strong>写卡工作台</strong><small>把时间留给故事</small></div></div>
              <span class="ww-character"></span>
              <button data-action="minimize">收起 / 继续聊天</button>
              <button type="button" data-action="close" aria-label="关闭工作台">✕</button>
            </header>
            <div class="ww-connection"><span class="ww-api"></span><label>写作预设 <select class="ww-writing-preset" aria-label="写作使用的预设"></select></label><small>与酒馆同步 · 无需另填 API</small></div>
            <details class="ww-binding"><summary>绑定编辑角色卡（不切换聊天）</summary><div class="ww-row"><input class="ww-card-search text_pole" type="search" placeholder="搜索角色名或文件名" aria-label="搜索要编辑的角色卡"><select class="ww-card-select" aria-label="要绑定的角色卡"></select><button data-action="bind-card">绑定这张卡</button></div><small class="ww-bound-info"></small></details>
            <nav class="ww-tabs" aria-label="内容类型"><button data-tab="character">人物设定</button><button data-tab="greetings">开场白</button><button data-tab="world">世界书</button><button data-tab="preset">预设</button><button data-tab="regex">局部正则</button></nav>
            <div class="ww-body">
              <aside class="ww-sidebar"><label class="ww-resource-label">编辑对象<select class="ww-resource" aria-label="正在编辑的对象"></select></label>
                <div class="ww-resource-tools" hidden><input class="ww-resource-search text_pole" type="search" placeholder="搜索世界书 / 预设名称" aria-label="搜索世界书或预设"><button data-action="refresh-resources">刷新列表</button></div>
                <details class="ww-new-world" hidden><summary>＋ 新建世界书</summary><input class="ww-world-name text_pole" aria-label="新世界书名称" placeholder="给新世界书起个名字"><button data-action="create-world">创建并开始编辑</button><small>创建后可写条目；绑定角色仍在酒馆中设置。</small></details>
                <label class="ww-preset-group-label" hidden>预设组<select class="ww-preset-group" aria-label="编辑的预设组"></select></label>
                <label class="ww-filter-label">搜索条目<input class="ww-filter text_pole" type="search" placeholder="搜标题或正文" aria-label="搜索条目标题或正文"></label><small class="ww-filter-count" aria-live="polite"></small>
                <details class="ww-batch" hidden><summary>多选导出 / 导入条目</summary><div class="ww-row"><button data-action="select-visible">全选搜索结果</button><button data-action="clear-selection">清空勾选</button></div><div class="ww-batch-list"></div><span class="ww-selected-count"></span><div class="ww-row"><button data-action="export-prompts">导出勾选条目</button><button data-action="import-prompts">导入条目包</button></div><small>导入到所选预设组，位置使用下面的“指定位置”；不会覆盖已有条目。</small><input class="ww-prompt-file" type="file" accept=".json,application/json" hidden></details>
                <div class="ww-list"></div><label class="ww-mobile-field-label">当前栏目<select class="ww-mobile-field" aria-label="当前栏目或世界书条目"></select></label><button data-action="add" class="ww-add">＋ 新增</button>
                <details class="ww-insert-tools" hidden><summary>指定位置 / 中间插入</summary><label>目标条目<select class="ww-anchor" aria-label="插入位置的目标条目"></select></label><label>位置<select class="ww-anchor-side" aria-label="插在目标之前或之后"><option value="after">在它后面</option><option value="before">在它前面</option></select></label><div class="ww-row"><button data-action="insert-new">在此处新建</button><button data-action="move-to">将当前条目移到此处</button></div><small class="ww-order-help"></small></details>
              </aside>
              <main class="ww-main">
                <div class="ww-editor-heading"><div><h2 class="ww-title">开始写作</h2><small class="ww-hint"></small></div><button data-action="search" title="查找与替换">查找替换</button></div>
                <div class="ww-search" hidden><input class="ww-find" placeholder="查找文字" aria-label="查找文字"><input class="ww-replace" placeholder="替换为" aria-label="替换文字"><button data-action="find">查找下一个</button><button data-action="replace">全部替换</button></div>
                <div class="ww-fields"></div>
                <div class="ww-hit-nav" hidden><span class="ww-hit-count" role="status"></span><button data-action="hit-prev">上一个</button><button data-action="hit-next">下一个</button></div>
                <div class="ww-editor-wrap"><textarea class="ww-editor" aria-label="正文编辑区" spellcheck="false" placeholder="从这里开始，写下你的角色……"></textarea><div class="ww-highlight-viewport" aria-hidden="true"><div class="ww-highlight-text"></div></div></div>
                <div class="ww-editor-meta"><span class="ww-count">0 字</span><span>Ctrl / ⌘ + S 写入酒馆</span><button data-action="duplicate" hidden>复制条目</button><button data-action="delete-entry" hidden>删除当前条目</button></div>
                <section class="ww-regex-preview" hidden aria-label="状态栏实时预览"><h2>HTML 实时预览</h2><div class="ww-row"><label>预览方式<select class="ww-preview-mode"><option value="regex">用测试文本运行当前正则</option><option value="html">直接预览 HTML</option></select></label><label>宽度<select class="ww-preview-width"><option value="100%">跟随窗口</option><option value="375px">手机 375px</option><option value="768px">平板 768px</option></select></label><button data-action="preview-refresh">刷新预览</button><button data-action="preview-advice">按意见修改代码</button></div><label>测试文本（仅供预览）<textarea class="ww-regex-test" rows="3" aria-label="正则测试文本"></textarea></label><p class="ww-preview-status" role="status"></p><div class="ww-preview-frame-wrap"><iframe class="ww-preview-frame" title="状态栏 HTML 预览" sandbox="" referrerpolicy="no-referrer"></iframe></div><details><summary>查看替换后的 HTML</summary><pre class="ww-preview-source"></pre></details><small>预览当前单条正则的替换结果；不模拟聊天深度与触发位置。支持 HTML/CSS，不执行脚本，不提供酒馆助手变量接口；基本宏支持 {{char}} / {{user}}，其他宏需用实际值测试。AI 根据代码和你的描述修改，不会自动看见预览画面。</small></section>
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
            <section class="ww-exit" hidden role="alertdialog" aria-modal="true" aria-label="退出前检查草稿"><h2>还有内容没写入酒馆</h2><p class="ww-exit-message"></p><ul class="ww-exit-list"></ul><div class="ww-row"><button data-action="exit-cancel" class="ww-primary">返回继续编辑</button><button data-action="exit-confirm">保留本地草稿并退出</button><button data-action="exit-discard">不保存并退出</button></div><small>不保存并退出：放弃以上对象尚未写入的修改，恢复酒馆当前内容；本地备注和 AI 输出仍保留，已经写入酒馆的内容不会撤销。</small><p class="ww-exit-error" role="alert"></p></section>
          </div>`;
        document.body.append(this.dialog);
        this.resumeButton = element('button', { class: 'ww-resume menu_button', hidden: '' }, '继续写卡');
        document.body.append(this.resumeButton);
        this.resumeButton.addEventListener('click', () => this.open());
        this.dialog.querySelectorAll('button').forEach(node => { node.classList.add('menu_button'); node.type = 'button'; });
        this.dialog.querySelectorAll('textarea,input:not([type="checkbox"])').forEach(node => node.classList.add('text_pole'));
        this.$ = selector => this.dialog.querySelector(selector);
        // Keep the history overlay outside the scrolling shell.
        this.dialog.append(this.$('.ww-history'));
        this.dialog.append(this.$('.ww-exit'));
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
        this.searchSource = 'filter'; this.activeHit = -1;
        this.highlightResize = new window.ResizeObserver(() => this.syncHighlights());
        this.highlightResize.observe(this.editor);
        this.dialog.addEventListener('click', event => this.click(event));
        this.dialog.addEventListener('cancel', event => { event.preventDefault(); if (this.busy) return; if (!this.$('.ww-exit').hidden) this.cancelExit(); else this.close(); });
        this.dialog.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && this.$('.ww-exit').hidden && this.$('.ww-history').hidden) {
                event.preventDefault(); this.$('.ww-search').hidden = false; this.searchSource = 'find';
                this.$('.ww-find').focus(); this.$('.ww-find').select(); this.updateHighlights();
            }
            if (event.target === this.$('.ww-find') && event.key === 'Enter') { event.preventDefault(); this.navigateHit(event.shiftKey ? -1 : 1); }
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
            this.syncHighlights();
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
        this.$('.ww-card-search').addEventListener('input', () => this.renderCardChoices());
        this.$('.ww-resource-search').addEventListener('input', () => this.renderResourceChoices());
        this.$('.ww-regex-test').addEventListener('input', () => {
            if (this.doc?.meta.kind !== 'regex') return;
            this.doc.previewTest = this.$('.ww-regex-test').value; this.persist(); this.schedulePreview();
        });
        this.$('.ww-preview-mode').addEventListener('change', () => this.schedulePreview());
        this.$('.ww-preview-width').addEventListener('change', () => { this.$('.ww-preview-frame').style.width = this.$('.ww-preview-width').value; });
        this.$('.ww-filter').addEventListener('input', () => { this.searchSource = 'filter'; this.renderList(undefined, true); this.updateHighlights(); });
        this.$('.ww-find').addEventListener('input', () => { this.searchSource = 'find'; this.updateHighlights(); });
        this.$('.ww-find').addEventListener('focus', () => { this.searchSource = 'find'; this.updateHighlights(); });
        this.$('.ww-preset-group').addEventListener('change', event => { this.presetGroupIndex = Number(event.target.value); this.renderList(this.field?.id); });
        this.$('.ww-prompt-file').addEventListener('change', event => {
            const file = event.target.files[0]; event.target.value = '';
            if (file) this.run(() => this.importPrompts(file));
        });
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
            if (this.pendingPersistence || this.failedPersistence.size || this.unwrittenDocuments().length) { event.preventDefault(); event.returnValue = ''; }
        });
    }
    syncTheme() {
        const color = window.getComputedStyle(this.themeProbe).backgroundColor;
        this.dialog.style.setProperty('--ww-surface', opaqueThemeColor(color));
        if (this.editor) this.syncHighlights();
    }
    writingKey() { return `ww:${this.namespace}:writing:${this.avatar || '_unbound'}`; }
    async persistWriting() {
        if (!this.writingLoaded) return;
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
        this.writingLoaded = true;
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
    async persist(doc = this.doc) {
        if (this.discarding) return false;
        if (!doc) return true;
        doc.updated = new Date().toISOString();
        const key = this.storageKey(doc.meta);
        const sequence = (this.persistenceSequence.get(key) || 0) + 1;
        this.persistenceSequence.set(key, sequence);
        this.pendingPersistence++;
        const clean = equal(doc.base, doc.draft);
        if (this.doc === doc) this.$('.ww-status').textContent = '正在保存草稿…';
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
        if (this.minimized) {
            this.minimized = false; this.resumeButton.hidden = true; this.syncTheme(); this.dialog.show(); this.renderCardChoices(); this.schedulePreview(); return;
        }
        this.syncTheme(); this.dialog.show(); this.renderCardChoices();
        await this.run(async () => {
            this.connection();
            const saved = this.bridge.context().accountStorage.getItem('writer-workbench-target');
            const candidates = this.cardChoices();
            const target = [this.avatar, saved, this.bridge.currentCharacter()?.avatar].find(id => candidates.some(c => c.avatar === id));
            if (target) await this.bindTarget(target);
            else { this.avatar = null; this.fullCard = {}; await this.loadWriting(); this.updateBinding(); await this.switchTab('character'); this.$('.ww-binding').open = true; }
        });
    }
    cardChoices() { return this.bridge.characters?.() || [this.bridge.currentCharacter()].filter(Boolean); }
    renderCardChoices() {
        const select = this.$('.ww-card-select'), previous = select.value;
        const query = this.$('.ww-card-search').value.trim().toLocaleLowerCase();
        const cards = this.cardChoices().filter(c => `${c.name} ${c.avatar}`.toLocaleLowerCase().includes(query));
        select.replaceChildren(option('', cards.length ? '选择编辑目标' : '没有匹配的角色卡'), ...cards.map(c => option(c.avatar, `${c.name} · ${c.avatar}`)));
        select.value = cards.some(c => c.avatar === previous) ? previous : cards.some(c => c.avatar === this.avatar) ? this.avatar : '';
    }
    updateBinding() {
        this.$('.ww-character').textContent = this.avatar ? `编辑：${this.fullCard.name || this.avatar}` : '尚未绑定角色卡';
        this.$('.ww-bound-info').textContent = this.avatar ? `写入目标：${this.fullCard.name || this.avatar}（${this.avatar}）。切换聊天不会改变此目标。` : '可先搜索并绑定角色卡；未绑定时仍能编辑世界书与预设。';
        this.$('[data-action="save"]').title = this.avatar ? `将当前草稿写入所选对象；角色目标为 ${this.fullCard.name || this.avatar}` : '将当前草稿写入所选对象';
    }
    async bindTarget(avatar) {
        if (!avatar) throw new Error('请先搜索并选择要绑定的角色卡。');
        await this.persist(); await this.persistWriting();
        const full = await this.bridge.getCharacter(avatar);
        this.avatar = avatar; this.fullCard = full;
        try { this.bridge.context().accountStorage.setItem('writer-workbench-target', avatar); } catch { /* Selection can stay in memory. */ }
        await this.loadWriting(); this.updateBinding(); this.renderCardChoices();
        await this.switchTab(['world', 'preset'].includes(this.tab) ? this.tab : this.tab === 'regex' ? 'regex' : 'character');
    }
    async minimize() {
        await this.persist(); await this.persistWriting();
        this.minimized = true; this.cancelPreview(); this.dialog.close(); this.resumeButton.hidden = false;
    }
    unwrittenDocuments() { return [...this.docs.values()].filter(doc => !equal(doc.base, doc.draft)); }
    async close({ confirmed = false } = {}) {
        await Promise.all([...this.docs.values()].map(doc => this.persist(doc)).concat(this.persistWriting()));
        const dirty = this.unwrittenDocuments();
        if (!confirmed && (dirty.length || this.failedPersistence.size)) {
            this.$('.ww-exit-list').replaceChildren(...dirty.map(doc => element('li', {}, `${doc.meta.kind === 'world' ? '世界书' : doc.meta.kind === 'preset' ? '预设' : doc.meta.kind === 'regex' ? '局部正则' : '角色卡'}：${doc.meta.title || doc.meta.id}`)));
            const failed = this.failedPersistence.size > 0;
            this.$('.ww-exit-message').textContent = failed ? '有本地备份未成功。建议返回编辑，先导出或写入酒馆；现在退出后，未备份的内容可能在刷新时丢失。' : '这些修改已保存在本地草稿，但还没有写入酒馆。可以返回保存，也可以保留草稿，下次继续。';
            this.$('[data-action="exit-confirm"]').textContent = failed ? '仍要退出（未备份）' : '保留本地草稿并退出';
            this.$('.ww-exit').hidden = false;
            this.$('.ww-exit-error').textContent = '';
            this.$('.ww-shell').inert = true;
            this.$('[data-action="exit-cancel"]').focus();
            return false;
        }
        this.cancelExit(); this.cancelPreview(); this.resumeButton.hidden = true; this.dialog.close(); return true;
    }
    cancelExit() {
        this.$('.ww-exit').hidden = true;
        this.$('.ww-shell').inert = false;
    }
    async discardAndExit() {
        const docs = this.unwrittenDocuments();
        this.discarding = true;
        try {
            // Read every live object before discarding anything. Never write to Tavern here.
            const live = await Promise.all(docs.map(doc => this.bridge.read(doc.meta)));
            for (let i = 0; i < docs.length; i++) {
                const doc = docs[i];
                const reset = { ...doc, base: clone(live[i]), draft: clone(live[i]), undo: [], lastEdit: 0 };
                await this.store.set(this.storageKey(doc.meta), reset);
                Object.assign(doc, reset);
                this.failedPersistence.delete(this.storageKey(doc.meta));
            }
            await this.persistWriting();
            if (this.failedPersistence.size) throw new Error('仍有本地备份失败，请返回检查。');
            this.renderList(); this.cancelExit(); this.cancelPreview(); this.resumeButton.hidden = true; this.dialog.close();
        } catch (error) {
            this.$('.ww-exit-error').textContent = `未能完成退出：${error.message}。已恢复成功的对象不再列为未保存；其余草稿仍保留，可重试或返回编辑。`;
            this.renderList();
        } finally { this.discarding = false; }
    }
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
        this.cancelPreview();
        this.tab = tab;
        this.$('.ww-regex-preview').hidden = tab !== 'regex';
        this.$('.ww-new-world').hidden = tab !== 'world';
        this.dialog.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
        const select = this.$('.ww-resource'); select.replaceChildren();
        this.$('.ww-resource-label').hidden = !['world', 'preset'].includes(tab);
        this.$('.ww-resource-tools').hidden = !['world', 'preset'].includes(tab);
        this.$('.ww-resource-search').value = ''; this.resourceNames = [];
        try { if (tab === 'world') {
            const names = await this.bridge.worlds();
            this.resourceNames = names;
            names.forEach(name => select.append(option(name, name)));
            const linked = this.fullCard?.data?.extensions?.world;
            if (names.includes(linked)) select.value = linked;
            if (!names.length) { this.empty('还没有世界书。点击上面的“新建世界书”即可开始。'); return; }
            await this.loadResource(select.value);
            if (this.bridge.worldWarning) this.message(this.bridge.worldWarning, true);
        } else if (tab === 'preset') {
            const p = this.bridge.presets();
            this.resourceNames = p.names;
            p.names.forEach(name => select.append(option(name, name))); select.value = p.current;
            if (!p.names.length) { this.empty('当前连接没有已保存的预设。'); return; }
            await this.loadResource(select.value);
        } else if (!this.avatar) this.empty('请在上方“绑定编辑角色卡”中搜索并选择一张卡，无需切换当前聊天。');
        else await this.load({ kind: tab === 'regex' ? 'regex' : 'character', id: this.avatar, title: this.fullCard.name || this.avatar });
        } catch (error) { this.empty('未能载入，请重试。已有草稿仍然保留。'); throw error; }
    }
    renderResourceChoices() {
        const query = this.$('.ww-resource-search').value.trim().toLocaleLowerCase();
        const select = this.$('.ww-resource'), current = this.doc?.meta.id;
        const names = (this.resourceNames || []).filter(name => name.toLocaleLowerCase().includes(query));
        select.replaceChildren(option('', names.length ? '请选择编辑对象' : '没有匹配结果'), ...names.map(name => option(name, name)));
        select.value = names.includes(current) ? current : '';
    }
    async loadResource(id) {
        if (!id) return;
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
        this.selectedPrompts.clear(); this.$('.ww-filter').value = '';
        this.presetGroupIndex = Math.max(0, doc.draft.prompt_order?.findIndex(g => Number(g.character_id) === 100001) ?? 0);
        this.docs.set(this.key(meta), doc);
        this.suggestion = null;
        this.$('.ww-note').value = doc.note || '';
        this.renderList(); this.persist();
    }
    empty(text) {
        this.doc = null; this.field = null;
        this.$('.ww-list').replaceChildren(); this.$('.ww-fields').replaceChildren();
        this.$('.ww-mobile-field').replaceChildren();
        this.$('.ww-batch').hidden = true; this.$('.ww-insert-tools').hidden = true; this.$('.ww-preset-group-label').hidden = true;
        this.$('.ww-title').textContent = '这里还是空的'; this.$('.ww-hint').textContent = text;
        this.editor.value = ''; this.editor.disabled = true; this.$('.ww-add').hidden = true;
        this.$('[data-action="delete-entry"]').hidden = true;
        this.$('[data-action="duplicate"]').hidden = true;
        this.count();
        this.$('.ww-status').textContent = '未选择内容';
        this.cancelPreview(); this.$('.ww-preview-frame').srcdoc = '';
    }
    fields() {
        if (!this.doc) return [];
        const d = this.doc.draft;
        if (this.tab === 'character') return CHARACTER_FIELDS.filter(([k]) => k !== 'first_mes').map(([key, title]) => ({ id: key, title, path: [key] }));
        if (this.tab === 'greetings') return [{ id: 'first_mes', title: '第一条开场白', path: ['first_mes'] }, ...d.alternate_greetings.map((_, i) => ({ id: `alt-${i}`, title: `备选开场白 ${i + 1}`, path: ['alternate_greetings', i] }))];
        if (this.tab === 'regex') return d.scripts.map((script, i) => ({ id: script.id || `regex-${i}`, title: script.scriptName || `正则 ${i + 1}`, path: ['scripts', i, 'replaceString'] }));
        if (this.tab === 'world') return Object.entries(d.entries || {}).sort((a, b) => (a[1].displayIndex ?? +a[0]) - (b[1].displayIndex ?? +b[0])).map(([id, entry]) => ({ id, title: entry.comment || entry.key?.join('、') || `条目 ${id}`, path: ['entries', id, 'content'] }));
        if (Array.isArray(d.prompts)) {
            const order = d.prompt_order?.[this.presetGroupIndex]?.order || [];
            const rank = id => { const n = order.findIndex(p => p.identifier === id); return n < 0 ? order.length : n; };
            return d.prompts.map((p, i) => ({ id: p.identifier || String(i), title: p.name || '未命名提示词', path: ['prompts', i, 'content'], marker: p.marker })).sort((a, b) => rank(a.id) - rank(b.id));
        }
        return Object.entries(d).filter(([k, v]) => typeof v === 'string' && /prompt|preamble|content|sequence|suffix|prefix/i.test(k)).map(([key]) => ({ id: key, title: key, path: [key] }));
    }
    visibleFields() {
        const terms = this.$('.ww-filter').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        return this.fields().filter(field => terms.every(term => `${field.title}\n${readPath(this.doc.draft, field.path) || ''}\n${this.tab === 'regex' ? this.doc.draft.scripts[field.path[1]].findRegex || '' : ''}`.toLocaleLowerCase().includes(term)));
    }
    renderList(wanted, filterOnly = false) {
        const fields = this.fields(), visible = this.visibleFields(); const list = this.$('.ww-list'); list.replaceChildren();
        this.$('.ww-filter-count').textContent = `找到 ${visible.length} / ${fields.length} 条`;
        this.$('.ww-mobile-field').replaceChildren(...visible.map(field => option(field.id, field.title)));
        const isPreset = this.tab === 'preset' && Array.isArray(this.doc?.draft.prompts);
        this.$('.ww-batch').hidden = !isPreset;
        this.$('.ww-preset-group-label').hidden = !isPreset;
        this.$('.ww-insert-tools').hidden = !(isPreset || this.tab === 'world') || !this.doc;
        const group = this.$('.ww-preset-group');
        group.replaceChildren(...(this.doc?.draft.prompt_order || []).map((g, i) => option(i, Number(g.character_id) === 100001 ? '角色聊天组' : Number(g.character_id) === 100000 ? '默认预设组' : `预设组 ${i + 1}`)));
        group.value = String(this.presetGroupIndex);
        this.$('.ww-order-help').textContent = isPreset ? '移动调整所选预设组的提示词顺序；定深条目仍受自身位置和深度设置控制。' : '这里只整理列表显示顺序，不改变模型注入顺序；后者使用“注入顺序”设置。';
        this.selectedPrompts = new Set([...this.selectedPrompts].filter(id => fields.some(f => f.id === id && !f.marker)));
        const batch = this.$('.ww-batch-list'); batch.replaceChildren();
        if (isPreset) for (const field of visible.filter(f => !f.marker)) {
            const label = element('label', { class: 'ww-batch-item' });
            const check = element('input', { type: 'checkbox', 'aria-label': `选择 ${field.title}` }); check.checked = this.selectedPrompts.has(field.id);
            check.addEventListener('change', () => { check.checked ? this.selectedPrompts.add(field.id) : this.selectedPrompts.delete(field.id); this.updateSelectedCount(); });
            label.append(check, element('span', {}, field.title)); batch.append(label);
        }
        this.updateSelectedCount();
        this.$('.ww-add').hidden = !this.doc || (!['greetings', 'world', 'regex'].includes(this.tab) && !(this.tab === 'preset' && Array.isArray(this.doc?.draft.prompts)));
        for (const field of visible) {
            const button = element('button', { type: 'button', 'data-field': field.id }, field.title);
            highlightText(button, field.title, searchRanges(field.title, this.$('.ww-filter').value.trim().split(/\s+/)));
            button.classList.toggle('ww-active', field.id === this.field?.id);
            list.append(button);
        }
        if (filterOnly) { this.$('.ww-mobile-field').value = this.field?.id || ''; return; }
        this.showField(fields.find(f => f.id === wanted || (!wanted && f.id === this.doc?.lastField?.[this.tab])) || fields[0]);
    }
    updateSelectedCount() { this.$('.ww-selected-count').textContent = `已勾选 ${this.selectedPrompts.size} 条（包含被搜索隐藏的勾选项）`; }
    showField(field) {
        this.field = field;
        this.$('[data-action="delete-entry"]').hidden = !this.canDelete(field);
        this.$('[data-action="duplicate"]').hidden = !['world', 'regex'].includes(this.tab) || !field;
        this.$('.ww-mobile-field').value = field?.id || '';
        this.suggestion = null;
        this.savedSelection = [0, 0];
        this.$('[data-action="accept"]').disabled = true; this.$('[data-action="append"]').disabled = true;
        this.$('.ww-fields').replaceChildren();
        const anchor = this.$('.ww-anchor');
        const orderedIds = this.doc?.draft.prompt_order?.[this.presetGroupIndex]?.order?.map(p => p.identifier);
        const targets = this.fields().filter(f => this.tab !== 'preset' || orderedIds?.includes(f.id));
        anchor.replaceChildren(option('', '列表末尾'), ...targets.map(f => option(f.id, f.title)));
        anchor.value = targets.some(f => f.id === field?.id) ? field.id : '';
        const destination = this.$('.ww-destination');
        destination.replaceChildren();
        this.fields().filter(f => !f.marker).forEach(f => destination.append(option(f.id, f.title)));
        if (field && !field.marker) destination.value = field.id;
        if (!field) { this.editor.value = ''; this.editor.disabled = true; this.$('.ww-title').textContent = '暂无可编辑条目'; this.$('.ww-hint').textContent = '可新增条目；参数型预设请在酒馆原面板调整参数。'; this.count(); return; }
        this.editor.disabled = !!field.marker;
        this.doc.lastField ||= {}; this.doc.lastField[this.tab] = field.id;
        this.doc.lastEdit = 0;
        this.$('.ww-title').textContent = field.title;
        this.$('.ww-hint').textContent = field.marker ? '酒馆自动注入的占位条目，正文由酒馆管理。' : (this.tab === 'preset' ? '编辑提示词正文；保存此预设后，酒馆会同步选中它。' : '直接编辑，草稿会自动保留。');
        this.editor.value = String(readPath(this.doc.draft, field.path) ?? '');
        this.editor.scrollTop = this.doc.scroll?.[field.id] || 0;
        this.dialog.querySelectorAll('[data-field]').forEach(b => b.classList.toggle('ww-active', b.dataset.field === field.id));
        this.$('[data-action="duplicate"]').hidden = !['world', 'regex'].includes(this.tab);
        if (this.tab === 'world') {
            this.metaInput('条目标题', ['entries', field.id, 'comment']);
            this.metaInput('关键词（逗号分隔）', ['entries', field.id, 'key'], 'array');
            this.metaInput('停用', ['entries', field.id, 'disable'], 'checkbox');
            this.metaInput('常驻', ['entries', field.id, 'constant'], 'checkbox');
            this.metaInput('注入顺序（不是列表位置）', ['entries', field.id, 'order'], 'number');
            const row = element('div', { class: 'ww-row' });
            row.append(element('small', {}, '列表位置只影响整理，可在“指定位置”中直接移动或插入。'));
            this.$('.ww-fields').append(row);
        } else if (this.tab === 'regex') {
            const path = ['scripts', field.path[1]];
            this.metaInput('正则名称', [...path, 'scriptName']);
            this.metaInput('查找表达式', [...path, 'findRegex']);
            this.metaInput('停用', [...path, 'disabled'], 'checkbox');
            this.metaInput('仅显示格式', [...path, 'markdownOnly'], 'checkbox');
            this.metaInput('仅提示词', [...path, 'promptOnly'], 'checkbox');
            this.metaInput('编辑时运行', [...path, 'runOnEdit'], 'checkbox');
            this.metaInput('最小深度（留空不限）', [...path, 'minDepth'], 'nullable-number');
            this.metaInput('最大深度（留空不限）', [...path, 'maxDepth'], 'nullable-number');
            const script = this.doc.draft.scripts[field.path[1]];
            const placement = element('div', { class: 'ww-row' });
            for (const [value, title] of [[1, '用户输入'], [2, 'AI 输出'], [3, '快捷命令'], [5, '世界书'], [6, '推理']]) {
                const label = element('label', {}, title), check = element('input', { type: 'checkbox' });
                check.checked = (script.placement || []).includes(value);
                check.addEventListener('change', () => { this.rememberUndo(); script.placement = check.checked ? [...new Set([...(script.placement || []), value])] : (script.placement || []).filter(p => p !== value); this.persist(); });
                label.prepend(check); placement.append(label);
            }
            this.$('.ww-fields').append(placement);
            const macroLabel = element('label', { class: 'ww-meta-input' }, '查找表达式宏替换');
            const macroSelect = element('select', { 'aria-label': '查找表达式宏替换' });
            [[0, '不替换'], [1, '原样替换'], [2, '转义后替换']].forEach(([value, name]) => macroSelect.append(option(value, name)));
            macroSelect.value = String(script.substituteRegex || 0);
            macroSelect.addEventListener('change', () => { this.rememberUndo(); script.substituteRegex = Number(macroSelect.value); this.persist(); this.schedulePreview(); });
            macroLabel.append(macroSelect); this.$('.ww-fields').append(macroLabel);
            const trimLabel = element('label', { class: 'ww-regex-trim-label' }, '从捕获组中裁剪的文字（每行一项）');
            const trimInput = element('textarea', { rows: '2', 'aria-label': '裁剪文字' }); trimInput.value = (script.trimStrings || []).join('\n');
            trimInput.addEventListener('change', () => { this.rememberUndo(); script.trimStrings = trimInput.value.split('\n').filter(Boolean); this.persist(); this.schedulePreview(); });
            trimLabel.append(trimInput); this.$('.ww-fields').append(trimLabel);
            const extra = element('details', { class: 'ww-regex-options' }); extra.append(element('summary', {}, '触发位置与高级设置'));
            [...this.$('.ww-fields').children].slice(2).forEach(node => extra.append(node)); this.$('.ww-fields').append(extra);
            this.$('.ww-regex-test').value = this.doc.previewTest ?? '<status>心情：平静\n地点：旧书店\n好感：20</status>';
            this.$('.ww-hint').textContent = '正文框编辑替换 HTML，保存到绑定角色卡的局部正则；聊天中的启用授权仍在酒馆正则面板确认。';
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
        const wrapper = element('label', { class: 'ww-meta-input', 'data-key': path.at(-1) }, label);
        const input = element('input', { type: type === 'array' ? 'text' : type === 'nullable-number' ? 'number' : type, 'aria-label': label });
        const val = readPath(this.doc.draft, path);
        if (type === 'checkbox') input.checked = !!val;
        else input.value = type === 'array' ? (val || []).join(', ') : (val ?? '');
        const liveRegex = path.at(-1) === 'findRegex';
        input.addEventListener(liveRegex ? 'input' : 'change', () => {
            if ((type === 'number' || type === 'nullable-number') && ((type === 'number' && !input.value.trim()) || !Number.isFinite(Number(input.value)))) { this.message('请输入有效数字。', true); return; }
            this.rememberUndo(liveRegex);
            writePath(this.doc.draft, path, type === 'checkbox' ? input.checked : type === 'nullable-number' ? input.value.trim() ? Number(input.value) : null : type === 'number' ? Number(input.value) : type === 'array' ? input.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) : input.value);
            if (liveRegex) { this.persist(); this.schedulePreview(); return; }
            this.persist(); this.renderList(this.field.id);
        });
        wrapper.append(input); this.$('.ww-fields').append(wrapper);
    }
    count() { this.$('.ww-count').textContent = `${Array.from(this.editor.value).length.toLocaleString()} 字`; this.updateHighlights(); this.schedulePreview(); }
    canDelete(field = this.field) {
        if (!field || !this.doc) return false;
        if (this.tab === 'world') return true;
        if (this.tab === 'regex') return true;
        if (this.tab === 'greetings') return field.path[0] === 'alternate_greetings';
        if (this.tab === 'preset' && field.path[0] === 'prompts') {
            const prompt = this.doc.draft.prompts[field.path[1]];
            return !prompt.marker && !prompt.system_prompt;
        }
        return false;
    }
    cancelPreview() {
        clearTimeout(this.previewTimer); this.previewSequence++;
        this.regexRunner.cancel();
    }
    schedulePreview() {
        this.cancelPreview();
        if (this.tab !== 'regex' || !this.field || !this.dialog.open) {
            this.$('.ww-preview-frame').srcdoc = ''; this.$('.ww-preview-source').textContent = ''; this.$('.ww-preview-status').textContent = ''; return;
        }
        const sequence = this.previewSequence;
        this.previewTimer = setTimeout(() => this.renderPreview(sequence), 220);
    }
    async renderPreview(sequence = this.previewSequence) {
        if (this.tab !== 'regex' || !this.field) { this.$('.ww-preview-frame').srcdoc = ''; return; }
        const script = clone(this.doc.draft.scripts[this.field.path[1]]);
        this.$('.ww-preview-status').textContent = '正在更新预览…';
        try {
            let result;
            if (this.$('.ww-preview-mode').value === 'html') {
                if (script.replaceString.length > 250000) throw new Error('预览代码过长，限 25 万字。');
                result = { html: script.replaceString, count: null };
            } else result = await this.regexRunner.run({ script, text: this.$('.ww-regex-test').value, character: this.fullCard?.name || '', user: this.bridge.context().name1 || '用户' });
            if (sequence !== this.previewSequence || this.tab !== 'regex') return;
            this.$('.ww-preview-frame').srcdoc = previewDocument(result.html);
            this.$('.ww-preview-source').textContent = result.html;
            this.$('.ww-preview-status').textContent = result.count === null ? '直接预览替换 HTML；捕获组与宏保持原文。' : result.disabled ? '这条正则已停用，显示未替换的测试文本。' : `当前单条正则命中 ${result.count} 处。预览仅保留在工作台，尚未写入角色卡。`;
        } catch (error) {
            if (sequence !== this.previewSequence) return;
            this.$('.ww-preview-frame').srcdoc = '';
            this.$('.ww-preview-source').textContent = '';
            this.$('.ww-preview-status').textContent = `预览未完成：${error.message}`;
        }
    }
    deleteEntry() {
        if (!this.canDelete()) throw new Error('固定栏目或酒馆内置提示词不能删除，可编辑正文或停用。');
        const fields = this.fields(), index = fields.findIndex(f => f.id === this.field.id), id = this.field.id;
        this.rememberUndo();
        if (this.tab === 'world') delete this.doc.draft.entries[id];
        else if (this.tab === 'regex') this.doc.draft.scripts.splice(this.field.path[1], 1);
        else if (this.tab === 'greetings') this.doc.draft.alternate_greetings.splice(this.field.path[1], 1);
        else {
            this.doc.draft.prompts.splice(this.field.path[1], 1);
            for (const group of this.doc.draft.prompt_order || []) group.order = group.order.filter(p => p.identifier !== id);
            this.selectedPrompts.delete(id);
        }
        this.persist(); this.renderList(this.fields()[Math.min(index, this.fields().length - 1)]?.id);
        this.message('已从草稿删除，可在“更多操作 → 撤回”中恢复；写入酒馆后才正式生效。');
    }
    updateHighlights() {
        const terms = this.searchSource === 'find' ? [this.$('.ww-find').value] : this.$('.ww-filter').value.trim().split(/\s+/);
        this.hitRanges = this.field?.marker ? [] : searchRanges(this.editor.value, terms);
        this.activeHit = -1;
        this.$('.ww-hit-nav').hidden = !terms.some(Boolean);
        this.paintHighlights();
    }
    paintHighlights() {
        highlightText(this.$('.ww-highlight-text'), this.editor.value + '\n', this.hitRanges || [], this.activeHit);
        const total = this.hitRanges?.length || 0;
        this.$('.ww-hit-count').textContent = `正文 ${this.activeHit < 0 ? 0 : this.activeHit + 1} / ${total} 处`;
        this.syncHighlights();
    }
    syncHighlights() {
        const style = window.getComputedStyle(this.editor), layer = this.$('.ww-highlight-text'), viewport = this.$('.ww-highlight-viewport');
        for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlign', 'textIndent', 'textTransform', 'direction', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) layer.style[key] = style[key];
        viewport.style.top = style.borderTopWidth; viewport.style.left = style.borderLeftWidth;
        viewport.style.width = `${this.editor.clientWidth}px`; viewport.style.height = `${this.editor.clientHeight}px`;
        layer.style.width = `${this.editor.clientWidth}px`;
        layer.style.transform = `translate(${-this.editor.scrollLeft}px, ${-this.editor.scrollTop}px)`;
    }
    navigateHit(direction) {
        const total = this.hitRanges?.length || 0;
        if (!total) { this.message('当前正文中没有找到。'); return; }
        this.activeHit = this.activeHit < 0 ? (direction > 0 ? 0 : total - 1) : (this.activeHit + direction + total) % total;
        this.paintHighlights();
        const mark = this.$('.ww-hit-current');
        const rect = mark.getBoundingClientRect(), editorRect = this.editor.getBoundingClientRect();
        this.editor.scrollTop += rect.top - editorRect.top - this.editor.clientHeight / 2;
        this.syncHighlights();
        this.$('.ww-editor-wrap').scrollIntoView?.({ block: 'nearest' });
    }
    async save() {
        if (!this.doc) throw new Error('请先选择要编辑的内容。');
        if (['character', 'regex'].includes(this.doc.meta.kind)) this.bridge.assertTarget?.(this.doc.meta.id);
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
        if (this.tab === 'preset' && !this.doc.draft.prompt_order?.[this.presetGroupIndex]) throw new Error('请先选择有效的预设组。');
        this.rememberUndo(); let wanted;
        if (this.tab === 'greetings') { this.doc.draft.alternate_greetings.push(''); wanted = `alt-${this.doc.draft.alternate_greetings.length - 1}`; }
        else if (this.tab === 'world') wanted = String(newEntry(this.doc.draft.entries, copy ? this.doc.draft.entries[this.field.id] : null));
        else if (this.tab === 'regex') {
            const script = copy && this.field ? { ...clone(this.doc.draft.scripts[this.field.path[1]]), id: createId(), scriptName: this.field.title + ' · 副本' } : newRegex();
            this.doc.draft.scripts.push(script); wanted = script.id;
        }
        else if (this.tab === 'preset' && Array.isArray(this.doc.draft.prompts)) {
            const id = createId();
            this.doc.draft.prompts.push({ identifier: id, name: '新提示词', role: 'system', content: '', system_prompt: false, marker: false, injection_position: 0, injection_depth: 4, forbid_overrides: false });
            this.doc.draft.prompt_order[this.presetGroupIndex].order.push({ identifier: id, enabled: true });
            wanted = id;
        }
        this.persist(); this.renderList(wanted);
        return wanted;
    }
    relocate(id, anchor, side, remember = true) {
        if (!id || id === anchor) return;
        const next = clone(this.doc.draft);
        if (this.tab === 'world') {
            const ids = this.fields().map(f => f.id).filter(key => key !== id);
            insertRelative(ids, [id], anchor, side, key => key).forEach((key, i) => { next.entries[key].displayIndex = i; });
        } else if (this.tab === 'preset') movePrompt(next, id, anchor, side, this.presetGroupIndex);
        else return;
        if (remember) this.rememberUndo();
        this.doc.draft = next;
        this.persist(); this.renderList(id);
    }
    insertNew() {
        const anchor = this.$('.ww-anchor').value, side = this.$('.ww-anchor-side').value;
        this.$('.ww-filter').value = '';
        const id = this.add();
        this.relocate(id, anchor, side, false);
    }
    async createWorld() {
        await this.persist();
        const name = await this.bridge.createWorld(this.$('.ww-world-name').value);
        this.$('.ww-world-name').value = '';
        await this.switchTab('world');
        this.$('.ww-resource').value = name;
        await this.loadResource(name);
        this.$('.ww-new-world').open = false;
        this.message(`已新建世界书“${name}”，可以新增条目。需要绑定角色时，请在酒馆中选择这本世界书。`);
    }
    downloadJson(payload, suffix) {
        const name = (this.doc.meta.title || this.doc.meta.id).replace(/[\\/:*?"<>|]/g, '_');
        const link = element('a', { download: `${name}-${suffix}.json`, href: URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })) });
        link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    exportPrompts() {
        this.downloadJson(exportPromptPack(this.doc.draft, this.selectedPrompts, this.presetGroupIndex), '预设条目包');
    }
    async importPrompts(file) {
        if (this.tab !== 'preset' || !Array.isArray(this.doc?.draft.prompts)) throw new Error('请先打开目标聊天补全预设。');
        if (file.size > 20 * 1024 * 1024) throw new Error('条目包过大，限 20 MB。');
        const pack = JSON.parse(await file.text(), (key, value) => {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('条目包含不支持的字段名。');
            return value;
        });
        const result = importPromptPack(this.doc.draft, pack, { groupIndex: this.presetGroupIndex, anchor: this.$('.ww-anchor').value, side: this.$('.ww-anchor-side').value });
        snapshot(this.doc, '导入条目包前'); this.rememberUndo();
        this.doc.draft = result.value;
        this.selectedPrompts = new Set(result.ids);
        this.$('.ww-filter').value = '';
        await this.persist(); this.renderList(result.ids[0]);
        this.message(`已将 ${result.ids.length} 个条目作为新副本插入当前预设组，可撤回；写入酒馆后生效。`);
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
            const context = `本次编辑目标：${this.fullCard?.name || '未绑定角色卡'}。不要把当前聊天的角色当作编辑目标。\n`;
            const regexContext = this.tab === 'regex' && this.field ? `\n你在修改局部正则的替换 HTML。请只返回完整可用的 HTML/CSS，不加代码围栏；保留捕获组引用和宏。查找表达式：${this.doc.draft.scripts[this.field.path[1]].findRegex}\n测试文本：${this.$('.ww-regex-test').value}\n预览不执行脚本。\n` : '';
            const text = await this.bridge.generate(context + regexContext + prompt, this.avatar);
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
        const reply = [...(this.bridge.context().chat || [])].reverse().find(m => !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim());
        if (!reply) throw new Error('当前聊天里没有可读取的 AI 回复。');
        this.$('.ww-suggestion').value = reply.mes;
        this.$('.ww-ai-mode').value = 'result'; this.suggestion = null;
        this.persistWriting(); this.message('已读取当前聊天最新回复（可能来自另一张角色卡）。请确认内容，再放入编辑目标的栏目。');
    }
    history() {
        if (!this.doc) return;
        this.$('.ww-history').hidden = false; const list = this.$('.ww-history-list'); list.replaceChildren();
        this.$('.ww-history-preview').textContent = '选择一个版本查看内容。'; this.$('[data-action="restore"]').disabled = true;
        this.doc.history.forEach((h, i) => list.append(element('button', { 'data-version': i }, `${new Date(h.time).toLocaleString()} · ${h.label}`)));
        if (!this.doc.history.length) list.textContent = '写入酒馆后会在这里保留版本。';
    }
    versionText(value) {
        if (this.doc.meta.kind === 'regex') return value.scripts.map(script => `${script.scriptName}\n${script.findRegex}\n${script.replaceString}`).join('\n\n──────────\n\n');
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
        if (data.meta.kind === 'regex' && (!Array.isArray(data.draft.scripts) || !data.draft.scripts.every(s => s && typeof s.findRegex === 'string' && typeof s.replaceString === 'string' && Array.isArray(s.placement)))) throw new Error('局部正则草稿格式不完整。');
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
        if (action === 'minimize') return this.run(() => this.minimize());
        if (action === 'close') return this.close();
        if (action === 'exit-cancel') { this.cancelExit(); return; }
        if (action === 'exit-confirm') return this.close({ confirmed: true });
        if (action === 'exit-discard') return this.run(() => this.discardAndExit());
        if (action === 'ai' || action === 'ai-close') {
            this.$('.ww-assistant').hidden = action === 'ai-close';
            if (action === 'ai') { this.$('.ww-assistant').scrollIntoView?.({ block: 'start', behavior: 'smooth' }); this.$('.ww-instruction').focus({ preventScroll: true }); }
            return;
        }
        if (action === 'search') { this.$('.ww-search').hidden = !this.$('.ww-search').hidden; this.searchSource = this.$('.ww-search').hidden ? 'filter' : 'find'; this.updateHighlights(); if (!this.$('.ww-search').hidden) this.$('.ww-find').focus(); return; }
        if (action === 'hit-next' || action === 'hit-prev' || action === 'find') {
            if (action === 'find' && this.searchSource !== 'find') { this.searchSource = 'find'; this.updateHighlights(); }
            this.navigateHit(action === 'hit-prev' ? -1 : 1); return;
        }
        if (action === 'history-close') { this.$('.ww-history').hidden = true; return; }
        if (action === 'import') { this.$('.ww-import').click(); return; }
        if (action === 'import-prompts') { this.$('.ww-prompt-file').click(); return; }
        await this.run(async () => {
            if (action === 'save') await this.save();
            else if (action === 'bind-card') await this.bindTarget(this.$('.ww-card-select').value);
            else if (action === 'refresh-resources') await this.switchTab(this.tab);
            else if (action === 'preview-refresh') { this.cancelPreview(); await this.renderPreview(); }
            else if (action === 'preview-advice') {
                this.$('.ww-assistant').hidden = false; this.$('.ww-ai-mode').value = 'current';
                this.$('.ww-instruction').placeholder = '例如：状态栏改为两列，手机上自动换行，保留 $1 等捕获组。';
                this.$('.ww-instruction').scrollIntoView?.({ block: 'center' });
            }
            else if (action === 'test') {
                if (this.doc?.meta.kind !== 'character') throw new Error('请回到人物设定或开场白，保存角色卡后再试聊；世界书和预设请先分别写入。');
                if (await this.save()) { await this.bridge.testChat(this.avatar); await this.close(); }
            } else if (action === 'undo') {
                const previous = this.doc?.undo?.pop();
                if (previous) { this.doc.draft = previous; this.doc.lastEdit = 0; this.persist(); this.renderList(this.field?.id); }
                else this.message('没有可撤回的操作；更早的保存可在历史版本中恢复。');
            } else if (action === 'history') this.history();
            else if (action === 'export') this.exportDraft();
            else if (action === 'export-prompts') this.exportPrompts();
            else if (action === 'select-visible' || action === 'clear-selection') {
                if (action === 'clear-selection') this.selectedPrompts.clear();
                else this.visibleFields().filter(f => !f.marker).forEach(f => this.selectedPrompts.add(f.id));
                this.renderList(this.field?.id, true);
            }
            else if (action === 'create-world') await this.createWorld();
            else if (action === 'delete-entry') this.deleteEntry();
            else if (action === 'insert-new') this.insertNew();
            else if (action === 'move-to') this.relocate(this.field?.id, this.$('.ww-anchor').value, this.$('.ww-anchor-side').value);
            else if (action === 'add' || action === 'duplicate') this.add(action === 'duplicate');
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
