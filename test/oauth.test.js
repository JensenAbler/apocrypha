import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";

import { ApocryphaOAuthProvider, createOAuthApprovalRouter } from "../src/oauth.js";

test("OAuth discovery, DCR, PKCE, access tokens, and rotating refresh tokens", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apocrypha-oauth-"));
  const resourceUrl = new URL("https://mcp.jensenabler.com/mcp");
  const provider = new ApocryphaOAuthProvider({ directory, accessKey: "private-approval-key", resourceUrl });
  const app = express();
  app.use(createOAuthApprovalRouter(provider));
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL("http://127.0.0.1:9999"),
    resourceServerUrl: resourceUrl,
    scopesSupported: ["apocrypha"],
    resourceName: "Apocrypha",
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;

  try {
    const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(metadata.resource, resourceUrl.href);
    assert.deepEqual(metadata.scopes_supported, ["apocrypha"]);

    const registrationResponse = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Claude",
      }),
    });
    assert.equal(registrationResponse.status, 201);
    const client = await registrationResponse.json();
    assert.ok(client.client_id);

    const verifier = "acceptance-verifier-with-at-least-forty-three-characters";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = new URL(`${base}/authorize`);
    authorization.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "apocrypha",
      state: "acceptance-state",
      resource: resourceUrl.href,
    }).toString();
    const approval = await fetch(authorization);
    const approvalBody = await approval.text();
    assert.equal(approval.status, 200);
    assert.match(approvalBody, /Authorize Apocrypha/);
    const pending = /name="pending" value="([^"]+)"/.exec(approvalBody)[1];

    const wrong = await fetch(`${base}/oauth/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pending, access_key: "wrong", decision: "approve" }),
    });
    assert.equal(wrong.status, 401);

    const accepted = await fetch(`${base}/oauth/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pending, access_key: "private-approval-key", decision: "approve" }),
    });
    assert.equal(accepted.status, 302);
    const callback = new URL(accepted.headers.get("location"));
    assert.equal(callback.origin + callback.pathname, "https://claude.ai/api/mcp/auth_callback");
    assert.equal(callback.searchParams.get("state"), "acceptance-state");

    const tokenResponse = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: callback.searchParams.get("code"),
        code_verifier: verifier,
        redirect_uri: client.redirect_uris[0],
        resource: resourceUrl.href,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    const verified = await provider.verifyAccessToken(tokens.access_token);
    assert.equal(verified.clientId, client.client_id);
    assert.equal(verified.resource.href, resourceUrl.href);

    const refreshResponse = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
        resource: resourceUrl.href,
      }),
    });
    assert.equal(refreshResponse.status, 200);
    const refreshed = await refreshResponse.json();
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
    assert.notEqual(refreshed.access_token, tokens.access_token);

    const replay = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
      }),
    });
    assert.equal(replay.status, 400);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
