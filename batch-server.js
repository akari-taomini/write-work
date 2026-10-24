import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import encode from '../../../../src/png/encode.js';
import YAML from 'yaml';
import archiver from 'archiver';
import { compileRules, findMatchesAsync, replaceMatches, snippet } from './batch-engine.js';
import { editableFields, getAt, setAt, BATCH_SCOPES } from './batch-adapters.js';

const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const idFor = name => hash(name).slice(0, 32);
const pause = () => new Promise(resolve => setImmediate(resolve));
const MAX_FILE = 64 * 1024 * 1024, MAX_BATCH = 256 * 1024 * 1024;
const TTL = 30 * 60 * 1000;
const fail = message => { throw Error(message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

// Replace only JSON string tokens. Everything else, including formatting,
// duplicate keys and large numeric literals, must remain byte-for-byte intact.
function jsonDocument(text) {
    const value = JSON.parse(text), tokens = [], strings = [];
    // A regex with repeated alternatives can exhaust V8's stack on a long
    // message string. Tokenize iteratively, jumping directly between quotes.
    for (let cursor = 0; cursor < text.length;) {
        if (/\s/.test(text[cursor])) { cursor++; continue; }
        const start = cursor;
        if (text[cursor] === '"') {
            cursor++;
            for (;;) {
                cursor = text.indexOf('"', cursor);
                if (cursor < 0) fail('JSON 字符串没有结束。');
                let slashes = 0; for (let n = cursor - 1; n >= 0 && text[n] === '\\'; n--) slashes++;
                cursor++; if (slashes % 2 === 0) break;
            }
        } else if ('{}[]:,'.includes(text[cursor])) cursor++;
        else while (cursor < text.length && !/[\s{}\[\]:,]/.test(text[cursor])) cursor++;
        tokens.push({ 0: text.slice(start, cursor), index: start });
    }
    let index = 0;
    const walk = p => {
        const token = tokens[index++];
        if (token[0] === '{') {
            const seen = new Set();
            while (tokens[index][0] !== '}') {
                const key = JSON.parse(tokens[index++][0]);
                if (seen.has(key)) fail('JSON 含重复键，无法安全确定目标字段。');
                seen.add(key); index++; walk([...p, key]);
                if (tokens[index][0] === ',') index++;
            }
            index++;
        } else if (token[0] === '[') {
            let n = 0;
            while (tokens[index][0] !== ']') { walk([...p, n++]); if (tokens[index][0] === ',') index++; }
            index++;
        } else if (token[0][0] === '"') strings.push({ path: p, start: token.index, end: token.index + token[0].length });
    };
    walk([]);
    return { value, encode(next) {
        const parts = []; let end = 0;
        for (const token of strings) {
            const original = getAt(value, token.path), replacement = getAt(next, token.path);
            if (replacement === original) continue;
            if (typeof replacement !== 'string') fail('禁止改变 JSON 字段类型。');
            parts.push(text.slice(end, token.start), JSON.stringify(replacement)); end = token.end;
        }
        parts.push(text.slice(end)); return parts.join('');
    } };
}

// Reject links and traversal on every open, including backup directories.
export function confined(root, relative, { missing = false } = {}) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /[\\:]/.test(relative)) fail('资源路径无效。');
    const segments = relative.split('/');
    if (segments.some(s => !s || s === '.' || s === '..')) fail('资源路径无效。');
    const absoluteRoot = fs.realpathSync(root);
    let cursor = absoluteRoot;
    for (let i = 0; i < segments.length; i++) {
        cursor = path.join(cursor, segments[i]);
        try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('不处理符号链接或目录联接。'); }
        catch (error) { if (!(missing && error.code === 'ENOENT')) throw error; }
    }
    return cursor;
}

function readBuffer(root, relative) {
    const file = confined(root, relative), stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE) fail('文件不是普通文件或超过 64 MB，请缩小范围。');
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_FILE) fail('文件在读取期间超过大小上限。');
    return bytes;
}

