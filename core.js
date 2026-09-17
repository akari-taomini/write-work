export const clone = value => value === undefined ? undefined : structuredClone(value);
export function equal(a, b) {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
}
const object = x => x && typeof x === 'object' && !Array.isArray(x);
// Arrays are atomic: never merge greetings or prompt order by numerical index.
export function mergeThreeWay(base, draft, live, path = []) {
    if (equal(base, draft)) return { value: clone(live), conflicts: [] };
    if (equal(base, live) || equal(draft, live)) return { value: clone(draft), conflicts: [] };
    if (object(base) && object(draft) && object(live)) {
        const value = {}, conflicts = [];
        for (const k of new Set([...Object.keys(base), ...Object.keys(draft), ...Object.keys(live)])) {
            const result = mergeThreeWay(base[k], draft[k], live[k], [...path, k]);
            if (result.value !== undefined) Object.defineProperty(value, k, { value: result.value, enumerable: true, writable: true, configurable: true });
            conflicts.push(...result.conflicts);
        }
        return { value, conflicts };
    }
    return { value: clone(draft), conflicts: [path.join('.') || '整份内容'] };
}
export const CHARACTER_FIELDS = [
    ['description', '人物设定'], ['personality', '性格'], ['scenario', '场景与背景'],
    ['first_mes', '第一条开场白'], ['mes_example', '对话示例'],
    ['system_prompt', '角色系统提示'], ['post_history_instructions', '后置提示'], ['creator_notes', '作者说明'],
];
export function characterContent(card) {
    const source = card.data || card;
    const result = Object.fromEntries(CHARACTER_FIELDS.map(([key]) => [key, String(source[key] ?? card[key] ?? '')]));
    result.alternate_greetings = clone(source.alternate_greetings || []);
    return result;
}
export function characterPatch(live, next, avatar) {
    const changed = Object.fromEntries(Object.keys(next).filter(k => !equal(live[k], next[k])).map(k => [k, clone(next[k])]));
    const v1 = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
    return { avatar, ...Object.fromEntries(v1.filter(k => k in changed).map(k => [k, changed[k]])), data: changed };
}
export function readPath(value, path) { return path.reduce((v, k) => v?.[k], value); }
export function writePath(value, path, next) {
    if (path.some(k => ['__proto__', 'constructor', 'prototype'].includes(String(k)))) throw new Error('不支持的字段名');
    const parent = path.slice(0, -1).reduce((v, k) => v[k], value);
    parent[path.at(-1)] = next;
}
export function applySuggestion(current, original, start, end, suggestion, append = false) {
    if (current !== original) throw new Error('原文已修改，请重新生成建议，避免覆盖新内容。');
    if (append) return current.slice(0, end) + '\n' + suggestion + current.slice(end);
    return current.slice(0, start) + suggestion + current.slice(end);
}
export function snapshot(doc, label) {
    doc.history ||= [];
    doc.history.unshift({ time: new Date().toISOString(), label, value: clone(doc.draft) });
    doc.history = doc.history.slice(0, 12);
}
export function newEntry(entries, copy) {
    let uid = 0;
    while (Object.hasOwn(entries, uid)) uid++;
    const value = copy ? clone(copy) : {
        key: [], keysecondary: [], comment: '新条目', content: '', constant: false,
        vectorized: false, selective: true, selectiveLogic: 0, addMemo: true,
        order: 100, position: 0, disable: false, excludeRecursion: false,
        preventRecursion: false, delayUntilRecursion: false, probability: 100,
        useProbability: true, depth: 4, group: '', groupOverride: false, groupWeight: 100,
        scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
        automationId: '', role: null, sticky: 0, cooldown: 0, delay: 0,
    };
    value.uid = uid;
    value.displayIndex = Math.max(-1, ...Object.values(entries).map(e => Number(e.displayIndex) || 0)) + 1;
    if (copy) value.comment = (value.comment || '条目') + ' · 副本';
    entries[uid] = value;
    return uid;
}
