import { timingSafeEqual } from "node:crypto";

import express from "express";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";

import { TranscriptStore } from "./transcripts.js";
import { ApocryphaStore } from "./storage.js";
import { createApocryphaMcpServer } from "./mcp.js";
import { BackgroundCompactor, modelFromEnvironment } from "./compactor.js";
import { completeWakeView } from "./wake-view.js";
import { queueDriveMirror, isDriveConfigured } from "./drive.js";
import { ApocryphaOAuthProvider, OAUTH_SCOPES, createOAuthApprovalRouter } from "./oauth.js";

const port = Number(process.env.PORT || 8787);
const host = "127.0.0.1";
const publicHostname = process.env.MCP_PUBLIC_HOSTNAME || "mcp.jensenabler.com";
const bearerToken = process.env.MCP_BEARER_TOKEN;
const oauthAccessKey = process.env.OAUTH_ACCESS_KEY;
const memoryDirectory = process.env.MEMORY_DIR;

if (!bearerToken) throw new Error("MCP_BEARER_TOKEN is required.");
if (!oauthAccessKey) throw new Error("OAUTH_ACCESS_KEY is required.");
if (!memoryDirectory) throw new Error("MEMORY_DIR is required.");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");

const store = new ApocryphaStore(memoryDirectory);
let transcripts;
let reconciliationError = null;
try { transcripts = new TranscriptStore(memoryDirectory); }
catch (error) { reconciliationError = error.message; console.error(JSON.stringify({event:'reconciliation_error',message:error.message})); }
let compactor;
const mirror = () => queueDriveMirror(store, { render: () => completeWakeView(store, compactor) });
compactor = new BackgroundCompactor(store, { mode:process.env.APOCRYPHA_COMPACTION_MODE || "background", model:modelFromEnvironment(), transcripts,
  onChange:async()=>{try {await mirror();}catch(error){console.error(JSON.stringify({event:'mirror_error',message:error.message}));}} });
if ((!compactor.configured || compactor.mode === "in-band") && transcripts) {
  try {console.log(JSON.stringify({event:'turn_leaf_reconciliation',...transcripts.reconcile()}));}
  catch(error){reconciliationError=error.message;}
}
compactor.start();
void mirror().catch(error=>console.error(JSON.stringify({event:'mirror_error',message:error.message})));
const publicOrigin = new URL(`https://${publicHostname}`);
const resourceUrl = new URL("/mcp", publicOrigin);
const oauthProvider = new ApocryphaOAuthProvider({
  directory: memoryDirectory,
  accessKey: oauthAccessKey,
  resourceUrl,
});
const app = createMcpExpressApp({
  host,
  allowedHosts: ["127.0.0.1", "localhost", publicHostname],
});
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);

// createMcpExpressApp installs express.json() with Express's 100 KB default.
// An outer app parses first with a limit well above any client's tool-argument
// size, so the clients' own limits, not this server's, are the binding ones.
export const BODY_LIMIT = "16mb";
const outer = express();
outer.use(express.json({ limit: BODY_LIMIT }));
outer.use((error, _req, res, next) => {
  if (error?.type !== "entity.too.large") return next(error);
  res.status(413).json({
    jsonrpc: "2.0",
    error: { code: -32600, message: `Request body exceeds Apocrypha's ${BODY_LIMIT} HTTP limit.` },
    id: null,
  });
});
outer.use(app);

function authorized(header) {
  const expected = Buffer.from(`Bearer ${bearerToken}`, "utf8");
  const actual = Buffer.from(header || "", "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function requireBearer(req, res, next) {
  const header = req.get("authorization") || "";
  if (authorized(header)) return next();
  const match = /^Bearer +(.+)$/i.exec(header);
  if (match) {
    try {
      req.auth = await oauthProvider.verifyAccessToken(match[1]);
      return next();
    } catch {
      // Fall through to the standards-compliant OAuth challenge.
    }
  }
  res
    .set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", scope="apocrypha"`)
    .status(401)
    .json({ error: "Unauthorized" });
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: !reconciliationError, memories: store.count(), compactor: compactor.status(), reconciliationError });
});

app.use(createOAuthApprovalRouter(oauthProvider));
app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: publicOrigin,
  resourceServerUrl: resourceUrl,
  scopesSupported: OAUTH_SCOPES,
  resourceName: "Apocrypha",
  clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
}));

app.use("/mcp", requireBearer);

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createApocryphaMcpServer(store, { transcripts, compactor, mirror });
  let closed = false;
  const closeProtocolObjects = () => {
    if (closed) return;
    closed = true;
    Promise.allSettled([transport.close(), server.close()]).catch(() => {});
  };
  res.once("close", closeProtocolObjects);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").send("Method Not Allowed"));
app.delete("/mcp", (_req, res) => res.status(405).set("Allow", "POST").send("Method Not Allowed"));

const listener = outer.listen(port, host, () => {
  console.log(`Apocrypha listening on http://${host}:${port}; ${store.count()} memories.`);
  if (!isDriveConfigured()) console.warn("Google Drive mirror is not configured.");
});

function shutdown(signal) {
  console.log(`${signal}: shutting down.`);
  compactor.stop();
  listener.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
