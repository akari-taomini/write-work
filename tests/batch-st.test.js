import test from 'node:test';
import assert from 'node:assert/strict';
import { StBatchService, ST_SCOPES } from '../src/batch/batch-st.js';
import { batchHost } from '../src/batch/batch-runtime.js';

function setup({ failWorld = false } = {}) {
    const records = new Map(), blobs = new Map();
    const key = ({namespace, table = '', key}) => `${namespace}:${table}:${key}`;
    const store = {
        async open() {},
        async tryGetJson(arg) { const k = key(arg); return {found:records.has(k),value:records.get(k)}; },
        async getJson(arg) { const k = key(arg); if (!records.has(k)) throw Error('missing backup'); return structuredClone(records.get(k)); },
        async setJson(arg) { records.set(key(arg), structuredClone(arg.value)); },
        async listKeys({namespace,table=''}) { const prefix=`${namespace}:${table}:`; return [...records.keys()].filter(k=>k.startsWith(prefix)).map(k=>k.slice(prefix.length)); },
        async getBlob(arg) { const data=blobs.get(key(arg)); if(!data) throw Error('missing blob'); return data; },
        async setBlob(arg) { blobs.set(key(arg),arg.data); },
    };
    const data={
        avatar:'A.png',
        character:{data:{description:'旧名字',personality:'友好',scenario:'场景',first_mes:'你好',mes_example:'',alternate_greetings:[],extensions:{}}},
        book:{entries:{0:{uid:0,comment:'旧名字',content:'这里也是旧名字',key:['旧名字'],keysecondary:[]}}},
        chat:[{user_name:'USER'}, {name:'角色',is_user:false,mes:'旧名字',swipes:[]}],
    };
    const host={ location:{origin:'http://localhost:8000'}, navigator:{} };
    const context=()=>({accountStorage:{getItem:()=> 'account-a'},getRequestHeaders:()=>({'Content-Type':'application/json'}),isGenerating:false});
    const fetcher=async (url,opts)=>{
        if (url === '/characters/A.png') return new Response(new Blob([new Uint8Array([137,80,78,71,13,10,26,10,0])], {type:'image/png'}),{status:200});
        const arg=JSON.parse(opts.body||'{}');
        let out;
        switch(url){
            case '/api/characters/all': out=[{avatar:'A.png',name:'A'}]; break;
            case '/api/characters/chats': out=[{file_id:'第一章',file_name:'第一章.jsonl'}]; break;
            case '/api/characters/get': out={json_data:JSON.stringify(data.character)}; break;
            case '/api/characters/merge-attributes': data.character={data:arg.data}; out='OK'; break;
            case '/api/worldinfo/list': out=[{file_id:'测试书'}]; break;
            case '/api/worldinfo/get': out=data.book; break;
            case '/api/worldinfo/edit': if(failWorld) throw Error('simulated failure'); data.book=arg.data; out='OK'; break;
            case '/api/chats/get': out=data.chat; break;
            case '/api/chats/save': data.chat=arg.chat; out={ok:true}; break;
            case '/api/groups/all': out=[]; break;
            default: throw Error('unexpected '+url);
        }
        return new Response(typeof out==='string'?out:JSON.stringify(out),{status:200});
    };
    const service=new StBatchService({context,host,fetcher,storeFactory:()=>store});
    return {service,data,records,store,host};
}

test('stock SillyTavern is a browser host and requires no Node server plugin', async()=>{
    assert.equal(batchHost({}), 'st');
    assert.ok(!ST_SCOPES.includes('persona'));
    const {service}=setup();await service.init();
    const inventory=await service.inventory();
    assert.equal(inventory.resources.length,3);
    assert.deepEqual(inventory.supportedScopes,ST_SCOPES);
    assert.equal(inventory.owners.length,3);
});

test('browser adapter scans, previews, securely backs up, modifies and restores',async()=>{
    const {service,data}=setup();await service.init();
    const job=await service.scan({rules:[{find:'旧名字',replace:'新名字'}],mode:'global',scopes:ST_SCOPES});
    await service.job(job.id).done;
    const summary=service.status(job.id);
    assert.equal(summary.status,'ready');
    assert.equal(summary.matches,5);
    assert.ok(service.preview(job.id,summary.files[0].id).rows.length);
    const done=await service.apply({id:job.id});
    assert.equal(done.files,3);
    assert.equal(data.character.data.description,'新名字');
    assert.equal(data.book.entries[0].content,'这里也是新名字');
    assert.equal(data.chat[1].mes,'新名字');
    const backups=await service.backups();assert.equal(backups[0].status,'complete');
    const zip=await service.download(done.id); assert.ok(zip.size>100);
    const restored=await service.restore({id:done.id});assert.equal(restored.restored,3);
    assert.equal(data.character.data.description,'旧名字');
    assert.equal(data.chat[1].mes,'旧名字');
});

test('browser adapter disables unknown scopes and stops after conflicting changes',async()=>{
    const {service,data}=setup();await service.init();
    await assert.rejects(service.scan({rules:[{find:'旧名字',replace:'新名字'}],mode:'global',scopes:['other']}),/TT 已支持/);
    const job=await service.scan({rules:[{find:'旧名字',replace:'新名字'}],mode:'global',scopes:['world']});
    await service.job(job.id).done;
    data.book.entries[0].content='外部更新';
    await assert.rejects(service.apply({id:job.id}),/扫描后有新变化/);
    assert.equal(data.book.entries[0].content,'外部更新');
});
