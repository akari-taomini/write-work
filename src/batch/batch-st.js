import { TtBatchService, ttHash } from './batch-tt.js';
import { BATCH_SCOPES } from './batch-adapters.js';

// The ordinary SillyTavern browser extension cannot install Node server
// plugins. Limit this adapter to officially exposed per-resource endpoints.
export const ST_SCOPES = ['character', 'greetings', 'world', 'chats'];
const BACKUP_DB = 'writer-workbench-st-backups';
const STORE_NAME = 'records';
const safeId = value => {
    if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f/\\]/.test(value) || value === '.' || value === '..') throw Error('无效的资源名称。');
    return value;
};
const resourceId = (kind, ...parts) => `st:${kind}:${parts.map(encodeURIComponent).join(':')}`;
const v1Fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];

// Backups must survive a page reload, and never fall back to localStorage:
// a failed persistent write must stop the transaction before business writes.
export class BrowserBatchStore {
    constructor({ indexedDB = globalThis.indexedDB, account }) {
        if (!indexedDB || !account) throw Error('浏览器没有可用的独立备份空间；为防止数据丢失，批量写入已停用。');
        this.indexedDB = indexedDB;
        this.account = account;
    }
    async open() {
        if (!this.opening) this.opening = new Promise((resolve, reject) => {
            const request = this.indexedDB.open(BACKUP_DB, 1);
            request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME); };
            request.onerror = () => reject(request.error || Error('无法打开本地备份数据库。'));
            request.onblocked = () => reject(Error('备份数据库被其他标签页占用，请关闭后重试。'));
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { db.close(); this.opening = null; };
                resolve(db);
            };
        }).catch(error => { this.opening = null; throw error; });
        return this.opening;
    }
    key({ namespace, table = '', key }) { return `${this.account}:${namespace}:${table}:${key}`; }
    async transact(mode, fn) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, mode), request = fn(tx.objectStore(STORE_NAME));
            tx.oncomplete = () => resolve(request.result);
            tx.onabort = () => reject(tx.error || request.error || Error('备份数据库事务失败。'));
            tx.onerror = () => {};
        });
    }
    async read(args) { return this.transact('readonly', s => s.get(this.key(args))); }
    async write(args, value) { await this.transact('readwrite', s => s.put(value, this.key(args))); }
    async tryGetJson(args) { const value = await this.read(args); return { found: value !== undefined, value }; }
    async getJson(args) { const v = await this.read(args); if (v === undefined) throw Error('备份记录不存在或不完整。'); return structuredClone(v); }
    async setJson(args) { await this.write(args, structuredClone(args.value)); }
    async listKeys({ namespace, table = '' }) {
        const prefix = `${this.account}:${namespace}:${table}:`, keys = await this.transact('readonly', s => s.getAllKeys());
        return keys.filter(k => typeof k === 'string' && k.startsWith(prefix)).map(k => k.slice(prefix.length));
    }
    async getBlob(args) { const v = await this.read(args); if (!(v instanceof Blob)) throw Error('原始备份不存在或格式不正确。'); return v; }
    async setBlob(args) { if (!(args.data instanceof Blob)) throw Error('备份内容必须为 Blob。'); await this.write(args, args.data); }
}

