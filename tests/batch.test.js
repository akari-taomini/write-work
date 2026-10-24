import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { deflateSync } from 'node:zlib';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import encode from '../../../../../src/png/encode.js';
import { write as cardWrite } from '../../../../../src/character-card-parser.js';
import { compileRules, findMatches, findMatchesAsync, replaceMatches, validateRules, previewSegments } from '../batch-engine.js';
import { editableFields, setAt } from '../batch-adapters.js';
import { BatchService, decodeDocument, confined } from '../batch-server.js';
import { revealInWorkbench } from '../layout-controls.js';

const rules = [{ find: '顾北辰', replace: '沈辞' }, { find: '顾家', replace: '沈家' }, { find: '辰辰', replace: '辞辞' }];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-batch-test-'));
    t.after(() => { if (path.resolve(root).startsWith(path.join(os.tmpdir(), 'ww-batch-test-'))) fs.rmSync(root, { recursive: true, force: true }); });
    const write = (relative, value) => { const f = path.join(root, relative); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)); };
    const settings = { username: '顾北辰', user_avatar: 'avatar-0.png', power_user: { personas: {}, persona_descriptions: {}, persona_description: '顾北辰当前身份' }, oai_settings: { prompts: [{ identifier: 'p', name: '顾北辰设定', content: '顾家 辰辰', role: 'system' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'p', enabled: true }] }], proxy_password: '顾北辰不可改密码' }, extension_settings: { regex: [{ id: 'r', scriptName: '顾北辰规则', findRegex: '/顾北辰/g', replaceString: '顾家', disabled: false }], third_party: { content: '顾北辰第三方' } } };
    for (let i = 0; i < 7; i++) { settings.power_user.personas[`avatar-${i}.png`] = '顾北辰'; settings.power_user.persona_descriptions[`avatar-${i}.png`] = { description: `顾家身份 ${i}`, title: '辰辰', role: i % 3, lorebook: '顾北辰资源引用' }; }
    write('settings.json', settings);
    write('worlds/书.json', { entries: { 4: { uid: 4, comment: '顾北辰', key: ['顾家'], keysecondary: ['辰辰'], content: '顾北辰与辰辰', disable: true, order: 90, automationId: '顾北辰标识' } }, originalData: { content: '顾北辰归档' } });
    write('chats/角色/分支一.jsonl', '\uFEFF{ "user_name": "顾北辰", "chat_metadata": { "integrity": "顾北辰标识", "persona": "avatar-0.png" } }\r\n{ "name": "顾北辰", "is_user": true, "mes": "顾北辰来自顾家", "send_date": "2026-01-01", "id": 900719925474099312345 }\r\n');
    write('chats/角色/分支二.jsonl', [{ user_name: '顾北辰' }, { name: '角色', is_user: false, mes: '辰辰', swipe_id: 1, swipes: ['顾家', '辰辰'], swipe_info: [{ send_date: 'x' }, { send_date: 'y' }] }].map(v => JSON.stringify(v)).join('\n'));
    write('user/files/指定.txt', '顾北辰 顾家 辰辰');
    write('user/files/指定.json', '{"body":"顾北辰", "keep":"顾北辰", "large":900719925474099312345}');
    write('user/files/指定.yaml', '# 留下这个注释\nbody: 顾北辰\nkeep: 顾北辰\n');
    write('extensions/unknown/data.json', { body: '顾北辰不可改' });
    const read = relative => fs.readFileSync(path.join(root, relative));
    return { root, write, read, settings, service: new BatchService(root) };
}
async function scan(service, extra = {}) {
    const { id } = service.startScan({ rules, scopes: ['persona', 'chats', 'world', 'prompts', 'presets', 'regex'], mode: 'global', ...extra });
    await service.job(id).done; const status = service.status(id); assert.equal(status.status, 'ready', status.error); return id;
}

test('rules are literal, non-cascading, delete text and prefer globally longest overlap', () => {
    let c = compileRules([{ find: 'ab', replace: 'bcd' }, { find: 'bcd', replace: '$&' }]);
    assert.equal(replaceMatches('abcd ab', findMatches('abcd ab', c), c.rules), 'a$& bcd');
    c = compileRules([{ find: 'a.*', replace: '' }, { find: '😀', replace: 'a.*' }]);
    assert.equal(replaceMatches('a.* 😀 A.*', findMatches('a.* 😀 A.*', c), c.rules), ' a.* A.*');
    assert.equal(validateRules([{ find: '甲', replace: '乙' }, { find: '乙', replace: '甲' }]).warnings.some(w => w.includes('循环')), true);
    assert.throws(() => validateRules([{ find: '甲', replace: '乙' }, { find: '甲', replace: '丙' }]), /冲突/);
    assert.throws(() => validateRules([{ find: '', replace: '' }]), /为空/);
});

