#!/usr/bin/env node
// One-time import of pre-Apocrypha Claude and ChatGPT exports into the
// reserved log slots. Each exported turn (a user message plus the assistant
// reply on the conversation's current branch) becomes a transcript record and
// a turn leaf, in time order across both vendors, starting at slot 0. Each
// conversation gets a token already linked to its real chat URL.
// Text, including numbers, is retained. Run with the service
// stopped and a backup taken. Dry run unless --apply.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withWriterLock } from '../src/writer-lock.js';
import { ApocryphaStore, LOG_RECORD_BYTES, blankRecord, turnLeafText } from '../src/storage.js';
import { TranscriptStore, pacificTimestamp, validateChatUrl } from '../src/transcripts.js';
const redact = text => ({text,found:[]});

const SOURCE = 'export-2026-01-29';
const text = value => (typeof value === 'string' ? value : '').replace(/⟦\s*mint\b/gu, '[mint]');

function claudeConversations(file) {
  const out = [];
  for (const c of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    let messages = c.chat_messages || [];
    if (messages.length && messages.every(m => m.parent_message_uuid)) {
      const byId = new Map(messages.map(m => [m.uuid, m]));
      let node = messages.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a));
      const chain = [];
      while (node && !chain.includes(node)) { chain.push(node); node = byId.get(node.parent_message_uuid); }
      messages = chain.reverse();
    }
    out.push({
      vendor: 'claude', id: c.uuid, created: c.created_at,
      url: `https://claude.ai/chat/${c.uuid}`,
      messages: messages.map(m => ({
        role: m.sender === 'human' ? 'user' : 'assistant',
        at: m.created_at,
        text: text(m.text) || (m.content || []).filter(x => x.type === 'text').map(x => text(x.text)).join('\n\n'),
      })),
    });
  }
  return out;
}

function chatgptConversations(file) {
  const out = [];
  for (const c of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    const id = c.conversation_id || c.id;
    const chain = [];
    let node = c.mapping?.[c.current_node];
    while (node && !chain.includes(node)) { chain.push(node); node = c.mapping[node.parent]; }
    const messages = [];
    for (const n of chain.reverse()) {
      const m = n.message;
      const role = m?.author?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (m.metadata?.is_visually_hidden_from_conversation) continue;
      if (!['text', 'multimodal_text'].includes(m.content?.content_type)) continue;
      const body = (m.content.parts || []).filter(p => typeof p === 'string').map(text).join('\n\n');
      messages.push({ role, at: new Date((m.create_time ?? c.create_time) * 1000).toISOString(), text: body });
    }
    out.push({ vendor: 'chatgpt', id, created: new Date(c.create_time * 1000).toISOString(), url: `https://chatgpt.com/c/${id}`, messages });
  }
  return out;
}

function turnsOf(conversation) {
  const turns = [];
  let current = null;
  for (const m of conversation.messages) {
    if (m.role === 'user') { current = { at: m.at, user: m.text, assistant: [] }; turns.push(current); }
    else if (current) current.assistant.push(m.text);
  }
  return turns.map(t => ({ ...t, assistant: t.assistant.filter(Boolean).join('\n\n') })).filter(t => t.user.trim() || t.assistant.trim());
}

function token(taken) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567', consonants = 'bcdfghjklmnprstvwz', vowels = 'aeiou';
  let value;
  do {
    const b = randomBytes(8);
    value = 'apx-' + [...b.subarray(0, 4)].map(n => alphabet[n & 31]).join('') + '-' + consonants[b[4] % consonants.length] + vowels[b[5] % vowels.length] + consonants[b[6] % consonants.length] + vowels[b[7] % vowels.length];
  } while (taken.has(value));
  taken.add(value);
  return value;
}

