import fs from 'node:fs';
import path from 'node:path';

// Append-only JSONL reader with an incremental cache: when a file only grew,
// just the new tail is parsed. Returns a fresh array whenever content changed.
const cache = new Map();

export function readJsonl(file) {
  let stat;
  try { stat = fs.statSync(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const size = Number(stat.size);
  if (!size) { cache.delete(file); return []; }
  const cached = cache.get(file);
  if (cached && cached.ino === stat.ino && cached.size === size && cached.mtimeNs === stat.mtimeNs) return cached.records;
  const grew = cached && cached.ino === stat.ino && size > cached.size;
  const start = grew ? cached.size : 0;
  const records = grew ? cached.records.slice() : [];
  const bytes = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, bytes, 0, bytes.length, start); } finally { fs.closeSync(fd); }
  if (bytes.at(-1) !== 10) throw new Error(`Incomplete append in ${path.basename(file)}; preserve the file and request operator recovery. No automatic truncation.`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  for (const line of text.slice(0, -1).split('\n')) {
    try { const v = JSON.parse(line); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); records.push(v); }
    catch { throw new Error(`Corrupt ${path.basename(file)} record ${records.length + 1}; request operator recovery.`); }
  }
  cache.set(file, { ino: stat.ino, size, mtimeNs: stat.mtimeNs, records });
  return records;
}