export function decodeDocument(bytes, resource) {
    if (resource.format === 'png') {
        const chunks = extract(bytes), cards = chunks.flatMap((chunk, index) => {
            if (chunk.name !== 'tEXt') return [];
            const meta = PNGtext.decode(chunk.data), key = meta.keyword.toLowerCase();
            if (!['chara', 'ccv3'].includes(key)) return [];
            const document = jsonDocument(Buffer.from(meta.text, 'base64').toString('utf8'));
            return [{ index, key, keyword: meta.keyword, document, value: document.value }];
        });
        if (!cards.length || new Set(cards.map(c => c.key)).size !== cards.length) fail('角色卡数据块缺失或重复。');
        const primary = cards.find(c => c.key === 'ccv3') || cards[0];
        if (!plain(primary.value) || !plain(primary.value.data)) fail('暂不支持这种 PNG 角色卡结构。');
        const value = primary.value;
        const fields = editableFields(value, resource);
        const mirrorPaths = field => {
            const paths = [field.path, ...field.aliases];
            if (field.path.length === 2 && field.path[0] === 'data' && ['description', 'personality', 'scenario', 'mes_example', 'first_mes'].includes(field.path[1]) && !paths.some(p => p.length === 1 && p[0] === field.path[1])) paths.push([field.path[1]]);
            return paths;
        };
        // Before previewing, verify that every editable mirror agrees. Unknown
        // metadata in either version remains in its own original document.
        for (const field of fields) for (const card of cards) for (const p of mirrorPaths(field)) {
            const original = getAt(card.value, p);
            if (original !== undefined && original !== field.text) fail(`PNG 的 V2/V3 字段 ${p.join('.')} 不一致。`);
        }
        return { value, encode(next) {
            for (const card of cards) {
                const updated = structuredClone(card.value);
                for (const field of fields) {
                    const replacement = getAt(next, field.path);
                    if (replacement === field.text) continue;
                    for (const p of mirrorPaths(field)) if (typeof getAt(updated, p) === 'string') setAt(updated, p, replacement);
                }
                chunks[card.index] = PNGtext.encode(card.keyword, Buffer.from(card.document.encode(updated), 'utf8').toString('base64'));
            }
            return Buffer.from(encode(chunks));
        } };
    }
    const raw = bytes.toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(bytes)) fail('仅支持有效 UTF-8 文本，已跳过其他编码。');
    const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '', text = bom ? raw.slice(1) : raw;
    if (resource.format === 'text') return { value: { text }, encode: next => Buffer.from(bom + next.text, 'utf8') };
    if (resource.format === 'yaml') {
        const document = YAML.parseDocument(text, { uniqueKeys: true });
        if (document.errors.length) fail('YAML 格式无效。');
        const value = document.toJS({ maxAliasCount: 50 });
        return { value, encode(next) {
            for (const p of resource.paths || []) if (getAt(value, p) !== getAt(next, p)) document.setIn(p, getAt(next, p));
            return Buffer.from(bom + String(document), 'utf8');
        } };
    }
    if (resource.format === 'jsonl') {
        const lines = text.split(/(\r?\n)/), indexes = [], documents = [];
        for (let i = 0; i < lines.length; i += 2) if (lines[i].trim()) { indexes.push(i); documents.push(jsonDocument(lines[i])); }
        const value = documents.map(d => d.value);
        return { value, encode(next) {
            if (next.length !== value.length) fail('聊天消息数量改变，已阻止写入。');
            const output = [...lines]; next.forEach((row, i) => { output[indexes[i]] = documents[i].encode(row); });
            return Buffer.from(bom + output.join(''), 'utf8');
        } };
    }
    const document = jsonDocument(text);
    return { value: document.value, encode: next => Buffer.from(bom + document.encode(next), 'utf8') };
}

