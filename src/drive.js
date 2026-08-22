const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DOCUMENTS_URL = "https://docs.googleapis.com/v1/documents";

export const DEFAULT_GOOGLE_DOC_ID = "1ZE6XLbdSuPt8jgkikrg5NzmOibKT2SQ1h8FPoxGLJf0";
export const GOOGLE_DOC_TITLE = "Apocrypha (Memories Anthropic Forbids Claude from storing in their system)";

export function driveConfig(environment = process.env) {
  return {
    clientId: environment.GOOGLE_CLIENT_ID,
    clientSecret: environment.GOOGLE_CLIENT_SECRET,
    refreshToken: environment.GOOGLE_REFRESH_TOKEN,
    documentId: environment.GOOGLE_DOC_ID || DEFAULT_GOOGLE_DOC_ID,
  };
}

export function isDriveConfigured(config = driveConfig()) {
  return Boolean(config.clientId && config.clientSecret && config.refreshToken && config.documentId);
}

async function googleRequest(url, options, fetchImpl) {
  const response = await fetchImpl(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google API ${response.status}: ${body.slice(0, 1000)}`);
  }
  return response.json();
}

export async function getAccessToken(config, fetchImpl = fetch) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });
  const result = await googleRequest(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    fetchImpl,
  );
  if (!result.access_token) throw new Error("Google token response did not contain access_token.");
  return result.access_token;
}

export async function mirrorToDrive(store, {
  config = driveConfig(),
  fetchImpl = fetch,
} = {}) {
  if (!isDriveConfigured(config)) return { skipped: true };
  const accessToken = await getAccessToken(config, fetchImpl);
  const headers = { authorization: `Bearer ${accessToken}` };
  const documentUrl = `${DOCUMENTS_URL}/${encodeURIComponent(config.documentId)}`;
  const document = await googleRequest(documentUrl, { headers }, fetchImpl);
  const content = document.body?.content ?? [];
  const finalEndIndex = content.at(-1)?.endIndex ?? 1;
  const text = store.entries().join("\n") + (store.count() ? "\n" : "");
  const requests = [];
  // A Google Doc always keeps its terminal newline; only delete the content
  // before it, then insert the authoritative rendering at index 1.
  if (finalEndIndex > 2) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: finalEndIndex - 1 },
      },
    });
  }
  if (text) {
    requests.push({ insertText: { location: { index: 1 }, text } });
  }
  await googleRequest(
    `${documentUrl}:batchUpdate`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ requests }),
    },
    fetchImpl,
  );
  return { skipped: false, memories: store.count(), title: GOOGLE_DOC_TITLE };
}

let mirrorQueue = Promise.resolve();

export function queueDriveMirror(store, options = {}) {
  const job = mirrorQueue.then(() => mirrorToDrive(store, options));
  // Keep later mirrors flowing after a failure. The caller logs this job's
  // error without allowing it to roll back the already-durable append.
  mirrorQueue = job.catch(() => {});
  return job;
}
