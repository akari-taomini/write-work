import { createId } from './core.js';

export function newRegex() {
    return { id: createId(), scriptName: '新状态栏', findRegex: '/<status>([\\s\\S]*?)<\\/status>/g',
        replaceString: '<section style="padding:16px;border:1px solid #888;border-radius:12px"><h3>{{char}} · 状态</h3><div style="white-space:pre-wrap">$1</div></section>',
        trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false,
        runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
}

// Standalone so the same function can run inside a disposable Worker (no UI-thread regex execution).
export function evaluateRegex({ script, text, character = '', user = '' }) {
    const macro = value => String(value).replace(/{{(char|user)}}/gi, (_, key) => key.toLowerCase() === 'char' ? character : user);
    if (text.length > 150000 || script.replaceString.length > 250000) throw new Error('预览文本过长：测试文本限 15 万字，替换代码限 25 万字。');
    if (script.disabled) return { html: text, count: 0, disabled: true };
    let pattern = script.findRegex;
    if (!pattern) throw new Error('请填写查找正则。');
    if (Number(script.substituteRegex) === 1) pattern = macro(pattern);
    if (Number(script.substituteRegex) === 2) pattern = pattern.replace(/{{(char|user)}}/gi, (_, key) => (key.toLowerCase() === 'char' ? character : user).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
    // Match Tavern's regexFromString parser; plain expressions and /expression/flags are accepted.
    const parsed = pattern.match(/(\/?)(.+)\1([a-z]*)/i);
    if (!parsed) throw new Error('查找正则格式无效。');
    const regex = parsed[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(parsed[3]) ? new RegExp(pattern) : new RegExp(parsed[2], parsed[3]);
    let count = 0, size = 0;
    const html = text.replace(regex, (...args) => {
        if (++count > 5000) throw new Error('匹配次数过多，请缩小测试文本或调整正则。');
        const groups = typeof args.at(-1) === 'object' ? args.at(-1) : null;
        const captures = args.slice(0, groups ? -3 : -2);
        const replacement = macro(String(script.replaceString).replace(/{{match}}/gi, '$0').replace(/\$(\d+)|\$<([^>]+)>/g, (_, n, name) => {
            let value = n !== undefined ? captures[Number(n)] : groups?.[name];
            if (value == null) return '';
            for (const trim of script.trimStrings || []) value = value.split(macro(trim)).join('');
            return value;
        }));
        size += replacement.length;
        if (size > 1000000) throw new Error('替换结果过大，请减少匹配或缩短代码。');
        return replacement;
    });
    return { html, count, disabled: false };
}

export function previewDocument(html) {
    const fenced = html.match(/^\s*```(?:html)?\s*\n([\s\S]*?)\n```\s*$/i);
    const content = fenced ? fenced[1] : html;
    // The iframe also has an empty sandbox: no scripts, same-origin access, forms or top navigation.
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: https:; font-src data:; script-src \'none\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'">' +
        '<style>body{margin:12px;overflow-wrap:anywhere}img{max-width:100%}</style></head><body>' + content + '</body></html>';
}

export class RegexRunner {
    constructor() { this.sequence = 0; }
    cancel() {
        this.sequence++; clearTimeout(this.timer);
        this.worker?.terminate(); this.worker = null;
        this.reject?.(new Error('预览已更新')); this.reject = null;
    }
    run(input) {
        this.cancel();
        if (typeof Worker === 'undefined') return Promise.reject(new Error('浏览器不支持独立正则预览，可切到“直接预览 HTML”。'));
        return new Promise((resolve, reject) => {
            this.reject = reject;
            const source = `const evaluate = ${evaluateRegex.toString()}; onmessage = e => { try { postMessage({ result: evaluate(e.data) }); } catch(error) { postMessage({ error: error.message }); } };`;
            const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            try { this.worker = new Worker(url); } catch (error) { this.reject = null; reject(error); return; }
            finally { URL.revokeObjectURL(url); }
            const done = (error, value) => { clearTimeout(this.timer); this.worker?.terminate(); this.worker = null; this.reject = null; error ? reject(error) : resolve(value); };
            this.worker.onmessage = e => done(e.data.error ? new Error(e.data.error) : null, e.data.result);
            this.worker.onerror = () => done(new Error('正则预览无法运行，请检查浏览器是否允许 Worker。'));
            this.timer = setTimeout(() => done(new Error('正则运行超时，已停止。请简化表达式或减少测试文本。')), 700);
            this.worker.postMessage(input);
        });
    }
}
