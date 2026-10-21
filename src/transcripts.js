import fs from 'node:fs';
import path from 'node:path';
import { withWriterLock } from './writer-lock.js';
import { ApocryphaStore, turnLeafText, turnLeafId } from './storage.js';
import { randomBytes, createHash } from 'node:crypto';

// No application cap on transcript turns: the binding limits are the clients'
// own tool-argument and output limits. The HTTP body limit (server.js) sits
// well above anything a client is expected to send.
const TOKEN = /^apx-[a-z2-7]{4}-[a-z]{4}$/;
const ID = /^t[1-9]\d*$/;
const VENDORS = new Set(['claude', 'chatgpt']);
const OMITTED = new Set(['id', 'account', 'suicide', 'self-harm', 'disordered-eating', 'attachment', 'length']);
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);

export function assertSafeText(text) {
  if (typeof text !== 'string') throw new Error('Transcript text must be a string.');
  // Turn text is stored verbatim, numbers included. The only content rule is
  // the origin marker, which must never be copied into the log.
  if (/⟦\s*mint\b/u.test(text)) throw new Error('Do not store origin markers. Resend with only the bare conversation token.');
}

export const assertAllowedText = assertSafeText;

export function pacificTimestamp(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('Invalid server clock.');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.timeZoneName.replace('GMT', '') || '+00:00'}`;
}

export function validateChatUrl(value, vendor) {
  if (!VENDORS.has(vendor) || typeof value !== 'string') throw new Error('Invalid vendor or chat URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid canonical chat URL.'); }
  const host = vendor === 'claude' ? 'claude.ai' : 'chatgpt.com';
  const prefix = vendor === 'claude' ? 'chat' : 'c';
  if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password || url.search || url.hash ||
      !new RegExp(`^/${prefix}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, 'i').test(url.pathname) || url.href !== value) {
    throw new Error(`Use a canonical https://${host}/${prefix}/<uuid> URL without query, fragment, credentials, or extra path.`);
  }
  return url.href;
}

