import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApocryphaStore, PAGE_BYTES, TREE_RECORD_BYTES, parseRange } from "../src/storage.js";
import { zoom, readPage, safeSearch } from "../src/read.js";
function setup(t) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apx-zoom-"));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const store=new ApocryphaStore(directory); return {directory,store};
}
function settle(store) { while(store.pendingCount()) { const [a,b]=store.pending(undefined,1)[0];store.sleep(`${a}-${b-1}`,`summary ${a}-${b-1}`); } }
function body(result){return result.split("\n").slice(1);}
test("every aligned settled block returns exactly original inputs; recursive root reaches every note",t=>{
 const {store,directory}=setup(t);
 for(let i=0;i<256;i++)store.append(`synthetic note ${i}`,"2026-10-20");
 settle(store);
 const before=fs.readdirSync(store.treeDirectory).map(f=>[f,fs.readFileSync(path.join(store.treeDirectory,f))]);
 const log=fs.readFileSync(store.logFile);
 for(let size=2;size<=256;size*=2) for(let lo=0;lo<256;lo+=size) {
   const got=body(zoom(store,null,{range:`${lo}-${lo+size-1}`}));
   if(size<=16)assert.deepEqual(got,Array.from({length:size},(_,i)=>store.get(lo+i)));
   else {const mid=lo+size/2;assert.deepEqual(got,[`#${lo}-${mid-1} summary ${lo}-${mid-1}`,`#${mid}-${lo+size-1} summary ${mid}-${lo+size-1}`]);}
 }
 const reached=[];
 function walk(range){for(const line of body(zoom(store,null,{range}))){const m=/^#(\d+-\d+) /.exec(line);if(m)walk(m[1]);else reached.push(Number(/^#(\d+)/.exec(line)[1]));}}
 walk("0-255");assert.deepEqual(reached,Array.from({length:256},(_,i)=>i));
 for(const[f,b]of before)assert.deepEqual(fs.readFileSync(path.join(store.treeDirectory,f)),b);
 assert.deepEqual(fs.readFileSync(store.logFile),log);
 assert.deepEqual(fs.readdirSync(directory).sort(),["LOG.txt","TREE"]);
});
test("missing, blank, invalid UTF8, oversized or truncated child yields repair hint",t=>{
 const {store}=setup(t);for(let i=0;i<32;i++)store.append("synthetic");settle(store);
 const file=store.treeFile(16),original=fs.readFileSync(file);
 for(const corrupt of [Buffer.alloc(TREE_RECORD_BYTES,32),Buffer.from([255]),Buffer.alloc(282,120)]){
 fs.writeFileSync(file,Buffer.concat([corrupt,Buffer.alloc(Math.max(0,TREE_RECORD_BYTES-corrupt.length),32),original.subarray(TREE_RECORD_BYTES)]));
 assert.throws(()=>zoom(store,null,{range:"0-31"}),/apocrypha_forget.*0-15/);
 }
 fs.unlinkSync(file);assert.throws(()=>zoom(store,null,{range:"0-31"}),/apocrypha_forget.*0-15/);
});
test("unsettled and invalid ranges fail rather than inventing data",t=>{
 const {store}=setup(t);store.append("a");store.append("b");
 assert.throws(()=>zoom(store,null,{range:"0-1"}),/apocrypha_forget/);
 for(const r of ["0-0","1-2","0-9007199254740992","0-4503599627370496","4294967296-4294967298","-1-2"])assert.throws(()=>parseRange(r));
 assert.throws(()=>zoom(store,null,{id:"#9007199254740993"}),/Invalid/);
});
test("long multi-byte transcript pages reconstruct exactly and fit 20KB",()=>{
 const text="t1\n"+"🪴é".repeat(10000);
 let recovered="",part=1;
 while(true){
 const result=readPage(text,{id:"t1",part},"t1");
 assert.ok(Buffer.byteLength(result)<=PAGE_BYTES);
 const lines=result.split("\n");lines.shift();
 const next=lines.at(-1)?.startsWith("Next command:");
 if(next)lines.pop();
 recovered+=lines.join("\n");if(!next)break;part++;
 }
 assert.equal(recovered,text);assert.ok(part>1);
});
test("regex remains compatible but pathological searches time out",async()=>{
 assert.match(await safeSearch(["#1 alpha","#2 beta"],"alpha|beta"),/2 of 2 matches/);
 assert.equal(await safeSearch(["x"],"none"),"No match.");
 await assert.rejects(safeSearch(["x"],"["),/Bad regex/);
 await assert.rejects(safeSearch(["a".repeat(50000)+"!"],"^(a+)+$"),/budget/);
});

test("paged reads reject changed snapshots rather than splice new data",()=>{
 const first=readPage("x".repeat(30000),{id:"t1"},"t1");
 const args=JSON.parse(first.match(/Next command: apocrypha_recall\((.*)\)$/)[1]);
 assert.throws(()=>readPage("y".repeat(30000),args,"t1"),/changed/);
});
