import { clone, createId } from './core.js';

export function insertRelative(items, additions, anchor, side, key = item => item.identifier) {
    const result = [...items];
    if (!anchor) return [...result, ...additions];
    const index = result.findIndex(item => key(item) === anchor);
    if (index < 0) throw new Error('目标条目不存在，请重新选择插入位置。');
    result.splice(index + (side === 'before' ? 0 : 1), 0, ...additions);
    return result;
}
export function movePrompt(preset, id, anchor, side, groupIndex) {
    if (id === anchor) return;
    const group = preset.prompt_order?.[groupIndex];
    if (!group || !preset.prompts.some(p => p.identifier === id)) throw new Error('请先选择有效的预设组和条目。');
    const entry = group.order.find(p => p.identifier === id) || { identifier: id, enabled: true };
    group.order = insertRelative(group.order.filter(p => p.identifier !== id), [entry], anchor, side);
}
export function exportPromptPack(preset, selectedIds, groupIndex = 0) {
    const selected = new Set(selectedIds);
    const prompts = preset.prompts.filter(p => selected.has(p.identifier) && !p.marker);
    if (!prompts.length) throw new Error('请先勾选要导出的提示词条目。自动注入的占位条目不能打包。');
    const ids = new Set(prompts.map(p => p.identifier));
    return clone({ format: 'writer-workbench-prompts-v1', version: 1,
        source_group: preset.prompt_order?.[groupIndex]?.character_id,
        prompts,
        prompt_order: (preset.prompt_order || []).map(group => ({ ...group, order: group.order.filter(p => ids.has(p.identifier)) })),
    });
}
export function importPromptPack(preset, pack, { groupIndex = 0, anchor = '', side = 'after', idFactory = createId } = {}) {
    if (pack?.format !== 'writer-workbench-prompts-v1' || !Array.isArray(pack.prompts) || !pack.prompts.length || pack.prompts.length > 2000) throw new Error('请选择工作台导出的预设条目包（最多 2000 条）。');
    const seen = new Set();
    for (const p of pack.prompts) {
        if (!p || typeof p.identifier !== 'string' || !p.identifier || seen.has(p.identifier) || p.marker || typeof p.name !== 'string' || typeof p.content !== 'string' || !['system', 'user', 'assistant'].includes(p.role || 'system')) throw new Error('条目包存在重复编号、占位条目或不完整的内容，未导入任何条目。');
        seen.add(p.identifier);
    }
    if (pack.prompt_order !== undefined && (!Array.isArray(pack.prompt_order) || pack.prompt_order.some(g => !g || !Array.isArray(g.order) || g.order.some(p => !p || typeof p.identifier !== 'string' || typeof p.enabled !== 'boolean')))) throw new Error('条目包的顺序或启用设置无效。');
    const next = clone(preset);
    const group = next.prompt_order?.[groupIndex];
    if (!group || !Array.isArray(group.order)) throw new Error('目标预设没有可用的条目组，请先在酒馆创建或选择一个预设组。');
    const source = pack.prompt_order?.find(g => g.character_id === pack.source_group) || pack.prompt_order?.[0];
    const order = source?.order || [];
    const ordered = [...pack.prompts].sort((a, b) => {
        const rank = p => { const n = order.findIndex(o => o.identifier === p.identifier); return n < 0 ? order.length : n; };
        return rank(a) - rank(b);
    });
    const existing = new Set(next.prompts.map(p => p.identifier));
    const ids = [], additions = [];
    for (const original of ordered) {
        const id = idFactory();
        if (!id || existing.has(id)) throw new Error('无法分配新条目编号，请重试。');
        existing.add(id); ids.push(id);
        // Imported main/jailbreak prompts become copies, never overwrite built-in slots.
        next.prompts.push({ ...clone(original), identifier: id, role: original.role || 'system', system_prompt: false, marker: false });
        additions.push({ identifier: id, enabled: order.find(p => p.identifier === original.identifier)?.enabled ?? true });
    }
    group.order = insertRelative(group.order, additions, anchor, side);
    return { value: next, ids };
}
