import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
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


export function withWriterLock(directory, fn) {
  const store = { directory, lockFile: path.join(directory, '.transcripts-write.lock') };
  const lock = acquireWriter(store);
  try { return fn(); }
  finally {
    try {
      withRecoveryGuard(store, () => {
        const current = fs.lstatSync(store.lockFile);
        if (!current.isFile() || !sameInode(lock.inode, current) || current.nlink !== 1) throw new Error('Writer lock identity changed; refusing release.');
        fs.unlinkSync(store.lockFile); syncDirectory(store.directory);
      });
    } finally { fs.closeSync(lock.fd); }
  }
}
