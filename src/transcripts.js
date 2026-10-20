import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  if (/⟦\s*mint\b/u.test(text)) throw new Error('Do not store origin markers. Resend with only the bare conversation token.');
  // UUID chat IDs are provenance, not inferred financial/government identifiers.
  let screened = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '[chat-id]');
  screened = screened.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/gu, (value, y, m, d) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? '[date]' : value;
  });
  // A bare word such as "account" next to a year is not identifier evidence.
  const labelled = /\b(?:account|passport|license|licence|routing|social security|ssn|taxpayer|member id)\s*(?:number\b|no\.?\b|#|:)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/giu;
  if (/\b\d{3}[- ]\d{2}[- ]\d{4}\b|\b\d{9,}\b|\b(?:\d[ -]?){13,19}\b/u.test(screened) ||
      [...screened.matchAll(labelled)].some(match => /\d/.test(match[1]))) {
    throw new Error('Possible ID or account number.');
  }
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

// Acquisition, release and stale-owner replacement all hold this guard. We never
// recover a stale guard automatically: that would reintroduce the unlink race.
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function sameInode(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function processIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || !/^\d+$/.test(fields[19] || '')) throw new Error('Unverifiable process identity.');
  return { start: fields[19], state: fields[0] };
}
function localIdentity() {
  if (process.platform !== 'linux') throw new Error('Transcript locking requires Linux process identity; no unsafe fallback.');
  return {
    version: 2,
    machine: hash(fs.readFileSync('/etc/machine-id', 'utf8').trim()),
    host: os.hostname(),
    boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    namespace: fs.readlinkSync('/proc/self/ns/pid'),
    pid: process.pid,
    start: processIdentity(process.pid).start,
  };
}
function ownerIsProvablyDead(owner, local) {
  if (!owner || owner.version !== 2 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^\d+$/.test(owner.start || '') ||
      ['machine', 'host', 'boot', 'namespace'].some(key => typeof owner[key] !== 'string' || owner[key] !== local[key])) return false;
  try {
    const current = processIdentity(owner.pid);
    // Same PID with a different birth time means PID reuse, not the old writer.
    return current.start !== owner.start || current.state === 'Z' || current.state === 'X';
  } catch (error) {
    if (error.code !== 'ENOENT') return false;
    // Two independent local observations; EPERM or any ambiguity is not death.
    try { process.kill(owner.pid, 0); return false; }
    catch (killError) { return killError.code === 'ESRCH'; }
  }
}
function withRecoveryGuard(store, fn) {
  const guard = `${store.lockFile}.recovery`;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let held = false;
  for (let tries = 0; tries < 100; tries++) {
    try { fs.mkdirSync(guard, { mode: 0o700 }); held = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; Atomics.wait(sleeper, 0, 0, 10); }
  }
  if (!held) throw new Error('Transcript writer is busy: recovery guard is held. A stopped guard owner requires operator verification; no automatic guard deletion.');
  const inode = fs.lstatSync(guard);
  try { return fn(); }
  finally {
    const current = fs.lstatSync(guard);
    if (!current.isDirectory() || !sameInode(inode, current)) throw new Error('Recovery guard identity changed; refusing removal.');
    fs.rmdirSync(guard); syncDirectory(store.directory);
  }
}
function acquireWriter(store) {
  const local = localIdentity();
  return withRecoveryGuard(store, () => {
    try {
      const fd = fs.openSync(store.lockFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let inode, owner, ownerText;
      try {
        inode = fs.fstatSync(fd);
        if (!inode.isFile() || inode.nlink !== 1 || inode.size > 8192) throw new Error('Unverifiable writer lock; operator verification required.');
        try { ownerText = fs.readFileSync(fd, 'utf8'); owner = JSON.parse(ownerText); } catch { owner = null; }
      } finally { fs.closeSync(fd); }
      if (!ownerIsProvablyDead(owner, local)) throw new Error('Transcript writer is busy or ownership is unverified. Live, foreign, old-boot and legacy locks require completion or operator verification.');
      const current = fs.lstatSync(store.lockFile);
      if (!current.isFile() || !sameInode(inode, current) || current.nlink !== 1 || fs.readFileSync(store.lockFile, 'utf8') !== ownerText || !ownerIsProvablyDead(owner, local)) throw new Error('Writer lock identity changed; refusing stale recovery.');
      fs.unlinkSync(store.lockFile);
      syncDirectory(store.directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // The guard excludes all compliant acquisition/release/recovery competitors.
    const fd = fs.openSync(store.lockFile, 'wx', 0o600);
    const inode = fs.fstatSync(fd);
    try { fs.writeFileSync(fd, `${JSON.stringify(local)}\n`); fs.fsyncSync(fd); syncDirectory(store.directory); }
    catch (error) { fs.closeSync(fd); throw error; } // Preserve uncertain lock, never guess.
    return { fd, inode };
  });
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
  locked(fn) {
    const lock = acquireWriter(this);
    try { return fn(); }
    finally {
      try {
        withRecoveryGuard(this, () => {
          const current = fs.lstatSync(this.lockFile);
          if (!current.isFile() || !sameInode(lock.inode, current) || current.nlink !== 1) throw new Error('Writer lock identity changed; refusing release.');
          fs.unlinkSync(this.lockFile); syncDirectory(this.directory);
        });
      } finally { fs.closeSync(lock.fd); }
    }
  }
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
          typeof t.user !== 'string' || typeof t.assistant !== 'string' || !Number.isFinite(Date.parse(t.at))) throw new Error('Corrupt transcript record or sequence.');
      last.set(t.conv, t.turn);
    }
    return { events, conversations, turns, last };
  }
  append(input) {
    if (!input || !VENDORS.has(input.vendor)) throw new Error('An explicit vendor, claude or chatgpt, is required.');
    assertSafeText(input.user); assertSafeText(input.assistant);
    if (input.omitted !== undefined && !OMITTED.has(input.omitted)) throw new Error('omitted must be one category word: id, account, suicide, self-harm, disordered-eating, attachment, or length.');
    if (input.conv !== undefined && !TOKEN.test(input.conv)) throw new Error('Invalid conversation token.');
    if (input.turn !== undefined && (!Number.isSafeInteger(input.turn) || input.turn < 1)) throw new Error('turn must be a positive safe integer.');
    const requestId = requestKey(input.requestId);
    const digest = hash(canonical({ conv: input.conv ?? null, vendor: input.vendor, turn: input.turn ?? null, user: input.user, assistant: input.assistant, omitted: input.omitted ?? null }));
    return this.locked(() => {
      const s = this.state();
      if (requestId) {
        const prior = s.turns.find(t => t.requestId === requestId);
        if (prior) { if (prior.requestHash !== digest) throw new Error('requestId was already used with different turn content.'); return { ...prior, replayed: true }; }
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
      if (input.omitted !== undefined) record.omitted = input.omitted;
      if (requestId) { record.requestId = requestId; record.requestHash = digest; }
      if (created) appendRecord(this.conversationFile, { type: 'created', token: conv, vendor: input.vendor, at, ...(requestId ? { requestId, requestHash: digest } : {}) });
      appendRecord(this.turnFile, record);
      return { ...record, newConversation: created };
    });
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