export class BatchService {
    constructor(root, { beforeRename } = {}) {
        this.root = fs.realpathSync(root); this.jobs = new Map(); this.busy = false; this.beforeRename = beforeRename;
    }
    catalog() {
        const resources = [], skipped = [];
        const add = (relative, adapter, format, extra = {}) => {
            try { const file = confined(this.root, relative); if (!fs.statSync(file).isFile()) return;
                resources.push({ id: idFor(relative), relative, label: relative, adapter, format, ...extra });
            } catch (error) { skipped.push({ path: relative, error: error.message }); }
        };
        const list = (dir, adapter, extensions, recursive = false, owner = '') => {
            let names; try { names = fs.readdirSync(confined(this.root, dir), { withFileTypes: true }); }
            catch (error) { if (error.code !== 'ENOENT') skipped.push({ path: dir, error: error.message }); return; }
            for (const entry of names) {
                const relative = `${dir}/${entry.name}`;
                if (entry.isSymbolicLink()) { skipped.push({ path: relative, error: '已跳过链接。' }); continue; }
                if (entry.isDirectory() && recursive) list(relative, adapter, extensions, false, entry.name);
                else if (entry.isFile() && extensions[path.extname(entry.name).toLowerCase()]) add(relative, adapter, extensions[path.extname(entry.name).toLowerCase()], { owner });
                else if (entry.isFile() && !entry.name.endsWith('.tmp')) skipped.push({ path: relative, error: '不支持的格式，已跳过。' });
            }
        };
        add('settings.json', 'settings', 'json');
        list('characters', 'character', { '.png': 'png', '.json': 'json' });
        list('chats', 'chat', { '.jsonl': 'jsonl' }, true);
        list('group chats', 'chat', { '.jsonl': 'jsonl' });
        list('worlds', 'world', { '.json': 'json' });
        for (const dir of ['OpenAI Settings', 'TextGen Settings', 'KoboldAI Settings', 'NovelAI Settings', 'instruct', 'context', 'sysprompt', 'reasoning']) list(dir, 'preset', { '.json': 'json' });
        list('user/files', 'text', { '.txt': 'text' });
        list('user/files', 'custom-json', { '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml' });
        // Both explicit-file adapters inspect the same directory; only report
        // files unsupported by both rather than each adapter's complementary set.
        const supported = new Set(resources.map(r => r.relative));
        return { resources, skipped: skipped.filter((s, i, a) => !supported.has(s.path) && a.findIndex(x => x.path === s.path) === i) };
    }
    inventory() {
        const { resources, skipped } = this.catalog();
        const owners = [];
        for (const resource of resources) {
            if (resource.adapter === 'settings') {
                try {
                    const doc = decodeDocument(readBuffer(this.root, resource.relative), resource).value;
                    for (const [id, name] of Object.entries(doc.power_user?.personas || {})) owners.push({ id, type: 'persona', label: `${name} · ${id}` });
                    for (const [i, p] of (doc.oai_settings?.prompts || []).entries()) if (!p.marker) owners.push({ id: `${resource.id}:prompt:${p.identifier ?? i}`, type: 'prompt', label: `当前提示词 · ${p.name || p.identifier || i + 1}` });
                } catch (error) { skipped.push({ path: resource.relative, error: error.message }); }
            }
            if (['character', 'world', 'preset', 'chat'].includes(resource.adapter)) owners.push({ id: resource.id, type: resource.adapter, label: resource.label });
            if (resource.adapter === 'preset') {
                try {
                    const doc = decodeDocument(readBuffer(this.root, resource.relative), resource).value;
                    for (const [i, p] of (doc.prompts || []).entries()) if (!p.marker) owners.push({ id: `${resource.id}:prompt:${p.identifier ?? i}`, type: 'prompt', label: `${resource.label} · ${p.name || p.identifier || i + 1}` });
                } catch (error) { skipped.push({ path: resource.relative, error: error.message }); }
            }
        }
        return { resources, owners, skipped, scopes: BATCH_SCOPES, version: 1 };
    }
    startScan(options) {
        if (this.busy) fail('正在写入或恢复，请稍后再扫描。');
        for (const [id, job] of this.jobs) if (Date.now() - job.created > TTL && job.status !== 'scanning') this.jobs.delete(id);
        while (this.jobs.size >= 4 || [...this.jobs.values()].reduce((n, j) => n + (j.retainedBytes || 0), 0) > MAX_BATCH / 2) { const oldest = [...this.jobs.values()].find(j => j.status !== 'scanning'); if (!oldest) break; this.jobs.delete(oldest.id); }
        if ([...this.jobs.values()].filter(j => j.status === 'scanning').length >= 2) fail('已有扫描任务，请先取消。');
        const compiled = compileRules(options.rules);
        if (!Array.isArray(options.scopes) || !options.scopes.length || options.scopes.some(s => !Object.hasOwn(BATCH_SCOPES, s))) fail('请选择有效作用范围。');
        if (!['global', 'local'].includes(options.mode)) fail('替换模式无效。');
        for (const key of ['fileIds', 'ownerIds']) if (options[key] !== undefined && (!Array.isArray(options[key]) || options[key].length > 10000 || options[key].some(v => typeof v !== 'string'))) fail('资源选择格式无效。');
        if (options.mode === 'local' && !options.fileIds?.length && !options.ownerIds?.length) fail('局部模式必须选择具体资源。');
        const catalog = this.catalog();
        const job = { id: crypto.randomUUID(), created: Date.now(), status: 'scanning', cancelled: false, options: structuredClone(options), compiled, files: [], skipped: catalog.skipped, scanned: 0, total: 0, matches: 0, retainedBytes: 0, counts: compiled.rules.map(() => 0), scopeCounts: {}, warnings: compiled.warnings };
        this.jobs.set(job.id, job);
        const applicable = r => r.adapter === 'settings' ? options.scopes.some(s => ['persona', 'prompts', 'presets', 'regex'].includes(s)) : r.adapter === 'character' ? options.scopes.some(s => ['character', 'greetings', 'world', 'regex'].includes(s)) : r.adapter === 'chat' ? options.scopes.includes('chats') : r.adapter === 'world' ? options.scopes.includes('world') : r.adapter === 'preset' ? options.scopes.some(s => ['prompts', 'presets', 'regex'].includes(s)) : options.scopes.includes('other') && options.fileIds?.includes(r.id);
        const local = r => options.mode === 'global' || r.adapter === 'settings' || options.fileIds?.includes(r.id) || options.ownerIds?.includes(r.id) || options.ownerIds?.some(id => id.startsWith(`${r.id}:prompt:`)) || (r.adapter === 'chat' && options.ownerIds?.includes(idFor(`characters/${r.owner}.png`)));
        const resources = catalog.resources.filter(r => applicable(r) && local(r));
        job.total = resources.length;
        const run = async () => {
            try {
                for (const original of resources) {
                    if (job.cancelled) break;
                    const r = { ...original, paths: options.customPaths?.[original.id] };
                    try {
                        const bytes = readBuffer(this.root, r.relative), doc = decodeDocument(bytes, r);
                        let fields = editableFields(doc.value, r).filter(f => options.scopes.includes(f.scope));
                        if (options.mode === 'local') fields = fields.filter(f => options.fileIds?.includes(r.id) || options.ownerIds?.includes(f.owner) || (r.adapter === 'chat' && options.ownerIds?.includes(idFor(`characters/${r.owner}.png`))));
                        const hits = [], counts = compiled.rules.map(() => 0), scopeCounts = {};
                        for (let i = 0; i < fields.length; i++) {
                            if (job.cancelled) break;
                            const field = fields[i], matches = await findMatchesAsync(field.text, compiled, { yieldControl: pause, cancelled: () => job.cancelled });
                            if (matches.length) {
                                for (const m of matches) {
                                    m.id = `${r.id}:${i}:${m.start}:${m.rule}`;
                                    counts[m.rule]++; scopeCounts[field.scope] = (scopeCounts[field.scope] || 0) + 1;
                                }
                                hits.push({ ...field, matches });
                            }
                            if (i % 50 === 0) await pause();
                        }
                        if (hits.length && !job.cancelled) {
                            const count = hits.reduce((n, f) => n + f.matches.length, 0);
                            if (job.matches + count > 100000) { job.status = 'failed'; fail('整批匹配超过十万处，请缩小范围。'); }
                            const retained = hits.reduce((n, f) => n + f.text.length * 2 + f.matches.length * 100, 0);
                            if (job.retainedBytes + retained > MAX_BATCH / 2) { job.status = 'failed'; fail('预览文本超过 128 MB 内存预算，请缩小范围分批扫描。'); }
                            job.retainedBytes += retained;
                            job.matches += count; counts.forEach((n, i) => { job.counts[i] += n; });
                            for (const [scope, n] of Object.entries(scopeCounts)) job.scopeCounts[scope] = (job.scopeCounts[scope] || 0) + n;
                            job.files.push({ ...r, beforeHash: hash(bytes), fields: hits, count });
                        }
                    } catch (error) { if (job.status === 'failed') throw error; job.skipped.push({ path: r.relative, error: error.message }); }
                    job.scanned++; await pause();
                }
                job.status = job.cancelled ? 'cancelled' : 'ready';
            } catch (error) { job.status = 'failed'; job.error = error.message; }
        };
        job.done = run(); return { id: job.id };
    }
    job(id) { const job = this.jobs.get(id); if (!job || Date.now() - job.created > TTL) fail('扫描已过期，请重新扫描。'); return job; }
    matchesFilter(file, field, match, rules, filter) {
        if (filter.rule !== undefined && filter.rule !== '' && Number(filter.rule) !== match.rule) return false;
        if (filter.scope && field.scope !== filter.scope) return false;
        if (!filter.query) return true;
        const preview = snippet(field.text, match, rules[match.rule]);
        return `${file.relative} ${field.label} ${field.owner} ${field.path.join('.')} ${preview.prefix}${preview.before}${preview.after}${preview.suffix}`.toLocaleLowerCase().includes(String(filter.query).toLocaleLowerCase());
    }
    status(id, filter = {}) {
        const j = this.job(id);
        return { id, status: j.status, scanned: j.scanned, total: j.total, matches: j.matches, counts: j.counts, scopeCounts: j.scopeCounts, warnings: j.warnings, skipped: j.skipped, error: j.error,
            files: j.files.map(f => ({ id: f.id, path: f.relative, count: f.count, visible: f.fields.reduce((n, field) => n + field.matches.filter(m => this.matchesFilter(f, field, m, j.compiled.rules, filter)).length, 0), scopes: [...new Set(f.fields.map(x => x.scope))], labels: [...new Set(f.fields.map(x => x.label))].slice(0, 40) })) };
    }
    preview(id, fileId, offset = 0, filter = {}) {
        const j = this.job(id), file = j.files.find(f => f.id === fileId);
        if (!file || !Number.isInteger(offset) || offset < 0) fail('预览资源无效。');
        const hits = file.fields.flatMap(field => field.matches.filter(m => this.matchesFilter(file, field, m, j.compiled.rules, filter)).map(match => ({ field, match })));
        const rows = hits.slice(offset, offset + 100).map(({ field: f, match: m }) => {
            let start = Math.max(0, m.start - 70), end = Math.min(f.text.length, m.end + 70);
            const nearby = f.matches.filter(n => n.end > start && n.start < end);
            start = Math.min(start, ...nearby.map(n => n.start)); end = Math.max(end, ...nearby.map(n => n.end));
            return { id: m.id, rule: m.rule, scope: f.scope, owner: f.owner, label: f.label, field: f.path.join('.'), aliases: f.aliases.map(p => p.join('.')), start: m.start,
                context: { text: f.text.slice(start, end), leading: start > 0, trailing: end < f.text.length, matches: nearby.map(n => ({ ...n, start: n.start - start, end: n.end - start })) } };
        });
        return { total: hits.length, offset, rows };
    }
    backupRoot() {
        const relative = 'backups/writer-workbench'; confined(this.root, relative, { missing: true });
        fs.mkdirSync(path.join(this.root, relative), { recursive: true, mode: 0o700 });
        return confined(this.root, relative);
    }
    manifest(id) {
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail('备份编号无效。');
        const relative = `backups/writer-workbench/${id}/manifest.json`;
        const manifest = JSON.parse(readBuffer(this.root, relative));
        if (manifest.id !== id || !Array.isArray(manifest.files)) fail('备份清单无效。');
        if (new Set(manifest.files.map(f => f.relative)).size !== manifest.files.length || manifest.files.some(f => typeof f.relative !== 'string' || !/^\d+\.bin$/.test(f.backup) || !/^[a-f0-9]{64}$/.test(f.beforeHash) || !/^[a-f0-9]{64}$/.test(f.afterHash))) fail('备份清单的文件记录无效。');
        return manifest;
    }
    writeManifest(manifest) {
        const relative = `backups/writer-workbench/${manifest.id}/manifest.json`, file = confined(this.root, relative, { missing: true });
        this.atomic(file, Buffer.from(JSON.stringify(manifest, null, 2)));
    }
    atomic(target, bytes) {
        const temporary = `${target}.ww-${crypto.randomUUID()}.tmp`;
        try {
            const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
            const descriptor = fs.openSync(temporary, 'wx', mode);
            try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
            if (hash(fs.readFileSync(temporary)) !== hash(bytes)) fail('临时文件校验失败。');
            this.beforeRename?.(target); fs.renameSync(temporary, target);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    apply({ id, excludedFiles = [], excludedMatches = [] }) {
        const job = this.job(id);
        if (this.busy || job.cancelled || job.status !== 'ready') fail('任务尚未完成、已执行、已取消或正在执行。');
        if (!Array.isArray(excludedFiles) || !Array.isArray(excludedMatches)) fail('选择格式无效。');
        const allMatches = new Set(job.files.flatMap(f => f.fields.flatMap(x => x.matches.map(m => m.id))));
        if (excludedFiles.some(x => !job.files.some(f => f.id === x)) || excludedMatches.some(x => !allMatches.has(x))) fail('选择中存在失效的匹配。');
        const excluded = new Set(excludedMatches), plan = [];
        let totalBytes = 0;
        for (const file of job.files) {
            if (excludedFiles.includes(file.id)) continue;
            const changes = file.fields.map(f => ({ ...f, selected: f.matches.filter(m => !excluded.has(m.id)) })).filter(f => f.selected.length);
            if (!changes.length) continue;
            const before = readBuffer(this.root, file.relative);
            if (hash(before) !== file.beforeHash) fail(`${file.relative} 已发生变化，未写入任何文件，请重新扫描。`);
            const document = decodeDocument(before, file), next = structuredClone(document.value);
            const growth = changes.reduce((n, field) => n + field.selected.reduce((sum, m) => {
                const rule = job.compiled.rules[m.rule];
                return sum + Math.max(0, Buffer.byteLength(JSON.stringify(rule.replace)) - Buffer.byteLength(JSON.stringify(rule.find))) * (1 + field.aliases.length);
            }, 0), 0) * (file.format === 'png' ? 4 : 2);
            if (before.length + growth > MAX_FILE || totalBytes + before.length * 2 + growth > MAX_BATCH) fail('替换后文件或整批内存预算过大，请减少匹配或缩短替换内容。');
            for (const field of changes) {
                if (getAt(next, field.path) !== field.text) fail('字段已改变，请重新扫描。');
                const result = replaceMatches(field.text, field.selected, job.compiled.rules);
                if (field.scope === 'regex' && field.path.at(-1) === 'findRegex') {
                    const parts = result.match(/^\/([\s\S]*)\/([a-z]*)$/);
                    try { new RegExp(parts ? parts[1] : result, parts ? parts[2] : ''); }
                    catch { fail(`${file.relative} 的查找表达式在替换后无效，未写入任何文件。`); }
                }
                setAt(next, field.path, result); for (const alias of field.aliases) setAt(next, alias, result);
            }
            const after = document.encode(next);
            if (after.length > MAX_FILE) fail('替换后文件超过 64 MB，未写入任何文件。');
            const verified = decodeDocument(after, file).value;
            if (JSON.stringify(verified) !== JSON.stringify(next)) fail(`${file.relative} 写入前结构校验失败。`);
            totalBytes += before.length + after.length;
            if (totalBytes > MAX_BATCH) fail('整批超过 256 MB 内存预算，请分批执行。');
            plan.push({ file, before, after, count: changes.reduce((n, f) => n + f.selected.length, 0) });
        }
        if (!plan.length) fail('没有选中的修改。');
        this.busy = true; const tx = crypto.randomUUID();
        const manifest = { version: 1, id: tx, created: new Date().toISOString(), status: 'preparing', rules: job.compiled.rules, scopes: job.options.scopes, mode: job.options.mode, files: [] };
        try {
            const directory = path.join(this.backupRoot(), tx); fs.mkdirSync(directory, { mode: 0o700 });
            for (const [i, p] of plan.entries()) {
                const backup = `${i}.bin`;
                this.atomic(path.join(directory, backup), p.before);
                if (hash(fs.readFileSync(path.join(directory, backup))) !== p.file.beforeHash) fail('备份校验失败，禁止写入。');
                manifest.files.push({ relative: p.file.relative, backup, beforeHash: p.file.beforeHash, afterHash: hash(p.after), count: p.count, state: 'pending', modified: fs.statSync(confined(this.root, p.file.relative)).mtime.toISOString() });
            }
            manifest.status = 'prepared'; this.writeManifest(manifest);
            // Recheck the entire batch after all backups, before the first write.
            for (const p of plan) if (hash(readBuffer(this.root, p.file.relative)) !== p.file.beforeHash) fail(`${p.file.relative} 在备份期间发生变化。`);
            for (const [i, p] of plan.entries()) {
                const record = manifest.files[i];
                if (hash(readBuffer(this.root, p.file.relative)) !== record.beforeHash) fail(`${p.file.relative} 写入前发生变化。`);
                manifest.status = 'committing'; record.state = 'committing'; this.writeManifest(manifest);
                this.atomic(confined(this.root, p.file.relative), p.after);
                if (hash(readBuffer(this.root, p.file.relative)) !== record.afterHash) fail(`${p.file.relative} 写入后校验失败。`);
                record.state = 'committed'; this.writeManifest(manifest);
            }
            manifest.status = 'complete'; this.writeManifest(manifest); job.status = 'applied';
            return { id: tx, files: plan.length, matches: plan.reduce((n, p) => n + p.count, 0) };
        } catch (error) {
            manifest.error = error.message;
            const failures = [];
            for (const record of [...manifest.files].reverse()) {
                try {
                    const current = hash(readBuffer(this.root, record.relative));
                    if (current === record.beforeHash) { record.state = 'unchanged'; continue; }
                    if (current !== record.afterHash) { record.state = 'conflict'; failures.push(record.relative); continue; }
                    const backup = readBuffer(this.root, `backups/writer-workbench/${tx}/${record.backup}`);
                    if (hash(backup) !== record.beforeHash) fail('恢复用备份损坏。');
                    this.atomic(confined(this.root, record.relative), backup); record.state = 'restored';
                } catch (restoreError) { record.state = 'conflict'; record.error = restoreError.message; failures.push(record.relative); }
            }
            manifest.status = failures.length ? 'needs-attention' : 'aborted';
            try { if (fs.existsSync(path.join(this.root, 'backups/writer-workbench', tx))) this.writeManifest(manifest); } catch { /* Original failure is retained for the caller. */ }
            job.status = 'failed';
            throw Error(`执行失败：${error.message}。${failures.length ? `有 ${failures.length} 个文件需从备份检查恢复，备份编号 ${tx}。` : '已停止；已提交文件已恢复。'}备份编号：${tx}`);
        } finally { this.busy = false; }
    }
    backups() {
        const dir = this.backupRoot();
        return fs.readdirSync(dir).filter(id => /^[a-f0-9-]{36}$/.test(id)).flatMap(id => {
            try { const m = this.manifest(id); return [{ id, created: m.created, status: m.status, files: m.files.map(f => ({ path: f.relative, state: f.state })), error: m.error }]; }
            catch { return [{ id, status: 'unreadable', error: '备份清单不完整，请保留目录以便检查。' }]; }
        }).sort((a, b) => String(b.created).localeCompare(String(a.created)));
    }
    restore({ id, preserveConflicts = false }) {
        if (this.busy) fail('正在执行其他写入。');
        const manifest = this.manifest(id), catalog = new Map(this.catalog().resources.map(r => [r.relative, r]));
        const conflicts = [], plan = [];
        for (const record of manifest.files) {
            if (!/^\d+\.bin$/.test(record.backup)) fail('备份文件名无效。');
            const current = catalog.has(record.relative) ? readBuffer(this.root, record.relative) : null;
            if (current && hash(current) === record.beforeHash) { record.state = 'restored'; continue; }
            if (!current || hash(current) !== record.afterHash) { conflicts.push(record.relative); continue; }
            const backup = readBuffer(this.root, `backups/writer-workbench/${id}/${record.backup}`);
            if (hash(backup) !== record.beforeHash) fail('备份校验失败，未恢复任何文件。');
            plan.push({ record, current, backup });
        }
        if (conflicts.length && !preserveConflicts) return { conflicts, restored: 0, needsConfirmation: true };
        this.busy = true;
        try {
            // Save post-edit versions too, so restoration itself remains recoverable.
            for (const p of plan) this.atomic(confined(this.root, `backups/writer-workbench/${id}/after-${p.record.backup}`, { missing: true }), p.current);
            for (const p of plan) {
                if (hash(readBuffer(this.root, p.record.relative)) !== p.record.afterHash) fail('恢复期间文件发生变化，已停止。');
                p.record.state = 'restoring'; this.writeManifest(manifest);
                this.atomic(confined(this.root, p.record.relative), p.backup);
                if (hash(readBuffer(this.root, p.record.relative)) !== p.record.beforeHash) fail('恢复后校验失败。');
                p.record.state = 'restored'; this.writeManifest(manifest);
            }
            manifest.status = conflicts.length ? 'partially-restored' : 'restored'; manifest.conflicts = conflicts; this.writeManifest(manifest);
            return { restored: plan.length, conflicts };
        } catch (error) {
            manifest.status = 'needs-attention'; manifest.error = error.message;
            try { this.writeManifest(manifest); } catch { /* Preserve original failure. */ }
            throw Error(`恢复未全部完成：${error.message}。请查看备份 ${id} 的逐文件状态。`);
        } finally { this.busy = false; }
    }
}

export function installBatchRoutes(router) {
    const services = new Map();
    const service = req => {
        if (!req.user?.directories?.root || !req.user?.profile?.handle) fail('需要已登录的酒馆用户。');
        const root = fs.realpathSync(req.user.directories.root), key = `${req.user.profile.handle}:${root}`;
        if (!services.has(key)) services.set(key, new BatchService(root)); return services.get(key);
    };
    const route = (name, action) => router.post(name, async (req, res) => {
        try { res.json(await action(service(req), req.body || {})); }
        catch (error) { res.status(400).json({ error: error.message }); }
    });
    route('/health', () => ({ version: 1 }));
    route('/inventory', s => s.inventory());
    route('/scan', (s, body) => s.startScan(body));
    route('/status', (s, body) => s.status(body.id, body.filter));
    route('/cancel', (s, body) => { const job = s.job(body.id); job.cancelled = true; if (job.status === 'ready') job.status = 'cancelled'; return { ok: true }; });
    route('/preview', (s, body) => s.preview(body.id, body.fileId, body.offset ?? 0, body.filter));
    route('/apply', (s, body) => s.apply(body));
    route('/backups', s => s.backups());
    route('/restore', (s, body) => s.restore(body));
    router.post('/download', (req, res) => {
        try {
            const s = service(req), m = s.manifest(req.body.id);
            const archive = archiver('zip');
            res.attachment(`writer-workbench-backup-${m.id}.zip`); archive.on('error', () => res.destroy()); archive.pipe(res);
            archive.append(JSON.stringify(m, null, 2), { name: 'manifest.json' });
            for (const record of m.files) {
                if (!/^\d+\.bin$/.test(record.backup)) fail('备份文件名无效。');
                const bytes = readBuffer(s.root, `backups/writer-workbench/${m.id}/${record.backup}`);
                if (hash(bytes) !== record.beforeHash) fail('备份校验失败。');
                archive.append(bytes, { name: record.backup });
            }
            archive.finalize();
        } catch (error) { if (!res.headersSent) res.status(400).json({ error: error.message }); else res.destroy(); }
    });
}
