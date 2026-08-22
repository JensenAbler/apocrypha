import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { queueDriveMirror } from "./drive.js";

const WAKE_DESCRIPTION = [
  "MANDATORY: call this before answering whenever Jensen's work, money, housing, planning, or life situation may be relevant.",
  "This is Jensen's standing personal context covering housing, income and runway, and work pipeline; read it before answering anything about his work, money, housing, planning, or life situation; it exists because the assistant's own memory system cannot store this.",
  "Apocrypha is only for context the assistant's normal memory system is not allowed to store; do not duplicate facts that can be kept in ordinary memory.",
  "With no arguments, returns the first page. If it names a next command, call that exact command before answering.",
].join(" ");

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

function wrap(handler) {
  return async (args) => {
    try {
      return textResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function createApocryphaMcpServer(store, options = {}) {
  const server = new McpServer({ name: "apocrypha", version: "1.0.0" });

  server.registerTool(
    "apocrypha_wake",
    {
      title: "Wake Apocrypha",
      description: WAKE_DESCRIPTION,
      inputSchema: {
        part: z.number().int().positive().optional().describe("Page number; omit for the first page."),
        snapshot: z.number().int().nonnegative().optional().describe("Snapshot id supplied by the preceding page."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async (args) => store.wake(args)),
  );

  server.registerTool(
    "apocrypha_note",
    {
      title: "Record an Apocrypha memory",
      description: "Append one durable fact about Jensen only when the assistant's normal memory system is not allowed to store it. Do not duplicate facts eligible for ordinary memory. Whitespace is collapsed to one line; the raw log is never edited or deleted. If a compression task is returned, complete it next with apocrypha_sleep.",
      inputSchema: {
        text: z.string().min(1).max(280).describe("One memory, 1-280 characters and at most 280 UTF-8 bytes."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    wrap(async ({ text }) => {
      const id = store.append(text);
      const task = store.compressionTask();
      try {
        await queueDriveMirror(store, options.drive);
      } catch (error) {
        // The append is already durable. The mirror is explicitly best-effort.
        console.error("Drive mirror failed after note; continuing:", error);
      }
      return `Saved as #${id}.${task ? `\n\n${task}` : ""}`;
    }),
  );

  server.registerTool(
    "apocrypha_sleep",
    {
      title: "Compress Apocrypha",
      description: "With no arguments, return the next required binary-tree compression. With both range and summary, save that exact block once and return the next task. Continue until it says Nothing left to compress.",
      inputSchema: {
        range: z.string().optional().describe("Inclusive aligned block range copied from the task, for example 16-31."),
        summary: z.string().min(1).max(280).optional().describe("Faithful one-line summary, at most 280 UTF-8 bytes."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap(async ({ range, summary }) => store.sleep(range, summary)),
  );

  server.registerTool(
    "apocrypha_recall",
    {
      title: "Search raw Apocrypha memories",
      description: "Case-insensitive regular-expression search of Jensen's raw append-only memory log. Use when a wake summary has lost needed detail.",
      inputSchema: { pattern: z.string().min(1).describe("JavaScript-compatible regular expression.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async ({ pattern }) => store.recall(pattern)),
  );

  server.registerTool(
    "apocrypha_forget",
    {
      title: "Discard a wrong Apocrypha summary",
      description: "Drop a wrong tree summary and every summary built on it. Never touches LOG.txt. Call apocrypha_sleep afterward to rebuild.",
      inputSchema: { range: z.string().describe("Inclusive aligned block range, for example 16-31.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    wrap(async ({ range }) => store.forget(range)),
  );

  return server;
}

export { WAKE_DESCRIPTION };
