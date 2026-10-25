import { compileRules, findMatchesAsync, replaceMatches, snippet } from './batch-engine.js';
import { editableFields, getAt, setAt, BATCH_SCOPES } from './batch-adapters.js';
import { zipSync, unzipSync } from '../../vendor/fflate.js';

const NS = 'writer-workbench-batch';
export const TT_SCOPES = ['persona', 'chats', 'character', 'greetings', 'world'];
const MAX_FILE = 32 * 1024 * 1024, MAX_BATCH = 128 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const clone = value => structuredClone(value);
const uuid = () => crypto.randomUUID();
const safeName = value => {
    if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f/\\]/.test(value) || ['.', '..'].includes(value)) throw Error('资源标识无效。');
    return value;
};
function stable(value) {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw Error('资源包含不能安全往返的数字，已停止处理。');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
export async function ttHash(value) { return bytesHash(encoder.encode(stable(value))); }
async function bytesHash(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join(''); }
function validateValue(value) {
    const text = stable(value); if (encoder.encode(text).length > MAX_FILE) throw Error('单份 TT 资源超过 32 MB，请缩小范围或使用文件导出。'); return text;
}
const rid = (kind, ...parts) => `tt:${kind}:${parts.map(x => encodeURIComponent(x)).join(':')}`;
const v1Fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
function personaValue(settings, id) {
    const pu = settings.power_user;
    if (!Object.hasOwn(pu?.personas || {}, id)) throw Error('目标身份已不存在。');
    const value = { power_user: { personas: { [id]: pu.personas[id] }, persona_descriptions: {} }, oai_settings: { prompts: [] }, extension_settings: { regex: [] } };
    if (Object.hasOwn(pu.persona_descriptions || {}, id)) value.power_user.persona_descriptions[id] = clone(pu.persona_descriptions[id]);
    if (settings.user_avatar === id) {
        value.user_avatar = id;
        if (typeof settings.username === 'string') value.username = settings.username;
        if (typeof pu.persona_description === 'string') value.power_user.persona_description = pu.persona_description;
    }
    return value;
}

export class TtBatchService {
    constructor({ context, host = globalThis, fetcher = (...args) => fetch(...args) }) {
        this.context = context; this.env = host; this.fetcher = fetcher; this.host = 'tt'; this.jobs = new Map(); this.busy = false;
    }
    async init() {
        if (!this.env.__TAURITAVERN__ || !this.env.SillyTavern && this.env === globalThis) throw Error('TT 宿主接口未就绪；不会改用 PC 酒馆。');
        this.tt = this.env.__TAURITAVERN__; await this.tt.ready;
        if (this.tt.abiVersion !== 2) throw Error('此 TT ABI 尚未验证，已停止直接写入。');
        this.store = this.tt.api?.extension?.store;
        for (const method of ['tryGetJson', 'getJson', 'setJson', 'listKeys', 'getBlob', 'setBlob']) if (typeof this.store?.[method] !== 'function') throw Error(`TT 缺少扩展备份能力 ${method}，已停止。`);
        const kind = this.env.__TAURITAVERN_HOST__?.kind;
        if (!['desktop', 'mobile'].includes(kind)) throw Error('无法确认 TT 宿主类型，停止直接写入。');
        this.desktop = kind === 'desktop';
        this.root = await this.currentRoot();
        const saved = await this.store.tryGetJson({ namespace: NS, key: 'dataset' });
        if (saved.found) {
            this.dataset = saved.value?.id;
            if (!this.dataset || saved.value.root !== this.root) this.bindingConflict = { previous: clone(saved.value ?? null) };
        } else {
            this.dataset = uuid(); await this.store.setJson({ namespace: NS, key: 'dataset', value: { id: this.dataset, root: this.root } });
        }
        return this;
    }
    async currentRoot() {
        if (!this.desktop) return 'tt-current-mobile-sandbox';
        const runtime = await this.tt.invoke.safeInvoke('get_runtime_paths');
        if (!runtime?.data_root || runtime.migration_pending || runtime.migration_error) throw Error('TT 数据目录未稳定，停止写入。');
        return runtime.data_root.replaceAll('\\', '/');
    }
    async assertTarget() {
        if (this.bindingConflict) throw Error('TT 备份资料集归属不一致；请先在批量替换中确认登记当前导入资料。');
        if (await this.currentRoot() !== this.root) throw Error('TT 数据目录已改变，已停止。');
        const data = await this.store.getJson({ namespace: NS, key: 'dataset' });
        if (data.id !== this.dataset || data.root !== this.root) throw Error('TT 资料集已改变，已停止。');
    }
    async registerDataset({ confirm, previousId, root } = {}) {
        return this.locked(async () => {
            if (!this.bindingConflict || confirm !== true || root !== this.root || previousId !== (this.bindingConflict.previous?.id ?? null)) throw Error('资料集登记确认已失效，请刷新后重试。');
            if (await this.currentRoot() !== this.root) throw Error('TT 数据目录已改变，未登记。');
            const saved = await this.store.getJson({ namespace: NS, key: 'dataset' });
            if (await ttHash(saved) !== await ttHash(this.bindingConflict.previous)) throw Error('资料集标记已改变，请刷新后重试。');
            const next = { id: uuid(), root: this.root, registeredAt: new Date().toISOString(), previousId: saved?.id ?? null };
            const archive = { previous: clone(saved), next: clone(next), reason: 'confirmed-import-or-move' };
            await this.store.setJson({ namespace: NS, table: 'datasets', key: next.id, value: archive });
            if (await ttHash(await this.store.getJson({ namespace: NS, table: 'datasets', key: next.id })) !== await ttHash(archive)) throw Error('旧资料集标记归档校验失败，未登记。');
            if (await this.currentRoot() !== this.root) throw Error('TT 数据目录已改变，未登记。');
            await this.store.setJson({ namespace: NS, key: 'dataset', value: next });
            if (await ttHash(await this.store.getJson({ namespace: NS, key: 'dataset' })) !== await ttHash(next)) throw Error('新资料集标记复读失败，请刷新检查。');
            this.dataset = next.id; this.bindingConflict = null; this.jobs.clear(); this.resources = null;
            return { id: next.id, root: next.root, previousArchived: true };
        });
    }
    async request(path, body = {}) {
        if (!path.startsWith('/api/') || path.startsWith('/api/plugins/')) throw Error('TT 请求目标被拒绝。');
        const response = await this.fetcher(path, { method: 'POST', headers: this.context().getRequestHeaders(), body: JSON.stringify(body) });
        const text = await response.text(); let data;
        try { data = JSON.parse(text); } catch { throw Error(`TT 接口未返回 JSON：${path} (${response.status})`); }
        if (!response.ok || data?.error) throw Error(`TT ${path}：${data?.error || response.status}${data?.details ? ` ${data.details}` : ''}`);
        return data;
    }
    async settings() {
        const result = await this.request('/api/settings/get');
        if (typeof result.settings !== 'string') throw Error('TT 设置响应格式不兼容。');
        return { ...result, value: JSON.parse(result.settings) };
    }
    async inventory() {
        if (this.bindingConflict) {
            if (await this.currentRoot() !== this.root) throw Error('TT 数据目录已改变，请刷新。');
            return { resources: [], owners: [], skipped: [], host: 'tt', scopes: BATCH_SCOPES, supportedScopes: TT_SCOPES, backupLocation: 'TT 当前数据目录 → _tauritavern/extension-store/writer-workbench-batch', warning: '当前导入资料尚未登记，扫描和写入保持停止。', datasetBinding: { currentRoot: this.root, previousRoot: this.bindingConflict.previous?.root || '未知旧目录', previousId: this.bindingConflict.previous?.id ?? null } };
        }
        await this.assertTarget();
        const [settings, characters, groups, chats] = await Promise.all([
            this.settings(), this.request('/api/characters/all'), this.request('/api/groups/all'),
            this.tt.invoke.safeInvoke('list_recent_chat_summaries', { include_metadata: false, max_entries: 10001, pinned: [] }),
        ]);
        if (![characters, groups, chats].every(Array.isArray) || !Array.isArray(settings.world_names)) throw Error('TT 资源列表格式不兼容。');
        if (chats.length > 10000) throw Error('TT 聊天数超过单次资源预算，请先分批导出。');
        const resources = [], owners = [], skipped = [];
        const add = resource => { resource.label = resource.relative; resources.push(resource); owners.push({ id: resource.avatarId || resource.id, type: resource.ownerType || resource.adapter, label: resource.relative }); };
        for (const [avatar, name] of Object.entries(settings.value.power_user?.personas || {})) {
            safeName(avatar); add({ id: rid('persona', avatar), adapter: 'settings', ownerType: 'persona', avatarId: avatar, relative: `User Persona · ${name} · ${avatar}` });
        }
        const cards = new Map();
        for (const character of characters) {
            const avatar = safeName(character.avatar), stem = avatar.replace(/\.png$/i, '');
            const resource = { id: rid('character', avatar), adapter: 'character', avatar, relative: `角色卡 · ${avatar}` };
            cards.set(stem, resource.id); add(resource);
        }
        for (const name of settings.world_names) { safeName(name); add({ id: rid('world', name), adapter: 'world', name, relative: `世界书 · ${name}` }); }
        for (const chat of chats) {
            const characterId = safeName(chat.character_name), fileName = safeName(chat.file_name.replace(/\.jsonl$/i, ''));
            add({ id: rid('chat', characterId, fileName), adapter: 'chat', characterId, fileName, ...(cards.has(characterId) ? { characterOwner: cards.get(characterId) } : {}), relative: `聊天 · ${characterId}/${fileName}.jsonl` });
        }
        const groupIds = new Set();
        for (const group of groups) for (const name of group.chats || []) {
            const fileName = safeName(String(name).replace(/\.jsonl$/i, '')); if (groupIds.has(fileName)) continue; groupIds.add(fileName);
            add({ id: rid('group-chat', fileName), adapter: 'chat', group: true, fileName, relative: `群聊 · ${fileName}.jsonl` });
        }
        this.resources = new Map(resources.map(resource => [resource.id, resource]));
        return { resources, owners, skipped, host: 'tt', scopes: BATCH_SCOPES, supportedScopes: TT_SCOPES, backupLocation: 'TT 当前数据目录 → _tauritavern/extension-store/writer-workbench-batch', warning: 'TT 使用原生接口逐项保存，JSON 排版可能规范化；执行期间暂停其他编辑与同步。' };
    }
    chatBody(resource) { return resource.group ? { id: resource.fileName } : { ch_name: resource.characterId, file_name: resource.fileName }; }
    async read(resource) {
        let value;
        if (resource.avatarId) {
            const { value: settings } = await this.settings(); value = personaValue(settings, resource.avatarId);
        } else if (resource.adapter === 'character') {
            // Export rematerializes linked lorebooks and strips private fields.
            // Only get.json_data represents the actual stored card for checks,
            // replacement and recovery.
            const result = await this.request('/api/characters/get', { avatar_url: resource.avatar });
            if (typeof result.json_data !== 'string') throw Error('TT 未提供角色卡原始 JSON，停止处理该卡。');
            const card = JSON.parse(result.json_data);
            value = { data: card.data || card };
        } else if (resource.adapter === 'world') {
            const settings = await this.settings(); if (!settings.world_names.includes(resource.name)) throw Error('目标世界书已不存在。');
            value = await this.request('/api/worldinfo/get', { name: resource.name });
        } else value = await this.request(resource.group ? '/api/chats/group/get' : '/api/chats/get', { ...this.chatBody(resource), allow_not_found: false });
        validateValue(value); return value;
    }
    async originalBlob(resource) {
        let response;
        if (resource.avatarId) response = await this.fetcher(`/User%20Avatars/${encodeURIComponent(resource.avatarId)}`, { cache: 'no-store' });
        else if (resource.adapter === 'character') response = await this.fetcher(`/characters/${encodeURIComponent(resource.avatar)}`, { cache: 'no-store' });
        else return null;
        if (!response.ok) throw Error('原始图片备份读取失败。');
        const blob = await response.blob(); if (!blob.size || blob.size > MAX_FILE) throw Error('原始图片备份大小无效。');
        return blob;
    }
    async write(resource, value, expectedHash) {
        await this.assertTarget();
        if (this.context().isGenerating || this.context().streamingProcessor) throw Error('请先停止生成，再执行替换。');
        if (await ttHash(await this.read(resource)) !== expectedHash) throw Error(`${resource.relative} 写入前已发生变化。`);
        if (resource.avatarId) {
            const current = await this.settings(), id = resource.avatarId;
            if (await ttHash(personaValue(current.value, id)) !== expectedHash) throw Error('身份在准备保存期间发生变化。');
            // Only this identity is submitted; all other settings use the freshly
            // fetched snapshot and the native settings revision.
            const full = current.value; full.power_user.personas = clone(value.power_user.personas); full.power_user.persona_descriptions = clone(value.power_user.persona_descriptions);
            if (value.user_avatar === id) {
                if (Object.hasOwn(value, 'username')) full.username = value.username;
                if (Object.hasOwn(value.power_user, 'persona_description')) full.power_user.persona_description = value.power_user.persona_description;
            }
            if (!current.tauritavern_settings_revision) throw Error('TT 缺少设置版本令牌。');
            const headers = { ...this.context().getRequestHeaders(), 'X-TauriTavern-Settings-Revision': JSON.stringify(current.tauritavern_settings_revision) };
            const response = await this.fetcher('/api/settings/save', { method: 'POST', headers, body: JSON.stringify(full) });
            const result = await response.json();
            if (!response.ok || result.result !== 'ok' || Object.keys(result.persona_errors || {}).length) throw Error(`身份保存未完整成功：${JSON.stringify(result.persona_errors || result.error || result.result)}（${id}）`);
        } else if (resource.adapter === 'character') {
            const data = value.data;
            await this.request('/api/characters/merge-attributes', { avatar: resource.avatar, data, ...Object.fromEntries(v1Fields.filter(key => typeof data[key] === 'string').map(key => [key, data[key]])) });
        } else if (resource.adapter === 'world') await this.request('/api/worldinfo/edit', { name: resource.name, data: value });
        else await this.request(resource.group ? '/api/chats/group/save' : '/api/chats/save', { ...this.chatBody(resource), chat: value, force: false });
        if (await ttHash(await this.read(resource)) !== await ttHash(value)) throw Error(`${resource.relative} 保存后复读不一致。`);
    }
    async scan(options) {
        if (this.busy) throw Error('正在写入或恢复。');
        await this.assertTarget();
        if (!['global', 'local'].includes(options.mode) || !options.scopes?.length || options.scopes.some(scope => !(this.supportedScopes || TT_SCOPES).includes(scope))) throw Error('请选择 TT 已支持的作用范围。');
        const compiled = compileRules(options.rules), inventory = await this.inventory();
        if (options.mode === 'local' && !options.fileIds?.length && !options.ownerIds?.length) throw Error('局部模式必须选择资源。');
        for (const [id, old] of this.jobs) if (Date.now() - old.created > 30 * 60 * 1000) this.jobs.delete(id);
        if (this.jobs.size >= 4) { const idle = [...this.jobs].find(([, job]) => job.status !== 'scanning'); if (idle) this.jobs.delete(idle[0]); else throw Error('扫描任务过多。'); }
        const scopes = options.scopes, applicable = resource => resource.avatarId ? scopes.includes('persona') : resource.adapter === 'character' ? scopes.some(s => ['character', 'greetings', 'world'].includes(s)) : scopes.includes(resource.adapter === 'world' ? 'world' : 'chats');
        const chosen = resource => options.mode === 'global' || options.fileIds?.includes(resource.id) || options.ownerIds?.includes(resource.avatarId || resource.id) || resource.characterOwner && options.ownerIds?.includes(resource.characterOwner);
        const resources = inventory.resources.filter(resource => applicable(resource) && chosen(resource));
        const job = { id: uuid(), created: Date.now(), status: 'scanning', compiled, options: clone(options), files: [], counts: compiled.rules.map(() => 0), scopeCounts: {}, warnings: ['逐资源备份和提交，不是跨资源原子事务；执行期间暂停其他编辑与同步。'], skipped: [], total: resources.length, scanned: 0, matches: 0, bytes: 0 };
        this.jobs.set(job.id, job);
        job.done = (async () => {
            try {
                for (const resource of resources) {
                    if (job.cancelled) break;
                    try {
                        const value = await this.read(resource), text = validateValue(value); job.bytes += encoder.encode(text).length;
                        if (job.bytes > MAX_BATCH) throw Error('本次 TT 扫描超过 128 MB 预算，请分批。');
                        const fields = editableFields(value, resource).filter(field => scopes.includes(field.scope)), hits = [];
                        for (const [i, field] of fields.entries()) {
                            const matches = await findMatchesAsync(field.text, compiled, { yieldControl: pause, cancelled: () => job.cancelled });
                            for (const match of matches) match.id = `${resource.id}:${i}:${match.start}:${match.rule}`;
                            if (matches.length) hits.push({ ...field, matches });
                        }
                        const count = hits.reduce((n, field) => n + field.matches.length, 0); job.matches += count;
                        if (job.matches > 100000) throw Error('匹配超过十万处，请缩小范围。');
                        for (const field of hits) for (const match of field.matches) { job.counts[match.rule]++; job.scopeCounts[field.scope] = (job.scopeCounts[field.scope] || 0) + 1; }
                        if (hits.length) job.files.push({ ...resource, beforeHash: await ttHash(value), fields: hits, count });
                    } catch (error) {
                        if (job.cancelled) break;
                        // Invalid or unrepresentable data is visible in the skipped list.
                        if (job.bytes > MAX_BATCH || job.matches > 100000) throw error;
                        job.skipped.push({ path: resource.relative, error: error.message });
                    }
                    job.scanned++; await pause();
                }
                job.status = job.cancelled ? 'cancelled' : 'ready';
            } catch (error) { job.status = 'failed'; job.error = error.message; }
        })();
        return { id: job.id };
    }
    job(id) { const job = this.jobs.get(id); if (!job || Date.now() - job.created > 30 * 60 * 1000) throw Error('扫描已过期，请重新扫描。'); return job; }
    matchesFilter(file, field, match, rules, filter = {}) {
        if (filter.rule !== undefined && filter.rule !== '' && Number(filter.rule) !== match.rule || filter.scope && filter.scope !== field.scope) return false;
        if (!filter.query) return true;
        const view = snippet(field.text, match, rules[match.rule]);
        return `${file.relative} ${field.label} ${field.path.join('.')} ${view.prefix}${view.before}${view.after}${view.suffix}`.toLocaleLowerCase().includes(String(filter.query).toLocaleLowerCase());
    }
    status(id, filter) {
        const job = this.job(id);
        return { id, status: job.status, scanned: job.scanned, total: job.total, matches: job.matches, counts: job.counts, scopeCounts: job.scopeCounts, warnings: job.warnings, skipped: job.skipped, error: job.error,
            files: job.files.map(file => ({ id: file.id, path: file.relative, count: file.count, visible: file.fields.reduce((n, field) => n + field.matches.filter(m => this.matchesFilter(file, field, m, job.compiled.rules, filter)).length, 0), scopes: [...new Set(file.fields.map(f => f.scope))], labels: [...new Set(file.fields.map(f => f.label))] })) };
    }
    preview(id, fileId, offset = 0, filter) {
        const job = this.job(id), file = job.files.find(f => f.id === fileId);
        if (!file || !Number.isInteger(offset) || offset < 0) throw Error('预览资源无效。');
        const hits = file.fields.flatMap(field => field.matches.filter(m => this.matchesFilter(file, field, m, job.compiled.rules, filter)).map(match => ({ field, match })));
        const rows = hits.slice(offset, offset + 100).map(({ field, match }) => {
            let start = Math.max(0, match.start - 70), end = Math.min(field.text.length, match.end + 70);
            const nearby = field.matches.filter(m => m.end > start && m.start < end); start = Math.min(start, ...nearby.map(m => m.start)); end = Math.max(end, ...nearby.map(m => m.end));
            return { ...match, scope: field.scope, owner: field.owner, label: field.label, field: field.path.join('.'), aliases: field.aliases.map(p => p.join('.')), context: { text: field.text.slice(start, end), leading: start > 0, trailing: end < field.text.length, matches: nearby.map(m => ({ ...m, start: m.start - start, end: m.end - start })) } };
        });
        return { total: hits.length, offset, rows };
    }
    async saveManifest(manifest) {
        await this.store.setJson({ namespace: NS, table: 'transactions', key: manifest.id, value: manifest });
        if (await ttHash(await this.store.getJson({ namespace: NS, table: 'transactions', key: manifest.id })) !== await ttHash(manifest)) throw Error('备份清单复读失败。');
    }
    async manifest(id, { allowForeign = false } = {}) {
        if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('备份编号无效。');
        const manifest = await this.store.getJson({ namespace: NS, table: 'transactions', key: id });
        if (manifest.id !== id || manifest.host !== this.host || !manifest.dataset || typeof manifest.root !== 'string' || !Array.isArray(manifest.files)) throw Error('备份清单无效。');
        if (!allowForeign && (manifest.dataset !== this.dataset || manifest.root !== this.root)) throw Error('备份属于迁移前或其他 TT 资料集，禁止直接恢复到当前资料；可以下载保留。');
        return manifest;
    }
    async putValue(key, value) {
        await this.store.setBlob({ namespace: NS, key, data: new Blob([validateValue(value)], { type: 'application/json' }) });
        if (await ttHash(await this.getValue(key)) !== await ttHash(value)) throw Error('原文备份复读校验失败。');
    }
    async getValue(key) {
        if (!/^[a-f0-9-]+\.(before|after)\.json$/.test(key)) throw Error('备份文件名无效。');
        const blob = await this.store.getBlob({ namespace: NS, key }); if (blob.size > MAX_FILE) throw Error('备份大小无效。');
        const value = JSON.parse(await blob.text()); validateValue(value); return value;
    }
    async backups() {
        await this.assertTarget(); const keys = await this.store.listKeys({ namespace: NS, table: 'transactions' }), results = [];
        for (const id of keys) {
            try {
                const m = await this.manifest(id, { allowForeign: true }), foreign = m.dataset !== this.dataset || m.root !== this.root;
                results.push({ id, created: m.created, status: foreign ? 'foreign' : m.status, error: foreign ? `属于迁移前或其他资料集（${m.root}）；保留下载，禁止直接恢复。` : m.error, files: m.files.map(file => ({ path: file.resource.relative, state: file.state })) });
            }
            catch { results.push({ id, status: 'unreadable', error: '备份清单无法验证，请保留扩展存储。' }); }
        }
        return results.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    }
    async locked(task) {
        if (this.busy) throw Error('正在执行其他 TT 写入。');
        this.busy = true;
        try {
            if (this.env.navigator?.locks?.request) return await this.env.navigator.locks.request(`ww-tt-${this.dataset}`, { ifAvailable: true }, lock => { if (!lock) throw Error('其他窗口正在执行批量操作。'); return task(); });
            return await task();
        } finally { this.busy = false; }
    }
    async apply({ id, excludedFiles = [], excludedMatches = [] }) {
        return this.locked(async () => {
            await this.assertTarget();
            const unfinished = (await this.backups()).filter(m => ['preparing', 'prepared', 'committing', 'restoring', 'needs-attention', 'unreadable'].includes(m.status));
            if (unfinished.length) throw Error('发现未完成事务，请先在备份中检查恢复。');
            const job = this.job(id); if (job.status !== 'ready' || job.cancelled) throw Error('任务尚未就绪或已执行。');
            if (!Array.isArray(excludedFiles) || !Array.isArray(excludedMatches)) throw Error('选择格式无效。');
            const known = new Set(job.files.flatMap(file => file.fields.flatMap(field => field.matches.map(m => m.id))));
            if (excludedFiles.some(fid => !job.files.some(file => file.id === fid)) || excludedMatches.some(mid => !known.has(mid))) throw Error('存在失效的选择。');
            const plan = []; let totalBytes = 0;
            for (const file of job.files) {
                if (excludedFiles.includes(file.id)) continue;
                const fields = file.fields.map(f => ({ ...f, selected: f.matches.filter(m => !excludedMatches.includes(m.id)) })).filter(f => f.selected.length); if (!fields.length) continue;
                const before = await this.read(file); if (await ttHash(before) !== file.beforeHash) throw Error(`${file.relative} 扫描后有新变化，未写入任何资源。`);
                const after = clone(before);
                for (const field of fields) { if (getAt(after, field.path) !== field.text) throw Error('匹配字段已改变。'); const text = replaceMatches(field.text, field.selected, job.compiled.rules); setAt(after, field.path, text); for (const alias of field.aliases) setAt(after, alias, text); }
                totalBytes += encoder.encode(validateValue(before)).length + encoder.encode(validateValue(after)).length;
                if (totalBytes > MAX_BATCH) throw Error('本次 TT 提交超过内存预算。');
                plan.push({ file, before, after, afterHash: await ttHash(after), count: fields.reduce((n, f) => n + f.selected.length, 0) });
            }
            if (!plan.length) throw Error('没有选中的修改。');
            if (plan.length > 1000) throw Error('TT 单批最多修改 1000 份资源，请分批。');
            const tx = uuid(), manifest = { version: 1, host: this.host, id: tx, dataset: this.dataset, root: this.root, created: new Date().toISOString(), status: 'preparing', rules: job.compiled.rules, scopes: job.options.scopes, files: [] };
            let started = false;
            try {
                await this.saveManifest(manifest);
                for (const [i, item] of plan.entries()) {
                    const key = `${tx}-${i}`, record = { resource: Object.fromEntries(Object.entries(item.file).filter(([name]) => !['fields', 'beforeHash', 'count'].includes(name))), backup: `${key}.before.json`, after: `${key}.after.json`, beforeHash: item.file.beforeHash, afterHash: item.afterHash, count: item.count, state: 'pending' };
                    await this.putValue(record.backup, item.before); await this.putValue(record.after, item.after);
                    const image = await this.originalBlob(item.file);
                    if (image) {
                        totalBytes += image.size; if (totalBytes > MAX_BATCH) throw Error('含图片的备份超过 128 MB 预算，请分批。');
                        record.image = `${key}.png`; record.imageHash = await bytesHash(await image.arrayBuffer());
                        await this.store.setBlob({ namespace: NS, key: record.image, data: image });
                        if (await bytesHash(await (await this.store.getBlob({ namespace: NS, key: record.image })).arrayBuffer()) !== record.imageHash) throw Error('原始图片备份验证失败。');
                    }
                    manifest.files.push(record); await this.saveManifest(manifest);
                }
                manifest.status = 'prepared'; await this.saveManifest(manifest);
                for (const item of plan) if (await ttHash(await this.read(item.file)) !== item.file.beforeHash) throw Error('备份期间源资料改变，停止提交。');
                for (const [i, item] of plan.entries()) {
                    const record = manifest.files[i]; manifest.status = 'committing'; record.state = 'committing'; await this.saveManifest(manifest); started = true;
                    await this.write(item.file, item.after, record.beforeHash); record.state = 'committed'; await this.saveManifest(manifest);
                }
                manifest.status = 'complete'; await this.saveManifest(manifest); job.status = 'applied';
                return { id: tx, files: plan.length, matches: plan.reduce((n, item) => n + item.count, 0) };
            } catch (error) {
                manifest.error = error.message; const failed = [];
                if (started) for (const record of [...manifest.files].reverse()) {
                    try {
                        const currentHash = await ttHash(await this.read(record.resource));
                        if (currentHash === record.beforeHash) { record.state = 'unchanged'; continue; }
                        if (currentHash !== record.afterHash) throw Error('内容既非原文也非预期结果，需要人工检查。');
                        const before = await this.getValue(record.backup); if (await ttHash(before) !== record.beforeHash) throw Error('恢复备份损坏。');
                        await this.write(record.resource, before, record.afterHash); record.state = 'restored';
                    } catch (restoreError) { record.state = 'conflict'; record.error = restoreError.message; failed.push(record.resource.relative); }
                }
                manifest.status = failed.length ? 'needs-attention' : 'aborted'; job.status = 'failed';
                try { await this.saveManifest(manifest); } catch (saveError) { throw Error(`提交失败且恢复日志未能确认：${saveError.message}。备份 ${tx}，请停止编辑并检查。`); }
                throw Error(`TT 执行停止：${error.message}。${failed.length ? `${failed.length} 项需要检查恢复` : started ? '已提交项已恢复' : '未写入业务资料'}。备份 ${tx}`);
            }
        });
    }
    async restore({ id, preserveConflicts = false }) {
        return this.locked(async () => {
            await this.assertTarget(); const manifest = await this.manifest(id), plan = [], conflicts = [];
            const inventory = await this.inventory(), known = new Map(inventory.resources.map(r => [r.id, r]));
            for (const record of manifest.files) {
                const resource = known.get(record.resource.id); if (!resource) { conflicts.push(record.resource.relative); continue; }
                const hash = await ttHash(await this.read(resource));
                if (hash === record.beforeHash) { record.state = 'restored'; continue; }
                if (hash !== record.afterHash) { conflicts.push(resource.relative); continue; }
                const before = await this.getValue(record.backup), after = await this.getValue(record.after);
                if (await ttHash(before) !== record.beforeHash || await ttHash(after) !== record.afterHash) throw Error('备份验证失败，未恢复任何资源。');
                plan.push({ record, resource, before });
            }
            if (conflicts.length && !preserveConflicts) return { restored: 0, conflicts, needsConfirmation: true };
            manifest.status = 'restoring'; await this.saveManifest(manifest);
            try {
                for (const { record, resource, before } of plan) { record.state = 'restoring'; await this.saveManifest(manifest); await this.write(resource, before, record.afterHash); record.state = 'restored'; await this.saveManifest(manifest); }
                manifest.status = conflicts.length ? 'partially-restored' : 'restored'; manifest.conflicts = conflicts; await this.saveManifest(manifest);
                return { restored: plan.length, conflicts };
            } catch (error) { manifest.status = 'needs-attention'; manifest.error = error.message; await this.saveManifest(manifest); throw Error(`恢复未全部完成：${error.message}。请查看备份 ${id}。`); }
        });
    }
    async download(id) {
        await this.assertTarget(); const manifest = await this.manifest(id, { allowForeign: true }), files = { 'manifest.json': encoder.encode(JSON.stringify(manifest, null, 2)) }; let total = 0;
        for (const record of manifest.files) for (const [key, hash, json] of [[record.backup, record.beforeHash, true], [record.after, record.afterHash, true], ...(record.image ? [[record.image, record.imageHash, false]] : [])]) {
            const blob = await this.store.getBlob({ namespace: NS, key }), bytes = new Uint8Array(await blob.arrayBuffer()); total += bytes.length;
            if (total > MAX_BATCH) throw Error('备份包超过导出预算。');
            if ((json ? await ttHash(JSON.parse(decoder.decode(bytes))) : await bytesHash(bytes)) !== hash) throw Error('备份校验失败，停止导出。'); files[key] = bytes;
        }
        return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
    }
    async importBackup(blob) { return this.locked(() => this.importBackupUnlocked(blob)); }
    async importBackupUnlocked(blob) {
        await this.assertTarget(); if (blob.size > MAX_BATCH) throw Error('备份包过大。');
        let bytes = 0, count = 0;
        const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()), { filter: file => {
            bytes += file.originalSize; count++;
            if (file.name !== 'manifest.json' && !/^[a-f0-9-]+\.(before\.json|after\.json|png)$/.test(file.name) || file.originalSize > MAX_FILE || bytes > MAX_BATCH || count > 10000) throw Error('备份 ZIP 路径或展开预算无效。'); return true;
        } });
        if (!entries['manifest.json']) throw Error('缺少备份清单。');
        const manifest = JSON.parse(decoder.decode(entries['manifest.json']));
        if (manifest.version !== 1 || manifest.host !== this.host || manifest.dataset !== this.dataset || manifest.root !== this.root || !/^[a-f0-9-]{36}$/.test(manifest.id) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 1000) throw Error('备份包不属于当前 TT 资料集或格式不兼容。');
        if (!['complete', 'restored', 'partially-restored', 'aborted', 'preparing', 'prepared', 'committing', 'restoring', 'needs-attention'].includes(manifest.status)) throw Error('备份事务状态无效。');
        const inventory = await this.inventory(), known = new Map(inventory.resources.map(r => [r.id, r])), ids = new Set();
        for (const record of manifest.files) {
            if (!known.has(record.resource?.id) || ids.has(record.resource.id)) throw Error('备份包含未知或重复资源。'); ids.add(record.resource.id); record.resource = known.get(record.resource.id);
            for (const [key, hash, json] of [[record.backup, record.beforeHash, true], [record.after, record.afterHash, true], ...(record.image ? [[record.image, record.imageHash, false]] : [])]) {
                const value = entries[key]; if (!value) throw Error('备份内容不完整。');
                if (json) { const parsed = JSON.parse(decoder.decode(value)); validateValue(parsed); if (await ttHash(parsed) !== hash) throw Error('备份 JSON 校验失败。'); }
                else if (await bytesHash(value) !== hash) throw Error('备份图片校验失败。');
            }
        }
        if ((await this.store.tryGetJson({ namespace: NS, table: 'transactions', key: manifest.id })).found) throw Error('该备份已存在，无需再次导入。');
        // Imported payloads get fresh keys: an archive must never overwrite an
        // existing transaction's recovery files, even if its manifest was edited.
        const importKey = uuid();
        for (const [i, record] of manifest.files.entries()) {
            for (const [property, suffix] of [['backup', 'before.json'], ['after', 'after.json'], ['image', 'png']]) {
                if (!record[property]) continue;
                const data = entries[record[property]], key = `${importKey}-${i}.${suffix}`;
                await this.store.setBlob({ namespace: NS, key, data });
                if (await bytesHash(await (await this.store.getBlob({ namespace: NS, key })).arrayBuffer()) !== await bytesHash(data)) throw Error('导入备份复读失败，未发布清单。');
                record[property] = key;
            }
        }
        manifest.importedAt = new Date().toISOString(); await this.saveManifest(manifest); return { id: manifest.id, files: manifest.files.length };
    }
    async call(name, body = {}) {
        if (name === 'inventory') return this.inventory();
        if (name === 'register-dataset') return this.registerDataset(body);
        if (name === 'scan') return this.scan(body);
        if (name === 'status') return this.status(body.id, body.filter);
        if (name === 'preview') return this.preview(body.id, body.fileId, body.offset, body.filter);
        if (name === 'cancel') { const job = this.job(body.id); if (job.status === 'scanning') job.cancelled = true; else if (job.status === 'ready') { job.cancelled = true; job.status = 'cancelled'; } return { cancelled: true }; }
        if (name === 'apply') return this.apply(body);
        if (name === 'backups') return this.backups();
        if (name === 'restore') return this.restore(body);
        throw Error('TT 批量操作不受支持。');
    }
}
