import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ApocryphaStore,
  LOG_RECORD_BYTES,
  TREE_RECORD_BYTES,
  WAKE_LINES,
  cover,
} from "../src/storage.js";

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apocrypha-test-"));
  return { directory, store: new ApocryphaStore(directory) };
}

function settle(store, summaries = new Map()) {
  while (store.pendingCount()) {
    const [lo, hi] = store.pending(undefined, 1)[0];
    const key = `${lo}-${hi - 1}`;
    assert.equal(summaries.has(key), false, `block ${key} was offered twice`);
    const summary = `summary of ${key}`;
    summaries.set(key, summary);
    store.sleep(key, summary);
  }
  assert.equal(store.sleep(), "Nothing left to compress.");
  return summaries;
}

test("normalizes whitespace, assigns sequential ids, and enforces UTF-8 limit", () => {
  const { directory, store } = temporaryStore();
  try {
    assert.equal(store.append("  van\n in\tshop  ", "2026-08-22"), 0);
    assert.equal(store.append("radiator fixed", "2026-08-22"), 1);
    assert.equal(store.get(0), "#0 2026-08-22 van in shop");
    assert.equal(store.get(1), "#1 2026-08-22 radiator fixed");
    assert.throws(() => store.append("ã".repeat(141)), /282 UTF-8 bytes/);
    assert.equal(fs.statSync(store.logFile).size, 2 * LOG_RECORD_BYTES);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("2,000 memories build a complete immutable merge tree and bounded wake", { timeout: 60_000 }, () => {
  const { directory, store } = temporaryStore();
  try {
    for (let index = 0; index < 2_000; index += 1) {
      store.append(`synthetic memory ${index}, durable context for acceptance testing`, "2026-08-22");
    }
    assert.throws(() => store.wake(), /Cannot wake/);
    const summaries = settle(store);

    const expectedBlocks = Array.from({ length: 11 }, (_, exponent) => {
      const size = 2 ** (exponent + 1);
      return Math.floor(2_000 / size);
    }).reduce((sum, count) => sum + count, 0);
    assert.equal(summaries.size, expectedBlocks);

    for (const file of fs.readdirSync(store.treeDirectory)) {
      assert.equal(fs.statSync(path.join(store.treeDirectory, file)).size % TREE_RECORD_BYTES, 0);
    }

    const tiles = cover(2_000);
    assert.ok(tiles.length <= WAKE_LINES);
    assert.equal(tiles[0][0], 0);
    assert.equal(tiles.at(-1)[1], 2_000);
    for (let index = 1; index < tiles.length; index += 1) {
      assert.equal(tiles[index - 1][1], tiles[index][0], "cover must tile without gaps or overlap");
      assert.ok(
        tiles[index - 1][1] - tiles[index - 1][0] >= tiles[index][1] - tiles[index][0],
        "detail must not decrease toward the present",
      );
    }
    assert.equal(tiles.at(-1)[1] - tiles.at(-1)[0], 1, "newest memory must remain raw");

    const pages = [];
    let part = 1;
    while (true) {
      const page = store.wake({ part, snapshot: 2_000 });
      pages.push(page);
      assert.ok(Buffer.byteLength(page) < 30_000, "Claude-safe page limit");
      if (page.endsWith("You are awake.")) break;
      assert.match(page, new RegExp(`apocrypha_wake\\(\\{\"part\":${part + 1},\"snapshot\":2000\\}\\)`));
      part += 1;
    }
    const rendered = pages.flatMap((page) => page.split("\n").filter((line) => /^#\d/.test(line)));
    assert.equal(rendered.length, tiles.length);
    assert.match(rendered[0], /^#0-/);
    assert.match(rendered.at(-1), /^#1999 /);

    const treeFingerprint = new Map(
      fs.readdirSync(store.treeDirectory).map((file) => [file, fs.readFileSync(path.join(store.treeDirectory, file))]),
    );
    assert.equal(store.sleep(), "Nothing left to compress.");
    for (const [file, before] of treeFingerprint) {
      assert.deepEqual(fs.readFileSync(path.join(store.treeDirectory, file)), before, `${file} was rewritten`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("forget truncates descendants, rebuilds, and never changes LOG.txt", { timeout: 60_000 }, () => {
  const { directory, store } = temporaryStore();
  try {
    for (let index = 0; index < 1_024; index += 1) store.append(`memory ${index}`, "2026-08-22");
    settle(store);
    const logBefore = fs.readFileSync(store.logFile);
    const response = store.forget("256-511");
    assert.match(response, /Forgot/);
    assert.ok(store.pendingCount() > 0);
    assert.throws(() => store.wake(), /Cannot wake/);
    settle(store);
    assert.deepEqual(fs.readFileSync(store.logFile), logBefore);
    assert.doesNotThrow(() => store.wake());
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("records survive reopening the store", () => {
  const { directory, store } = temporaryStore();
  try {
    store.append("persistent fact", "2026-08-22");
    store.append("second persistent fact", "2026-08-22");
    settle(store);
    const reopened = new ApocryphaStore(directory);
    assert.equal(reopened.count(), 2);
    assert.match(reopened.wake(), /persistent fact/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
