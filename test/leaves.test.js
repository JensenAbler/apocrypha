
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApocryphaStore, turnLeafText } from '../src/storage.js';
import { TranscriptStore } from '../src/transcripts.js';
import { zoom } from '../src/read.js';
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apx-leaves-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {store:new ApocryphaStore(dir),ts:new TranscriptStore(dir)};
}
const input={vendor:'chatgpt',user:'  User\nquestion 😀 ',assistant:'Full answer'};
test('turn appends exactly one leaf, summary and fallback, UTF8 truncation', t=>{
 const {store,ts}=fixture(t);
 const a=ts.append({...input,summary:'Assistant describes topic',requestId:'leaves-first-key'});
 ts.append({...input,summary:'Assistant describes topic',requestId:'leaves-first-key'});
 assert.equal(store.count(),1);
 assert.match(store.get(0),/t1 chatgpt: Assistant describes topic$/);
 ts.append({...input,summary:''});
 assert.match(store.get(1),/t2 chatgpt: User question 😀$/);
 const long=turnLeafText({...a,user:'😀'.repeat(300),summary:''});
 assert.ok(Buffer.byteLength(long)<=280);assert.ok(long.endsWith('…'));
 assert.equal(long.includes('�'),false);
 assert.equal(ts.get(a.id).user,input.user);
 assert.throws(()=>ts.append({...input,summary:'Changed',requestId:'leaves-first-key'}),/different turn/);
});
test('crash repair, repeated reconciliation, backfill dates and writer lock',t=>{
 const {store,ts}=fixture(t);
 // Simulate old-version transcript-only writes / crash after transcript fsync.
 const original=ts.reconcileUnlocked;ts.reconcileUnlocked=()=>{};
 for(let i=0;i<5;i++)ts.append(input);
 ts.reconcileUnlocked=original;
 assert.equal(store.count(),0);
 assert.deepEqual(ts.reconcile({dryRun:true}),{added:5,dryRun:true});
 assert.equal(store.count(),0);
 assert.equal(ts.reconcile().added,5);assert.equal(ts.reconcile().added,0);
 for(const line of store.entries())assert.match(line,/t\d+ chatgpt \d{4}-\d{2}-\d{2}: User question/);
 ts.locked(()=>assert.throws(()=>ts.reconcile(),/writer is busy/));
});
test('root zoom reaches every leaf and full linked transcript; recent wake raw',t=>{
 const {store,ts}=fixture(t);
 const first=ts.append(input);
 const url='https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
 ts.resolve({token:first.conv,url,candidates:[{url,snippet:'⟦mint '+first.conv+'⟧'}]});
 for(let i=1;i<32;i++)ts.append(input);
 while(store.pendingCount()){const[a,b]=store.pending(undefined,1)[0];store.sleep(a+'-'+(b-1),'chatgpt: questions and answers');}
 const leaves=[];
 function walk(range){for(const line of zoom(store,ts,{range}).split('\n').slice(1)){const m=/^#(\d+-\d+) /.exec(line);if(m)walk(m[1]);else leaves.push(line);}}
 walk('0-31');assert.equal(leaves.length,32);
 const full=zoom(store,ts,{id:'#0'});
 assert.ok(full.includes(input.user));assert.ok(full.includes(input.assistant));assert.ok(full.includes(url));
 assert.match(store.wake(),/t32 chatgpt: User question 😀/);
});
