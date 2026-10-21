import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApocryphaStore, PAGE_BYTES } from '../src/storage.js';
import { TranscriptStore } from '../src/transcripts.js';
import { BackgroundCompactor, modelFromEnvironment } from '../src/compactor.js';
import { wakeView, completeWakeView } from '../src/wake-view.js';
import { createApocryphaMcpServer } from '../src/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apx-compact-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {store:new ApocryphaStore(dir),ts:new TranscriptStore(dir)};
}
test('fake model drains blocks, refreshes view, and automatically rebuilds forgotten summaries',async t=>{
 const {store,ts}=fixture(t);
 for(let i=0;i<32;i++)ts.append({vendor:'claude',user:'Question '+i,assistant:'Reply'});
 let mirrors=0;
 const c=new BackgroundCompactor(store,{model:async()=>'claude: questions and replies',transcripts:ts,onChange:async()=>{mirrors++},logger:()=>{}});
 assert.match(wakeView(store,{},c),/31 pending blocks/);
 assert.match(wakeView(store,{},c),/t32 claude:/);
 while(await c.step()){}
 assert.equal(store.pendingCount(),0);assert.equal(mirrors,31);assert.ok(c.status().lastSuccess);
 const log=fs.readFileSync(store.logFile);
 store.forget('0-15');while(await c.step()){}
 assert.equal(store.pendingCount(),0);assert.deepEqual(fs.readFileSync(store.logFile),log);
 assert.equal(c.status().lastError,null);
});
test('invalid model results never save, backoff and recovery are observable',async t=>{
 for(const value of ['two\nlines','','😀'.repeat(71),'two\rwords']){
  const {store}=fixture(t);store.append('first');store.append('second');
  let now=1000,calls=0,answer=value;
  const c=new BackgroundCompactor(store,{model:async()=>{calls++;return answer;},now:()=>now,logger:()=>{}});
  assert.equal(await c.step(),false);assert.equal(store.pendingCount(),1);
  assert.ok(c.status().lastError);assert.throws(()=>wakeView(store,{},c),/Cannot wake/);
  await c.step();assert.equal(calls,1);
  now=2000;answer='valid one line';await c.step();assert.equal(store.pendingCount(),0);
  assert.equal(c.status().lastError,null);
 }
});
test('configured wake via MCP offers no sleep tasks, unconfigured retains original behavior',async t=>{
 const {store}=fixture(t);store.append('one');store.append('two');
 const c=new BackgroundCompactor(store,{model:async()=>'pair',logger:()=>{}});
 const server=createApocryphaMcpServer(store,{compactor:c,drive:{config:{}}});
 const client=new Client({name:'compactor-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();});
 const wake=await client.callTool({name:'apocrypha_wake',arguments:{}});
 assert.notEqual(wake.isError,true);assert.match(wake.content[0].text,/1 pending blocks/);
 assert.doesNotMatch(wake.content[0].text,/apocrypha_sleep/);
 assert.throws(()=>wakeView(store),/Cannot wake/);
 assert.equal(new BackgroundCompactor(store).status().configured,false);
});
test('pending cover is lossless, paged and shows newest leaves raw',t=>{
 const {store}=fixture(t);for(let i=0;i<150;i++)store.append('t'+(i+1)+' chatgpt: '+'😀'.repeat(60));
 const c=new BackgroundCompactor(store,{model:async()=>'chatgpt: topic'});
 const pages=[];
 for(let part=1;;part++){const p=wakeView(store,{part,snapshot:150},c);pages.push(p);assert.ok(Buffer.byteLength(p)<PAGE_BYTES+1000);if(p.endsWith('You are awake.'))break;}
 assert.equal(pages.join('\n').split('\n').filter(l=>/^#\d+ /.test(l)).length,150);
 assert.equal(completeWakeView(store,c),pages.join('\n\n'));
 assert.match(pages.at(-1),/t150 chatgpt:/);
});
test('configured reconciler summarizes historic turns before appending dated leaves',async t=>{
 const {store,ts}=fixture(t);const original=ts.reconcileUnlocked;ts.reconcileUnlocked=()=>{};
 ts.append({vendor:'claude',user:'A historical topic',assistant:'A historical answer'});
 ts.reconcileUnlocked=original;
 let source;
 const c=new BackgroundCompactor(store,{transcripts:ts,model:async text=>{source=text;return 'claude: historical topic and answer';},logger:()=>{}});
 assert.equal((await c.reconcile()).added,1);assert.match(source,/A historical answer/);
 assert.match(store.get(0),/t1 claude \d{4}-\d{2}-\d{2}: claude: historical topic/);
 assert.equal((await c.reconcile()).added,0);
});
test('provider adapter uses configured endpoint and rejects incomplete/error responses without leaking bodies',async()=>{
 const env={APOCRYPHA_COMPACTOR_PROVIDER:'anthropic',APOCRYPHA_COMPACTOR_MODEL:'synthetic-model',APOCRYPHA_COMPACTOR_API_KEY:'test-key'};
 let request;
 const model=modelFromEnvironment(env,async(url,options)=>{request={url,options};return new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:'topic'}]}));});
 assert.equal(await model('source'),'topic');assert.equal(request.options.headers['x-api-key'],'test-key');
 assert.equal(JSON.parse(request.options.body).model,'synthetic-model');
 await assert.rejects(modelFromEnvironment(env,async()=>new Response('private',{status:429}))('source'),/HTTP 429/);
 assert.equal(modelFromEnvironment({}),null);
 assert.throws(()=>modelFromEnvironment({APOCRYPHA_COMPACTOR_PROVIDER:'anthropic'}),/Incomplete/);
});
test('network waits never hold writer lock and stale results cannot overwrite a different task',async t=>{
 const {store}=fixture(t);store.append('one');store.append('two');store.append('three');store.append('four');
 let release;const pending=new Promise(r=>release=r);
 const c=new BackgroundCompactor(store,{model:()=>pending,logger:()=>{}});
 const running=c.step();await new Promise(r=>setImmediate(r));
 store.sleep('0-1','manually settled');store.append('five');
 release('obsolete result');await running;
 assert.equal(store.readBlock(0,2),'manually settled');assert.equal(store.blockCount(2),1);
});