export function importBackfill(directory, { claude, chatgpt, apply = false } = {}) {
  const conversations = [...(claude ? claudeConversations(claude) : []), ...(chatgpt ? chatgptConversations(chatgpt) : [])];
  return withWriterLock(directory, () => {
    const store = new ApocryphaStore(directory);
    const transcripts = new TranscriptStore(directory);
    const state = transcripts.state();
    if (state.turns.some(t => t.source === SOURCE)) throw new Error('This export was already imported; refusing.');
    const taken = new Set(state.conversations.keys());

    const all = [];
    const events = [];
    const redactions = { id: 0, account: 0 };
    for (const c of conversations) {
      const turns = turnsOf(c);
      if (!turns.length) continue;
      const conv = token(taken);
      const at = pacificTimestamp(new Date(c.created));
      const url = validateChatUrl(c.url, c.vendor);
      events.push({ type: 'created', token: conv, vendor: c.vendor, at, source: SOURCE });
      events.push({ type: 'resolved', token: conv, vendor: c.vendor, at, url, correction: false, evidenceHash: createHash('sha256').update(`${SOURCE}:${c.id}`).digest('hex'), source: SOURCE });
      let previous = -Infinity;
      turns.forEach((t, i) => {
        const user = redact(t.user), assistant = redact(t.assistant);
        const found = new Set([...user.found, ...assistant.found]);
        for (const kind of found) redactions[kind]++;
        // Keep each conversation's turns in order even if a timestamp is missing or skewed.
        const parsed = Date.parse(t.at || c.created);
        const time = previous = Math.max(previous, Number.isFinite(parsed) ? parsed : previous);
        const userText = user.text.trim() ? user.text : '[no text: attachment or image only]';
        all.push({ conv, vendor: c.vendor, turn: i + 1, at: pacificTimestamp(new Date(time)), time, user: userText, assistant: assistant.text, omitted: found.has('account') ? 'account' : found.has('id') ? 'id' : undefined });
      });
    }
    all.sort((a, b) => a.time - b.time);

    const records = store.logRecords();
    if (all.length > records.length || records.slice(0, all.length).some(r => r !== null)) throw new Error(`Not enough empty reserved slots at the start of the log for ${all.length} turns.`);
    let next = state.turns.length;
    const turnRecords = all.map(t => {
      const record = { id: `t${++next}`, conv: t.conv, vendor: t.vendor, turn: t.turn, at: t.at, user: t.user, assistant: t.assistant, source: SOURCE };
      if (t.omitted) record.omitted = t.omitted;
      return record;
    });
    const leaves = turnRecords.map((r, slot) => `#${slot} ${r.at.slice(0, 10)} ${turnLeafText(r)}`);

    const summary = {
      applied: apply, conversations: events.length / 2, turns: all.length,
      claude: all.filter(t => t.vendor === 'claude').length, chatgpt: all.filter(t => t.vendor === 'chatgpt').length,
      first: all[0]?.at, last: all.at(-1)?.at, slots: `0-${all.length - 1}`, ids: `t${state.turns.length + 1}-t${next}`,
      redactedTurns: redactions, transcriptBytes: turnRecords.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)) + 1, 0),
      sampleLeaves: [leaves[0], leaves[Math.floor(leaves.length / 2)], leaves.at(-1)],
    };
    if (!apply) return summary;

    // Leaves first: if interrupted later, no transcript exists without its leaf,
    // so reconciliation never appends backfill leaves at the end of the log.
    const fd = fs.openSync(store.logFile, 'r+');
    try {
      leaves.forEach((line, slot) => {
        const body = Buffer.from(line, 'utf8');
        if (body.length > LOG_RECORD_BYTES - 1) throw new Error(`Leaf too long: ${line}`);
        const record = blankRecord(LOG_RECORD_BYTES); body.copy(record);
        fs.writeSync(fd, record, 0, record.length, slot * LOG_RECORD_BYTES);
      });
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.appendFileSync(transcripts.conversationFile, events.map(e => JSON.stringify(e) + '\n').join(''));
    const out = fs.openSync(transcripts.turnFile, 'a');
    try { for (const r of turnRecords) fs.writeSync(out, JSON.stringify(r) + '\n'); fs.fsyncSync(out); } finally { fs.closeSync(out); }
    return summary;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
  if (!args.dir) { console.error('Usage: import-backfill.mjs --dir=/var/lib/apocrypha --claude=conversations.json --chatgpt=conversations.json [--apply]'); process.exit(2); }
  console.log(JSON.stringify(importBackfill(path.resolve(args.dir), { claude: args.claude, chatgpt: args.chatgpt, apply: args.apply === true }), null, 1));
}
