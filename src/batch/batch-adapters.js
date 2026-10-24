// Explicit editable-field lists. Never walk arbitrary JSON strings.
export const BATCH_SCOPES = { persona: 'User Persona', chats: '聊天记录', character: '角色卡设定', greetings: '角色开场白', world: '世界书（含角色卡内嵌世界书）', prompts: '提示词条目', presets: '预设与系统提示', regex: '正则规则', other: '指定文本文件' };
export const getAt = (value, path) => path.reduce((v, key) => v?.[key], value);
export function setAt(value, path, text) {
    if (!path.length || path.some(k => ['__proto__', 'constructor', 'prototype'].includes(String(k)))) throw Error('不支持的字段路径。');
    const parent = getAt(value, path.slice(0, -1));
    if (!parent || !Object.hasOwn(parent, path.at(-1)) || typeof parent[path.at(-1)] !== 'string') throw Error('字段结构已改变。');
    parent[path.at(-1)] = text;
}

export function editableFields(value, resource) {
    const fields = [], keys = new Set();
    const add = (scope, path, owner = resource.id, label = resource.label, aliases = []) => {
        const text = getAt(value, path), key = JSON.stringify(path);
        if (typeof text !== 'string' || keys.has(key)) return;
        keys.add(key); fields.push({ scope, path, aliases, owner, label, text });
    };
    const strings = (scope, base, names, owner, label) => names.forEach(key => add(scope, [...base, key], owner, label));
    const array = (scope, base, owner, label) => { if (Array.isArray(getAt(value, base))) getAt(value, base).forEach((_, i) => add(scope, [...base, i], owner, label)); };
    const regex = (base, owner, label) => {
        const scripts = getAt(value, base); if (scripts == null) return;
        if (!Array.isArray(scripts) || scripts.some(s => !s || typeof s.findRegex !== 'string' || typeof s.replaceString !== 'string')) throw Error('正则规则格式不兼容。');
        scripts.forEach((script, i) => strings('regex', [...base, i], ['scriptName', 'findRegex', 'replaceString'], owner, `${label} · 正则 ${script.scriptName || i + 1}`));
    };
    const world = (base, embedded = false) => {
        const entries = getAt(value, [...base, 'entries']);
        if (!entries || typeof entries !== 'object') throw Error('世界书缺少有效 entries。');
        for (const [key, entry] of Object.entries(entries)) {
            if (!entry || typeof entry !== 'object') throw Error('世界书条目格式不兼容。');
            const p = [...base, 'entries', Array.isArray(entries) ? Number(key) : key];
            strings('world', p, ['comment', 'content', 'name'], resource.id, `${resource.label} · 条目 ${entry.uid ?? entry.id ?? key}`);
            for (const name of embedded ? ['keys', 'secondary_keys'] : ['key', 'keysecondary']) array('world', [...p, name]);
        }
    };
    const preset = base => {
        const p = getAt(value, base);
        if (!p || typeof p !== 'object') throw Error('预设格式不兼容。');
        if (p.prompts !== undefined && !Array.isArray(p.prompts)) throw Error('提示词条目格式不兼容。');
        (p.prompts || []).forEach((entry, i) => {
            if (!entry || typeof entry !== 'object') throw Error('提示词条目格式不兼容。');
            if (entry.marker) return;
            strings('prompts', [...base, 'prompts', i], ['name', 'content'], `${resource.id}:prompt:${entry.identifier ?? i}`, `${resource.label} · ${entry.name || entry.identifier || i + 1}`);
        });
        strings('presets', base, ['main_prompt', 'nsfw_prompt', 'jailbreak_prompt', 'system_prompt', 'system_prompt_prefix', 'system_prompt_suffix', 'preamble', 'content', 'post_history', 'send_if_empty', 'impersonation_prompt', 'new_chat_prompt', 'new_group_chat_prompt', 'new_example_chat_prompt', 'continue_nudge_prompt', 'group_nudge_prompt', 'wi_format', 'scenario_format', 'personality_format', 'assistant_prefill', 'assistant_impersonation', 'input_sequence', 'output_sequence', 'last_output_sequence', 'system_sequence', 'stop_sequence', 'first_output_sequence', 'output_suffix', 'input_suffix', 'system_suffix', 'user_alignment_message', 'last_system_sequence', 'first_input_sequence', 'last_input_sequence', 'story_string_prefix', 'story_string_suffix', 'story_string', 'example_separator', 'chat_start', 'input_prefix', 'output_prefix']);
        regex([...base, 'extensions', 'regex_scripts'], resource.id, resource.label);
    };
    if (resource.adapter === 'settings') {
        const pu = value.power_user;
        if (!pu || typeof pu.personas !== 'object' || Array.isArray(pu.personas)) throw Error('Persona 设置格式不兼容。');
        for (const [id, name] of Object.entries(pu.personas)) {
            const label = `${name} · ${id}`;
            add('persona', ['power_user', 'personas', id], id, label);
            strings('persona', ['power_user', 'persona_descriptions', id], ['description', 'title'], id, label);
        }
        // The active persona cache has no independent identity: attach it only
        // when settings stores an explicit avatar key, never infer by name.
        const avatar = value.user_avatar;
        if (typeof avatar === 'string' && Object.hasOwn(pu.personas, avatar)) {
            strings('persona', [], ['username'], avatar, `当前 Persona · ${avatar}`);
            add('persona', ['power_user', 'persona_description'], avatar, `当前 Persona 缓存 · ${avatar}`);
        }
        preset(['oai_settings']);
        for (const key of ['sysprompt', 'instruct', 'context', 'reasoning']) if (pu[key] && typeof pu[key] === 'object') preset(['power_user', key]);
        regex(['extension_settings', 'regex'], resource.id, '全局正则');
    } else if (resource.adapter === 'character') {
        const base = value.data && typeof value.data === 'object' ? ['data'] : [];
        const names = ['description', 'personality', 'scenario', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions'];
        for (const key of [...names, 'first_mes']) {
            const path = [...base, key], text = getAt(value, path), aliases = [];
            if (base.length && ['description', 'personality', 'scenario', 'mes_example', 'first_mes'].includes(key) && typeof value[key] === 'string') {
                if (typeof text === 'string' && value[key] !== text) throw Error(`角色卡兼容字段 ${key} 不一致，已跳过。`);
                if (typeof text === 'string') aliases.push([key]);
            }
            add(key === 'first_mes' ? 'greetings' : 'character', path, resource.id, resource.label, aliases);
        }
        array('greetings', [...base, 'alternate_greetings']);
        strings('character', [...base, 'extensions', 'depth_prompt'], ['prompt']);
        if (getAt(value, [...base, 'character_book'])) world([...base, 'character_book'], true);
        regex([...base, 'extensions', 'regex_scripts'], resource.id, resource.label);
    } else if (resource.adapter === 'world') world([]);
    else if (resource.adapter === 'preset') preset([]);
    else if (resource.adapter === 'chat') {
        if (!Array.isArray(value) || !value.length || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw Error('聊天记录格式不兼容。');
        value.forEach((row, i) => {
            if (typeof row.mes === 'string') {
                const active = Number.isInteger(row.swipe_id) && row.swipes?.[row.swipe_id] === row.mes ? [i, 'swipes', row.swipe_id] : null;
                add('chats', [i, 'mes'], resource.id, `${resource.label} · 消息 ${i}`, active ? [active] : []);
                if (row.is_user === true) add('chats', [i, 'name']);
                if (Array.isArray(row.swipes)) row.swipes.forEach((_, n) => { if (!active || n !== row.swipe_id) add('chats', [i, 'swipes', n]); });
                strings('chats', [i, 'extra'], ['reasoning']);
                if (Array.isArray(row.swipe_info)) row.swipe_info.forEach((_, n) => strings('chats', [i, 'swipe_info', n, 'extra'], ['reasoning']));
            } else if (i !== 0) throw Error(`聊天第 ${i + 1} 行缺少消息正文，已跳过。`);
            if (i === 0) add('chats', [i, 'user_name']);
            // persona/integrity/chat_id_hash are identifiers, not editable text.
            strings('chats', [i, 'chat_metadata'], ['note_prompt']);
        });
    } else if (resource.adapter === 'text') add('other', ['text']);
    else if (resource.adapter === 'custom-json') {
        if (!Array.isArray(resource.paths) || !resource.paths.length) throw Error('指定 JSON 文件必须先填写允许修改的字段路径。');
        for (const path of resource.paths) {
            if (!Array.isArray(path) || !path.length || path.some(k => typeof k !== 'string' && !Number.isInteger(k))) throw Error('自定义字段路径无效。');
            if (typeof getAt(value, path) !== 'string') throw Error('指定 JSON 路径不是文本字段。');
            add('other', path);
        }
    } else throw Error('不支持的资源格式。');
    return fields;
}
