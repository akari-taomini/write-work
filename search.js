// Literal, case-insensitive search. Offsets remain native UTF-16 textarea offsets.
export function searchRanges(text, terms) {
    const words = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
    if (!words.length) return [];
    const pattern = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    return [...text.matchAll(new RegExp(pattern, 'giu'))].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

export function highlightText(node, text, ranges, active = -1) {
    const fragment = document.createDocumentFragment(); let cursor = 0;
    ranges.forEach((range, i) => {
        fragment.append(document.createTextNode(text.slice(cursor, range.start)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(range.start, range.end);
        if (i === active) mark.className = 'ww-hit-current';
        fragment.append(mark); cursor = range.end;
    });
    fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceChildren(fragment);
}
