#!/usr/bin/env node
// One-time, offline chronological rebuild. Always stage into a NEW directory;
// never edit the live store. The operator stops the service, keeps the original
// directory as the backup, then swaps the verified stage into place.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSources, clean, normalized } from './history-sources.mjs';
import { parseArchive } from './code-sessions.mjs';
import { ApocryphaStore, LOG_RECORD_BYTES, TREE_RECORD_BYTES, turnLeafId, turnLeafText } from '../src/storage.js';
import { TranscriptStore, pacificTimestamp } from '../src/transcripts.js';
import { withWriterLock } from '../src/writer-lock.js';
const HASH=x=>createHash('sha256').update(x).digest('hex');
const jsonl=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
const time=t=>Date.parse(t.at);
const SOURCE='chronological-rebuild-2026-11';
const started=Date.now();
const progress=phase=>console.error(JSON.stringify({phase,elapsedSeconds:Math.round((Date.now()-started)/1000),rssMiB:Math.round(process.memoryUsage().rss/1048576)}));
const insert=(map,key,value)=>{if(!map.has(key))map.set(key,[]);map.get(key).push(value);};
const pair=t=>HASH(normalized(t.user)+'\0'+normalized(t.assistant));
function mint(key,taken) {
  const alphabet='abcdefghijklmnopqrstuvwxyz234567', cons='bcdfghjklmnprstvwz', vowels='aeiou';
  for(let n=0;;n++){
    const b=createHash('sha256').update(key+':'+n).digest();
    const token='apx-'+[...b.subarray(0,4)].map(x=>alphabet[x&31]).join('')+'-'+cons[b[4]%cons.length]+vowels[b[5]%5]+cons[b[6]%cons.length]+vowels[b[7]%5];
    if(!taken.has(token)){taken.add(token);return token;}
  }
}
export function rewriteReferences(text, limit, mapping) {
  return text.replace(/#(\d+)(?:([–-])(\d+))?/gu,(match,a,dash,b,offset,whole)=>{
    if(offset>0 && /[\p{L}\p{N}&]/u.test(whole[offset-1]))return match;
    if(/\b(?:st|ave|apt|unit|suite|ste|rd|blvd|invoices?|claims?|accounts?|order|ticket)\.?\s*$/iu.test(whole.slice(Math.max(0,offset-24),offset)))return match;
    const first=Number(a);
    if(first>=limit || !mapping.has(first))return match;
    if(b===undefined)return '#'+mapping.get(first);
    const second=Number(b);
    // A former contiguous block can become non-contiguous. Preserve its two
    // mapped endpoint citations instead of inventing a newly contiguous range.
    if(second>=limit || second<first || !mapping.has(second))return match;
    const start=mapping.get(first), end=mapping.get(second);
    const continuous=end-start===second-first && Array.from({length:second-first+1},(_,i)=>mapping.get(first+i)===start+i).every(Boolean);
    return continuous?'#'+start+dash+end:'#'+start+' through #'+end;
  });
}
function pad(text,size) {
  const b=Buffer.from(text);
  if(b.length>=size)throw new Error('Rewritten fixed record too long: '+b.length);
  return Buffer.concat([b,Buffer.alloc(size-1-b.length,32),Buffer.from('\n')]);
}
function snapshot(directory) {
  return withWriterLock(directory,()=>{
    const transcripts=new TranscriptStore(directory),store=new ApocryphaStore(directory);
    return {state:structuredClone(transcripts.state()),log:[...store.logRecords()],summaries:{...store.turnSummaries()}};
  });
}
export function buildHistory(directory,{sources=[],archive,reserveAt,reserve=32768}={}) {
  if(fs.existsSync(path.join(directory,'CHRONOLOGICAL_REBUILD.json')))throw new Error('Chronological rebuild already installed; refusing to renumber again.');
  const {state,log,summaries}=snapshot(directory);
  progress('snapshot');
  const originalTurns=state.turns, turns=structuredClone(originalTurns), events=structuredClone(state.events);
  const oldLeaf=new Map();log.forEach((line,i)=>{const id=line&&turnLeafId(line);if(id){if(oldLeaf.has(id))throw new Error('Duplicate existing turn leaf '+id);oldLeaf.set(id,i);}});
  const grouped=new Map();
  const input=readSources(sources);
  progress('app-sources');
  for(const c of input) {
    const key=c.vendor+':'+c.id;
    if(!grouped.has(key))grouped.set(key,{...c,turns:new Map(),markers:new Set()});
    const g=grouped.get(key);
    for(const m of c.markers||[])g.markers.add(m);
    for(const t of c.turns) {
      const key=t.messageId || t.at+':'+HASH(t.user);
      // Later supplied snapshots supersede the same message, keeping older
      // messages if an export is partial.
      g.turns.set(key,{...t,sourceFile:c.file});
    }
  }
  let archiveStats=null;
  if(archive) {
    const parsed=parseArchive(archive);
    archiveStats={files:parsed.files,copies:parsed.copies,sessions:parsed.sessions.length};
    for(const s of parsed.sessions)grouped.set(s.vendor+':archive:'+s.id,{...s,created:s.turns[0]?.at,markers:new Set(),turns:new Map(s.turns.map(t=>[t.messageId,{...t,user:clean(t.user),assistant:clean(t.assistant),sourceFile:s.file}]))});
  }
  progress('coding-sources');
  const tokenKeys=new Map(), byUrl=new Map(), markerKeys=new Map();
  for(const c of state.conversations.values())if(c.link)byUrl.set(c.token,c.link);
  for(const [key,c] of grouped) {
    for(const marker of c.markers)insert(markerKeys,marker,key);
    for(const [token,url] of byUrl)if(c.url===url)insert(tokenKeys,token,key);
  }
  for(const [token,keys] of markerKeys) {
    const unique=[...new Set(keys)], known=state.conversations.get(token);
    if(unique.length===1 && known && known.vendor===grouped.get(unique[0]).vendor && (!known.link || known.link===grouped.get(unique[0]).url)) {
      if(!tokenKeys.has(token))tokenKeys.set(token,unique);
      if(!known.link && grouped.get(unique[0]).url) {
        const c=grouped.get(unique[0]);
        events.push({type:'resolved',token,vendor:c.vendor,at:c.updated||c.created,url:c.url,source:SOURCE,evidenceHash:HASH('origin-marker:'+token+':'+c.url)});
      }
    }
  }
  const byKeyTime=new Map(), byKeyUser=new Map(), byPair=new Map(), byUser=new Map();
  for(const t of turns) {
    for(const key of tokenKeys.get(t.conv)||[]) {
      insert(byKeyTime,key+':'+Math.floor(time(t)/1000),t);
      insert(byKeyUser,key+':'+HASH(normalized(t.user)),t);
    }
    if(!t.source) {
      insert(byPair,t.vendor+':'+pair(t),t);
      if(normalized(t.user).length>=80)insert(byUser,t.vendor+':'+HASH(normalized(t.user)),t);
    }
  }
  const taken=new Set(state.conversations.keys()), matched=new Set(), newTurns=[], changedText=new Set();
  const report={inputConversations:input.length,sourceConversations:grouped.size,originalTurns:turns.length,matchedExisting:0,addedTurns:0,restoredRedactedTurns:0,matchedBy:{},archive:archiveStats,unmatchedImported:[],unmatchedLive:[],sourceTurns:0};
  const canonicalByKey=new Map();
  const nearest=(candidates,t)=>candidates.filter(x=>!matched.has(x.id)).sort((a,b)=>Math.abs(time(a)-time(t))-Math.abs(time(b)-time(t)))[0];
  for(const [key,c] of grouped) {
    let conv=[...tokenKeys].find(([token,keys])=>keys.includes(key) && originalTurns.some(t=>t.conv===token && t.source))?.[0]
      || [...tokenKeys].find(([,keys])=>keys.includes(key))?.[0];
    const list=[...c.turns.values()].sort((a,b)=>time(a)-time(b)||a.sourceOrder-b.sourceOrder);
    if(!list.length)continue;
    if(!conv) {
      conv=mint(key,taken);
      events.push({type:'created',token:conv,vendor:c.vendor,at:pacificTimestamp(new Date(c.created||list[0].at)),source:SOURCE});
      if(c.url)events.push({type:'resolved',token:conv,vendor:c.vendor,at:pacificTimestamp(new Date(c.created||list[0].at)),url:c.url,source:SOURCE,evidenceHash:HASH(key)});
      else events.push({type:'archived',token:conv,vendor:c.vendor,at:pacificTimestamp(new Date(c.created||list[0].at)),source:SOURCE,archive:{kind:'archive',path:c.file,sessionId:c.id,sessionKind:c.kind}});
    }
    canonicalByKey.set(key,conv);
    for(const t of list) {
      if(!Number.isFinite(time(t)))throw new Error('Missing source timestamp: '+key+':'+t.messageId);
      report.sourceTurns++;
      let found,method;
      const exact=(byKeyTime.get(key+':'+Math.floor(time(t)/1000))||[]).filter(x=>!matched.has(x.id));
      if(exact.length===1 && (exact[0].source || normalized(exact[0].user)===normalized(t.user))){found=exact[0];method='conversation_timestamp';}
      if(!found){
        const same=(byKeyUser.get(key+':'+HASH(normalized(t.user)))||[]).filter(x=>Math.abs(time(x)-time(t))<14*86400e3);
        found=nearest(same,t);method='conversation_prompt';
      }
      if(!found && normalized(t.user).length>0 && normalized(t.assistant).length>=30) {
        const same=(byPair.get(c.vendor+':'+pair(t))||[]).filter(x=>!matched.has(x.id) && Math.abs(time(x)-time(t))<14*86400e3);
        if(same.length===1){found=same[0];method='exact_pair';}
      }
      if(!found && normalized(t.user).length>=80) {
        const same=(byUser.get(c.vendor+':'+HASH(normalized(t.user)))||[]).filter(x=>!matched.has(x.id) && Math.abs(time(x)-time(t))<3600e3);
        if(same.length===1){found=same[0];method='unique_long_prompt';}
      }
      if(found) {
        matched.add(found.id);report.matchedExisting++;report.matchedBy[method]=(report.matchedBy[method]||0)+1;
        if(found.source==='export-2026-01-29') {
          if(['id','account'].includes(found.omitted))report.restoredRedactedTurns++;
          if(found.user!==t.user || found.assistant!==t.assistant)changedText.add(found.id);
          found.user=t.user;found.assistant=t.assistant;
          if(['id','account'].includes(found.omitted))delete found.omitted;
        }
        if(!found.recordedAt)found.recordedAt=found.at;
        found.at=pairTime(t);found.provenance={conversationId:c.id,messageId:t.messageId,file:t.sourceFile,kind:c.kind||'chat'};
        // A content match also supplies auditable origin evidence for unlinked
        // live captures; never replace an existing conflicting link.
        const oldConv=state.conversations.get(found.conv);
        if(c.url && oldConv && !oldConv.link && !events.some(e=>e.type==='resolved' && e.token===found.conv))events.push({type:'resolved',token:found.conv,vendor:c.vendor,at:found.at,url:c.url,source:SOURCE,evidenceHash:HASH(method+':'+key+':'+found.id)});
      } else {
        const r={conv,vendor:c.vendor,at:pairTime(t),user:t.user,assistant:t.assistant,source:SOURCE,provenance:{conversationId:c.id,messageId:t.messageId,file:t.sourceFile,kind:c.kind||'chat'}};
        newTurns.push(r);
      }
    }
  }
  progress('matching');
  newTurns.sort((a,b)=>time(a)-time(b)||a.conv.localeCompare(b.conv));
  for(const t of newTurns){t.id='t'+(turns.length+1);turns.push(t);}
  report.addedTurns=newTurns.length;
  for(const t of originalTurns)if(!matched.has(t.id))(t.source?report.unmatchedImported:report.unmatchedLive).push(t.id);
  // tIDs and request receipts remain stable. Turn ordinals reflect chronological
  // order, independent of the physical tID order in the append-only JSONL.
  const perConv=new Map();
  for(const t of [...turns].sort((a,b)=>time(a)-time(b)||Number(a.id.slice(1))-Number(b.id.slice(1)))) {
    const n=(perConv.get(t.conv)||0)+1;perConv.set(t.conv,n);
    if(t.turn!==undefined && t.turn!==n)t.previousTurn=t.turn;
    t.turn=n;
  }
  const byId=new Map(turns.map(t=>[t.id,t])), nodes=[];
  for(const t of turns)nodes.push({id:t.id,old:oldLeaf.get(t.id),time:time(t),rank:1});
  // Date-only notes inherit the nearest same-day live turn's time, preserving
  // which side of that turn they were written on. Older standalone notes use noon.
  const liveIds=new Set(originalTurns.filter(t=>!t.source).map(t=>t.id));
  const liveAnchors=log.flatMap((line,i)=>{
    const id=line&&turnLeafId(line),t=id&&byId.get(id);
    return t && liveIds.has(id)?[{old:i,time:time(t),date:(t.recordedAt||t.at).slice(0,10),logDate:line.split(' ')[1]}]:[];
  });
  for(let i=0;i<log.length;i++) {
    const line=log[i];if(!line || turnLeafId(line))continue;
    const m=/^#\d+ (\S+) (.*)$/s.exec(line);if(!m)throw new Error('Invalid note '+i);
    const before=liveAnchors.findLast(a=>a.old<i&&(a.date===m[1]||a.logDate===m[1])),after=liveAnchors.find(a=>a.old>i&&(a.date===m[1]||a.logDate===m[1]));
    const anchor=before||after;
    const fallback=Date.parse(m[1]+'T12:00:00-07:00');
    nodes.push({old:i,date:m[1],body:m[2],time:anchor?anchor.time:fallback,rank:before?2:0});
  }
  nodes.sort((a,b)=>a.time-b.time||a.rank-b.rank||(a.old??Infinity)-(b.old??Infinity)||Number((a.id||'t0').slice(1))-Number((b.id||'t0').slice(1)));
  const mapping=new Map();nodes.forEach((n,i)=>{if(n.old!==undefined)mapping.set(n.old,i);});
  const rewrittenSummaries={};
  for(const [id,summary] of Object.entries(summaries))if(byId.has(id)&&!changedText.has(id))rewrittenSummaries[id]=rewriteReferences(summary,oldLeaf.get(id)??0,mapping);
  const lastOldByDate=new Map();
  log.forEach((line,i)=>{if(line && i>=reserve){const date=line.split(' ')[1];lastOldByDate.set(date,Math.max(lastOldByDate.get(date)||0,i+1));}});
  const datedBounds=[...lastOldByDate].sort((a,b)=>a[0].localeCompare(b[0]));
  const preReserveMap=new Map([...mapping].filter(([n])=>n>=reserve).map(([n,to])=>[n-reserve,to]));
  report.rewrittenTranscriptReferences=0;
  for(const t of turns) {
    const position=oldLeaf.get(t.id);
    // Transcript bodies were never shifted by reserve-slots.mjs. Before that
    // migration, #55 means the old live note now at 32768+55, not backfill #55.
    const epoch=Date.parse(t.recordedAt||t.at);
    const pre=reserveAt && epoch<Date.parse(reserveAt);
    let limit=position;
    if(limit===undefined) {
      limit=0;
      for(const [date,end] of datedBounds)if(date<=(t.recordedAt||t.at).slice(0,10))limit=Math.max(limit,end);
    }
    if(t.source!=='export-2026-01-29') {
      const refs=pre?preReserveMap:mapping;
      const bound=pre?Math.max(0,limit-reserve):limit;
      const user=rewriteReferences(t.user,bound,refs),assistant=rewriteReferences(t.assistant,bound,refs);
      if(user!==t.user || assistant!==t.assistant)report.rewrittenTranscriptReferences++;
      t.user=user;t.assistant=assistant;
    }
    if(t.summary)t.summary=rewriteReferences(t.summary,position??0,mapping);
  }
  const lines=nodes.map((n,i)=>{
    if(n.id){const t=byId.get(n.id);return '#'+i+' '+t.at.slice(0,10)+' '+turnLeafText(t);}
    return '#'+i+' '+n.date+' '+rewriteReferences(n.body,n.old,mapping);
  });
  progress('layout');
  const logBuffer=Buffer.concat(lines.map(l=>pad(l,LOG_RECORD_BYTES)));
  // Reuse a tree summary only if every original leaf remains unchanged and
  // contiguous at an aligned location. Other blocks must be regenerated.
  const trees=new Map();let reusedBlocks=0;
  const oldDir=path.join(directory,'TREE');
  for(const name of fs.readdirSync(oldDir).filter(x=>/^\d+$/.test(x))) {
    const size=Number(name),data=fs.readFileSync(path.join(oldDir,name));
    for(let j=0;j<data.length/TREE_RECORD_BYTES;j++) {
      const summary=data.toString('utf8',j*TREE_RECORD_BYTES,(j+1)*TREE_RECORD_BYTES).trimEnd();if(!summary)continue;
      const start=j*size,newStart=mapping.get(start);
      if(newStart===undefined || newStart%size || newStart+size>lines.length)continue;
      let ok=true;
      for(let k=0;k<size;k++){
        const old=log[start+k],id=old&&turnLeafId(old);
        if(mapping.get(start+k)!==newStart+k || !old || (id&&changedText.has(id))){ok=false;break;}
      }
      if(!ok)continue;
      const value=rewriteReferences(summary,start+size,mapping);
      if(Buffer.byteLength(value)>280)continue;
      if(!trees.has(size))trees.set(size,new Map());
      trees.get(size).set(newStart/size,value);reusedBlocks++;
    }
  }
  progress('trees');
  report.finalTurns=turns.length;report.finalMemories=lines.length;
  report.curatedNotes=nodes.filter(n=>!n.id).length;report.restoredTextTurns=changedText.size;
  report.retainedTurnSummaries=Object.keys(rewrittenSummaries).length;report.reusedBlocks=reusedBlocks;
  report.first=turns.reduce((a,t)=>time(t)<Date.parse(a)?t.at:a,turns[0].at);
  report.last=turns.reduce((a,t)=>time(t)>Date.parse(a)?t.at:a,turns[0].at);
  report.linkedConversations=new Set(events.filter(e=>['resolved','archived'].includes(e.type)).map(e=>e.token)).size;
  return {report,turns,events,logBuffer,summaries:rewrittenSummaries,trees,mapping,sourceHashes:sources.map(s=>({...s,sha256:HASH(fs.readFileSync(s.file))}))};
}
const pairTime=t=>pacificTimestamp(new Date(t.at));
export function stageHistory(directory,out,options) {
  if(fs.existsSync(out))throw new Error('Stage already exists; inspect it instead of overwriting: '+out);
  const plan=buildHistory(directory,options);
  fs.mkdirSync(out,{recursive:true,mode:0o700});
  const write=(name,value)=>{const fd=fs.openSync(path.join(out,name),'wx',0o600);try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  write('TRANSCRIPTS.jsonl',plan.turns.map(x=>JSON.stringify(x)+'\n').join(''));
  write('CONVERSATIONS.jsonl',plan.events.map(x=>JSON.stringify(x)+'\n').join(''));
  write('LOG.txt',plan.logBuffer);write('TURN_SUMMARIES.json',JSON.stringify(plan.summaries)+'\n');
  fs.mkdirSync(path.join(out,'TREE'));
  for(const [size,blocks] of plan.trees) {
    const count=Math.max(...blocks.keys())+1;
    write('TREE/'+size,Buffer.concat(Array.from({length:count},(_,i)=>pad(blocks.get(i)||'',TREE_RECORD_BYTES))));
  }
  write('CHRONOLOGICAL_REBUILD.json',JSON.stringify({version:1,at:new Date().toISOString(),source:directory,...plan.report,sources:plan.sourceHashes,oldToNew:Object.fromEntries(plan.mapping)},null,2)+'\n');
  const ts=new TranscriptStore(out),store=new ApocryphaStore(out);
  if(ts.entries().length!==plan.report.finalTurns || ts.missingLeaves(store).length || store.memoryCount()!==plan.report.finalMemories)throw new Error('Staged reconciliation validation failed.');
  const seen=new Set(), turnById=new Map(ts.entries().map(t=>[t.id,t]));let previous=-Infinity;
  for(const line of store.logRecords()) {
    const id=turnLeafId(line);if(!id)continue;
    if(seen.has(id))throw new Error('Duplicate leaf '+id);seen.add(id);
    const at=time(turnById.get(id));if(at<previous)throw new Error('Transcript chronology regressed at '+id);previous=at;
  }
  return plan.report;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=Object.fromEntries(process.argv.slice(2).map(s=>{const [k,...v]=s.replace(/^--/,'').split('=');return[k,v.join('=')||true];}));
  if(!args.dir||!args.config)throw new Error('Usage: rebuild-history.mjs --dir=STORE --config=JSON [--out=NEW_STAGE]');
  const options=JSON.parse(fs.readFileSync(args.config,'utf8'));
  const result=args.out?stageHistory(args.dir,args.out,options):buildHistory(args.dir,options).report;
  console.log(JSON.stringify(result,null,2));
}
