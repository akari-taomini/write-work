// Pure, shared browser/Node engine. Rules always apply to the original text.
export function validateRules(input) {
    if (!Array.isArray(input) || !input.length || input.length > 200) throw Error('请填写 1～200 条替换规则。');
    const seen = new Map(), warnings = [], rules = input.map((rule, index) => {
        if (typeof rule.find !== 'string' || !rule.find || rule.find.length > 5000 || typeof rule.replace !== 'string' || rule.replace.length > 50000) throw Error(`第 ${index + 1} 条规则为空或过长。`);
        if (seen.has(rule.find)) throw Error(`第 ${index + 1} 条与第 ${seen.get(rule.find) + 1} 条查找内容重复${input[seen.get(rule.find)].replace !== rule.replace ? '且替换目标冲突' : ''}。`);
        seen.set(rule.find, index);
        if (rule.find === rule.replace) warnings.push(`第 ${index + 1} 条前后相同，将跳过。`);
        return { find: rule.find, replace: rule.replace };
    });
    const edges = rules.map(a => rules.flatMap((b, i) => a.replace.includes(b.find) ? [i] : []));
    const state = new Uint8Array(rules.length);
    const visit = i => { if (state[i] === 1) return true; if (state[i] === 2) return false; state[i] = 1; const cycle = edges[i].some(visit); state[i] = 2; return cycle; };
    if (rules.some((_, i) => visit(i))) warnings.push('规则存在循环关系；本次使用原文非级联替换，重复执行仍可能反向改回。');
    else if (edges.some(a => a.length)) warnings.push('替换内容包含其他查找词；本次不会继续替换新生成的内容。');
    if (rules.some((a, i) => rules.some((b, j) => i !== j && a.find.includes(b.find)))) warnings.push('查找词存在重叠，优先保留较长匹配，同长度按规则顺序。');
    return { rules, warnings };
}

export function compileRules(input) {
    const { rules, warnings } = validateRules(input), trie = new Map();
    rules.forEach((rule, i) => {
        if (rule.find === rule.replace) return;
        let node = trie;
        for (let n = 0; n < rule.find.length; n++) { if (!node.has(rule.find[n])) node.set(rule.find[n], new Map()); node = node.get(rule.find[n]); }
        node.rule = i;
    });
    return { rules, warnings, trie };
}

function* matchSteps(text, compiled, limit) {
    const candidates = [];
    let work = 0;
    for (let start = 0; start < text.length; start++) {
        if (++work % 50000 === 0) yield;
        let node = compiled.trie;
        for (let end = start; end < text.length; end++) {
            if (++work % 50000 === 0) yield;
            node = node.get(text[end]); if (!node) break;
            if (node.rule !== undefined) {
                candidates.push({ start, end: end + 1, rule: node.rule });
                if (candidates.length > limit) throw Error('匹配数量超过安全上限，请缩小范围后重新扫描。');
            }
        }
    }
    // Resolve overlaps across starting positions, not only at the same offset.
    candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.rule - b.rule || a.start - b.start);
    const occupied = new Uint8Array(text.length), matches = [];
    for (const item of candidates) {
        let overlap = false;
        for (let i = item.start; i < item.end; i++) { if (++work % 50000 === 0) yield; if (occupied[i]) { overlap = true; break; } }
        if (overlap) continue;
        occupied.fill(1, item.start, item.end); matches.push(item);
    }
    return matches.sort((a, b) => a.start - b.start);
}

export function findMatches(text, compiled, limit = 100000) {
    const iterator = matchSteps(text, compiled, limit);
    for (;;) { const step = iterator.next(); if (step.done) return step.value; }
}

export async function findMatchesAsync(text, compiled, { yieldControl, cancelled = () => false, limit = 100000 }) {
    const iterator = matchSteps(text, compiled, limit);
    for (;;) {
        if (cancelled()) throw Error('扫描已取消。');
        const step = iterator.next(); if (step.done) return step.value;
        await yieldControl();
    }
}

export function replaceMatches(text, matches, rules) {
    let end = 0; const parts = [];
    for (const item of matches) {
        if (item.start < end || text.slice(item.start, item.end) !== rules[item.rule].find) throw Error('匹配位置已失效，请重新扫描。');
        parts.push(text.slice(end, item.start), rules[item.rule].replace); end = item.end;
    }
    parts.push(text.slice(end)); return parts.join('');
}

export function snippet(text, match, rule, radius = 70) {
    return { prefix: (match.start > radius ? '…' : '') + text.slice(Math.max(0, match.start - radius), match.start),
        before: text.slice(match.start, match.end), after: rule.replace,
        suffix: text.slice(match.end, match.end + radius) + (match.end + radius < text.length ? '…' : '') };
}

export function previewSegments(context, currentId, rules, excluded = new Set()) {
    const current = context.matches.find(m => m.id === currentId);
    if (!current) throw Error('预览位置失效。');
    const selected = context.matches.filter(m => !excluded.has(m.id));
    const prefix = context.text.slice(0, current.start), suffix = context.text.slice(current.end);
    return { prefix: (context.leading ? '…' : '') + prefix, before: context.text.slice(current.start, current.end), suffix: suffix + (context.trailing ? '…' : ''),
        afterPrefix: (context.leading ? '…' : '') + replaceMatches(prefix, selected.filter(m => m.end <= current.start), rules),
        after: excluded.has(currentId) ? context.text.slice(current.start, current.end) : rules[current.rule].replace,
        afterSuffix: replaceMatches(suffix, selected.filter(m => m.start >= current.end).map(m => ({ ...m, start: m.start - current.end, end: m.end - current.end })), rules) + (context.trailing ? '…' : '') };
}
