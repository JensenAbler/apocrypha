#!/usr/bin/env node
// Parses archived Claude Code, Cowork (local agent mode) and Codex session
// files into turns: each human prompt plus the assistant's written replies.
// Tool calls, tool output and reasoning are left out of turns (the raw
// archive keeps them). Copies of the same session are deduplicated by id.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* walk(p); }
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}
// Parse a bounded chunk at a time and discard tool payloads immediately.
function rows(file) {
  const out = [], decoder = new StringDecoder('utf8'), buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, 'r'); let pending = '', lineNumber = 0;
  function consume(line) {
    lineNumber++; if (!line.trim()) return;
    let d; try { d=JSON.parse(line); } catch { throw new Error('Invalid archive JSONL at '+file+':'+lineNumber); }
    if (d.type === 'session_meta') out.push({type:d.type,payload:{id:d.payload?.id,cwd:d.payload?.cwd}});
    else if (d.type === 'event_msg' && ['user_message','agent_message'].includes(d.payload?.type))
      out.push({type:d.type,timestamp:d.timestamp,payload:{type:d.payload.type,message:d.payload.message}});
    else if (d.type === 'response_item' && (d.payload?.type==='agent_message' ||
      (d.payload?.type==='message' && ['user','assistant'].includes(d.payload?.role) && d.payload?.channel!=='analysis')))
      out.push({type:d.type,timestamp:d.timestamp,payload:{type:d.payload.type,role:d.payload.role,channel:d.payload.channel,message:d.payload.message,content:textOf(d.payload.content)}});
    else if (d.sessionId && ['user','assistant','summary','ai-title'].includes(d.type) && !d.isMeta && !d.isSidechain) {
      const c=d.message?.content;
      if (d.type==='user' && Array.isArray(c) && c.some(b=>b?.type==='tool_result')) return;
      out.push({type:d.type,sessionId:d.sessionId,cwd:d.cwd,timestamp:d.timestamp,aiTitle:d.aiTitle,summary:d.summary,message:d.message?{content:textOf(c)}:undefined});
    }
  }
  try {
    let n;
    while ((n=fs.readSync(fd,buffer,0,buffer.length,null))) {
      pending += decoder.write(buffer.subarray(0,n));
      let pos; while ((pos=pending.indexOf('\n'))!==-1) {consume(pending.slice(0,pos));pending=pending.slice(pos+1);}
    }
    pending += decoder.end(); if(pending.trim())consume(pending);
  } finally {fs.closeSync(fd);}
  return out;
}
export const textOf = c => typeof c === 'string' ? c : Array.isArray(c)
  ? c.filter(b => b && ['text', 'input_text', 'output_text'].includes(b.type)).map(b => b.text).join('\n\n') : '';
const finish = turns => turns.map(t => ({ ...t, assistant: t.assistant.join('\n\n') }));

export function claudeSession(file, list) {
  let id = null, cwd = null, title = null, cur = null;
  const turns = [];
  for (const d of list) {
    id ||= d.sessionId; cwd ||= d.cwd;
    if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
    if (d.type === 'summary' && d.summary) title ||= d.summary;
    if (d.isSidechain || d.isMeta || !d.message) continue;
    const c = d.message.content;
    if (d.type === 'user') {
      if (Array.isArray(c) && c.some(b => b?.type === 'tool_result')) continue;
      const t = textOf(c);
      if (t.trim()) { cur = { at: d.timestamp, user: t, assistant: [] }; turns.push(cur); }
    } else if (d.type === 'assistant' && cur) {
      const t = textOf(c);
      if (t.trim() && cur.assistant.at(-1) !== t) cur.assistant.push(t);
    }
  }
  const kind = file.includes('local-agent-mode') ? 'cowork' : 'claude-code';
  return { kind, vendor: 'claude', id, cwd, title, file, turns: finish(turns) };
}

export function codexSession(file, list) {
  let id = null, cwd = null, cur = null;
  const turns = [];
  const events = list.some(d => d.type === 'event_msg' && d.payload?.type === 'user_message');
  for (const d of list) {
    const p = d.payload || {};
    if (d.type === 'session_meta') { id ||= p.id; cwd ||= p.cwd; continue; }
    let role = null, text = '';
    if (events) {
      if (d.type === 'event_msg' && p.type === 'user_message') { role = 'user'; text = p.message || ''; }
      else if (d.type === 'event_msg' && p.type === 'agent_message') { role = 'assistant'; text = p.message || ''; }
    } else if (d.type === 'response_item') {
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        role = p.role; text = textOf(p.content);
        
      } else if (p.type === 'agent_message') { role = 'assistant'; text = p.message || textOf(p.content); }
    }
    if (role === 'user' && /^\s*(?:<(?:environment_context|user_instructions|permissions|INSTRUCTIONS)\b|# AGENTS\.md instructions\b|<turn_aborted>)/i.test(text)) role = null;
    if (role === 'assistant' && p.channel === 'analysis') role = null;
    if (!role || !text.trim()) continue;
    if (role === 'user') { cur = { at: d.timestamp, user: text, assistant: [] }; turns.push(cur); }
    else if (cur && cur.assistant.at(-1) !== text) cur.assistant.push(text);
  }
  id ||= path.basename(file).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  return { kind: 'codex', vendor: 'chatgpt', id, cwd, title: null, file, turns: finish(turns) };
}

export function parseArchive(root) {
  const best = new Map();
  let files = 0, copies = 0;
  for (const file of walk(root)) {
    const list = rows(file);
    const codex = list.some(d => d.type === 'session_meta' || d.type === 'response_item');
    const claude = !codex && list.some(d => d.sessionId && (d.type === 'user' || d.type === 'assistant'));
    if (!codex && !claude) continue;
    files++;
    const s = codex ? codexSession(file, list) : claudeSession(file, list);
    if (!s.id || !s.turns.length) continue;
    const key = `${s.vendor}:${s.id}`;
    const prior = best.get(key);
    if (prior) copies++;
    if (!prior || s.turns.length > prior.turns.length) best.set(key, s);
  }
  return { files, copies, sessions: [...best.values()].map(s => ({...s, turns:s.turns.map((t,i)=>({...t,messageId:s.id+':'+i,sourceOrder:i}))})) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  const split = Date.parse(process.argv[3] || '2026-08-22T00:00:00-07:00');
  const { files, copies, sessions } = parseArchive(root);
  const byKind = {};
  let before = 0, after = 0, first = null, last = null;
  for (const s of sessions) {
    const k = byKind[s.kind] ||= { sessions: 0, turns: 0 };
    k.sessions++; k.turns += s.turns.length;
    for (const t of s.turns) {
      const time = Date.parse(t.at);
      if (time < split) before++; else after++;
      if (!first || t.at < first) first = t.at;
      if (!last || t.at > last) last = t.at;
    }
  }
  const sample = sessions.find(s => s.kind === 'codex' && s.turns.length > 1) || sessions[0];
  console.log(JSON.stringify({ files, duplicateCopies: copies, uniqueSessions: sessions.length, byKind, turnsBeforeSplit: before, turnsAfterSplit: after, first, last,
    sample: { kind: sample?.kind, title: sample?.title, firstPrompt: sample?.turns[0]?.user.slice(0, 160), firstReply: sample?.turns[0]?.assistant.slice(0, 160) } }, null, 1));
}
