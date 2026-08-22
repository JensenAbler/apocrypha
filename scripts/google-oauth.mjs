import http from "node:http";
import { URL } from "node:url";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const port = Number(process.env.GOOGLE_OAUTH_PORT || 53682);
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const scope = "https://www.googleapis.com/auth/documents";

if (!clientId || !clientSecret) {
  throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before running this helper.");
}

const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authorization.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope,
  access_type: "offline",
  prompt: "consent",
}).toString();

const server = http.createServer(async (request, response) => {
  const callback = new URL(request.url, redirectUri);
  if (callback.pathname !== "/oauth2callback") {
    response.writeHead(404).end("Not found");
    return;
  }
  const code = callback.searchParams.get("code");
  if (!code) {
    response.writeHead(400).end(`OAuth failed: ${callback.searchParams.get("error") || "no code"}`);
    return;
  }
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.refresh_token) {
      throw new Error(JSON.stringify(tokens));
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Refresh token created. Return to the terminal.");
    console.log(`\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("Store it in /etc/apocrypha.env (mode 600), then erase it from terminal history.");
  } catch (error) {
    response.writeHead(500).end("Token exchange failed. See terminal.");
    console.error(error);
  } finally {
    server.close();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log("Open this URL in a browser on this laptop:\n");
  console.log(authorization.toString());
  console.log("\nWaiting for Google's callback...");
});
