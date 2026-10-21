
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ApocryphaStore,turnLeafText} from '../src/storage.js';
import {TranscriptStore} from '../src/transcripts.js';
import {BackgroundCompactor} from '../src/compactor.js';
import {completeWakeView} from '../src/wake-view.js';
import {zoom} from '../src/read.js';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apx-turn-summary-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {dir,store:new ApocryphaStore(dir),ts:new TranscriptStore(dir)};
}
test('fresh omitted summaries and legacy excerpts become full-exchange leaves; restart, tree rebuild and zoom preserve sources',async t=>{
 const {dir,store,ts}=fixture(t);
 const original=ts.reconcileUnlocked;ts.reconcileUnlocked=()=>{};
 const old=ts.append({vendor:'claude',user:'Can you fix it?',assistant:'Fixed the broken mirror.'});
 ts.reconcileUnlocked=original;
 store.append(turnLeafText(old,{legacyFallback:true}));
 ts.append({vendor:'chatgpt',user:'Check the work.',assistant:'All checks passed.'});
 store.sleep('0-1','Old excerpt-based tree');
 const log=fs.readFileSync(store.logFile),transcript=fs.readFileSync(ts.turnFile);
 let calls=0;
 const c=new BackgroundCompactor(store,{transcripts:ts,logger:()=>{},model:async source=>{
   calls++;if(source.includes('Recorded turn t1')){assert.match(source,/Fixed the broken mirror/);return 'User requested repair; claude fixed the mirror.';}
   if(source.includes('Recorded turn t2')){assert.match(source,/All checks passed/);return 'User requested verification; chatgpt reported all checks passed.';}
   assert.match(source,/claude fixed the mirror/);assert.match(source,/chatgpt reported all checks passed/);return 'claude repaired the mirror; chatgpt verified it.';
 }});
 assert.equal(c.status().pendingTurnSummaries,2);
 assert.match(completeWakeView(store,c),/excerpts are temporary/);
 await c.step();
 assert.equal(store.pendingCount(),1);
 assert.match(store.get(0),/claude fixed the mirror/);
 assert.equal(new ApocryphaStore(dir).pendingTurnSummaries(ts).length,1);
 while(await c.step()){}
 assert.equal(calls,3);assert.equal(c.status().pendingTurnSummaries,0);
 assert.doesNotMatch(completeWakeView(store,c),/User said:|excerpts are temporary/);
 assert.deepEqual(fs.readFileSync(store.logFile),log);assert.deepEqual(fs.readFileSync(ts.turnFile),transcript);
 assert.match(zoom(store,ts,{id:'#0'}),/t1 user:\nCan you fix it\?/);
 assert.match(zoom(store,ts,{id:'#0'}),/t1 assistant:\nFixed the broken mirror/);
 assert.equal(await c.step(),false);assert.equal(calls,3);
});
test('invalid turn summaries remain pending and retry; writer lock is free during inference',async t=>{
 const {store,ts}=fixture(t);
 ts.append({vendor:'claude',user:'Question',assistant:'Answer'});
 let now=1000,output='bad\nsummary';
 const c=new BackgroundCompactor(store,{transcripts:ts,logger:()=>{},now:()=>now,model:async()=>{
   ts.locked(()=>{});return output;
 }});
 await c.step();assert.equal(c.status().pendingTurnSummaries,1);assert.equal(store.turnSummaries().t1,undefined);
 now=2000;output='claude answered the user question';await c.step();
 assert.equal(c.status().pendingTurnSummaries,0);assert.equal(c.status().lastError,null);
 assert.equal(store.saveTurnSummary(ts.get('t1'),'duplicate'),false);
});
test('provided and historical model summaries are preserved and excluded from repair',t=>{
 const {store,ts}=fixture(t);
 ts.append({vendor:'chatgpt',user:'Question',assistant:'Answer',summary:'User asked; chatgpt answered.'});
 const original=ts.reconcileUnlocked;ts.reconcileUnlocked=()=>{};
 const turn=ts.append({vendor:'claude',user:'Other question',assistant:'Other answer'});
 ts.reconcileUnlocked=original;
 store.append(turnLeafText(turn,{backfill:true,summary:'User asked another question; claude answered.'}));
 assert.equal(store.pendingTurnSummaries(ts).length,0);
});

test('interrupted publication leaves old leaf and invalidated tree, then resumes safely',t=>{
 const {dir,store,ts}=fixture(t);
 const turn=ts.append({vendor:'claude',user:'Please repair',assistant:'Repair completed'});
 ts.append({vendor:'claude',user:'Thanks',assistant:'Welcome'});
 store.sleep('0-1','stale tree');
 const original=fs.renameSync;
 fs.renameSync=()=>{throw new Error('simulated interruption before publish');};
 try{assert.throws(()=>store.saveTurnSummary(turn,'claude completed the requested repair'),/simulated interruption/);}
 finally{fs.renameSync=original;}
 const restarted=new ApocryphaStore(dir);
 assert.equal(restarted.pendingCount(),1);
 assert.equal(restarted.pendingTurnSummaries(ts).length,2);
 assert.match(restarted.get(0),/User said:/);
 assert.equal(restarted.saveTurnSummary(turn,'claude completed the requested repair'),true);
 assert.equal(new ApocryphaStore(dir).pendingTurnSummaries(ts).length,1);
 assert.match(restarted.get(0),/completed the requested repair/);
});
test('in-band option leaves generation paused even with pending turn summaries',async t=>{
 const {store,ts}=fixture(t);
 ts.append({vendor:'chatgpt',user:'Question',assistant:'Answer'});
 let calls=0;
 const c=new BackgroundCompactor(store,{mode:'in-band',transcripts:ts,model:async()=>{calls++;return 'summary';}});
 c.start();assert.equal(await c.step(),false);c.stop();
 assert.equal(calls,0);assert.equal(c.status().pendingTurnSummaries,1);
});
