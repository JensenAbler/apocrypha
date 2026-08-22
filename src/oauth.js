import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import express from "express";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

const ACCESS_TOKEN_SECONDS = 60 * 60;
const PENDING_SECONDS = 10 * 60;
const DEFAULT_SCOPE = "apocrypha";
export const OAUTH_SCOPES = [DEFAULT_SCOPE, "offline_access"];

function opaqueToken() {
  return randomBytes(32).toString("base64url");
}

function safeEqual(actual, expected) {
  const left = Buffer.from(actual || "", "utf8");
  const right = Buffer.from(expected || "", "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function approvalHtml({ pendingId, clientName, redirectHost, error = "" }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Apocrypha</title>
<style>body{font:16px system-ui;background:#151515;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:34rem;padding:2rem;border:1px solid #555;border-radius:16px;background:#202020}h1{margin-top:0}label{display:block;margin:1.25rem 0 .4rem}input{box-sizing:border-box;width:100%;padding:.8rem;border:1px solid #777;border-radius:8px;background:#111;color:#fff}button{margin-top:1.25rem;padding:.8rem 1rem;border:0;border-radius:8px;font-weight:700}.approve{background:#fff;color:#111}.deny{background:#555;color:#fff;margin-left:.5rem}.error{color:#ff9b9b}small{color:#bbb}</style>
</head><body><main class="card"><h1>Authorize Apocrypha</h1>
<p><strong>${escapeHtml(clientName)}</strong> is requesting access to Jensen's private Apocrypha memory through <code>${escapeHtml(redirectHost)}</code>.</p>
<p>This permits reading and appending personal context, requesting summaries, searching the raw log, and rebuilding summary blocks.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/approve"><input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
<label for="key">Apocrypha access key</label><input id="key" name="access_key" type="password" required autocomplete="current-password">
<small>This is the private authorization key stored on Alpha—not the Google OAuth secret.</small><br>
<button class="approve" name="decision" value="approve" type="submit">Authorize Apocrypha</button>
<button class="deny" name="decision" value="deny" type="submit">Deny</button></form></main></body></html>`;
}

class PersistentOAuthState {
  constructor(directory) {
    this.file = path.join(directory, "OAUTH.json");
    this.data = { clients: {}, accessTokens: {}, refreshTokens: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = {
        clients: parsed.clients ?? {},
        accessTokens: parsed.accessTokens ?? {},
        refreshTokens: parsed.refreshTokens ?? {},
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  save() {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  pruneAccessTokens() {
    const now = Math.floor(Date.now() / 1000);
    for (const [token, record] of Object.entries(this.data.accessTokens)) {
      if (record.expiresAt <= now) delete this.data.accessTokens[token];
    }
  }
}

export class ApocryphaOAuthProvider {
  constructor({ directory, accessKey, resourceUrl }) {
    if (!accessKey) throw new Error("OAUTH_ACCESS_KEY is required.");
    this.accessKey = accessKey;
    this.resourceUrl = new URL(resourceUrl);
    this.state = new PersistentOAuthState(directory);
    this.pending = new Map();
    this.codes = new Map();
    this.clientsStore = {
      getClient: async (clientId) => this.state.data.clients[clientId],
      registerClient: async (client) => {
        for (const redirect of client.redirect_uris) {
          const url = new URL(redirect);
          const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
          if (url.protocol !== "https:" && !loopback) {
            throw new InvalidClientMetadataError("Redirect URIs must use HTTPS or an HTTP loopback address.");
          }
        }
        this.state.data.clients[client.client_id] = client;
        this.state.save();
        return client;
      },
    };
  }

  validResource(resource) {
    return resource === undefined || resource.href === this.resourceUrl.href;
  }

  async authorize(client, params, res) {
    if (!this.validResource(params.resource)) throw new InvalidRequestError("Invalid resource audience.");
    if (params.scopes.some((scope) => !OAUTH_SCOPES.includes(scope))) {
      throw new InvalidScopeError("Requested scope is not supported.");
    }
    const pendingId = opaqueToken();
    this.pending.set(pendingId, {
      clientId: client.client_id,
      params,
      expiresAt: Date.now() + PENDING_SECONDS * 1000,
    });
    const redirectHost = new URL(params.redirectUri).host;
    res
      .status(200)
      .set({
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
      })
      .send(approvalHtml({
        pendingId,
        clientName: client.client_name || "An MCP client",
        redirectHost,
      }));
  }

  completeAuthorization(pendingId, accessKey, decision, res) {
    const request = this.pending.get(pendingId);
    if (!request || request.expiresAt < Date.now()) {
      this.pending.delete(pendingId);
      res.status(400).send("This authorization request expired. Return to the connector and try again.");
      return;
    }
    const client = this.state.data.clients[request.clientId];
    if (!client) {
      this.pending.delete(pendingId);
      res.status(400).send("The OAuth client is no longer registered.");
      return;
    }
    if (decision === "deny") {
      this.pending.delete(pendingId);
      const target = new URL(request.params.redirectUri);
      target.searchParams.set("error", "access_denied");
      if (request.params.state) target.searchParams.set("state", request.params.state);
      res.redirect(302, target.href);
      return;
    }
    if (!safeEqual(accessKey, this.accessKey)) {
      res
        .status(401)
        .set({
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
        })
        .send(approvalHtml({
          pendingId,
          clientName: client.client_name || "An MCP client",
          redirectHost: new URL(request.params.redirectUri).host,
          error: "Incorrect access key.",
        }));
      return;
    }
    this.pending.delete(pendingId);
    const code = opaqueToken();
    this.codes.set(code, { ...request, expiresAt: Date.now() + PENDING_SECONDS * 1000 });
    const target = new URL(request.params.redirectUri);
    target.searchParams.set("code", code);
    if (request.params.state) target.searchParams.set("state", request.params.state);
    res.redirect(302, target.href);
  }

  async challengeForAuthorizationCode(client, code) {
    const record = this.codes.get(code);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    return record.params.codeChallenge;
  }

  issueTokens(clientId, scopes, resource) {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = opaqueToken();
    const refreshToken = opaqueToken();
    const normalizedScopes = scopes?.length ? scopes : [DEFAULT_SCOPE];
    const audience = resource?.href ?? this.resourceUrl.href;
    this.state.pruneAccessTokens();
    this.state.data.accessTokens[accessToken] = {
      clientId,
      scopes: normalizedScopes,
      resource: audience,
      expiresAt: now + ACCESS_TOKEN_SECONDS,
    };
    this.state.data.refreshTokens[refreshToken] = {
      clientId,
      scopes: normalizedScopes,
      resource: audience,
    };
    this.state.save();
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      scope: normalizedScopes.join(" "),
      refresh_token: refreshToken,
    };
  }

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const record = this.codes.get(code);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    }
    if (!this.validResource(resource) || !this.validResource(record.params.resource)) {
      throw new InvalidGrantError("Invalid resource audience.");
    }
    this.codes.delete(code);
    return this.issueTokens(client.client_id, record.params.scopes, record.params.resource ?? resource);
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const record = this.state.data.refreshTokens[refreshToken];
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token.");
    if (resource && resource.href !== record.resource) throw new InvalidGrantError("Invalid resource audience.");
    const requested = scopes?.length ? scopes : record.scopes;
    if (requested.some((scope) => !record.scopes.includes(scope))) {
      throw new InvalidGrantError("A refresh request cannot expand its scopes.");
    }
    delete this.state.data.refreshTokens[refreshToken];
    return this.issueTokens(client.client_id, requested, new URL(record.resource));
  }

  async verifyAccessToken(token) {
    const record = this.state.data.accessTokens[token];
    const now = Math.floor(Date.now() / 1000);
    if (!record || record.expiresAt <= now || record.resource !== this.resourceUrl.href) {
      throw new Error("Invalid or expired access token.");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: new URL(record.resource),
    };
  }

  async revokeToken(client, request) {
    const access = this.state.data.accessTokens[request.token];
    const refresh = this.state.data.refreshTokens[request.token];
    if (access?.clientId === client.client_id) delete this.state.data.accessTokens[request.token];
    if (refresh?.clientId === client.client_id) delete this.state.data.refreshTokens[request.token];
    this.state.save();
  }
}

export function createOAuthApprovalRouter(provider) {
  const router = express.Router();
  const attempts = new Map();
  router.post("/oauth/approve", express.urlencoded({ extended: false }), (req, res) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const recent = (attempts.get(key) ?? []).filter((time) => now - time < 15 * 60 * 1000);
    if (recent.length >= 10) {
      res.status(429).send("Too many authorization attempts. Wait 15 minutes and try again.");
      return;
    }
    recent.push(now);
    attempts.set(key, recent);
    provider.completeAuthorization(req.body.pending, req.body.access_key, req.body.decision, res);
  });
  return router;
}
