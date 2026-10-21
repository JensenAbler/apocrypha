import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { wakeView, completeWakeView } from "./wake-view.js";
import { queueDriveMirror } from "./drive.js";
import { ENTRY_BYTES } from "./storage.js";
import { TranscriptStore } from "./transcripts.js";
import { zoom, safeSearch } from "./read.js";

// Tool text describes what each tool does: inputs, outputs, and what the server
// accepts or rejects. Usage guidance belongs in each assistant's own instructions.
const SERVER_INSTRUCTIONS = [
  "Apocrypha is an append-only memory store shared by Claude and ChatGPT. It holds three kinds of records.",
  "Notes are one-line entries in a log, numbered from #0.",
  "Summaries compress aligned blocks of notes into a binary tree, so the whole log can be shown in a bounded view.",
  "Transcripts are stored conversation turns, numbered from t1, grouped into conversations identified by tokens; a conversation can carry a link to its original chat.",
  "Notes, transcripts, and link records are never edited or deleted; only summaries can be discarded and rebuilt.",
].join(" ");

const WAKE_DESCRIPTION = [
  "Returns a bounded view of the whole note log: recent notes and turn leaves in full and older notes as block summaries, each labeled with its note number or block range.",
  "Long views are split into pages; a page that isn't the last ends with the exact command for the next page.",
  "With a healthy background compactor, unfinished blocks appear as raw lines or available child summaries, with a pending-block count. Without it, outstanding compression returns the next task.",
].join(" ");

// The one prescriptive passage: recording every turn is the purpose of the store.
// Everything else in the tool text stays descriptive.
const CAPTURE_INSTRUCTION = [
  "Every turn of every conversation is recorded here.",
  "Before writing the visible reply, call this tool with turn: vendor set to your own (claude or chatgpt), user set to the user's message, assistant set to the full reply you are about to send, summary set to a one-line description of the turn, and a unique requestId; then send that reply unchanged.",
  "On a conversation's first recorded turn, omit conv; then end that reply with one final line, \u27e6mint <token>\u27e7, using the returned token, and pass the bare token as conv on every later turn.",
].join(" ");

const NOTE_DESCRIPTION = [
  CAPTURE_INSTRUCTION,
  "\n\nAppends one record. Accepts exactly one of text, turn, or resolve.",
  "\n\ntext appends a note to the log, collapsing whitespace to a single line, and returns its number. The Google Drive mirror renders the same wake view, including turn leaves and summaries. Without a healthy background compactor, a newly ready block is included as a compression task.",
  "\n\nturn appends a transcript turn and returns its id, conversation token, turn number, and timestamp; the turn text is not echoed back. Without conv, the server mints a new conversation token. A turn is rejected without saving if it contains the marked form \u27e6mint <token>\u27e7. A recorded turn also appends a leaf line t<n> <vendor>: <summary> to the log. The vendor identifies the conversation assistant, not the speaker of quoted text. Missing or empty summaries use an explicitly user-attributed message excerpt; leaf text is truncated to 280 UTF-8 bytes. A configured background compactor replaces temporary excerpts in the shared read view with summaries of both sides of the exchange, including existing excerpt leaves. Turn leaves appear in wake and its Google Drive mirror.",
  "\n\nresolve records a link attempt for a conversation. It links the conversation to url only when a supplied candidate for that URL has a snippet containing \u27e6mint <token>\u27e7, the URL is a canonical claude.ai/chat or chatgpt.com/c address matching the conversation's vendor, and the conversation has no existing or disputed link (unless correction is set). Candidates from two different chats that both contain the marked form are recorded as an ambiguous attempt and link nothing. Snippets are stored only as hashes. After 10 failed attempts spanning at least 7 days, the conversation is marked unresolvable.",
].join(" ").replace(/ \n\n/g, "\n\n");

const SLEEP_DESCRIPTION = [
  "Builds the summary tree one block at a time, in order.",
  "With no arguments, returns the next block to compress: its range and its source lines (raw notes for blocks of 16 or fewer, otherwise its two child summaries).",
  "With range and summary, saves that summary and returns the next task, or reports that nothing is left.",
].join(" ");

