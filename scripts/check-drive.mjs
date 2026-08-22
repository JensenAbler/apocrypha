import { driveConfig, getAccessToken, GOOGLE_DOC_TITLE } from "../src/drive.js";
import { ApocryphaStore } from "../src/storage.js";

function textRuns(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (typeof value.textRun?.content === "string") output.push(value.textRun.content);
  for (const child of Array.isArray(value) ? value : Object.values(value)) textRuns(child, output);
  return output;
}

const config = driveConfig();
const token = await getAccessToken(config);
const response = await fetch(
  `https://docs.googleapis.com/v1/documents/${encodeURIComponent(config.documentId)}`,
  { headers: { authorization: `Bearer ${token}` } },
);
if (!response.ok) throw new Error(`Google Docs read failed with HTTP ${response.status}.`);
const document = await response.json();
const rendered = textRuns(document.body).join("");
const store = new ApocryphaStore(process.env.MEMORY_DIR);
const entries = store.entries();
const lines = rendered.split("\n");
console.log(JSON.stringify({
  titleMatches: document.title === GOOGLE_DOC_TITLE,
  memories: entries.length,
  allMemoriesPresent: entries.every((entry) => rendered.includes(entry)),
  rawIdPrefixes: lines.filter((line) => /^#\d/.test(line)).length,
  escapedIdPrefixes: lines.filter((line) => /^\\#\d/.test(line)).length,
}));
