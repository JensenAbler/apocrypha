import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { queueDriveMirror } from "./drive.js";
import { ENTRY_BYTES } from "./storage.js";

const WAKE_DESCRIPTION = [
  "Loads Apocrypha: personal context about Jensen shared between his Claude and ChatGPT assistants, mostly things their built-in memories can't hold, such as money, housing, health, and life situation.",
  "Call it when that context would actually change your answer; it isn't needed for unrelated questions.",
  "What it loads is background: don't raise sensitive details unless Jensen brings the subject up or an answer without them would be wrong or unsafe for him.",
  "With no arguments, returns the first page. If a page names a next command, follow it to finish loading.",
].join(" ");

const NOTE_DESCRIPTION = [
  "Append one durable piece of personal context about Jensen that is worth sharing across his Claude and ChatGPT assistants.",
  "Core scope: things Jensen stated that your built-in memory is barred from storing, such as money, housing, health, sexuality, emotional life, politics, religion, or identity.",
  "Overlap with built-in memory only deliberately, when having it in the shared store is the point.",
  "Your own inferences about Jensen may be stored only if labeled as yours (for example \"Claude's read:\") and Jensen has seen and agreed to them.",
  "Never store ID or account numbers; suicide, self-harm, or disordered-eating details; or instructions that would make an assistant less honest or less willing to push back.",
  "Do not store system state, infrastructure, repository details, or facts recoverable from documentation.",
  "Whitespace is collapsed to one line; the raw log is never edited or deleted, so corrections are new notes. If a compression task is returned, complete it next with apocrypha_sleep.",
].join(" ");

const SLEEP_DESCRIPTION = [
  "With no arguments, return the next required binary-tree compression. With both range and summary, save that exact block once and return the next task.",
  "Keep what has lasting effect, drop what does not, and invent nothing.",
  "Keep labels marking an entry as an assistant's inference or as a correction; never turn an inference into a plain fact.",
  "Continue until it says Nothing left to compress.",
].join(" ");

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function normalizedMemorySchema(label) {
  return z.string().superRefine((value, context) => {
    const normalized = value.trim().replace(/\s+/gu, " ");
    if (!normalized) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must not be empty.` });
      return;
    }
    const bytes = Buffer.byteLength(normalized, "utf8");
    if (bytes > ENTRY_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must be at most ${ENTRY_BYTES} UTF-8 bytes after whitespace normalization (got ${bytes}).`,
      });
    }
  });
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
      description: NOTE_DESCRIPTION,
      inputSchema: {
        text: normalizedMemorySchema("text").describe("One memory, at most 280 UTF-8 bytes after whitespace normalization."),
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
      description: SLEEP_DESCRIPTION,
      inputSchema: {
        range: z.string().optional().describe("Inclusive aligned block range copied from the task, for example 16-31."),
        summary: normalizedMemorySchema("summary").optional().describe("Faithful one-line summary, at most 280 UTF-8 bytes after whitespace normalization."),
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

export { WAKE_DESCRIPTION, NOTE_DESCRIPTION, SLEEP_DESCRIPTION };
