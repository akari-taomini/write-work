import { clone, characterContent, characterPatch, equal } from './core.js';

export class TavernBridge {
    context() {
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (!ctx) throw new Error('请在 SillyTavern 中打开写卡工作台。');
        return ctx;
    }
    async post(path, data) {
        const response = await fetch(path, { method: 'POST', headers: this.context().getRequestHeaders(), body: JSON.stringify(data) });
        if (!response.ok) throw new Error(`酒馆请求失败（${response.status}）。草稿仍保留，请检查连接或酒馆版本。`);
        return response;
    }
    currentCharacter() {
        const ctx = this.context();
        return ctx.groupId ? null : ctx.characters?.[ctx.characterId];
    }
    characters() {
        return (this.context().characters || []).filter(c => c?.avatar).map(c => ({ avatar: c.avatar, name: c.name || c.avatar }));
    }
    assertTarget(avatar) {
        if (!avatar || !this.characters().some(c => c.avatar === avatar)) throw new Error('编辑目标角色卡已不存在，请重新搜索并绑定。');
    }
    assertCharacter(avatar) {
        if (this.currentCharacter()?.avatar !== avatar) throw new Error('当前聊天的角色已变更。请关闭并重新打开工作台，草稿已保留。');
    }
    async getCharacter(avatar) { return (await this.post('/api/characters/get', { avatar_url: avatar })).json(); }
    async worlds({ fresh = false } = {}) {
        const errors = [];
        // /settings/get is also used by Tavern's native world-list refresh, including older releases.
        for (const path of ['/api/settings/get', '/api/worldinfo/list']) {
            try {
                const data = await (await this.post(path, {})).json();
                const list = path.endsWith('/settings/get') ? data.world_names : data;
                if (!Array.isArray(list)) throw new Error('列表格式不兼容');
                const names = list.map(x => typeof x === 'string' ? x : x?.file_id || x?.name);
                if (names.some(x => typeof x !== 'string' || !x)) throw new Error('列表含无效名称');
                this.worldWarning = '';
                return [...new Set(names)];
            } catch (error) { errors.push(`${path}: ${error.message}`); }
        }
        const cached = this.context().getWorldInfoNames?.();
        if (!fresh && Array.isArray(cached) && cached.length && cached.every(x => typeof x === 'string')) {
            this.worldWarning = '服务器列表刷新失败，暂用酒馆已加载的世界书列表；新建前仍须联网核对名称。';
            return [...new Set(cached)];
        }
        throw new Error(`世界书列表加载失败，请确认酒馆仍登录、连接正常后点击“刷新列表”。${errors.join('；')}`);
    }
    async createWorld(input) {
        const name = input.trim();
        if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) throw new Error('请填写有效的世界书名称，不含斜杠、冒号等文件名符号。');
        const all = await this.worlds({ fresh: true });
        if (all.some(book => book.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('已经有同名世界书，请换个名字；原世界书不会被覆盖。');
        const data = { entries: {} };
        await this.post('/api/worldinfo/edit', { name, data });
        const saved = await (await this.post('/api/worldinfo/get', { name })).json();
        if (!saved?.entries) throw new Error('世界书未能验证保存，请刷新世界书列表后检查。');
        try { await this.context().updateWorldInfoList?.(); } catch { /* The server save was verified; workbench refreshes its own list. */ }
        return name;
    }
    manager(api) {
        const manager = this.context().getPresetManager?.(api);
        if (!manager) throw new Error('当前连接类型没有可用的预设管理接口。');
        return manager;
    }
    presets() {
        const m = this.manager();
        const { preset_names } = m.getPresetList();
        return { api: m.apiId, current: m.getSelectedPresetName(), names: Array.isArray(preset_names) ? [...preset_names] : Object.keys(preset_names) };
    }
    async activatePreset(name) {
        const manager = this.manager();
        const id = manager.findPreset(name);
        if (id === undefined || id === null) throw new Error('预设不存在，请重新打开工作台。');
        await manager.selectPreset(id);
    }
    async read(meta) {
        if (meta.kind === 'character') return characterContent(await this.getCharacter(meta.id));
        if (meta.kind === 'regex') {
            const card = await this.getCharacter(meta.id);
            const scripts = card.data?.extensions?.regex_scripts ?? [];
            if (!Array.isArray(scripts)) throw new Error('这张卡的局部正则格式不是数组，请先在酒馆正则面板检查。');
            if (scripts.some(s => !s || typeof s.findRegex !== 'string' || typeof s.replaceString !== 'string' || !Array.isArray(s.placement) || (s.trimStrings !== undefined && !Array.isArray(s.trimStrings)))) throw new Error('角色卡有不完整的局部正则条目，请先在酒馆正则面板检查格式。');
            return { scripts: clone(scripts) };
        }
        if (meta.kind === 'world') {
            if (!(await this.worlds()).includes(meta.id)) throw new Error('这本世界书已不存在，请重新选择。');
            const world = await (await this.post('/api/worldinfo/get', { name: meta.id })).json();
            if (!world?.entries || typeof world.entries !== 'object' || Array.isArray(world.entries)) throw new Error('世界书内容格式不兼容：未找到有效条目。');
            return world;
        }
        const m = this.manager(meta.api);
        const preset = m.getCompletionPresetByName(meta.id);
        if (!preset) throw new Error('预设已不存在，请重新选择。');
        const active = m.getSelectedPresetName() === meta.id;
        // OpenAI's generic getPresetSettings() is not implemented by PresetManager.
        // Only retain editable text in drafts, never connection credentials or sampling settings.
        const source = active && meta.api === 'openai' ? this.context().chatCompletionSettings : active ? m.getPresetSettings(meta.id) : preset;
        if (meta.api === 'openai') return clone({ prompts: source.prompts || [], prompt_order: source.prompt_order || [] });
        return Object.fromEntries(Object.entries(source).filter(([k, v]) => typeof v === 'string' && /prompt|preamble|content|sequence|suffix|prefix/i.test(k)));
    }
    async write(meta, live, next) {
        if (equal(live, next)) return;
        if (meta.kind === 'character' || meta.kind === 'regex') {
            this.assertTarget(meta.id);
            const patch = meta.kind === 'regex' ? { avatar: meta.id, data: { extensions: { regex_scripts: clone(next.scripts) } } } : characterPatch(live, next, meta.id);
            await this.post('/api/characters/merge-attributes', patch);
            const verified = await this.read(meta);
            if (!equal(verified, next)) throw new Error('角色内容未能完整验证保存，请保留草稿并重试。');
            const ctx = this.context();
            await ctx.getOneCharacter?.(meta.id);
            // Refresh the native form too: it otherwise can write stale values back on chat changes.
            if (this.currentCharacter()?.avatar === meta.id) await ctx.selectCharacterById?.(ctx.characterId, { switchMenu: false });
        } else if (meta.kind === 'world') {
            if (!(await this.worlds({ fresh: true })).includes(meta.id)) throw new Error('世界书已被移除，已停止写入；草稿仍保留。');
            // The official helper clears the World Info cache and emits its update event.
            const ctx = this.context();
            if (!ctx.saveWorldInfo) throw new Error('酒馆缺少世界书保存接口，请升级后再试。');
            await ctx.saveWorldInfo(meta.id, clone(next), true);
            const check = await this.read(meta);
            if (!equal(check, next)) throw new Error('世界书未能完整保存。草稿已保留，请重试。');
            await ctx.reloadWorldInfoEditor?.(meta.id);
        } else {
            const manager = this.manager(meta.api);
            const saved = clone(manager.getCompletionPresetByName(meta.id));
            if (!saved) throw new Error('预设已不存在，已停止保存。');
            let full = saved;
            if (manager.getSelectedPresetName() === meta.id) {
                if (meta.api === 'openai') {
                    // Use the native export mapping to preserve unsaved native parameter changes.
                    const { settingsToUpdate } = await import('/scripts/openai.js');
                    const settings = this.context().chatCompletionSettings;
                    for (const [key, [, setting]] of Object.entries(settingsToUpdate)) {
                        if (settings[setting] !== undefined) full[key] = clone(settings[setting]);
                    }
                } else full = { ...saved, ...clone(manager.getPresetSettings(meta.id)) };
            }
            await manager.savePreset(meta.id, { ...full, ...clone(next) });
            await manager.selectPreset(manager.findPreset(meta.id));
        }
    }
    async generate(prompt, avatar) {
        if (avatar) this.assertTarget(avatar);
        const ctx = this.context();
        if (ctx.streamingProcessor || ctx.isGenerating) throw new Error('酒馆正在生成回复，请等当前回复完成后再使用 AI 辅助。');
        if (!ctx.generateQuietPrompt) throw new Error('酒馆缺少后台生成接口，请升级后再试。');
        if (ctx.onlineStatus === 'no_connection') throw new Error('请先在酒馆连接 API，再使用 AI 辅助。');
        const result = await ctx.generateQuietPrompt({ quietPrompt: prompt, skipWIAN: false, quietToLoud: false });
        if (typeof result !== 'string' || !result.trim()) throw new Error('AI 没有返回正文，请检查连接或预设。');
        return result;
    }
    async testChat(avatar) {
        this.assertTarget(avatar);
        const ctx = this.context();
        if (this.currentCharacter()?.avatar !== avatar) throw new Error('为避免打断当前聊天，请先在酒馆切到这张目标卡，再使用“保存并新开试聊”。');
        await ctx.saveChat();
        await ctx.openCharacterChat(`写卡测试 ${new Date().toISOString().replace(/[:.]/g, '-')}`);
    }
}
