import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { TranscriptStore, assertAllowedText } from '../src/transcripts.js';

const moduleUrl = new URL('../src/transcripts.js', import.meta.url).href;
const payload = { vendor: 'chatgpt', user: 'Synthetic lock test.', assistant: 'Synthetic answer.' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new TranscriptStore(directory);
}
function metadata(s) { return s.locked(() => JSON.parse(fs.readFileSync(s.lockFile, 'utf8'))); }
function child(script, directory) {
  return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; import { TranscriptStore } from ${JSON.stringify(moduleUrl)}; const store = new TranscriptStore(${JSON.stringify(directory)}); ${script}`], { stdio: ['ignore', 'pipe', 'pipe'] });
}
async function killedWriter(t, s) {
  const p = child("store.locked(() => { fs.writeSync(1, 'ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });", s.directory);
  t.after(() => { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Writer startup timed out')); }, 5000);
    p.stdout.once('data', () => clearTimeout(timeout));
    p.stdout.on('data', chunk => { output += chunk; if (output.includes('ready')) resolve(); });
    p.once('error', reject); p.once('exit', () => { if (!output.includes('ready')) reject(new Error('Writer exited before locking.')); });
  });
  const saved = fs.readFileSync(s.lockFile, 'utf8');
  assert.throws(() => s.append(payload), /writer is busy/);
  p.kill('SIGKILL'); await once(p, 'exit');
  return saved;
}
async function completed(p) {
  let out = '', err = ''; p.stdout.on('data', x => out += x); p.stderr.on('data', x => err += x);
  const [code] = await once(p, 'exit'); assert.equal(code, 0, err); return out;
}

test('actual killed writer lock is recovered; live writer is never stolen', async t => {
  const s = fixture(t); const old = JSON.parse(await killedWriter(t, s));
  assert.equal(old.version, 2); assert.ok(old.start); assert.ok(old.boot); assert.ok(old.namespace);
  assert.equal(s.append(payload).id, 't1'); assert.equal(fs.existsSync(s.lockFile), false);
});

test('competing processes recover once and append distinct sequential records', async t => {
  const s = fixture(t); await killedWriter(t, s);
  const script = `for (let i = 0; i < 6; i++) { let done = false; for (let retry = 0; retry < 100; retry++) { try { store.append(${JSON.stringify(payload)}); done = true; break; } catch (e) { if (!/writer is busy/.test(e.message)) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } } if (!done) throw new Error('No progress'); }`;
  await Promise.all([completed(child(script, s.directory)), completed(child(script, s.directory)), completed(child(script, s.directory))]);
  const entries = s.entries(); assert.equal(entries.length, 18);
  assert.deepEqual(entries.map(x => x.id), Array.from({ length: 18 }, (_, i) => `t${i + 1}`));
});

test('same PID with different birth time proves reused PID, not a live old owner', t => {
  const s = fixture(t), owner = metadata(s);
  owner.start = String(BigInt(owner.start) + 1n);
  fs.writeFileSync(s.lockFile, JSON.stringify(owner));
  assert.equal(s.append(payload).id, 't1');
});

test('live same-process owner cannot be recovered', t => {
  const s = fixture(t), owner = metadata(s);
  const bytes = JSON.stringify(owner); fs.writeFileSync(s.lockFile, bytes);
  assert.throws(() => s.append(payload), /writer is busy/);
  assert.equal(fs.readFileSync(s.lockFile, 'utf8'), bytes);
});

test('legacy, empty, malformed, foreign, old-boot and namespace locks fail closed', t => {
  const s = fixture(t), owner = metadata(s);
  const variants = ['', `${process.pid}\n`, '{unfinished', JSON.stringify({ ...owner, host: 'foreign-host' }), JSON.stringify({ ...owner, machine: 'foreign-machine' }), JSON.stringify({ ...owner, boot: 'previous-boot' }), JSON.stringify({ ...owner, namespace: 'other-namespace' }), JSON.stringify({ ...owner, pid: -1 }), JSON.stringify({ ...owner, start: '' })];
  for (const bytes of variants) {
    fs.writeFileSync(s.lockFile, bytes);
    assert.throws(() => s.append(payload), /writer is busy|unverified/);
    assert.equal(fs.readFileSync(s.lockFile, 'utf8'), bytes);
    fs.unlinkSync(s.lockFile);
  }
  assert.deepEqual(s.entries(), []);
});

test('stale recovery guard is never recursively removed or bypassed', t => {
  const s = fixture(t), guard = `${s.lockFile}.recovery`;
  fs.mkdirSync(guard); const inode = fs.statSync(guard).ino;
  assert.throws(() => s.append(payload), /guard.*operator verification/);
  assert.equal(fs.statSync(guard).ino, inode); assert.equal(fs.existsSync(s.lockFile), false);
});

test('release checks inode and refuses to unlink replacement locks', t => {
  const s = fixture(t), replacement = path.join(s.directory, 'replacement');
  fs.writeFileSync(replacement, 'unrelated owner');
  assert.throws(() => s.locked(() => { fs.unlinkSync(s.lockFile); fs.renameSync(replacement, s.lockFile); }), /identity changed/);
  assert.equal(fs.readFileSync(s.lockFile, 'utf8'), 'unrelated owner');
});

test('symlink and multiply-linked lock files are not recovered', t => {
  const s = fixture(t), target = path.join(s.directory, 'target');
  fs.writeFileSync(target, 'preserve'); fs.symlinkSync(target, s.lockFile);
  assert.throws(() => s.append(payload)); assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
  fs.unlinkSync(s.lockFile); fs.linkSync(target, s.lockFile);
  assert.throws(() => s.append(payload), /Unverifiable/); assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
});

test('killed-writer recovery does not truncate partial transcript bytes', async t => {
  const s = fixture(t); await killedWriter(t, s);
  fs.writeFileSync(s.turnFile, '{partial');
  assert.throws(() => s.append(payload), /Incomplete append/);
  assert.equal(fs.readFileSync(s.turnFile, 'utf8'), '{partial');
});

test('dates and year context do not become inferred identifiers; real patterns still reject', () => {
  for (const text of ['2026-10-20', '2026-10-20 2026-10-21', '2024-02-29 2026-10-20 2026-10-21', 'account 2026 snapshot', 'The account settings were reviewed.']) assert.doesNotThrow(() => assertAllowedText(text));
  for (const text of ['Account number AB12345', 'Account # AB12345', 'Account: AB12345', 'SSN: 123-45-6789', 'Synthetic 4111 1111 1111 1111', 'Synthetic 1234567890']) assert.throws(() => assertAllowedText(text), /Possible ID/);
});
