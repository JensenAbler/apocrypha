import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TranscriptStore, pacificTimestamp, validateChatUrl, assertSafeText } from '../src/transcripts.js';

const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const other = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const url = `https://chatgpt.com/c/${uuid}`;
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-v2-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new TranscriptStore(directory, options);
}
const turn = { vendor: 'chatgpt', user: 'A synthetic question.', assistant: 'A synthetic answer.' };
const candidate = (token, link = url) => ({ url: link, snippet: `Origin: ⟦mint ${token}⟧` });

test('append survives restart, preserves exact text and uses server Pacific date', t => {
  const s = fixture(t, { clock: () => new Date('2026-10-20T01:00:00Z') });
  const a = s.append({ ...turn, user: '  exact\ntext 🧪  ' });
  assert.equal(a.id, 't1'); assert.equal(a.turn, 1); assert.match(a.conv, /^apx-[a-z2-7]{4}-[a-z]{4}$/);
  assert.equal(a.at, '2026-10-19T18:00:00-07:00');
  const fresh = new TranscriptStore(s.directory);
  assert.equal(fresh.get(a.id).user, '  exact\ntext 🧪  ');
  const b = fresh.append({ ...turn, conv: a.conv, turn: 4 });
  assert.equal(b.id, 't2'); assert.equal(b.turn, 4);
  assert.equal(fresh.append({ ...turn, conv: a.conv }).turn, 5);
  assert.throws(() => fresh.append({ ...turn, conv: a.conv, turn: 3 }), /must increase/);
});

test('Pacific timestamp follows DST, including winter', () => {
  assert.equal(pacificTimestamp(new Date('2026-12-20T01:00:00Z')), '2026-12-19T17:00:00-08:00');
});

test('idempotent first writes and retries do not duplicate, changed content rejects', t => {
  const s = fixture(t); const a = s.append({ ...turn, requestId: 'first-turn-0001' });
  const before = fs.readFileSync(s.turnFile);
  const b = new TranscriptStore(s.directory).append({ ...turn, requestId: 'first-turn-0001' });
  assert.equal(b.id, a.id); assert.equal(b.conv, a.conv); assert.equal(b.replayed, true);
  assert.deepEqual(fs.readFileSync(s.turnFile), before);
  assert.throws(() => s.append({ ...turn, user: 'Changed', requestId: 'first-turn-0001' }), /different turn content/);
});

test('orphan conversation from interrupted first write recovers with same key only', t => {
  const s = fixture(t); const a = s.append({ ...turn, requestId: 'orphan-turn-0001' });
  fs.unlinkSync(s.turnFile); // synthetic crash fixture, not a production recovery procedure
  const recovered = new TranscriptStore(s.directory).append({ ...turn, requestId: 'orphan-turn-0001' });
  assert.equal(recovered.conv, a.conv); assert.equal(recovered.id, 't1');
  assert.equal(fs.readFileSync(s.conversationFile, 'utf8').trim().split('\n').length, 1);
});

test('multiple store instances serialize, fail closed on outstanding lock', t => {
  const a = fixture(t), b = new TranscriptStore(a.directory);
  assert.equal(a.append(turn).id, 't1'); assert.equal(b.append(turn).id, 't2');
  fs.writeFileSync(a.lockFile, 'unknown writer');
  assert.throws(() => b.append(turn), /writer is busy/);
  assert.equal(b.entries().length, 2);
  assert.equal(fs.readFileSync(a.lockFile, 'utf8'), 'unknown writer');
});

test('partial and corrupt JSONL never repaired, truncated, or overwritten', t => {
  const s = fixture(t); s.append(turn); fs.appendFileSync(s.turnFile, '{"id":');
  const before = fs.readFileSync(s.turnFile);
  assert.throws(() => new TranscriptStore(s.directory), /Incomplete append/);
  assert.throws(() => s.append(turn), /Incomplete append/);
  assert.deepEqual(fs.readFileSync(s.turnFile), before);
  fs.appendFileSync(s.turnFile, '\n');
  assert.throws(() => new TranscriptStore(s.directory), /Corrupt TRANSCRIPTS/);
});

