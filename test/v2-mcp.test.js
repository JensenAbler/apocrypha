import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApocryphaStore } from "../src/storage.js";
import { TranscriptStore } from "../src/transcripts.js";
import { createApocryphaMcpServer } from "../src/mcp.js";
async function setup(t,options={}) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apx-mcp-v2-"));
 const store=new ApocryphaStore(directory);
 const server=createApocryphaMcpServer(store,{drive:{config:{}},...options});
 const client=new Client({name:"synthetic-v2-test",version:"1"});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();fs.rmSync(directory,{recursive:true,force:true});});
 const call=(name,args)=>client.callTool({name:"apocrypha_"+name,arguments:args});
 return {directory,store,client,call};
}
test("five tools expose backward compatible optional v2 schema, not automatic capture",async t=>{
 const {client,directory,call}=await setup(t);const tools=(await client.listTools()).tools;
 assert.equal(tools.length,5);
 const recall=tools.find(x=>x.name==="apocrypha_recall");
 for(const key of ["pattern","range","id","in","part","snapshot"])assert.ok(recall.inputSchema.properties[key]);
 assert.match(recall.description,/settled block/);
 assert.equal(fs.existsSync(path.join(directory,"TRANSCRIPTS.jsonl")),false);
 assert.equal((await call("recall",{})).isError,true);
 assert.equal((await call("recall",{pattern:"x",id:"#0"})).isError,true);
 assert.equal((await call("note",{})).isError,true);
 assert.equal((await call("note",{text:"fact",turn:{vendor:"chatgpt",user:"u",assistant:"a"}})).isError,true);

});
test("MCP transcript write, note citations, full paging, own-vendor resolve and search",async t=>{
 const {call,directory}=await setup(t);
 const result=await call("note",{turn:{vendor:"chatgpt",user:"Question",assistant:"🧪".repeat(11000),requestId:"mcp-first-turn-1"}});
 assert.notEqual(result.isError,true);const saved=JSON.parse(result.content[0].text);
 assert.equal(saved.id,"t1");assert.equal(saved.assistant,undefined);
 const note=await call("note",{text:"Synthetic durable pointer; see t1"});
 assert.match(note.content[0].text,/Saved as #0/);
 assert.equal(fs.existsSync(path.join(directory,"TRANSCRIPTS.jsonl")),true);
 const first=await call("recall",{id:"#0"});assert.match(first.content[0].text,/t1 user/);
 let page=await call("recall",{id:"t1"}),parts=1;
 while(page.content[0].text.includes("Next command:")){
   assert.ok(Buffer.byteLength(page.content[0].text)<=20000);
   const args=JSON.parse(page.content[0].text.match(/Next command: apocrypha_recall\((.*)\)$/)[1]);
   page=await call("recall",args);assert.notEqual(page.isError,true);parts++;
 }
 assert.ok(parts>1);
 const url="https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
 assert.equal((await call("note",{resolve:{token:saved.conv,vendor:"claude",url}})).isError,true);
 assert.equal((await call("note",{resolve:{token:saved.conv,vendor:"chatgpt",url,candidates:[{url,snippet:saved.conv}]}})).isError,true);
 const resolved=await call("note",{resolve:{token:saved.conv,vendor:"chatgpt",url,candidates:[{url,snippet:"⟦mint "+saved.conv+"⟧"}]}});
 assert.notEqual(resolved.isError,true);
 assert.match((await call("recall",{id:"t1"})).content[0].text,/Next command/);
 assert.match((await call("recall",{pattern:"Question",in:"transcripts"})).content[0].text,/t1/);
 assert.equal(fs.readFileSync(path.join(directory,"CONVERSATIONS.jsonl"),"utf8").includes("⟦mint"),false);
});
test("corrupt transcript store does not disable independent legacy tools",async t=>{
 const {directory,call}=await setup(t);
 fs.writeFileSync(path.join(directory,"TRANSCRIPTS.jsonl"),'{"broken":');
 assert.notEqual((await call("note",{text:"Independent note"})).isError,true);
 assert.notEqual((await call("wake",{})).isError,true);
 assert.notEqual((await call("recall",{id:"#0"})).isError,true);
 assert.equal((await call("recall",{id:"t1"})).isError,true);
});
test("wake preserves vendor across pages and flags ambiguous origins",async t=>{
 const {directory,store,call}=await setup(t,{lazyResolution:true});
 for(let i=0;i<96;i++)store.append("x".repeat(270));
 while(store.pendingCount()){const[a,b]=store.pending(undefined,1)[0];store.sleep(a+"-"+(b-1),"summary");}
 const ts=new TranscriptStore(directory,{lazyResolution:true}),turn=ts.append({vendor:"chatgpt",user:"u",assistant:"a"});
 const candidates=["aaaaaaaa","bbbbbbbb"].map(id=>({url:"https://chatgpt.com/c/"+id+"-bbbb-cccc-dddd-eeeeeeeeeeee",snippet:"⟦mint "+turn.conv+"⟧"}));
 ts.resolve({token:turn.conv,candidates});
 const first=await call("wake",{vendor:"chatgpt"});
 const args=JSON.parse(first.content[0].text.match(/Next command: apocrypha_wake\((.*)\)/)[1]);
 assert.equal(args.vendor,"chatgpt");
 const last=await call("wake",args);
 assert.match(last.content[0].text,/Unresolved chatgpt conversations, oldest first:\n.*\[ambiguous: conflicting origin markers recorded\]/);
});

test("vendor-aware wake never parses or rewrites stored tool-like text",async t=>{
 const {store,call}=await setup(t,{lazyResolution:true});
 store.append('Literal apocrypha_wake({not JSON}) is just text.');
 const result=await call('wake',{vendor:'chatgpt'});
 assert.notEqual(result.isError,true);
 assert.match(result.content[0].text,/apocrypha_wake\(\{not JSON\}\)/);
});

test("curated notes and compression preserve legacy text validation and date-rich content",async t=>{
 const {call,store}=await setup(t);
 for(const text of ["2026-09-07 2026-09-07 Van is back","Schwab account 2026 snapshot"]){
   assert.notEqual((await call("note",{text})).isError,true);
 }
 const compressed=await call("sleep",{range:"0-1",summary:"2026-09-07 2026-09-07 Van is back; Schwab account 2026 snapshot"});
 assert.notEqual(compressed.isError,true);
 assert.notEqual((await call("wake",{})).isError,true);
 assert.equal(store.pendingCount(),0);
});
test("missing transcript citations preserve the original note and report the gap",async t=>{
 const {call}=await setup(t);
 await call("note",{text:"A durable fact with a typo: see t999"});
 const result=await call("recall",{id:"#0"});
 assert.notEqual(result.isError,true);
 assert.match(result.content[0].text,/A durable fact with a typo: see t999/);
 assert.match(result.content[0].text,/t999 not available: Transcript t999 does not exist/);
 assert.equal((await call("recall",{id:"t999"})).isError,true);
});
test("wake output is descriptive: a header, labeled lines, and a footer, with no usage directives",async t=>{
 const {call,store}=await setup(t);
 assert.equal((await call("wake",{})).content[0].text,"Apocrypha, oldest first (0 memories).\nNo memories yet. You are awake.");
 store.append("one"); store.append("two"); store.sleep("0-1","pair");
 const result=(await call("wake",{})).content[0].text;
 assert.match(result,/^Apocrypha, oldest first \(2 memories\)\.\n#0 \S+ one\n#1 \S+ two\nYou are awake\.$/);
});

test("origin markers stay out of curated notes and summaries while bare tokens remain usable",async t=>{
 const {call,store}=await setup(t);
 assert.equal((await call("note",{text:"Origin ⟦mint apx-abcd-baba⟧"})).isError,true);
 assert.equal(store.count(),0);
 assert.notEqual((await call("note",{text:"Pointer apx-abcd-baba"})).isError,true);
 await call("note",{text:"Another durable note"});
 assert.equal((await call("sleep",{range:"0-1",summary:"Origin ⟦mint apx-abcd-baba⟧"})).isError,true);
 assert.notEqual((await call("sleep",{range:"0-1",summary:"Bare apx-abcd-baba pointer"})).isError,true);
});
