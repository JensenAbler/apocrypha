#!/usr/bin/env node
// One-time migration: prepend `reserve` empty slots to LOG.txt and the TREE so
// every existing memory moves up by `reserve` positions (#0 becomes #reserve),
// and rewrite #references in note text, summaries and turn summaries to match.
// Turn-leaf excerpts whose turn has no supplied summary keep their text byte for
// byte (only the number prefix changes) so legacy attribution still matches.
// Run with the service stopped and a backup taken. Dry run unless --apply.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withWriterLock } from "../src/writer-lock.js";
import { LOG_RECORD_BYTES, TREE_RECORD_BYTES, turnLeafId } from "../src/storage.js";

function readRecords(file, size) {
  const buffer = fs.readFileSync(file);
  if (buffer.length % size) throw new Error(`${file} has a partial trailing record.`);
  const out = [];
  for (let i = 0; i < buffer.length / size; i++) out.push(buffer.toString("utf8", i * size, (i + 1) * size).trimEnd());
  return out;
}

function pad(text, size) {
  const body = Buffer.from(text, "utf8");
  if (body.length > size - 1) throw new Error(`Record too long after rewrite (${body.length} > ${size - 1}): ${text}`);
  return Buffer.concat([body, Buffer.alloc(size - 1 - body.length, 0x20), Buffer.from("\n")]);
}

function writeAtomic(file, buffer) {
  const temp = `${file}.reserve-tmp`;
  const fd = fs.openSync(temp, "w", 0o600);
  try { fs.writeSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const stat = fs.statSync(file);
  fs.chmodSync(temp, stat.mode & 0o777);
  try { fs.chownSync(temp, stat.uid, stat.gid); } catch (error) { if (error.code !== "EPERM") throw error; }
  fs.renameSync(temp, file);
}

// Rewrites #N and #A-B (hyphen or en dash) where every number names a memory
// that existed when the text was written (< limit): a note can only cite earlier
// notes, so later-looking numbers (invoice numbers, claim numbers) stay. Tokens
// glued to a preceding letter or digit, and street-address units, are left alone.
export function shiftReferences(text, limit, reserve) {
  return text.replace(/#(\d+)(?:([–-])(\d+))?/gu, (match, a, dash, b, offset, whole) => {
    if (offset > 0 && /[\p{L}\p{N}&]/u.test(whole[offset - 1])) return match;
    if (/\b(?:St|Ave|Apt|Unit|Suite|Ste|Rd|Blvd|[Ii]nvoices?)\.? $/u.test(whole.slice(Math.max(0, offset - 10), offset))) return match;
    const first = Number(a);
    if (first >= limit) return match;
    if (b === undefined) return `#${first + reserve}`;
    const second = Number(b);
    if (second >= limit || second < first) return `#${first + reserve}${dash}${b}`;
    return `#${first + reserve}${dash}${second + reserve}`;
  });
}

export function reserveSlots(directory, { reserve = 32768, apply = false } = {}) {
  if (!Number.isSafeInteger(reserve) || reserve < 2 || (reserve & (reserve - 1)) !== 0) throw new Error("reserve must be a power of two.");
  return withWriterLock(directory, () => {
    const logFile = path.join(directory, "LOG.txt");
    const log = readRecords(logFile, LOG_RECORD_BYTES);
    const count = log.length;
    if (count === 0 || log[0] === "") throw new Error("Log is empty or already starts with reserved slots; refusing.");
    if (count >= reserve) throw new Error(`Log has ${count} records; reserve ${reserve} must exceed it.`);
    log.forEach((line, i) => { if (!line.startsWith(`#${i} `)) throw new Error(`Record ${i} does not start with #${i}.`); });

    const excerptLeaves = new Set();
    const transcriptsFile = path.join(directory, "TRANSCRIPTS.jsonl");
    if (fs.existsSync(transcriptsFile)) {
      for (const line of fs.readFileSync(transcriptsFile, "utf8").split("\n")) {
        try { const turn = JSON.parse(line); if (turn.id && !turn.summary?.trim()) excerptLeaves.add(turn.id); } catch {}
      }
    }

    const changes = [];
    const note = (where, before, after) => { if (before !== after) changes.push({ where, before, after }); };

    const newLog = log.map((line, i) => {
      const prefix = /^#\d+ \S+ /.exec(line)[0];
      const body = line.slice(prefix.length);
      const newPrefix = prefix.replace(/^#\d+/, `#${i + reserve}`);
      const leaf = turnLeafId(line);
      const newBody = leaf && excerptLeaves.has(leaf) ? body : shiftReferences(body, i, reserve);
      if (body !== newBody) note(`log #${i}`, body, newBody);
      return newPrefix + newBody;
    });

    const treeDirectory = path.join(directory, "TREE");
    const trees = [];
    if (fs.existsSync(treeDirectory)) {
      for (const name of fs.readdirSync(treeDirectory)) {
        if (!/^\d+$/.test(name)) continue;
        const size = Number(name);
        if (size > reserve) throw new Error(`Tree size ${size} exceeds reserve ${reserve}.`);
        const file = path.join(treeDirectory, name);
        const records = readRecords(file, TREE_RECORD_BYTES).map((summary, index) => {
          if (!summary) return summary;
          const shifted = shiftReferences(summary, Math.min(count, (index + 1) * size), reserve);
          note(`tree ${size}#${index}`, summary, shifted);
          return shifted;
        });
        trees.push({ file, size, records });
      }
    }

    const summariesFile = path.join(directory, "TURN_SUMMARIES.json");
    let summaries = null;
    if (fs.existsSync(summariesFile)) {
      summaries = JSON.parse(fs.readFileSync(summariesFile, "utf8"));
      const leafAt = new Map();
      log.forEach((line, i) => { const id = turnLeafId(line); if (id && !leafAt.has(id)) leafAt.set(id, i); });
      for (const [id, value] of Object.entries(summaries)) {
        const shifted = shiftReferences(value, leafAt.get(id) ?? count, reserve);
        note(`turn summary ${id}`, value, shifted);
        summaries[id] = shifted;
      }
    }

    // Build every buffer first so a length failure aborts before any write.
    const blankLog = pad("", LOG_RECORD_BYTES), blankTree = pad("", TREE_RECORD_BYTES);
    const logBuffer = Buffer.concat([...Array(reserve).fill(blankLog), ...newLog.map(line => pad(line, LOG_RECORD_BYTES))]);
    const treeBuffers = trees.map(({ file, size, records }) => ({
      file,
      buffer: Buffer.concat([...Array(reserve / size).fill(blankTree), ...records.map(r => pad(r, TREE_RECORD_BYTES))]),
    }));

    if (apply) {
      for (const { file, buffer } of treeBuffers) writeAtomic(file, buffer);
      if (summaries) writeAtomic(summariesFile, Buffer.from(JSON.stringify(summaries) + "\n"));
      writeAtomic(logFile, logBuffer);
      const dir = fs.openSync(directory, "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    return { applied: apply, reserve, memories: count, firstNew: reserve, lastNew: reserve + count - 1, trees: trees.length, changes };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.length ? v.join("=") : true]; }));
  if (!args.dir) { console.error("Usage: reserve-slots.mjs --dir=/var/lib/apocrypha [--reserve=32768] [--apply]"); process.exit(2); }
  const result = reserveSlots(path.resolve(args.dir), { reserve: Number(args.reserve ?? 32768), apply: args.apply === true });
  for (const change of result.changes) console.log(`${change.where}\n  - ${change.before}\n  + ${change.after}`);
  console.log(JSON.stringify({ ...result, changes: result.changes.length }));
}