test('explicit in-band mode pauses configured model and restores sleep tasks',async t=>{
 const {store}=fixture(t);store.append('one');store.append('two');
 let calls=0;const c=new BackgroundCompactor(store,{mode:'in-band',model:async()=>{calls++;return 'summary';}});
 c.start();assert.equal(await c.step(),false);assert.equal(calls,0);
 assert.equal(c.status().mode,'in-band');assert.throws(()=>wakeView(store,{},c),/apocrypha_sleep/);
 store.sleep('0-1','manual pair');assert.match(wakeView(store,{},c),/You are awake/);c.stop();
});
test('paging detects a changed pending cover instead of silently skipping messages',t=>{
 const {store}=fixture(t);for(let i=0;i<150;i++)store.append('x'.repeat(270));
 const c=new BackgroundCompactor(store,{model:async()=>'summary'});
 const first=wakeView(store,{},c);
 const args=JSON.parse(first.match(/Next command: apocrypha_wake\((.*)\)$/)[1]);
 while(store.pendingCount()){const[a,b]=store.pending(undefined,1)[0];store.sleep(a+'-'+(b-1),'summary');}
 assert.throws(()=>wakeView(store,args,c),/Wake view changed/);
});
test('backfill progress survives a later model failure without repeated completed calls',async t=>{
 const {store,ts}=fixture(t);const original=ts.reconcileUnlocked;ts.reconcileUnlocked=()=>{};
 for(let i=0;i<3;i++)ts.append({vendor:'chatgpt',user:'history '+i,assistant:'answer'});
 ts.reconcileUnlocked=original;let calls=0;
 const c=new BackgroundCompactor(store,{transcripts:ts,model:async()=>{calls++;if(calls===2)throw new Error('retry');return 'chatgpt: history';},logger:()=>{}});
 await assert.rejects(c.reconcile(),/retry/);assert.equal(store.count(),1);
 assert.equal((await c.reconcile()).added,2);assert.equal(calls,4);assert.equal(store.count(),3);
});
