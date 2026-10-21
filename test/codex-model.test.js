
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { codexModel } from '../src/codex-model.js';
import { modelFromEnvironment } from '../src/compactor.js';
test('Codex adapter accepts subscription auth only, isolates execution, and reads final output',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'apx-codex-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const model=codexModel({home,run:async(binary,args,options)=>{
   assert.ok(args.includes('--ignore-user-config'));assert.ok(args.includes('read-only'));assert.ok(args.includes('--ephemeral'));
   assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'),false);
   assert.equal(options.input,'source');
   await fs.writeFile(args[args.indexOf('-o')+1],'summary\n');
 }});
 await assert.rejects(model('source'),/subscription login/);
 await fs.writeFile(path.join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'synthetic'}));
 await assert.rejects(model('source'),/subscription login/);
 await fs.writeFile(path.join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic'}}));
 assert.equal(await model('source'),'summary');
 assert.deepEqual(await fs.readdir(home),['auth.json']);
});
test('explicit free Groq fallback is used after missing subscription auth, without provider switching',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'apx-codex-fallback-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 let endpoint;
 const model=modelFromEnvironment({
  APOCRYPHA_COMPACTOR_PROVIDER:'codex',APOCRYPHA_COMPACTOR_CODEX_HOME:home,
  APOCRYPHA_COMPACTOR_FALLBACK_PROVIDER:'groq',APOCRYPHA_COMPACTOR_FALLBACK_MODEL:'openai/gpt-oss-120b',
  APOCRYPHA_COMPACTOR_FALLBACK_API_KEY:'synthetic-free-key',
 },async(url,options)=>{
  endpoint=url;assert.equal(JSON.parse(options.body).model,'openai/gpt-oss-120b');
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'chatgpt: topic'}}]}));
 });
 assert.equal(await model('source'),'chatgpt: topic');
 assert.equal(endpoint,'https://api.groq.com/openai/v1/chat/completions');
 assert.equal(model.lastBackend,'groq');assert.match(model.lastFallback.reason,/subscription login/);
});
