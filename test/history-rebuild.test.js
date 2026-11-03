import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaude, parseChatGPT, turnsOf } from '../scripts/history-sources.mjs';
import { codexSession, claudeSession } from '../scripts/code-sessions.mjs';
import { stageHistory, rewriteReferences } from '../scripts/rebuild-history.mjs';
import { TranscriptStore, validateArchiveLink } from '../src/transcripts.js';
import { ApocryphaStore, turnLeafId } from '../src/storage.js';
import { zoom } from '../src/read.js';
const uuid='12345678-1234-4234-8234-123456789abc';
const at='2026-10-21T12:00:00Z';
const message=(id,sender,text,parent,created_at=at)=>({uuid:id,sender,text,parent_message_uuid:parent,created_at});
test('Claude reads selected branch, not the newest discarded answer',()=>{
 const c={uuid,created_at:at,current_leaf_message_uuid:'a',chat_messages:[message('u','human','hello',null),message('a','assistant','chosen','u'),message('b','assistant','discarded','u','2026-10-22T12:00:00Z')]};
 assert.deepEqual(turnsOf(parseClaude([c])[0]).map(x=>x.assistant),['chosen']);
 assert.throws(()=>parseClaude([{...c,current_leaf_message_uuid:'missing'}]),/missing/);
});
test('ChatGPT preserves voice text and visible prose, excludes tools and analysis',()=>{
 const stamp=Date.parse(at)/1000, mapping={};
 const add=(id,parent,role,content,extra={})=>mapping[id]={id,parent,message:{id,author:{role},create_time:stamp,content,...extra}};
 add('u',null,'user',{content_type:'multimodal_text',parts:[{content_type:'audio_transcription',text:'My spoken words'},{content_type:'image_asset_pointer',asset_pointer:'image'}]});
 add('tool','u','assistant',{content_type:'text',parts:['tool command']},{recipient:'functions.exec'});
 add('thought','tool','assistant',{content_type:'text',parts:['private reasoning']},{channel:'analysis',recipient:'all'});
 add('a','thought','assistant',{content_type:'text',parts:['Visible reply']},{channel:'final',recipient:'all'});
 const t=turnsOf(parseChatGPT([{id:uuid,create_time:stamp,current_node:'a',mapping}])[0]);
 assert.equal(t.length,1);assert.equal(t[0].user,'My spoken words');assert.equal(t[0].assistant,'Visible reply');
});
test('Codex ignores injected instructions in event and response-item formats',()=>{
 for(const events of [true,false]){
  const rows=[{type:'session_meta',payload:{id:uuid}}];
  const add=(role,text)=>rows.push(events?{type:'event_msg',timestamp:at,payload:{type:role==='user'?'user_message':'agent_message',message:text}}:{type:'response_item',timestamp:at,payload:{type:'message',role,content:[{type:'text',text}] }});
  add('user','# AGENTS.md instructions\nAutomatic instructions');add('user','<environment_context>machine</environment_context>');add('user','Please fix my app');add('assistant','Fixed it');
  const s=codexSession('/archive/session.jsonl',rows);
  assert.equal(s.turns.length,1);assert.equal(s.turns[0].user,'Please fix my app');assert.equal(s.turns[0].assistant,'Fixed it');
 }
});
test('Claude Code excludes tool output, sidechain, meta and thinking',()=>{
 const s=claudeSession('/archive/session.jsonl',[
 {sessionId:uuid,type:'user',timestamp:at,message:{content:'Fix it'}},
 {sessionId:uuid,type:'user',timestamp:at,message:{content:[{type:'tool_result',content:'output'}]}},
 {sessionId:uuid,type:'assistant',timestamp:at,message:{content:[{type:'thinking',thinking:'secret'},{type:'tool_use',name:'exec'},{type:'text',text:'Done'}]}},
 {sessionId:uuid,type:'user',timestamp:at,isMeta:true,message:{content:'Injected'}},
 ]);
 assert.equal(s.turns.length,1);assert.equal(s.turns[0].assistant,'Done');
});
test('reference rewrite guards numeric labels and represents split ranges honestly',()=>{
 const mapping=new Map([[0,3],[1,5],[2,6]]);
 assert.equal(rewriteReferences('See #0, #1-2; Invoice #1; claim #2; Apt #1; #99',3,mapping),'See #3, #5-6; Invoice #1; claim #2; Apt #1; #99');
 assert.equal(rewriteReferences('See #0-2',3,mapping),'See #3 through #6');
});
test('full staged rebuild dedupes, restores raw text, preserves IDs/receipts, orders turns and adjacent notes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'apx-rebuild-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'original'),out=path.join(root,'stage'),file=path.join(root,'source.json');
 const ts=new TranscriptStore(dir,{clock:()=>new Date('2026-10-21T12:00:30Z')}),store=new ApocryphaStore(dir);
 store.append('Note before the exchange','2026-10-21');
 const saved=ts.append({vendor:'claude',user:'The live prompt is long enough',assistant:'This is the exact visible final response',requestId:'fixture-request-1'});
 store.append('Note after the exchange cites #0','2026-10-21');
 const c={uuid,created_at:'2026-10-20T12:00:00Z',chat_messages:[
 message('u0','human','Earlier prompt has account 123456789','00000000-0000-4000-8000-000000000000','2026-10-20T12:00:00Z'),
 message('a0','assistant','Earlier response','u0','2026-10-20T12:00:01Z'),
 message('u','human',saved.user,'a0'),message('a','assistant',saved.assistant,'u')
 ],current_leaf_message_uuid:'a'};
 fs.writeFileSync(file,JSON.stringify([c]));
 const r=stageHistory(dir,out,{sources:[{vendor:'claude',file},{vendor:'claude',file}]});
 assert.equal(r.originalTurns,1);assert.equal(r.addedTurns,1);assert.equal(r.matchedExisting,1);
 const next=new TranscriptStore(out),ns=new ApocryphaStore(out);
 assert.equal(next.get('t1').requestId,'fixture-request-1');
 assert.equal(next.get('t2').user,'Earlier prompt has account 123456789');
 const lines=ns.logRecords();assert.equal(turnLeafId(lines[0]),'t2');assert.match(lines[1],/Note before/);assert.equal(turnLeafId(lines[2]),'t1');assert.match(lines[3],/Note after.*#1/);
 assert.equal(next.missingLeaves(ns).length,0);
 assert.equal(next.getConversation(saved.conv).link,'https://claude.ai/chat/'+uuid);
 assert.throws(()=>stageHistory(out,path.join(root,'again'),{sources:[]}),/already installed/);
 assert.equal(new TranscriptStore(dir).entries().length,1);
});
test('restoration and chronological ordinals work while tIDs remain in physical append order',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'apx-restore-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'original'),out=path.join(root,'stage'),file=path.join(root,'source.json');
 const ts=new TranscriptStore(dir,{clock:()=>new Date(at)}),store=new ApocryphaStore(dir);
 const saved=ts.append({vendor:'claude',user:'[redacted account number]',assistant:'Answer'});
 const turn={...saved,source:'export-2026-01-29',omitted:'account'};delete turn.newConversation;
 fs.writeFileSync(ts.turnFile+'.new',JSON.stringify(turn)+'\n');fs.renameSync(ts.turnFile+'.new',ts.turnFile);
 fs.appendFileSync(ts.conversationFile,JSON.stringify({type:'resolved',token:saved.conv,vendor:'claude',at,url:'https://claude.ai/chat/'+uuid})+'\n');
 const c={uuid,created_at:'2026-10-20T12:00:00Z',current_leaf_message_uuid:'a',chat_messages:[
 message('old','human','A prompt before existing','00000000-0000-4000-8000-000000000000','2026-10-20T12:00:00Z'),message('old-a','assistant','Earlier','old','2026-10-20T12:00:01Z'),
 message('u','human','account 123456789','old-a'),message('a','assistant','Answer','u')]};
 fs.writeFileSync(file,JSON.stringify([c]));
 const r=stageHistory(dir,out,{sources:[{vendor:'claude',file}]});assert.equal(r.restoredRedactedTurns,1);
 const next=new TranscriptStore(out);assert.equal(next.get('t1').user,'account 123456789');assert.equal(next.get('t1').omitted,undefined);
 assert.equal(next.get('t1').turn,2);assert.equal(next.get('t2').turn,1);
 assert.deepEqual(next.chronologicalEntries().map(t=>t.id),['t2','t1']);
 assert.equal(next.append({conv:saved.conv,vendor:'claude',user:'new',assistant:'ok'}).turn,3);
});
test('archive links validate and render without pretending to have a web URL',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'apx-archive-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const ts=new TranscriptStore(root);const saved=ts.append({vendor:'chatgpt',user:'Code prompt',assistant:'Code reply'});
 const archive={kind:'archive',path:'/code-sessions-archive/session.jsonl',sessionId:uuid,sessionKind:'codex'};
 fs.appendFileSync(ts.conversationFile,JSON.stringify({type:'archived',token:saved.conv,vendor:'chatgpt',at,archive})+'\n');
 assert.deepEqual(ts.getConversation(saved.conv).archive,archive);
 assert.match(zoom(new ApocryphaStore(root),ts,{id:saved.id}),/archive: \/code-sessions-archive\/session.jsonl/);
 assert.throws(()=>validateArchiveLink({...archive,path:'relative'}),/Invalid/);
});

