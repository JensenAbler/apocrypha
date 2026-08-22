import fs from "node:fs";
import path from "node:path";

export const ENTRY_BYTES = 280;
export const LOG_RECORD_BYTES = 320;
export const TREE_RECORD_BYTES = 288;
export const WAKE_LINES = 96;
export const PAGE_BYTES = 20_000;
export const PAGE_LINES = 500;
export const RAW_MAX = 16;

const encoder = new TextEncoder();

function byteLength(text) {
  return encoder.encode(text).byteLength;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function today(timeZone = process.env.APOCRYPHA_TIME_ZONE || "America/Los_Angeles") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function normalizeText(value) {
  if (typeof value !== "string") {
    throw new Error("Text must be a string.");
  }
  const text = value.trim().replace(/\s+/gu, " ");
  if (!text) {
    throw new Error("Empty. A memory is one line of text.");
  }
  const bytes = byteLength(text);
  if (bytes > ENTRY_BYTES) {
    throw new Error(`Too long: ${bytes} UTF-8 bytes, limit ${ENTRY_BYTES}.`);
  }
  return text;
}

function paddedRecord(text, recordBytes) {
  const body = Buffer.from(text, "utf8");
  if (body.length > recordBytes - 1) {
    throw new Error(`Record is ${body.length} bytes; limit is ${recordBytes - 1}.`);
  }
  return Buffer.concat([
    body,
    Buffer.alloc(recordBytes - 1 - body.length, 0x20),
    Buffer.from("\n"),
  ]);
}

function recordCount(file, recordBytes) {
  try {
    return Math.floor(fs.statSync(file).size / recordBytes);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function repairTrailingRecord(file, recordBytes) {
  try {
    const size = fs.statSync(file).size;
    const complete = size - (size % recordBytes);
    if (complete !== size) fs.truncateSync(file, complete);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function readRecord(file, index, recordBytes) {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(recordBytes);
    const read = fs.readSync(descriptor, buffer, 0, recordBytes, index * recordBytes);
    if (read !== recordBytes) return null;
    const decoded = buffer.toString("utf8").trimEnd();
    return decoded || null;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function parseRange(value) {
  const match = /^(\d+)-(\d+)$/.exec(value ?? "");
  if (!match) throw new Error(`'${value}' is not a block range. Use one printed by apocrypha_sleep.`);
  const lo = Number(match[1]);
  const hi = Number(match[2]) + 1;
  const size = hi - lo;
  if (size < 2 || (size & (size - 1)) !== 0 || lo % size !== 0) {
    throw new Error(`${value} is not an aligned power-of-two block.`);
  }
  return [lo, hi];
}

function internalCover(total, alpha) {
  let root = 1;
  while (root < total) root *= 2;
  const output = [];
  const stack = [[0, root]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (lo >= total) continue;
    const size = hi - lo;
    if (size > 1 && (hi > total || size > alpha * (total - lo))) {
      const mid = (lo + hi) / 2;
      stack.push([mid, hi], [lo, mid]);
    } else {
      output.push([lo, hi]);
    }
  }
  output.sort((a, b) => a[0] - b[0]);
  return output;
}

export function cover(total, budget = WAKE_LINES) {
  if (total <= 0) return [];
  if (total <= budget) return Array.from({ length: total }, (_, index) => [index, index + 1]);
  let lo = 0;
  let hi = 1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const mid = (lo + hi) / 2;
    if (internalCover(total, mid).length > budget) lo = mid;
    else hi = mid;
  }
  const output = internalCover(total, hi);
  while (output.length < budget) {
    let index = -1;
    for (let candidate = 0; candidate < output.length; candidate += 1) {
      if (output[candidate][1] - output[candidate][0] > 1) index = candidate;
    }
    if (index < 0) break;
    const [start, end] = output[index];
    const mid = (start + end) / 2;
    output.splice(index, 1, [start, mid], [mid, end]);
  }
  return output;
}

export function paginate(lines, maxBytes = PAGE_BYTES, maxLines = PAGE_LINES) {
  const pages = [];
  let current = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = byteLength(line) + 1;
    if (current.length && (current.length >= maxLines || bytes + lineBytes > maxBytes)) {
      pages.push(current);
      current = [];
      bytes = 0;
    }
    current.push(line);
    bytes += lineBytes;
  }
  if (current.length) pages.push(current);
  return pages;
}

export class ApocryphaStore {
  constructor(directory) {
    if (!directory) throw new Error("MEMORY_DIR is required.");
    this.directory = path.resolve(directory);
    this.logFile = path.join(this.directory, "LOG.txt");
    this.treeDirectory = path.join(this.directory, "TREE");
    fs.mkdirSync(this.treeDirectory, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.logFile)) fs.closeSync(fs.openSync(this.logFile, "a", 0o600));
    repairTrailingRecord(this.logFile, LOG_RECORD_BYTES);
  }

  treeFile(size) {
    return path.join(this.treeDirectory, String(size));
  }

  count() {
    return recordCount(this.logFile, LOG_RECORD_BYTES);
  }

  get(index) {
    const record = readRecord(this.logFile, index, LOG_RECORD_BYTES);
    if (record === null) throw new Error(`Memory #${index} does not exist.`);
    return record;
  }

  entries() {
    return Array.from({ length: this.count() }, (_, index) => this.get(index));
  }

  append(value, date = today()) {
    const text = normalizeText(value);
    repairTrailingRecord(this.logFile, LOG_RECORD_BYTES);
    const id = this.count();
    const record = paddedRecord(`#${id} ${date} ${text}`, LOG_RECORD_BYTES);
    const descriptor = fs.openSync(this.logFile, "a");
    try {
      fs.writeSync(descriptor, record);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return id;
  }

  readBlock(lo, hi) {
    const size = hi - lo;
    return readRecord(this.treeFile(size), lo / size, TREE_RECORD_BYTES);
  }

  blockCount(size) {
    return recordCount(this.treeFile(size), TREE_RECORD_BYTES);
  }

  pending(total = this.count(), limit = Infinity) {
    const output = [];
    for (let size = 2; size <= total; size *= 2) {
      const have = this.blockCount(size);
      for (let index = have; index < Math.floor(total / size); index += 1) {
        output.push([index * size, (index + 1) * size]);
        if (output.length >= limit) return output;
      }
    }
    return output;
  }

  pendingCount(total = this.count()) {
    let result = 0;
    for (let size = 2; size <= total; size *= 2) {
      result += Math.max(0, Math.floor(total / size) - this.blockCount(size));
    }
    return result;
  }

  compressionTask(total = this.count()) {
    const next = this.pending(total, 1)[0];
    if (!next) return null;
    const [lo, hi] = next;
    let source;
    if (hi - lo <= RAW_MAX) {
      source = Array.from({ length: hi - lo }, (_, offset) => `  ${this.get(lo + offset)}`).join("\n");
    } else {
      const mid = (lo + hi) / 2;
      const halves = [[lo, mid], [mid, hi]].map(([start, end]) => {
        const summary = this.readBlock(start, end);
        if (summary === null) {
          throw new Error(
            `The summary of #${start}-${end - 1} is blank or corrupt. ` +
            `Run apocrypha_forget with range "${start}-${end - 1}".`,
          );
        }
        return `  #${start}-${end - 1} ${summary}`;
      });
      source = halves.join("\n");
    }
    const remaining = this.pendingCount(total) - 1;
    const tail = remaining ? `\n${plural(remaining, "compression")} remain after this one.` : "";
    return [
      `Compress memories #${lo}-${hi - 1} into one line of at most ${ENTRY_BYTES} UTF-8 bytes.`,
      "Keep what has lasting effect, drop what does not. Invent nothing.",
      "Preserve standing directives about how to treat Jensen verbatim, even over episodic detail.",
      "",
      source,
      tail,
      `Next command: apocrypha_sleep({"range":"${lo}-${hi - 1}","summary":"<your line>"})`,
    ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
  }

  putBlock(lo, hi, value) {
    const summary = normalizeText(value);
    const size = hi - lo;
    const file = this.treeFile(size);
    repairTrailingRecord(file, TREE_RECORD_BYTES);
    if (this.blockCount(size) !== lo / size) return false;
    const descriptor = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(descriptor, paddedRecord(summary, TREE_RECORD_BYTES));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return true;
  }

  sleep(range, summary) {
    const total = this.count();
    if (range === undefined && summary === undefined) {
      return this.compressionTask(total) ?? "Nothing left to compress.";
    }
    if (range === undefined || summary === undefined) {
      throw new Error("range and summary must be supplied together.");
    }
    const [lo, hi] = parseRange(range);
    const next = this.pending(total, 1)[0];
    if (!next) return "Nothing left to compress.";
    if (lo !== next[0] || hi !== next[1]) {
      if (this.readBlock(lo, hi) !== null) {
        return `${range} is already settled.\n${this.compressionTask(total) ?? "Nothing left to compress."}`;
      }
      throw new Error(
        `Wrong block: ${range}. Blocks are built in order; the next is ${next[0]}-${next[1] - 1}.`,
      );
    }
    if (!this.putBlock(lo, hi, summary)) {
      return `${range} was settled or forgotten meanwhile.\n${this.compressionTask(total) ?? "Nothing left to compress."}`;
    }
    const following = this.compressionTask(total);
    return `${range} saved.\n${following ?? "Nothing left to compress."}`;
  }

  wake({ part = 1, snapshot } = {}) {
    const now = this.count();
    const total = snapshot ?? now;
    if (!Number.isSafeInteger(part) || part < 1) throw new Error("part must be a positive integer.");
    if (!Number.isSafeInteger(total) || total < 0 || total > now) {
      throw new Error(`snapshot must be between 0 and ${now}.`);
    }
    const task = this.compressionTask(total);
    if (task) {
      throw new Error(
        `Cannot wake: ${plural(this.pendingCount(total), "compression")} are outstanding. ` +
        `Complete them first.\n\n${task}`,
      );
    }
    const preamble = [
      "Every line below is a stated fact from Jensen.",
      "This context is append-only; corrections appear as later lines.",
      "Factor this context into advice. Do not treat it as a crisis, do not tiptoe, and do not respond with resource referrals unless Jensen asks.",
    ].join(" ");
    if (total === 0) return `${preamble}\n\nNo memories yet. You are awake.`;
    const lines = cover(total).map(([lo, hi]) => {
      if (hi - lo === 1) return this.get(lo);
      const summary = this.readBlock(lo, hi);
      if (summary === null) {
        throw new Error(
          `The summary of #${lo}-${hi - 1} is blank or corrupt. ` +
          `Run apocrypha_forget with range "${lo}-${hi - 1}".`,
        );
      }
      return `#${lo}-${hi - 1} ${summary}`;
    });
    const pages = paginate(lines);
    if (part > pages.length) throw new Error(`No part ${part}; this wake has ${plural(pages.length, "part")}.`);
    const heading = pages.length > 1
      ? `Apocrypha, part ${part} of ${pages.length}, oldest first (${plural(total, "memory")}).`
      : "Apocrypha, oldest first.";
    const body = pages[part - 1].join("\n");
    const footer = part < pages.length
      ? `Not awake yet. Next command: apocrypha_wake({"part":${part + 1},"snapshot":${total}})`
      : "You are awake.";
    return `${preamble}\n\n${heading}\n${body}\n${footer}`;
  }

  recall(pattern) {
    let regex;
    try {
      regex = new RegExp(pattern, "i");
    } catch (error) {
      throw new Error(`Bad regex: ${error.message}`);
    }
    const output = [];
    let bytes = 0;
    let matches = 0;
    for (const line of this.entries()) {
      if (!regex.test(line)) continue;
      regex.lastIndex = 0;
      matches += 1;
      output.push(line);
      bytes += byteLength(line) + 1;
      while (bytes > PAGE_BYTES && output.length) {
        bytes -= byteLength(output.shift()) + 1;
      }
    }
    if (!matches) return "No match.";
    const tail = output.length < matches
      ? `Newest ${output.length} of ${plural(matches, "match")}. Narrow the regex.`
      : `${plural(matches, "match")}.`;
    return `${output.join("\n")}\n${tail}`;
  }

  forget(range) {
    const [lo, hi] = parseRange(range);
    const total = this.count();
    const removed = [];
    for (let size = hi - lo; size <= total; size *= 2) {
      const file = this.treeFile(size);
      const index = Math.floor(lo / size);
      const count = this.blockCount(size);
      if (count > index) {
        for (let block = index; block < count; block += 1) {
          removed.push([block * size, (block + 1) * size]);
        }
        fs.truncateSync(file, index * TREE_RECORD_BYTES);
      }
    }
    if (!removed.length) throw new Error(`No summary at ${range}.`);
    return `Forgot ${plural(removed.length, "summary")} from #${removed[0][0]}-${removed[0][1] - 1} upward. ` +
      "Call apocrypha_sleep with no arguments to rebuild.";
  }
}
