import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApocryphaStore } from "../src/storage.js";
import { reserveSlots, shiftReferences } from "../scripts/reserve-slots.mjs";

function temporary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apocrypha-reserve-"));
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function settle(store) {
  const seen = new Set();
  while (store.pendingCount()) {
    const [lo, hi] = store.pending(undefined, 1)[0];
    const key = `${lo}-${hi - 1}`;
    assert.equal(seen.has(key), false, `block ${key} was offered twice`);
    seen.add(key);
    store.sleep(key, `summary of ${key}`);
  }
  return seen;
}

test("shiftReferences rewrites only existing memory numbers", () => {
  assert.equal(shiftReferences("AGREED (#709); see #11–17 and #0-31", 781, 32768), "AGREED (#33477); see #32779–32785 and #32768-32799");
  assert.equal(shiftReferences("claim #44518176 and C#5", 781, 32768), "claim #44518176 and C#5");
  assert.equal(shiftReferences("932 Wilson St #2; invoices #328-334", 20, 32768), "932 Wilson St #2; invoices #328-334");
});

test("reserved slots move memories up, keep summaries, and stay out of views", () => {
  const { directory, cleanup } = temporary();
  try {
    let store = new ApocryphaStore(directory);
    for (let i = 0; i < 40; i++) store.append(i === 39 ? "see #3 and #0-31" : `memory ${i}`, "2026-11-02");
    settle(store);
    const before = store.readBlock(0, 32);

    const dry = reserveSlots(directory, { reserve: 64 });
    assert.equal(dry.applied, false);
    assert.equal(new ApocryphaStore(directory).count(), 40);

    reserveSlots(directory, { reserve: 64, apply: true });
    store = new ApocryphaStore(directory);
    assert.equal(store.count(), 104);
    assert.equal(store.memoryCount(), 40);
    assert.equal(store.get(64), "#64 2026-11-02 memory 0");
    assert.equal(store.get(103), "#103 2026-11-02 see #67 and #64-95");
    assert.equal(store.readBlock(64, 96), before);
    assert.equal(store.entries().length, 40);
    assert.equal(store.pendingCount(), 0, "empty reserved blocks need no summary");
    const wake = store.wake();
    assert.match(wake, /\(40 memories\)/);
    assert.doesNotMatch(wake, /#0-/);

    assert.equal(store.append("next", "2026-11-02"), 104);
    assert.throws(() => reserveSlots(directory, { reserve: 64 }), /already starts with reserved/);
  } finally {
    cleanup();
  }
});

test("filling a reserved slot invalidates only its own ancestors", () => {
  const { directory, cleanup } = temporary();
  try {
    let store = new ApocryphaStore(directory);
    for (let i = 0; i < 20; i++) store.append(`memory ${i}`, "2026-11-02");
    settle(store);
    reserveSlots(directory, { reserve: 32, apply: true });
    store = new ApocryphaStore(directory);
    // Simulate a backfilled memory landing in reserved slot 5.
    const fd = fs.openSync(store.logFile, "r+");
    const record = Buffer.alloc(320, 0x20); record.write("#5 2023-01-27 backfilled"); record[319] = 10;
    fs.writeSync(fd, record, 0, 320, 5 * 320); fs.closeSync(fd);
    store = new ApocryphaStore(directory);
    const pending = store.pending().map(([lo, hi]) => `${lo}-${hi - 1}`);
    assert.deepEqual(pending.slice(0, 4), ["4-5", "4-7", "0-7", "0-15"]);
    assert.ok(store.readBlock(32, 48) !== null, "live summaries stay settled");
    settle(store);
    assert.match(store.wake(), /\(21 memories\)/);
    assert.equal(store.forget("4-5").startsWith("Forgot"), true);
    assert.ok(store.readBlock(32, 48) !== null, "forget leaves sibling blocks settled");
  } finally {
    cleanup();
  }
});