test('no application cap: a multi-megabyte turn saves and survives restart', t => {
  const s = fixture(t);
  const big = '😀'.repeat(600_000); // 2.4 MB of UTF-8
  const a = s.append({ ...turn, user: big });
  assert.equal(new TranscriptStore(s.directory).get(a.id).user, big);
});

test('locally redacted exclusions, marker rejection and categories', t => {
  const s = fixture(t);
  for (const user of ['Synthetic 123-45-6789', 'Synthetic 1234567890', 'Account number AB12345', '⟦mint apx-abcd-baba⟧']) {
    assert.throws(() => s.append({ ...turn, user }), /redact|Redact|bare conversation token/i);
  }
  assert.equal(s.entries().length, 0);
  const a = s.append({ ...turn, user: '', assistant: '', omitted: 'self-harm' });
  assert.equal(a.omitted, 'self-harm');
  assert.throws(() => s.append({ ...turn, omitted: 'private detailed explanation' }), /category/);
  assert.doesNotThrow(() => assertSafeText('October 20, 2026 at 15:30.'));
});

test('unknown conversation and vendor mismatches never append', t => {
  const s = fixture(t), a = s.append(turn);
  assert.throws(() => s.append({ ...turn, conv: a.conv, vendor: 'claude' }), /vendor mismatch/);
  assert.throws(() => s.append({ ...turn, conv: 'apx-abcd-baba' }), /Unknown/);
  assert.throws(() => s.append({ ...turn, vendor: 'other' }), /explicit vendor/);
  assert.equal(s.entries().length, 1);
});

test('lazy resolution is disabled by default; validated explicit resolution remains available', t => {
  const s = fixture(t), a = s.append(turn);
  assert.deepEqual(s.unresolved('chatgpt'), []);
  assert.equal(s.resolve({ token: a.conv, url, candidates: [candidate(a.conv)] }).link, url);
});

test('strict canonical vendor URL validation rejects spoofing and non-chat paths', () => {
  assert.equal(validateChatUrl(url, 'chatgpt'), url);
  assert.equal(validateChatUrl(`https://claude.ai/chat/${uuid}`, 'claude'), `https://claude.ai/chat/${uuid}`);
  for (const bad of [url + '?x=1', url + '#x', url + '/', url.replace('https:', 'http:'), url.replace('chatgpt.com', 'chatgpt.com.evil.test'), url.replace('chatgpt.com', 'user@chatgpt.com'), url.replace('/c/', '/share/'), url.replace(uuid, 'not-a-chat'), url.replace('chatgpt.com', 'claude.ai')]) assert.throws(() => validateChatUrl(bad, 'chatgpt'));
});

test('bare-token or absent evidence cannot resolve; marked evidence persisted as hash only', t => {
  const s = fixture(t, { lazyResolution: true }), a = s.append(turn);
  assert.throws(() => s.resolve({ token: a.conv, url }), /origin marker/);
  assert.throws(() => s.resolve({ token: a.conv, url, candidates: [{ url, snippet: `Mention ${a.conv}` }] }), /bare-token/);
  assert.equal(s.getConversation(a.conv).link, '');
  const r = s.resolve({ token: a.conv, url, candidates: [candidate(a.conv)], requestId: 'resolve-one-0001' });
  assert.equal(r.link, url);
  assert.equal(fs.readFileSync(s.conversationFile, 'utf8').includes('⟦mint'), false);
  assert.deepEqual(s.unresolved('chatgpt'), []);
  assert.equal(s.resolve({ token: a.conv, url, candidates: [candidate(a.conv)], requestId: 'resolve-one-0001' }).replayed, true);
  assert.throws(() => s.resolve({ token: a.conv, url, candidates: [candidate(a.conv)] }), /correction/);
  const next = `https://chatgpt.com/c/${other}`;
  assert.equal(s.resolve({ token: a.conv, url: next, candidates: [candidate(a.conv, next)], correction: true }).link, next);
});