test('equal-length overlaps follow rule order and a deselected longer match never creates a new match', () => {
    const c = compileRules([{ find: 'bc', replace: '1' }, { find: 'ab', replace: '2' }]);
    const hits = findMatches('abc', c); assert.deepEqual(hits.map(m => m.rule), [0]);
    assert.equal(replaceMatches('abc', [], c.rules), 'abc');
});

test('scan is read-only; all branches and seven same-name personas remain distinct', async t => {
    const f = fixture(t), before = f.read('settings.json'), chat = f.read('chats/角色/分支一.jsonl');
    const id = await scan(f.service), status = f.service.status(id);
    assert.equal(f.service.inventory().owners.filter(o => o.type === 'persona').length, 7);
    assert.equal(status.files.filter(x => x.path.startsWith('chats/')).length, 2);
    assert.deepEqual(f.read('settings.json'), before); assert.deepEqual(f.read('chats/角色/分支一.jsonl'), chat);
    assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
    assert.equal(status.files.some(x => x.path.startsWith('extensions/')), false);
});

test('local persona selection uses avatar identity, preserves other personas and reference fields', async t => {
    const f = fixture(t); const id = await scan(f.service, { scopes: ['persona'], mode: 'local', ownerIds: ['avatar-3.png'] });
    const result = f.service.apply({ id }); assert.equal(result.matches, 3);
    const s = JSON.parse(f.read('settings.json'));
    assert.equal(s.power_user.personas['avatar-3.png'], '沈辞');
    assert.equal(s.power_user.personas['avatar-0.png'], '顾北辰'); assert.equal(s.username, '顾北辰');
    assert.equal(s.power_user.persona_descriptions['avatar-3.png'].lorebook, '顾北辰资源引用');
    assert.equal(s.oai_settings.proxy_password, f.settings.oai_settings.proxy_password);
    assert.equal(s.extension_settings.third_party.content, '顾北辰第三方');
});

test('apply preserves JSONL BOM, CRLF, exact unrelated numeric tokens, IDs and timestamps', async t => {
    const f = fixture(t), before = f.read('chats/角色/分支一.jsonl').toString();
    const id = await scan(f.service, { scopes: ['chats'] }); f.service.apply({ id });
    assert.equal(f.read('chats/角色/分支一.jsonl').toString(), before.replace('"user_name": "顾北辰"', '"user_name": "沈辞"').replace('"name": "顾北辰"', '"name": "沈辞"').replace('"顾北辰来自顾家"', '"沈辞来自沈家"'));
    const rows = f.read('chats/角色/分支二.jsonl').toString().split('\n').map(JSON.parse);
    assert.equal(rows[1].mes, '辞辞'); assert.equal(rows[1].swipes[1], '辞辞'); assert.equal(rows[1].swipes[0], '沈家'); assert.equal(rows[1].name, '角色');
});

test('local card and world choices protect unselected resources containing the same broad phrase', async t => {
    const f = fixture(t);
    for (const name of ['选中角色', '其他角色']) f.write(`characters/${name}.json`, { name, description: '顾家同样出现在这里', character_book: { entries: [{ content: '顾家内嵌设定', keys: ['顾家'] }] } });
    f.write('worlds/其他世界书.json', { entries: { 0: { content: '顾家无关设定' } } });
    const catalog = f.service.catalog();
    const chosen = ['characters/选中角色.json', 'worlds/书.json'];
    const protectedPaths = ['characters/其他角色.json', 'worlds/其他世界书.json', 'settings.json', 'chats/角色/分支一.jsonl'];
    const originals = new Map(protectedPaths.map(relative => [relative, f.read(relative)]));
    const ids = catalog.resources.filter(resource => chosen.includes(resource.relative)).map(resource => resource.id);
    assert.equal(ids.length, 2);
    const id = await scan(f.service, { rules: [{ find: '顾家', replace: '沈家' }], scopes: ['character', 'world'], mode: 'local', fileIds: ids, ownerIds: ids });
    assert.deepEqual(f.service.status(id).files.map(file => file.path).sort(), chosen.sort());
    f.service.apply({ id });
    for (const [relative, bytes] of originals) assert.deepEqual(f.read(relative), bytes, relative);
    assert.match(f.read('characters/选中角色.json').toString(), /沈家内嵌设定/);
    assert.match(f.read('worlds/书.json').toString(), /沈家/);
});

