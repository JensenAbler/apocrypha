import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mirrorToDrive } from "../src/drive.js";
import { ApocryphaStore } from "../src/storage.js";

test("Drive mirror replaces the body with a full raw-log rendering", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apocrypha-drive-"));
  try {
    const store = new ApocryphaStore(directory);
    store.append("first fact", "2026-08-22");
    store.append("second fact", "2026-08-22");
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "access" }), { status: 200 });
      }
      if (String(url).endsWith(":batchUpdate")) {
        return new Response(JSON.stringify({ replies: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ body: { content: [{ endIndex: 42 }] } }), { status: 200 });
    };
    await mirrorToDrive(store, {
      config: { clientId: "client", clientSecret: "secret", refreshToken: "refresh", documentId: "doc" },
      fetchImpl,
    });
    const request = JSON.parse(calls.at(-1).options.body);
    assert.deepEqual(request.requests[0], {
      deleteContentRange: { range: { startIndex: 1, endIndex: 41 } },
    });
    assert.match(request.requests[1].insertText.text, /^#0 2026-08-22 first fact\n#1 2026-08-22 second fact\n$/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