test('two marked URLs flag ambiguous and resolve neither, append-only history preserved', t => {
  const s = fixture(t, { lazyResolution: true }), a = s.append(turn);
  const before = fs.readFileSync(s.conversationFile);
  const candidates = [candidate(a.conv), candidate(a.conv, `https://chatgpt.com/c/${other}`)];
  assert.throws(() => s.resolve({ token: a.conv, url, candidates }), /Ambiguous/);
  const r = s.resolve({ token: a.conv, candidates });
  assert.equal(r.status, 'ambiguous'); assert.equal(r.link, ''); assert.equal(r.attempts, 1);
  assert.deepEqual(fs.readFileSync(s.conversationFile).subarray(0, before.length), before);
  assert.equal(s.unresolved('chatgpt')[0].status, 'ambiguous');
  assert.throws(() => s.resolve({ token: a.conv, url, candidates: [candidate(a.conv)] }), /reviewed correction/);
  s.resolve({ token: a.conv, outcome: 'missing' });
  assert.equal(s.getConversation(a.conv).status, 'ambiguous');
});

test('give-up needs BOTH 10 attempts and seven days, retries deduplicated', t => {
  let now = new Date('2026-10-20T12:00:00Z');
  const s = fixture(t, { lazyResolution: true, clock: () => now }), a = s.append(turn);
  for (let i = 0; i < 10; i++) s.resolve({ token: a.conv, outcome: 'missing', requestId: `attempt-key-${i}` });
  assert.equal(s.unresolved('chatgpt').length, 1);
  s.resolve({ token: a.conv, outcome: 'missing', requestId: 'attempt-key-9' });
  assert.equal(s.getConversation(a.conv).attempts, 10);
  now = new Date('2026-10-27T12:00:00Z');
  assert.equal(s.resolve({ token: a.conv, outcome: 'missing' }).status, 'unresolvable');
  assert.equal(s.unresolved('chatgpt').length, 0);
  assert.equal(new TranscriptStore(s.directory, { lazyResolution: true }).getConversation(a.conv).attempts, 11);
});

test('unresolved is oldest first, max five and vendor scoped', t => {
  const s = fixture(t, { lazyResolution: true });
  const first = s.append(turn);
  for (let i = 0; i < 7; i++) s.append(turn);
  s.append({ ...turn, vendor: 'claude' });
  assert.equal(s.unresolved('chatgpt').length, 5); assert.equal(s.unresolved('chatgpt')[0].token, first.conv);
  assert.equal(s.unresolved('claude').length, 1);
});

test('provenance UUIDs and ordinary account discussion are not account numbers', () => {
  assert.doesNotThrow(() => assertSafeText('Chat https://chatgpt.com/c/12345678-1234-1234-1234-123456789012'));
  assert.doesNotThrow(() => assertSafeText('The account settings were reviewed.'));
});

test('known ambiguity remains review-required even after give-up window', t => {
  let now = new Date('2026-10-20T12:00:00Z');
  const s = fixture(t, { lazyResolution: true, clock: () => now }), a = s.append(turn);
  s.resolve({token:a.conv,candidates:[candidate(a.conv),candidate(a.conv,`https://chatgpt.com/c/${other}`)]});
  for(let i=0;i<9;i++)s.resolve({token:a.conv,outcome:'missing'});
  now = new Date('2026-10-27T12:00:00Z');
  s.resolve({token:a.conv,outcome:'missing'});
  assert.equal(s.getConversation(a.conv).status,'unresolvable');
  assert.throws(()=>s.resolve({token:a.conv,url,candidates:[candidate(a.conv)]}),/correction/);
});

test('separate writer processes preserve unique sequential ids', async t => {
  const s = fixture(t);
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const exec = promisify(execFile);
  const code = `
    import { TranscriptStore } from ${JSON.stringify(new URL('../src/transcripts.js',import.meta.url).href)};
    const s = new TranscriptStore(process.argv[1]);
    for(let i=0;i<5;i++){
      let done=false;
      for(let attempt=0;attempt<100;attempt++){
        try { s.append({vendor:'chatgpt',user:'synthetic',assistant:'concurrent',requestId:process.argv[2]+'-'+i}); done=true;break; }
        catch(e){if(!e.message.includes('writer is busy'))throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
      }
      if(!done)throw new Error('Could not acquire test lock');
    }`;
  await Promise.all([0,1,2,3].map(i=>exec(process.execPath,['--input-type=module','-e',code,s.directory,'writer-process-'+i])));
  assert.deepEqual(s.entries().map(t=>t.id),Array.from({length:20},(_,i)=>'t'+(i+1)));
});