test('file and individual-match exclusions write exactly the previewed subset', async t => {
    const f = fixture(t), id = await scan(f.service), files = f.service.status(id).files;
    const target = files.find(x => x.path === 'worlds/书.json'), rows = f.service.preview(id, target.id).rows;
    const excluded = rows.find(x => x.field.endsWith('content') && x.rule === 0);
    const original = JSON.parse(f.read('worlds/书.json'));
    const result = f.service.apply({ id, excludedFiles: files.filter(x => x.id !== target.id).map(x => x.id), excludedMatches: [excluded.id] });
    assert.equal(result.matches, rows.length - 1); assert.equal(result.files, 1);
    const updated = JSON.parse(f.read('worlds/书.json')); original.entries[4].comment = '沈辞'; original.entries[4].key = ['沈家']; original.entries[4].keysecondary = ['辞辞']; original.entries[4].content = '顾北辰与辞辞';
    assert.deepEqual(updated, original); assert.equal(JSON.parse(f.read('settings.json')).username, '顾北辰');
    assert.throws(() => f.service.apply({ id }), /已执行/);
});

test('post-scan modification blocks the whole apply before any backup or write', async t => {
    const f = fixture(t), id = await scan(f.service), original = f.read('settings.json');
    f.write('worlds/书.json', { entries: { 4: { content: '其他程序新改动' } } });
    assert.throws(() => f.service.apply({ id }), /已发生变化/);
    assert.deepEqual(f.read('settings.json'), original); assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
});

test('backup failure blocks every source write', async t => {
    const f = fixture(t), id = await scan(f.service), original = f.read('settings.json'), atomic = f.service.atomic.bind(f.service);
    f.service.atomic = (file, bytes) => { if (file.endsWith('.bin')) throw Error('模拟磁盘已满'); return atomic(file, bytes); };
    assert.throws(() => f.service.apply({ id }), /磁盘已满/); assert.deepEqual(f.read('settings.json'), original);
});

test('failure after the first committed file restores prior commits and records interruption', async t => {
    const f = fixture(t), originals = new Map(f.service.catalog().resources.map(r => [r.relative, f.read(r.relative)]));
    let commits = 0, triggered = false;
    f.service.beforeRename = file => { if (!file.includes(`${path.sep}backups${path.sep}`) && ++commits === 2 && !triggered) { triggered = true; throw Error('模拟文件锁定'); } };
    const id = await scan(f.service); assert.throws(() => f.service.apply({ id }), /文件锁定/);
    for (const [relative, bytes] of originals) assert.deepEqual(f.read(relative), bytes, relative);
    assert.equal(f.service.backups()[0].status, 'aborted');
});

test('rollback conflicts preserve current files and restore only explicitly allowed remainder', async t => {
    const f = fixture(t), original = f.read('settings.json'), id = await scan(f.service), result = f.service.apply({ id });
    const changed = f.read('settings.json'), newWorld = '{"entries":{"4":{"content":"执行后新编辑"}}}'; f.write('worlds/书.json', newWorld);
    const blocked = f.service.restore({ id: result.id }); assert.equal(blocked.needsConfirmation, true); assert.deepEqual(f.read('settings.json'), changed);
    assert.deepEqual(blocked.conflicts, ['worlds/书.json']);
    const restored = f.service.restore({ id: result.id, preserveConflicts: true }); assert.ok(restored.restored > 0);
    assert.deepEqual(f.read('settings.json'), original); assert.equal(f.read('worlds/书.json').toString(), newWorld);
});

test('damaged backup prevents rollback before touching any current file', async t => {
    const f = fixture(t), id = await scan(f.service), result = f.service.apply({ id }), manifest = f.service.manifest(result.id), current = f.read('settings.json');
    f.write(`backups/writer-workbench/${result.id}/${manifest.files[0].backup}`, '损坏');
    assert.throws(() => f.service.restore({ id: result.id }), /校验失败/); assert.deepEqual(f.read('settings.json'), current);
});

