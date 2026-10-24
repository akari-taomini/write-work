import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import yauzl from 'yauzl';
import { installBatchRoutes } from '../src/batch/batch-server.js';

test('local API enforces user-scoped scan tokens and exports a complete verified ZIP', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-route-test-'));
    for (const user of ['a', 'b']) {
        const dir = path.join(root, user); fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ power_user: { personas: { 'avatar.png': '顾北辰' }, persona_descriptions: { 'avatar.png': { description: '顾家' } } }, oai_settings: { prompts: [] }, extension_settings: { regex: [] } }));
    }
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { const user = req.get('x-fixture-user'); if (['a', 'b'].includes(user)) req.user = { profile: { handle: user }, directories: { root: path.join(root, user) } }; next(); });
    const router = express.Router(); installBatchRoutes(router); app.use('/batch', router);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); if (path.resolve(root).startsWith(path.join(os.tmpdir(), 'ww-route-test-'))) fs.rmSync(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}/batch`;
    const post = (route, body = {}, user = 'a') => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-user': user }, body: JSON.stringify(body) });
    assert.equal((await post('/inventory', {}, 'unauthenticated')).status, 400);
    const started = await (await post('/scan', { rules: [{ find: '顾北辰', replace: '沈辞' }], scopes: ['persona'], mode: 'global', root: 'C:/Windows' })).json();
    let status;
    do { status = await (await post('/status', { id: started.id })).json(); if (status.status === 'scanning') await new Promise(r => setTimeout(r, 5)); } while (status.status === 'scanning');
    assert.equal(status.matches, 1);
    assert.equal((await post('/status', { id: started.id }, 'b')).status, 400);
    assert.equal((await post('/apply', { id: started.id }, 'b')).status, 400);
    const applied = await (await post('/apply', { id: started.id })).json(); assert.equal(applied.matches, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'b/settings.json'))).power_user.personas['avatar.png'], '顾北辰');
    const response = await post('/download', { id: applied.id }); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const entries = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error); const files = new Map();
        zip.on('error', reject); zip.on('end', () => resolve(files));
        zip.on('entry', entry => zip.openReadStream(entry, (err, stream) => {
            if (err) return reject(err); const chunks = []; stream.on('error', reject); stream.on('data', c => chunks.push(c)); stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        })); zip.readEntry();
    }));
    const manifest = JSON.parse(entries.get('manifest.json')); assert.equal(manifest.files.length, 1); assert.ok(entries.has('0.bin'));
    assert.equal(JSON.parse(entries.get('0.bin')).power_user.personas['avatar.png'], '顾北辰');
    const restored = await (await post('/restore', { id: applied.id })).json(); assert.equal(restored.restored, 1);
});