test('pre-reservation transcript references target live notes, not historical slot occupants',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'apx-epoch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'original'),out=path.join(root,'stage'),file=path.join(root,'source.json');
 const ts=new TranscriptStore(dir,{clock:()=>new Date(at)}),store=new ApocryphaStore(dir);
 store.append('Original target note','2026-10-21');
 const saved=ts.append({vendor:'claude',user:'Remember that note',assistant:'See #0'});
 const bytes=fs.readFileSync(store.logFile),blank=Buffer.from(' '.repeat(319)+'\n');
 const lines=[...Array(4)].map(()=>blank);
 for(let i=0;i<bytes.length/320;i++){const s=bytes.toString('utf8',i*320,(i+1)*320).trimEnd().replace(/^#\d+/, '#'+(i+4));lines.push(Buffer.from(s+' '.repeat(319-Buffer.byteLength(s))+'\n'));}
 fs.writeFileSync(store.logFile+'.new',Buffer.concat(lines));fs.renameSync(store.logFile+'.new',store.logFile);
 fs.writeFileSync(file,JSON.stringify([{uuid,created_at:'2026-10-20T12:00:00Z',chat_messages:[message('before','human','An earlier historical prompt',null,'2026-10-20T12:00:00Z')]}]));
 stageHistory(dir,out,{sources:[{vendor:'claude',file}],reserve:4,reserveAt:'2026-11-02T18:25:05Z'});
 assert.equal(new TranscriptStore(out).get(saved.id).assistant,'See #1');
 assert.match(new ApocryphaStore(out).get(1),/Original target note/);
});