const RECALL_DESCRIPTION = [
  "Reads records without changing anything. Accepts exactly one of pattern, range, or id.",
  "A pattern runs a case-insensitive regular expression over notes, or over transcripts with in: \"transcripts\", and returns the newest matches within the page limit; long transcript matches are excerpted.",
  "A range returns what a settled block was built from: its two child summaries, or its raw notes for blocks of 16 or fewer.",
  "An id returns one note plus any transcript turns it mentions by id, or one transcript turn plus its conversation's link.",
  "Every returned line is labeled with its number, range, or id. Results longer than one page end with the exact command for the next page.",
].join(" ");

const FORGET_DESCRIPTION = "Deletes the summary for a block and every summary built on top of it, so they can be rebuilt with apocrypha_sleep. Notes and transcripts are unaffected.";

function rejectOriginMarker(value) {
  if (typeof value === "string" && /⟦\s*mint\b/u.test(value)) throw new Error("Do not store origin markers. Use only the bare conversation token.");
}

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
  const server = new McpServer({ name: "apocrypha", version: "2.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  let transcriptStore = options.transcripts;
  const mirror = async () => {
    try { await (options.mirror ? options.mirror() : queueDriveMirror(store, { ...options.drive, render: () => completeWakeView(store, options.compactor) })); }
    catch (error) { console.error("Drive mirror failed after write; continuing:", error.message); }
  };

  const transcripts = Object.fromEntries(["append","resolve","get","getConversation","entries","unresolved"].map(name => [name, (...args) => {
    transcriptStore ??= new TranscriptStore(store.directory, { lazyResolution: options.lazyResolution === true });
    return transcriptStore[name](...args);
  }]));

  server.registerTool(
    "apocrypha_wake",
    {
      title: "Wake Apocrypha",
      description: WAKE_DESCRIPTION,
      inputSchema: {
        vendor: z.enum(["claude", "chatgpt"]).optional().describe("claude or chatgpt. When unresolved-link listing is enabled on the server, the view ends with up to five of that vendor's unlinked conversation tokens, oldest first."),
        part: z.number().int().positive().optional().describe("Page number. Defaults to the first page."),
        view: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Wake rendering fingerprint from a previous page; changed rendering requires a new first page."),
        snapshot: z.number().int().nonnegative().optional().describe("The note count the view is pinned to, from a previous page's next command."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async (args) => {
      const result = wakeView(store, args, options.compactor);
      if (!args.vendor || options.lazyResolution !== true || !result.endsWith("You are awake.")) return result;
      const pending = transcripts.unresolved(args.vendor);
      return result + (pending.length ? `\nUnresolved ${args.vendor} conversations, oldest first:\n` + pending.map(c => c.token + (c.status === "ambiguous" ? " [ambiguous: conflicting origin markers recorded]" : "")).join("\n") : "");
    }),
  );

  server.registerTool(
    "apocrypha_note",
    {
      title: "Write to Apocrypha",
      description: NOTE_DESCRIPTION,
      inputSchema: {
        text: normalizedMemorySchema("text").optional().describe("Note text, at most 280 UTF-8 bytes after whitespace collapses. Text containing the marked form is rejected."),
        turn: z.object({
          conv: z.string().optional().describe("Existing conversation token. Omitted, a new conversation and token are created."),
          vendor: z.enum(["claude", "chatgpt"]).describe("Conversation assistant: claude or chatgpt; not the speaker of every statement in the turn."),
          user: z.string().describe("The user side of the turn."),
          summary: z.string().optional().describe("One-line description of the turn; an empty or missing value uses an explicitly user-attributed message excerpt."),
          assistant: z.string().describe("The assistant side of the turn."),
          turn: z.number().int().positive().optional().describe("Turn number within the conversation; must increase. Omitted, the server assigns the next number among stored turns."),
          omitted: z.enum(["id","account","suicide","self-harm","disordered-eating","attachment","length"]).optional().describe("One category word recorded with the turn."),
          requestId: z.string().min(8).max(128).optional().describe("Idempotency key. Repeating it with identical content returns the original record; with different content, it's rejected."),
        }).strict().optional().describe("A transcript turn."),
        resolve: z.object({
          token: z.string().describe("Conversation token."),
          vendor: z.enum(["claude", "chatgpt"]).describe("claude or chatgpt; must match the conversation's vendor."),
          url: z.string().optional().describe("The URL to link."),
          correction: z.boolean().optional().describe("Allows replacing an existing link or resolving a conversation flagged ambiguous."),
          candidates: z.array(z.object({url:z.string(),snippet:z.string().max(20000)}).strict()).max(20).optional().describe("Up to 20 {url, snippet} pairs used as link evidence."),
          outcome: z.literal("missing").optional().describe("missing records a failed attempt with no candidates."),
          requestId: z.string().min(8).max(128).optional().describe("Idempotency key."),
        }).strict().optional().describe("A link attempt for a conversation."),

      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    wrap(async ({ text, turn, resolve }) => {
      if ([text,turn,resolve].filter(v=>v!==undefined).length !== 1) throw new Error("Supply exactly one of text, turn, resolve.");
      if (turn) {
        const t = transcripts.append(turn);
        await mirror();
        return JSON.stringify({id:t.id,conv:t.conv,vendor:t.vendor,turn:t.turn,at:t.at,newConversation:t.newConversation === true,replayed:t.replayed === true});
      }
      if (resolve) {
        const conversation = transcripts.getConversation(resolve.token);
        if (!conversation || conversation.vendor !== resolve.vendor) throw new Error("Resolve only a conversation belonging to your stated vendor.");
        const {vendor,...input}=resolve;
        return JSON.stringify(transcripts.resolve(input));
      }
      rejectOriginMarker(text);
      const id = store.append(text);
      const task = options.compactor?.available ? null : store.compressionTask();
      await mirror();
      return `Saved as #${id}.${task ? `\n\n${task}` : ""}`;
    }),
  );

  server.registerTool(
    "apocrypha_sleep",
    {
      title: "Compress Apocrypha",
      description: SLEEP_DESCRIPTION,
      inputSchema: {
        range: z.string().optional().describe("Inclusive aligned block range, as given in the task, for example 16-31."),
        summary: normalizedMemorySchema("summary").optional().describe("One line, at most 280 UTF-8 bytes after whitespace collapses."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap(async ({ range, summary }) => { rejectOriginMarker(summary); const result = store.sleep(range, summary); await mirror(); return result; }),
  );

  server.registerTool(
    "apocrypha_recall",
    {
      title: "Search or zoom Apocrypha",
      description: RECALL_DESCRIPTION,
      inputSchema: {
        pattern: z.string().min(1).max(1024).optional().describe("JavaScript regular expression, up to 1024 bytes, with a one-second execution limit."),
        range: z.string().max(40).optional().describe("Inclusive aligned block range, for example 16-31."),
        id: z.string().max(40).optional().describe("A note number like #42 or a transcript id like t412."),
        in: z.enum(["notes","transcripts"]).optional().describe("notes (default) or transcripts. Only with pattern."),
        part: z.number().int().positive().optional().describe("Page number."),
        snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Content fingerprint from a previous page's next command. If the content has changed, the read is rejected."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async (args) => {
      if ([args.pattern,args.range,args.id].filter(v=>v!==undefined).length !== 1) throw new Error("Supply exactly one of pattern, range, id.");
      if (args.pattern !== undefined) {
        if (args.part !== undefined || args.snapshot !== undefined) throw new Error("Search returns the newest bounded matches; use zoom for transcript paging.");
        const lines = args.in === "transcripts" ? transcripts.entries().map(t => t.id + " " + JSON.stringify(t)) : store.entries();
        return safeSearch(lines,args.pattern);
      }
      if (args.in !== undefined) throw new Error("in is only valid with pattern.");
      return zoom(store,transcripts,args);
    }),
  );

  server.registerTool(
    "apocrypha_forget",
    {
      title: "Discard an Apocrypha summary",
      description: FORGET_DESCRIPTION,
      inputSchema: { range: z.string().describe("Inclusive aligned block range of the summary, for example 16-31.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    wrap(async ({ range }) => { const result = store.forget(range); await mirror(); return result; }),
  );

  return server;
}

export { SERVER_INSTRUCTIONS, CAPTURE_INSTRUCTION, WAKE_DESCRIPTION, NOTE_DESCRIPTION, SLEEP_DESCRIPTION, RECALL_DESCRIPTION, FORGET_DESCRIPTION };
