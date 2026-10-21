import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function codexModel({ home, model, binary = 'codex', run = runCodex }) {
  if (!home || !path.isAbsolute(home)) throw new Error('Codex compactor requires an absolute dedicated auth directory.');
  return async source => {
    // Refuse API authentication even if a parent process supplies an API key.
    let auth;
    try { auth=JSON.parse(await fs.readFile(path.join(home,'auth.json'),'utf8')); }
    catch { throw new Error('Codex subscription login is required.'); }
    if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token || auth.OPENAI_API_KEY) throw new Error('Codex subscription login is required; API-key auth is not accepted.');
    const directory=await fs.mkdtemp(path.join(home,'summary-'));
    try {
      const output=path.join(directory,'result.txt');
      const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only',
        '-c','approval_policy="never"','-c','web_search="disabled"',
        '--disable','shell_tool','--disable','multi_agent','--disable','apps','--disable','plugins','--disable','hooks',
        '--disable','browser_use','--disable','computer_use','--disable','image_generation',
        '-o',output,...(model?['-m',model]:[]),'-'];
      await run(binary,args,{cwd:directory,home,input:source});
      // The CLI adds a transport newline; model-internal newlines still fail validation.
      return (await fs.readFile(output,'utf8')).replace(/\r?\n$/u,'');
    } finally {await fs.rm(directory,{recursive:true,force:true});}
  };
}
export function runCodex(binary,args,{cwd,home,input}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{cwd,env:{
      PATH:process.env.PATH,HOME:home,CODEX_HOME:home,
      LANG:'C.UTF-8',NO_COLOR:'1',
    },stdio:['pipe','ignore','ignore']});
    // stderr can contain prompt excerpts; errors expose exit status only.
    const timer=setTimeout(()=>{child.kill('SIGKILL');},120_000);
    child.on('error',()=>{clearTimeout(timer);reject(new Error('Codex CLI could not start.'));});
    child.on('close',(code,signal)=>{clearTimeout(timer);code===0?resolve():reject(new Error('Codex CLI failed ('+(signal||code)+').'));});
    child.stdin.on('error',()=>{});
    child.stdin.end(input);
  });
}
