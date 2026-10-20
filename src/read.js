import fs from "node:fs";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { PAGE_BYTES, RAW_MAX, TREE_RECORD_BYTES, parseRange } from "./storage.js";

function summary(store, lo, hi) {
  const range = `${lo}-${hi - 1}`;
  const fail = () => new Error(`The summary of #${range} is missing, blank or corrupt. Run apocrypha_forget with range "${range}", then apocrypha_sleep.`);
  let fd;
  try {
    fd = fs.openSync(store.treeFile(hi - lo), "r");
    const bytes = Buffer.alloc(TREE_RECORD_BYTES);
    if (fs.readSync(fd, bytes, 0, bytes.length, lo / (hi - lo) * bytes.length) !== bytes.length || bytes.at(-1) !== 10) throw fail();
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trimEnd();
    if (!value || Buffer.byteLength(value) > 280 || /[\r\n\0]/u.test(value)) throw fail();
    return value;
  } catch { throw fail(); } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function raw(store, id) {
  const line = store.get(id);
  if (!line.startsWith(`#${id} `) || line.includes("\uFFFD")) throw new Error(`Raw memory #${id} is corrupt; stop and inspect the preserved log.`);
  return line;
}
function turnText(transcripts, id) {
  const turn = transcripts.get(id);
  const conv = transcripts.getConversation(turn.conv);
  return `${id} ${turn.vendor} ${turn.conv} turn ${turn.turn} at ${turn.at}\n${id} user:\n${turn.user}\n${id} assistant:\n${turn.assistant}${turn.omitted ? `\n${id} omitted: ${turn.omitted}` : ""}\n${id} chat: ${conv?.link || "unresolved"}`;
}
function utf8Chunks(text, budget) {
  const result = [];
  let chunk = "", count = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (count + size > budget) { result.push(chunk); chunk = ""; count = 0; }
    chunk += char; count += size;
  }
  if (chunk || !result.length) result.push(chunk);
  return result;
}
export function readPage(text, args, label) {
  const snapshot = createHash("sha256").update(text).digest("hex");
  if (args.snapshot !== undefined && args.snapshot !== snapshot) throw new Error("Read changed since the preceding page; restart without snapshot.");
  const pages = utf8Chunks(text, PAGE_BYTES - 1500);
  const part = args.part ?? 1;
  if (!Number.isSafeInteger(part) || part < 1 || part > pages.length) throw new Error(`No part ${part}; ${pages.length} parts available.`);
  const continuation = part < pages.length ? `\nNext command: apocrypha_recall(${JSON.stringify({ ...args, snapshot, part: part + 1 })})` : "";
  const result = `${label}, part ${part} of ${pages.length}.\n${pages[part - 1]}${continuation}`;
  if (Buffer.byteLength(result) > PAGE_BYTES) throw new Error("Continuation arguments exceed the page budget.");
  return result;
}
export function zoom(store, transcripts, args) {
  let text, label;
  if (args.range !== undefined) {
    const [lo, hi] = parseRange(args.range);
    if (hi > store.count()) throw new Error("Range extends beyond the memory log.");
    summary(store, lo, hi); // Any settled block, not only the wake cover.
    label = `#${args.range}`;
    if (hi - lo <= RAW_MAX) text = Array.from({ length: hi - lo }, (_, i) => raw(store, lo + i)).join("\n");
    else {
      const mid = (lo + hi) / 2;
      text = [[lo, mid], [mid, hi]].map(([a,b]) => `#${a}-${b - 1} ${summary(store,a,b)}`).join("\n");
    }
  } else if (/^#(?:0|[1-9]\d*)$/.test(args.id || "")) {
    const id = Number(args.id.slice(1));
    if (!Number.isSafeInteger(id)) throw new Error("Invalid memory id.");
    label = args.id; text = raw(store, id);
    const citations = [...new Set(text.match(/\bt[1-9]\d*\b/g) || [])];
    for (const citation of citations) {
      try { text += "\n\n" + turnText(transcripts, citation); }
      catch (error) { text += `\n\n${citation} not available: ${error.message}`; }
    }
  } else if (/^t[1-9]\d*$/.test(args.id || "")) {
    label = args.id; text = turnText(transcripts, args.id);
  } else throw new Error("id must be #<memory number> or t<transcript number>.");
  return readPage(text, args, label);
}

// A worker deadline bounds catastrophic JavaScript regex backtracking without
// silently changing the established regex language or blocking the HTTP server.
export async function safeSearch(lines, pattern) {
  if (typeof pattern !== "string" || !pattern || Buffer.byteLength(pattern) > 1024) throw new Error("Regex must contain 1–1024 UTF-8 bytes.");
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    try {
      const regex = new RegExp(workerData.pattern, "i");
      let matches = 0, output = [], bytes = 0;
      for (const line of workerData.lines) {
        if (!regex.test(line)) continue;
        matches++;
        let snippet = line;
        if (Buffer.byteLength(snippet) > 16000) {
          let n=0; snippet = [...snippet].filter(c => (n += Buffer.byteLength(c)) <= 16000).join("") + " [excerpt; zoom the turn id for full text]";
        }
        output.push(snippet); bytes += Buffer.byteLength(snippet) + 1;
        while (bytes > 18500 && output.length) bytes -= Buffer.byteLength(output.shift()) + 1;
      }
      parentPort.postMessage(matches ? output.join("\\n") + "\\nNewest " + output.length + " of " + matches + " matches." : "No match.");
    } catch (error) { parentPort.postMessage({ error: "Bad regex: " + error.message }); }
  `, { eval: true, workerData: { lines, pattern } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("Regex search exceeded its 1-second execution budget. Use a simpler pattern.")); }, 1000);
    worker.once("message", result => { clearTimeout(timer); worker.terminate(); result?.error ? reject(new Error(result.error)) : resolve(result); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.once("exit", code => { clearTimeout(timer); if (code) reject(new Error("Regex search worker stopped.")); });
  });
}