function requestKey(value) {
  if (value !== undefined && (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{8,128}$/.test(value))) throw new Error('requestId must contain 8–128 letters, digits, dots, colons, underscores, or hyphens.');
  return value;
}
function records(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 10) throw new Error(`Incomplete append in ${path.basename(file)}; preserve the file and request operator recovery. No automatic truncation.`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return text.slice(0, -1).split('\n').map((line, i) => {
    try { const v = JSON.parse(line); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); return v; }
    catch { throw new Error(`Corrupt ${path.basename(file)} record ${i + 1}; request operator recovery.`); }
  });
}
function appendRecord(file, record) {
  const data = Buffer.from(`${JSON.stringify(record)}\n`);
  const fd = fs.openSync(file, 'a', 0o600);
  try { let offset = 0; while (offset < data.length) { const written = fs.writeSync(fd, data, offset, data.length - offset); if (!written) throw new Error('Append made no progress.'); offset += written; } fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

/** Own assistant text copies, not canonical vendor exports. No implicit capture or Drive mirror. */
export class TranscriptStore {
  constructor(directory, options = {}) {
    if (!directory) throw new Error('Transcript directory is required.');
    this.directory = path.resolve(directory);
    this.turnFile = path.join(this.directory, 'TRANSCRIPTS.jsonl');
    this.conversationFile = path.join(this.directory, 'CONVERSATIONS.jsonl');
    this.lockFile = path.join(this.directory, '.transcripts-write.lock');
    this.clock = options.clock || (() => new Date());
    this.lazyResolution = options.lazyResolution === true;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.state();
  }
  locked(fn) { return withWriterLock(this.directory, fn); }
  state() {
    const events = records(this.conversationFile);
    const conversations = new Map();
    for (const e of events) {
      if (!TOKEN.test(e.token) || !VENDORS.has(e.vendor) || !Number.isFinite(Date.parse(e.at))) throw new Error('Corrupt conversation event.');
      if (e.type === 'created') {
        if (conversations.has(e.token)) throw new Error('Duplicate conversation token.');
        conversations.set(e.token, { token: e.token, vendor: e.vendor, at: e.at, link: '', attempts: 0, everAmbiguous: false, status: 'unresolved', firstAttemptAt: null, creationRequestId: e.requestId, creationRequestHash: e.requestHash });
      } else {
        const c = conversations.get(e.token);
        if (!c || c.vendor !== e.vendor) throw new Error('Conversation event has no matching creation.');
        if (e.type === 'resolved') { c.link = validateChatUrl(e.url, e.vendor); c.status = 'resolved'; }
        else if (e.type === 'attempt') {
          if (!['missing', 'ambiguous'].includes(e.outcome)) throw new Error('Corrupt resolution outcome.');
          c.attempts += 1; c.firstAttemptAt ||= e.at;
          if (e.outcome === 'ambiguous') c.everAmbiguous = true;
          c.status = c.attempts >= 10 && Date.parse(e.at) - Date.parse(c.firstAttemptAt) >= 7 * 86400_000 ? 'unresolvable' : (e.outcome === 'ambiguous' || c.status === 'ambiguous') ? 'ambiguous' : 'unresolved';
        } else throw new Error('Unknown conversation event.');
      }
    }
    const turns = records(this.turnFile);
    const last = new Map();
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i], c = conversations.get(t.conv);
      if (t.id !== `t${i + 1}` || !c || c.vendor !== t.vendor || !Number.isSafeInteger(t.turn) || t.turn <= (last.get(t.conv) || 0) ||
          typeof t.user !== 'string' || typeof t.assistant !== 'string' || (t.summary !== undefined && typeof t.summary !== 'string') || !Number.isFinite(Date.parse(t.at))) throw new Error('Corrupt transcript record or sequence.');
      last.set(t.conv, t.turn);
    }
    return { events, conversations, turns, last };
  }
  append(input) {
    if (!input || !VENDORS.has(input.vendor)) throw new Error('An explicit vendor, claude or chatgpt, is required.');
    assertSafeText(input.user); assertSafeText(input.assistant);
    if (input.summary !== undefined) assertSafeText(input.summary);
    if (input.omitted !== undefined && !OMITTED.has(input.omitted)) throw new Error('omitted must be one category word: id, account, suicide, self-harm, disordered-eating, attachment, or length.');
    if (input.conv !== undefined && !TOKEN.test(input.conv)) throw new Error('Invalid conversation token.');
    if (input.turn !== undefined && (!Number.isSafeInteger(input.turn) || input.turn < 1)) throw new Error('turn must be a positive safe integer.');
    const requestId = requestKey(input.requestId);
    const digest = hash(canonical({ conv: input.conv ?? null, vendor: input.vendor, turn: input.turn ?? null, user: input.user, assistant: input.assistant, omitted: input.omitted ?? null, ...(input.summary !== undefined ? {summary: input.summary} : {}) }));
    return this.locked(() => {
      const s = this.state();
      if (requestId) {
        const prior = s.turns.find(t => t.requestId === requestId);
        if (prior) { if (prior.requestHash !== digest) throw new Error('requestId was already used with different turn content.'); this.reconcileUnlocked(); return { ...prior, replayed: true }; }
      }
      let conv = input.conv;
      let created = false;
      if (!conv) {
        const orphan = requestId && [...s.conversations.values()].find(c => c.creationRequestId === requestId);
        if (orphan) { if (orphan.vendor !== input.vendor || orphan.creationRequestHash !== digest) throw new Error('requestId vendor conflict.'); conv = orphan.token; }
        else {
          const alphabet = 'abcdefghijklmnopqrstuvwxyz234567', consonants = 'bcdfghjklmnprstvwz', vowels = 'aeiou';
          do { const b = randomBytes(8); conv = 'apx-' + [...b.subarray(0, 4)].map(n => alphabet[n & 31]).join('') + '-' + consonants[b[4] % consonants.length] + vowels[b[5] % vowels.length] + consonants[b[6] % consonants.length] + vowels[b[7] % vowels.length]; } while (s.conversations.has(conv));
          created = true;
        }
      }
      const c = s.conversations.get(conv);
      if (!created && (!c || c.vendor !== input.vendor)) throw new Error('Unknown conversation or vendor mismatch.');
      const turn = input.turn ?? ((s.last.get(conv) || 0) + 1);
      if (turn <= (s.last.get(conv) || 0)) throw new Error('turn must increase; use the original requestId to retry an append.');
      const at = pacificTimestamp(this.clock());
      const record = { id: `t${s.turns.length + 1}`, conv, vendor: input.vendor, turn, at, user: input.user, assistant: input.assistant };
      if (input.summary !== undefined) record.summary = input.summary;
      if (input.omitted !== undefined) record.omitted = input.omitted;
      if (requestId) { record.requestId = requestId; record.requestHash = digest; }
      if (created) appendRecord(this.conversationFile, { type: 'created', token: conv, vendor: input.vendor, at, ...(requestId ? { requestId, requestHash: digest } : {}) });
      appendRecord(this.turnFile, record);
      this.reconcileUnlocked({ freshId: record.id });
      return { ...record, newConversation: created };
    });
  }
  missingLeaves(store = new ApocryphaStore(this.directory)) {
    const present = new Set(store.entries().map(turnLeafId).filter(Boolean));
    return this.entries().filter(t => !present.has(t.id));
  }
  reconcileUnlocked({ freshId, summaries = {}, ids } = {}) {
    const store = new ApocryphaStore(this.directory);
    const missing = this.missingLeaves(store).filter(turn => !ids || ids.includes(turn.id));
    for (const turn of missing) {
      store.appendUnlocked(turnLeafText(turn, { backfill: turn.id !== freshId, summary: summaries[turn.id] }));
    }
    return { added: missing.length, ids: missing.map(t => t.id) };
  }
  reconcile({ dryRun = false, ...options } = {}) {
    return this.locked(() => dryRun
      ? { added: this.missingLeaves().length, dryRun: true }
      : this.reconcileUnlocked(options));
  }
  entries() { return this.state().turns; }
  get(id) {
    if (!ID.test(id)) throw new Error('Invalid transcript id.');
    const result = this.state().turns.find(t => t.id === id);
    if (!result) throw new Error(`Transcript ${id} does not exist.`);
    return result;
  }
  getConversation(token) { return this.state().conversations.get(token) || null; }
  unresolved(vendor) {
    if (!VENDORS.has(vendor)) throw new Error('Explicit vendor is required for unresolved conversations.');
    if (!this.lazyResolution) return [];
    return [...this.state().conversations.values()].filter(c => c.vendor === vendor && !c.link && c.status !== 'unresolvable').sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, 5);
  }
  resolve(input) {
    if (!input || !TOKEN.test(input.token)) throw new Error('Invalid conversation token.');
    const requestId = requestKey(input.requestId);
    const digest = hash(canonical(input));
    return this.locked(() => {
      const s = this.state(), c = s.conversations.get(input.token);
      if (!c) throw new Error('Unknown conversation.');
      if (requestId) {
        const prior = s.events.find(e => e.type !== 'created' && e.requestId === requestId);
        if (prior) { if (prior.requestHash !== digest) throw new Error('requestId was already used with different resolution evidence.'); return { ...c, replayed: true }; }
      }
      const at = pacificTimestamp(this.clock());
      const base = { token: c.token, vendor: c.vendor, at, ...(requestId ? { requestId, requestHash: digest } : {}) };
      const candidates = input.candidates ?? [];
      if (!Array.isArray(candidates) || candidates.length > 20) throw new Error('Provide at most 20 candidate URL/snippet pairs.');
      const verified = new Map();
      for (const candidate of candidates) {
        if (!candidate || typeof candidate.snippet !== 'string' || Buffer.byteLength(candidate.snippet) > 20_000) throw new Error('Invalid candidate snippet.');
        const url = validateChatUrl(candidate.url, c.vendor);
        if (!candidate.snippet.includes(`⟦mint ${c.token}⟧`)) throw new Error('Candidate does not contain the exact origin marker; a bare-token hit is not evidence.');
        verified.set(url, hash(candidate.snippet));
      }
      if (verified.size > 1) {
        if (c.link) throw new Error('Already-linked conversations cannot receive ambiguous attempts.');
        if (input.url) throw new Error('Ambiguous origin markers: remove url and record the ambiguous attempt; resolve neither.');
        appendRecord(this.conversationFile, { ...base, type: 'attempt', outcome: 'ambiguous', candidateHashes: [...verified].map(([url, snippet]) => hash(`${url}:${snippet}`)) });
      } else if (input.url !== undefined) {
        const url = validateChatUrl(input.url, c.vendor);
        if (!verified.has(url)) throw new Error('Resolution requires the exact origin marker in a matching candidate snippet.');
        if ((c.link || c.everAmbiguous) && !input.correction) throw new Error('Conversation is already linked or has conflicting origin evidence; an explicit reviewed correction is required.');
        if (input.outcome !== undefined) throw new Error('Do not combine a resolved URL with an attempt outcome.');
        appendRecord(this.conversationFile, { ...base, type: 'resolved', url, correction: input.correction === true, evidenceHash: verified.get(url) });
      } else {
        if (c.link) throw new Error('Already-linked conversations cannot receive failed attempts.');
        if (input.outcome !== 'missing' || verified.size) throw new Error('A missing attempt requires outcome: missing and no candidate hits; one verified hit requires url.');
        appendRecord(this.conversationFile, { ...base, type: 'attempt', outcome: 'missing' });
      }
      return this.getConversation(c.token);
    });
  }
}