export class StBatchService extends TtBatchService {
    constructor({ context, host = globalThis, fetcher = (...args) => fetch(...args), storeFactory = null }) {
        super({ context, host, fetcher });
        this.host = 'st'; this.supportedScopes = ST_SCOPES; this.storeFactory = storeFactory;
    }
    accountKey() { return this.context()?.accountStorage?.getItem('writer-workbench-browser-key'); }
    async init() {
        const account = this.accountKey();
        if (!account) throw Error('未找到当前酒馆账号的存储标识，请先正常打开写卡工作台。');
        this.root = `st:${this.env.location?.origin ?? 'local'}:${account}`;
        this.store = this.storeFactory ? this.storeFactory(account) : new BrowserBatchStore({ indexedDB: this.env.indexedDB, account });
        await this.store.open?.();
        const saved = await this.store.tryGetJson({ namespace: 'writer-workbench-batch', key: 'dataset' });
        if (saved.found) {
            if (!saved.value?.id || saved.value.root !== this.root) throw Error('当前账号备份标记不一致，已停用批量写入。');
            this.dataset = saved.value.id;
        } else {
            this.dataset = crypto.randomUUID();
            const data = { id: this.dataset, root: this.root };
            await this.store.setJson({ namespace: 'writer-workbench-batch', key: 'dataset', value: data });
            if (await ttHash(await this.store.getJson({ namespace: 'writer-workbench-batch', key: 'dataset' })) !== await ttHash(data)) throw Error('本地资料集标记保存失败。');
        }
        return this;
    }
    async assertTarget() {
        if (this.root !== `st:${this.env.location?.origin ?? 'local'}:${this.accountKey()}`) throw Error('酒馆账号已变化，停止批量操作。');
        const saved = await this.store.getJson({ namespace: 'writer-workbench-batch', key: 'dataset' });
        if (saved.id !== this.dataset || saved.root !== this.root) throw Error('备份资料集已变化，停止批量操作。');
    }
    async request(path, body = {}) {
        if (!/^\/api\/(?:characters|chats|worldinfo|groups)\/[a-z/-]+$/.test(path)) throw Error('不允许访问的酒馆资源接口。');
        const response = await this.fetcher(path, { method: 'POST', headers: this.context().getRequestHeaders(), body: JSON.stringify(body) });
        const text = await response.text(); let result;
        try { result = JSON.parse(text); } catch { result = text; }
        if (!response.ok || result?.error === true || typeof result?.error === 'string') throw Error(`${path}：${typeof result?.error === 'string' ? result.error : response.status}`);
        return result;
    }
    async inventory() {
        await this.assertTarget();
        const [characters, worlds] = await Promise.all([
            this.request('/api/characters/all'), this.request('/api/worldinfo/list'),
        ]);
        if (!Array.isArray(characters) || !Array.isArray(worlds)) throw Error('酒馆资源列表格式不兼容，已停止批量操作。');
        const resources = [], owners = [], skipped = [], cards = new Map();
        const add = resource => {
            resource.label = resource.relative;
            resources.push(resource);
            owners.push({ id: resource.id, type: resource.adapter, label: resource.relative });
        };
        for (const card of characters) {
            try {
                const avatar = safeId(card.avatar);
                if (!avatar.endsWith('.png')) continue;
                const resource = { id: resourceId('character', avatar), adapter: 'character', avatar, relative: `角色卡 · ${card.name || avatar}` };
                cards.set(avatar, resource.id); add(resource);
            } catch (e) { skipped.push({ path: String(card?.avatar), error: e.message }); }
        }
        for (const world of worlds) {
            try { const name = safeId(typeof world === 'string' ? world : world.file_id); add({ id: resourceId('world', name), adapter: 'world', name, relative: `世界书 · ${name}` }); }
            catch (e) { skipped.push({ path: '世界书列表', error: e.message }); }
        }
        // Character chats come from the native endpoint, not inferred filesystem paths.
        for (const card of characters) {
            if (!cards.has(card.avatar)) continue;
            let files;
            try { files = await this.request('/api/characters/chats', { avatar_url: card.avatar, simple: true }); }
            catch (e) { skipped.push({ path: card.avatar, error: `读取聊天列表失败：${e.message}` }); continue; }
            if (!Array.isArray(files)) { skipped.push({ path: card.avatar, error: '聊天列表格式不兼容' }); continue; }
            for (const file of files) {
                try {
                    const stem = safeId(file.file_id);
                    add({ id: resourceId('chat', card.avatar, stem), adapter: 'chat', avatar: card.avatar, fileName: stem, characterOwner: cards.get(card.avatar), relative: `聊天 · ${card.avatar}/${stem}.jsonl` });
                } catch (e) { skipped.push({ path: card.avatar, error: e.message }); }
            }
        }
        // Group files can be listed through the normal groups endpoint.
        try {
            const groups = await this.request('/api/groups/all');
            if (Array.isArray(groups)) {
                const seen = new Set();
                for (const group of groups) for (const value of group.chats || []) {
                    try { const name = safeId(String(value).replace(/\.jsonl$/i, '')); if (seen.has(name)) continue; seen.add(name); add({ id: resourceId('group-chat', name), adapter: 'chat', group: true, fileName: name, relative: `群聊 · ${name}.jsonl` }); }
                    catch (e) { skipped.push({ path: String(value), error: e.message }); }
                }
            }
        } catch (e) { skipped.push({ path: '群聊', error: `无法读取群聊列表：${e.message}` }); }
        if (resources.length > 10000) throw Error('资源太多，请先缩小酒馆内容范围。');
        this.resources = new Map(resources.map(r => [r.id, r]));
        return { resources, owners, skipped, host: 'st', scopes: BATCH_SCOPES, supportedScopes: ST_SCOPES,
            backupLocation: '此浏览器的 IndexedDB（当前酒馆账号，支持 ZIP 导出）',
            warning: '使用 SillyTavern 自带接口逐份保存，无需安装额外插件。聊天和世界书原有排版可能被规范化；执行期间请关闭其他编辑窗口。' };
    }
    async read(resource) {
        await this.assertTarget(); let value;
        if (resource.adapter === 'character') {
            const result = await this.request('/api/characters/get', { avatar_url: resource.avatar });
            if (typeof result.json_data !== 'string') throw Error('酒馆未提供原始角色卡内容，已跳过这张卡。');
            const original = JSON.parse(result.json_data);
            if (!original?.data || typeof original.data !== 'object') throw Error('角色卡不是可验证的 V2 数据，已跳过。');
            value = { data: original.data };
        } else if (resource.adapter === 'world') {
            value = await this.request('/api/worldinfo/get', { name: resource.name });
        } else if (resource.adapter === 'chat') {
            value = await this.request(resource.group ? '/api/chats/group/get' : '/api/chats/get',
                resource.group ? { id: resource.fileName } : { avatar_url: resource.avatar, file_name: resource.fileName });
            if (!Array.isArray(value)) throw Error('聊天记录读取格式不兼容，已跳过。');
        } else throw Error('此类内容目前不支持免配置批量替换。');
        return value;
    }
    async originalBlob(resource) {
        if (resource.adapter !== 'character') return null;
        const response = await this.fetcher(`/characters/${encodeURIComponent(resource.avatar)}`, { cache: 'no-store' });
        if (!response.ok) throw Error('角色 PNG 原图备份无法读取；禁止修改该卡。');
        const blob = await response.blob();
        if (!blob.size || blob.size > 32 * 1024 * 1024) throw Error('角色 PNG 备份大小无效。');
        const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
        if (signature.length !== 8 || [137,80,78,71,13,10,26,10].some((x,i) => signature[i] !== x)) throw Error('角色原图不是有效 PNG，禁止修改该卡。');
        return blob;
    }
    async write(resource, value, expectedHash) {
        await this.assertTarget();
        if (this.context().isGenerating || this.context().streamingProcessor) throw Error('生成中禁止批量写入。');
        if (await ttHash(await this.read(resource)) !== expectedHash) throw Error(`${resource.relative} 已被其他编辑器修改，停止写入。`);
        if (resource.adapter === 'character') {
            const data = value.data;
            await this.request('/api/characters/merge-attributes', { avatar: resource.avatar, data, ...Object.fromEntries(v1Fields.filter(k => typeof data[k] === 'string').map(k => [k, data[k]])) });
        } else if (resource.adapter === 'world') {
            await this.request('/api/worldinfo/edit', { name: resource.name, data: value });
        } else {
            await this.request(resource.group ? '/api/chats/group/save' : '/api/chats/save',
                resource.group ? { id: resource.fileName, chat: value, force: false } : { avatar_url: resource.avatar, file_name: resource.fileName, chat: value, force: false });
        }
        if (await ttHash(await this.read(resource)) !== await ttHash(value)) throw Error(`${resource.relative} 保存结果不一致；请检查备份。`);
    }
}
