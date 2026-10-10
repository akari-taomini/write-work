import { clone, createId } from './core.js';
import { newRegex, RegexRunner, previewDocument } from './regex-preview.js';

export function parseFrontendDesign(text) {
    const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    const value = JSON.parse(fenced ? fenced[1] : text, (key, val) => {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('设计结果包含不支持的字段名。');
        return val;
    });
    if (!value || typeof value.findRegex !== 'string' || !value.findRegex.trim() || typeof value.replaceString !== 'string' || !value.replaceString.trim() || typeof value.sampleText !== 'string' || !value.sampleText.trim()) throw new Error('AI 结果不完整，需要 findRegex、replaceString 和 sampleText；可手动修正 JSON 后再采用。');
    if (value.findRegex.length > 10000 || value.replaceString.length > 250000 || value.sampleText.length > 150000) throw new Error('生成内容超出预览长度限制，请缩小输出模块。');
    return { script: { ...newRegex(), scriptName: typeof value.scriptName === 'string' ? value.scriptName : '前端渲染', findRegex: value.findRegex, replaceString: value.replaceString }, sampleText: value.sampleText, explanation: typeof value.explanation === 'string' ? value.explanation : '' };
}

export class FrontendDesigner {
    constructor(app) {
        this.app = app; this.runner = new RegexRunner(); this.sequence = 0;
        this.panel = document.createElement('section'); this.panel.className = 'ww-designer'; this.panel.hidden = true;
        this.panel.innerHTML = `<div class="ww-row"><h2>前端正则设计</h2><button type="button" class="menu_button" data-designer="close">收起</button></div>
          <p>贴输出模块的格式、正则或示例，设计匹配表达式与替换 HTML。可以读取当前栏目，再按你的排版要求生成。</p>
          <div class="ww-row"><button type="button" data-designer="read">读取当前栏目</button><button type="button" data-designer="read-all">读取整份预设 / 角色文本</button><button type="button" data-designer="reply">读取聊天最新回复</button></div>
          <label>输出格式 / 原有正则<textarea data-design="format" rows="5" placeholder="例如：模型固定输出 &lt;status&gt;姓名：… 心情：…&lt;/status&gt;；也可以贴预设中的输出模块说明。"></textarea></label>
          <label>真实输出样本<textarea data-design="sample" rows="3" placeholder="尽量贴一份真实输出，用来检查是否能匹配。"></textarea></label>
          <label>设计或修改要求<textarea data-design="request" rows="3" placeholder="例如：奶油色两列状态栏，手机上自动变成一列；保留原有字段。"></textarea></label>
          <div class="ww-row"><button type="button" data-designer="generate">AI 设计 / 按意见修改</button><button type="button" data-designer="stop" hidden>停止生成</button></div>
          <label>设计结果 JSON（可手动编辑）<textarea data-design="result" rows="6" spellcheck="false"></textarea></label>
          <div class="ww-row"><button type="button" data-designer="preview">刷新预览</button><label>预览宽度<select data-design="width"><option value="100%">跟随窗口</option><option value="375px">手机 375px</option><option value="768px">平板 768px</option></select></label></div>
          <p class="ww-design-status" role="status"></p><div class="ww-preview-frame-wrap"><iframe class="ww-design-frame" title="前端正则设计预览" sandbox="" referrerpolicy="no-referrer"></iframe></div>
          <div class="ww-row"><label>采用到<select data-design="target"><option value="character">绑定角色卡的局部正则</option><option value="preset">所选预设的正则</option></select></label><button type="button" data-designer="adopt">新增到正则草稿</button><button type="button" data-designer="export">导出正则 JSON</button></div>
          <div class="ww-design-preset" hidden><label>搜索目标预设<input type="search" class="text_pole" data-design="preset-search" placeholder="输入预设名"></label><label>目标预设<select data-design="preset" aria-label="设计结果的目标预设"></select></label></div>
          <small>预览使用当前单条正则和测试文本；支持 HTML/CSS，不执行脚本。采用后先进入草稿，点击“写入酒馆”才正式保存。预设／角色卡正则的运行授权仍在酒馆原正则面板确认。</small>`;
        app.$('.ww-main').prepend(this.panel);
        this.$ = selector => this.panel.querySelector(selector);
        this.panel.querySelectorAll('button').forEach(b => b.classList.add('menu_button'));
        this.panel.querySelectorAll('textarea').forEach(t => t.classList.add('text_pole'));
        this.panel.addEventListener('input', () => { this.persist(); this.schedule(); });
        this.$('[data-design="width"]').addEventListener('change', event => { this.$('iframe').style.width = event.target.value; });
        this.$('[data-design="target"]').addEventListener('change', () => { this.$('.ww-design-preset').hidden = this.$('[data-design="target"]').value !== 'preset'; this.presets(); });
        this.$('[data-design="preset-search"]').addEventListener('input', () => this.presets());
        this.panel.addEventListener('click', event => {
            const action = event.target.closest('[data-designer]')?.dataset.designer;
            if (!action) return;
            if (action === 'stop') { app.bridge.context().stopGeneration?.(); return; }
            if (app.busy) return;
            if (action === 'close') { this.panel.hidden = true; this.cancel(); return; }
            app.run(() => this.action(action));
        });
    }
    key() { return `ww:${this.app.namespace}:frontend-design`; }
    presets() {
        const select = this.$('[data-design="preset"]');
        try {
            const p = this.app.bridge.presets(), query = this.$('[data-design="preset-search"]').value.trim().toLocaleLowerCase();
            const preferred = select.value || (['preset', 'preset-regex'].includes(this.app.doc?.meta.kind) ? this.app.doc.meta.id : p.current);
            const names = p.names.filter(n => n.toLocaleLowerCase().includes(query));
            select.replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option; }));
            select.value = names.includes(preferred) ? preferred : names[0] || '';
            this.presetApi = p.api;
        } catch (error) { select.replaceChildren(); this.$('.ww-design-status').textContent = error.message; }
    }
    data() { return Object.fromEntries(['format', 'sample', 'request', 'result'].map(k => [k, this.$(`[data-design="${k}"]`).value])); }
    async persist() {
        const app = this.app; app.pendingPersistence++;
        try { await app.store.set(this.key(), this.data()); app.failedPersistence.delete(this.key()); }
        catch { app.failedPersistence.add(this.key()); this.$('.ww-design-status').textContent = '设计草稿本地保存失败，请复制或导出设计结果。'; }
        finally { app.pendingPersistence--; }
    }
    async open() {
        if (!this.loaded) {
            const data = await this.app.store.get(this.key()) || {};
            for (const [key, value] of Object.entries(data)) if (this.$(`[data-design="${key}"]`) && typeof value === 'string') this.$(`[data-design="${key}"]`).value = value;
            this.loaded = true;
        }
        this.presets(); this.panel.hidden = false; this.panel.scrollIntoView?.({ block: 'start' }); this.schedule();
    }
    cancel() { clearTimeout(this.timer); this.sequence++; this.runner.cancel(); }
    schedule() { this.cancel(); if (!this.panel.hidden && this.$('[data-design="result"]').value.trim()) this.timer = setTimeout(() => this.preview(), 300); }
    async preview() {
        this.cancel(); const sequence = this.sequence;
        try {
            const design = parseFrontendDesign(this.$('[data-design="result"]').value);
            const sample = this.$('[data-design="sample"]').value || design.sampleText;
            const result = await this.runner.run({ script: design.script, text: sample, character: this.app.fullCard?.name || '', user: this.app.bridge.context().name1 || '用户' });
            if (sequence !== this.sequence) return;
            this.$('iframe').srcdoc = previewDocument(result.html);
            this.$('.ww-design-status').textContent = `命中 ${result.count} 处。${result.count ? '' : '没有匹配到样本，请调整正则或格式。'} ${design.explanation}`;
        } catch (error) {
            if (sequence !== this.sequence) return;
            this.$('iframe').srcdoc = ''; this.$('.ww-design-status').textContent = `预览未完成：${error.message}`;
        }
    }
    async action(action) {
        const app = this.app;
        if (action === 'read' || action === 'read-all') {
            if (!app.doc || (action === 'read' && !app.field)) throw new Error('先选择预设输出模块或角色卡栏目，再读取。');
            const source = action === 'read-all' ? app.versionText(app.doc.draft) : app.tab === 'regex' ? JSON.stringify(app.doc.draft.scripts[app.field.path[1]], null, 2) : app.editor.value;
            if (source.length > 150000) throw new Error('文本过长，请改为只读取输出模块栏目。');
            this.$('[data-design="format"]').value = source;
            this.$('.ww-design-status').textContent = '已读取当前栏目；请补充真实输出样本与设计要求。'; await this.persist();
        } else if (action === 'reply') {
            const reply = [...(app.bridge.context().chat || [])].reverse().find(m => !m.is_user && !m.is_system && typeof m.mes === 'string');
            if (!reply) throw new Error('当前聊天没有可读取的 AI 回复。');
            this.$('[data-design="sample"]').value = reply.mes; await this.persist(); this.schedule();
        } else if (action === 'generate') {
            const data = this.data();
            if (!data.format.trim() && !data.sample.trim()) throw new Error('先贴输出格式、原正则或真实样本。');
            this.$('.ww-design-status').textContent = '正在设计…'; app.generating = true;
            const stop = this.$('[data-designer="stop"]'); stop.hidden = false; stop.disabled = false;
            try {
                const prompt = `你是 SillyTavern 前端正则设计助手。依据作者给出的输出模块说明或示例，生成用于显示格式化的正则与替换 HTML/CSS。保持原输出格式，匹配真实样本；如作者仅提供模板，构造一份有代表性的 sampleText。不执行 JavaScript，不依赖酒馆助手。用数字或命名捕获组，把动态字段写入替换 HTML。布局应适应手机。只返回严格 JSON，字段为 scriptName、findRegex（可含 /pattern/flags）、replaceString（完整 HTML/CSS）、sampleText、explanation。JSON 字符串中的反斜杠和换行必须正确转义，不加 Markdown 代码围栏。作者未要求修改的设置尽量保留。\n输出格式或原正则：\n${data.format}\n真实样本：\n${data.sample}\n设计意见：\n${data.request || '清晰美观地呈现输出字段'}\n上一版设计：\n${data.result}`;
                const result = await app.bridge.generate(prompt, app.avatar);
                this.$('[data-design="result"]').value = result; await this.persist(); await this.preview();
            } finally { app.generating = false; stop.hidden = true; }
        } else if (action === 'preview') await this.preview();
        else if (action === 'adopt' || action === 'export') {
            const design = parseFrontendDesign(this.$('[data-design="result"]').value);
            // Validate against the actual sample before adopting. A non-match needs author correction.
            const sample = this.$('[data-design="sample"]').value || design.sampleText;
            const rendered = await this.runner.run({ script: design.script, text: sample, character: app.fullCard?.name || '', user: app.bridge.context().name1 || '用户' });
            if (!rendered.count) throw new Error('当前正则没有命中测试样本，请先调整或替换样本。');
            if (action === 'export') {
                const link = document.createElement('a'); link.download = '前端渲染正则.json'; link.href = URL.createObjectURL(new Blob([JSON.stringify(design.script, null, 2)], { type: 'application/json' })); link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); return;
            }
            app.regexTarget = this.$('[data-design="target"]').value;
            if (app.regexTarget === 'character' && !app.avatar) throw new Error('先在顶部绑定要保存的角色卡，或选择采用到预设。');
            const preset = this.$('[data-design="preset"]').value;
            if (app.regexTarget === 'preset' && (!preset || app.bridge.presets().api !== this.presetApi || !app.bridge.presets().names.includes(preset))) throw new Error('目标预设已变动，请重新选择。');
            await app.switchTab('regex');
            if (app.regexTarget === 'preset' && app.doc?.meta.id !== preset) { app.$('.ww-resource').value = preset; await app.loadResource(preset); }
            if (!app.doc) throw new Error('请先选择可用的正则目标。');
            app.rememberUndo(); design.script.id = createId(); app.doc.draft.scripts.push(clone(design.script)); app.doc.previewTest = sample;
            await app.persist(); app.renderList(design.script.id); this.panel.hidden = true; this.cancel();
            app.message('已新增到正则草稿，可以继续预览和撤回；点击“写入酒馆”后才正式保存。');
        }
    }
}
