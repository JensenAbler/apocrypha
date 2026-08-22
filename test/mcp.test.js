import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createApocryphaMcpServer, WAKE_DESCRIPTION } from "../src/mcp.js";
import { ApocryphaStore } from "../src/storage.js";

test("MCP exposes five portable tools and rejects a 400-character note", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apocrypha-mcp-"));
  const store = new ApocryphaStore(directory);
  const server = createApocryphaMcpServer(store, {
    drive: { config: {} },
  });
  const client = new Client({ name: "acceptance-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["apocrypha_forget", "apocrypha_note", "apocrypha_recall", "apocrypha_sleep", "apocrypha_wake"],
    );
    const wake = listed.tools.find((tool) => tool.name === "apocrypha_wake");
    const noteTool = listed.tools.find((tool) => tool.name === "apocrypha_note");
    assert.equal(wake.description, WAKE_DESCRIPTION);
    assert.equal(wake.annotations.readOnlyHint, true);
    assert.match(noteTool.description, /not supposed to save/);
    assert.match(noteTool.description, /Do not duplicate/);
    assert.match(noteTool.description, /Do not store system state/);
    const sleepTool = listed.tools.find((tool) => tool.name === "apocrypha_sleep");
    assert.match(sleepTool.description, /Keep what has lasting effect, drop what does not, and invent nothing/);
    assert.doesNotMatch(sleepTool.description, /standing directives/i);

    const multibyte = await client.callTool({ name: "apocrypha_note", arguments: { text: "—".repeat(94) } });
    assert.equal(multibyte.isError, true);
    assert.match(multibyte.content[0].text, /text must be at most 280 UTF-8 bytes.*got 282/);
    assert.equal(store.count(), 0);

    const tooLong = await client.callTool({ name: "apocrypha_note", arguments: { text: "x".repeat(400) } });
    assert.equal(tooLong.isError, true);
    assert.equal(store.count(), 0);

    store.append("left half", "2026-08-22");
    store.append("right half", "2026-08-22");
    const multibyteSummary = await client.callTool({
      name: "apocrypha_sleep",
      arguments: { range: "0-1", summary: "—".repeat(94) },
    });
    assert.equal(multibyteSummary.isError, true);
    assert.match(multibyteSummary.content[0].text, /summary must be at most 280 UTF-8 bytes.*got 282/);
    assert.equal(store.pendingCount(), 1);
    store.sleep("0-1", "two setup entries");

    const note = await client.callTool({ name: "apocrypha_note", arguments: { text: "  housing\n context  " } });
    assert.match(note.content[0].text, /^Saved as #2\./);
    const wakeResult = await client.callTool({ name: "apocrypha_wake", arguments: {} });
    assert.match(wakeResult.content[0].text, /#2 .* housing context/);
  } finally {
    await client.close();
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
