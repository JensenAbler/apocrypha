import { timingSafeEqual } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";

import { ApocryphaStore } from "./storage.js";
import { createApocryphaMcpServer } from "./mcp.js";
import { isDriveConfigured } from "./drive.js";
import { ApocryphaOAuthProvider, createOAuthApprovalRouter } from "./oauth.js";

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
  res.json({ ok: true, memories: store.count() });
});

app.use(createOAuthApprovalRouter(oauthProvider));
app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: publicOrigin,
  resourceServerUrl: resourceUrl,
  scopesSupported: ["apocrypha"],
  resourceName: "Apocrypha",
  clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
}));

app.use("/mcp", requireBearer);

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createApocryphaMcpServer(store);
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

const listener = app.listen(port, host, () => {
  console.log(`Apocrypha listening on http://${host}:${port}; ${store.count()} memories.`);
  if (!isDriveConfigured()) console.warn("Google Drive mirror is not configured.");
});

function shutdown(signal) {
  console.log(`${signal}: shutting down.`);
  listener.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