test('explicit custom JSON/YAML fields preserve unselected strings, large integers and comments', async t => {
    const f = fixture(t), custom = f.service.catalog().resources.filter(r => ['custom-json', 'text'].includes(r.adapter));
    const paths = Object.fromEntries(custom.filter(r => r.adapter === 'custom-json').map(r => [r.id, [['body']]]));
    const id = await scan(f.service, { scopes: ['other'], fileIds: custom.map(r => r.id), customPaths: paths }); f.service.apply({ id });
    assert.equal(f.read('user/files/指定.json').toString(), '{"body":"沈辞", "keep":"顾北辰", "large":900719925474099312345}');
    assert.match(f.read('user/files/指定.yaml').toString(), /^# 留下这个注释\nbody: 沈辞\nkeep: 顾北辰\n$/);
    assert.equal(f.read('user/files/指定.txt').toString(), '沈辞 沈家 辞辞');
});

test('PNG keeps both card versions, metadata and image chunks while changing only selected fields', t => {
    const f = fixture(t), header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
    const image = Buffer.from(encode([{ name: 'IHDR', data: header }, { name: 'IDAT', data: deflateSync(Buffer.from([0, 255, 255, 255, 255])) }, { name: 'IEND', data: Buffer.alloc(0) }]));
    const data = { spec: 'chara_card_v2', spec_version: '2.0', name: '角色', description: '顾北辰', first_mes: '辰辰', data: { name: '角色', description: '顾北辰', first_mes: '辰辰', alternate_greetings: ['顾家'], extensions: { unknown: '顾北辰不修改' } } };
    const chunks = extract(cardWrite(image, JSON.stringify(data))); chunks.splice(-1, 0, PNGtext.encode('unrelated', 'keep')); const bytes = Buffer.from(encode(chunks));
    const resource = { id: 'card', adapter: 'character', format: 'png', label: 'test' }, document = decodeDocument(bytes, resource), next = structuredClone(document.value);
    next.data.description = '沈辞'; next.description = '沈辞'; const after = document.encode(next), decoded = decodeDocument(after, resource);
    assert.equal(decoded.value.data.description, '沈辞'); assert.equal(decoded.value.data.first_mes, '辰辰'); assert.equal(decoded.value.data.extensions.unknown, '顾北辰不修改');
    const unchanged = list => list.filter(c => c.name !== 'tEXt').map(c => [c.name, sha(c.data)]);
    assert.deepEqual(unchanged(extract(after)), unchanged(extract(bytes)));
    const meta = extract(after).filter(c => c.name === 'tEXt').map(c => PNGtext.decode(c.data));
    assert.equal(meta.find(m => m.keyword === 'unrelated').text, 'keep');
    assert.equal(JSON.parse(Buffer.from(meta.find(m => m.keyword === 'chara').text, 'base64')).spec, 'chara_card_v2');
    assert.equal(JSON.parse(Buffer.from(meta.find(m => m.keyword === 'ccv3').text, 'base64')).spec, 'chara_card_v3');
    const mixed = extract(bytes), legacy = mixed.findIndex(c => c.name === 'tEXt' && PNGtext.decode(c.data).keyword === 'chara');
    mixed[legacy] = PNGtext.encode('chara', Buffer.from(JSON.stringify({ name: '角色', description: '顾北辰', first_mes: '辰辰', custom: '顾北辰保留' })).toString('base64'));
    const oldDocument = decodeDocument(Buffer.from(encode(mixed)), resource), updated = structuredClone(oldDocument.value); updated.data.description = '沈辞'; updated.description = '沈辞';
    const oldMeta = extract(oldDocument.encode(updated)).filter(c => c.name === 'tEXt').map(c => PNGtext.decode(c.data)).find(m => m.keyword === 'chara');
    assert.deepEqual(JSON.parse(Buffer.from(oldMeta.text, 'base64')), { name: '角色', description: '沈辞', first_mes: '辰辰', custom: '顾北辰保留' });
});

test('traversal, absolute paths, links and unknown resources cannot authorize writes', t => {
    const f = fixture(t);
    for (const relative of ['../settings.json', 'worlds/../../settings.json', 'C:/secrets', '/etc/passwd', 'worlds\\书.json']) assert.throws(() => confined(f.root, relative), /路径无效/);
    const outside = path.join(f.root, 'extensions'); fs.symlinkSync(outside, path.join(f.root, 'worlds', 'junction'), 'junction');
    assert.throws(() => confined(f.root, 'worlds/junction/unknown/data.json'), /链接/);
    assert.throws(() => setAt({}, ['__proto__', 'x'], 'bad'), /路径/); assert.equal({}.x, undefined);
    const duplicate = Buffer.from('{"content":"a","content":"b"}'); assert.throws(() => decodeDocument(duplicate, { format: 'json' }), /重复键/);
});

test('cancelled scan cannot execute and leaves no backups', async t => {
    const f = fixture(t), { id } = f.service.startScan({ rules, scopes: ['chats'], mode: 'global' }); f.service.job(id).cancelled = true;
    await f.service.job(id).done; assert.equal(f.service.status(id).status, 'cancelled'); assert.throws(() => f.service.apply({ id }), /尚未完成/);
    assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
});

test('preview reflects all selected changes in its context and updates when a neighboring hit is excluded', () => {
    const compiled = compileRules(rules), text = '顾北辰来自顾家，昵称辰辰';
    const matches = findMatches(text, compiled).map((m, i) => ({ ...m, id: String(i) })), context = { text, matches };
    let preview = previewSegments(context, '0', rules);
    assert.equal(preview.afterPrefix + preview.after + preview.afterSuffix, '沈辞来自沈家，昵称辞辞');
    preview = previewSegments(context, '0', rules, new Set(['1']));
    assert.equal(preview.afterPrefix + preview.after + preview.afterSuffix, '沈辞来自顾家，昵称辞辞');
});

test('large chat scans and writes without changing message count or unselected payload', async t => {
    const f = fixture(t), padding = 'x'.repeat(13 * 1024 * 1024), raw = `{"user_name":"顾北辰"}\n{"name":"角色","is_user":false,"mes":"${padding}顾北辰","send_date":"original"}\n`;
    f.write('chats/角色/大聊天.jsonl', raw); const id = await scan(f.service, { scopes: ['chats'] });
    assert.equal(f.service.status(id).skipped.some(s => s.path.includes('大聊天')), false);
    f.service.apply({ id }); assert.equal(sha(f.read('chats/角色/大聊天.jsonl')), sha(raw.replaceAll('顾北辰', '沈辞')));
});

test('revealing designer scrolls only the internal pane, never the host document', () => {
    const dialog = {}, outer = { parentElement: dialog }, pane = { parentElement: outer, scrollHeight: 2000, clientHeight: 500, clientTop: 1, scrollTop: 100, getBoundingClientRect: () => ({ top: 50, bottom: 550 }), scrollTo(options) { this.result = options; } };
    const target = { parentElement: pane, getBoundingClientRect: () => ({ top: 900, bottom: 1400, height: 500 }) };
    globalThis.window = { getComputedStyle: el => ({ overflowY: el === pane ? 'auto' : 'visible' }) };
    revealInWorkbench({ dialog }, target); assert.deepEqual(pane.result, { top: 949, behavior: 'auto' });
    delete globalThis.window;
});

test('cancellation interrupts a long matching field before it finishes', async () => {
    let yields = 0;
    await assert.rejects(findMatchesAsync('x'.repeat(2000000), compileRules(rules), { yieldControl: async () => { yields++; }, cancelled: () => yields >= 2 }), /取消/);
    assert.equal(yields, 2);
});

test('replacement expansion and invalid resulting regex are refused before any source write', async t => {
    const f = fixture(t), original = f.read('settings.json');
    let id = await scan(f.service, { scopes: ['regex'], rules: [{ find: '顾北辰', replace: '[' }] });
    assert.throws(() => f.service.apply({ id }), /表达式.*无效/); assert.deepEqual(f.read('settings.json'), original);
    f.write('user/files/膨胀.txt', 'x'.repeat(1000));
    const resource = f.service.catalog().resources.find(r => r.relative.endsWith('膨胀.txt'));
    id = await scan(f.service, { scopes: ['other'], rules: [{ find: 'x', replace: 'y'.repeat(50000) }], fileIds: [resource.id] });
    assert.throws(() => f.service.apply({ id }), /预算过大/); assert.equal(f.read('user/files/膨胀.txt').length, 1000);
});

test('a fresh service recovers an interrupted transaction from disk without old scan state', async t => {
    const f = fixture(t), before = f.read('settings.json'), id = await scan(f.service), result = f.service.apply({ id });
    const manifest = f.service.manifest(result.id); manifest.status = 'committing'; manifest.files.forEach(r => { r.state = 'committing'; }); f.service.writeManifest(manifest);
    const restarted = new BatchService(f.root), recovered = restarted.restore({ id: result.id });
    assert.equal(recovered.conflicts.length, 0); assert.deepEqual(f.read('settings.json'), before); assert.equal(restarted.backups()[0].status, 'restored');
});

test('server-side result filtering finds unloaded content and preserves global counts', async t => {
    const f = fixture(t), id = await scan(f.service), original = f.service.status(id);
    const filtered = f.service.status(id, { query: 'avatar-3.png', scope: 'persona', rule: '0' });
    assert.equal(filtered.matches, original.matches); assert.equal(filtered.files.filter(r => r.visible).length, 1);
    const file = filtered.files.find(r => r.visible), preview = f.service.preview(id, file.id, 0, { query: 'avatar-3.png', scope: 'persona', rule: '0' });
    assert.equal(preview.total, 1); assert.equal(preview.rows[0].owner, 'avatar-3.png');
});
