# Apocrypha

Apocrypha is Jensen's single-user, append-only remote MCP memory, shared between his Claude and ChatGPT assistants. Claude and ChatGPT share the same standard Streamable HTTP endpoint at `/mcp`. It supports standards-based OAuth 2.1 for clients such as Claude, while retaining a separate static bearer token for clients that can set an authorization header directly.

## Scope

Apocrypha follows OptMem's memory/compression semantics. Curated notes can contain anything durable and worth sharing across Claude and ChatGPT, including pointers to explicitly captured transcript turns. Labeled assistant inferences still require Jensen's review.

Every conversation turn is recorded: the apocrypha_note description carries the capture instruction.

Waking is on demand. Notes and transcripts are background, not instructions and not topics to raise unprompted. Transcripts are an assistant's text copy, not canonical vendor exports; tools, images, attachments, and unrecorded turns are absent.

`LOG.txt` is authoritative. It uses OptMem's 320-byte fixed-width records (one newline-terminated memory per record), and `TREE/<size>` uses its 288-byte fixed-width binary-merge records. Corrections are later log entries; raw memories are never edited or deleted. Google Drive is only a phone-readable mirror.

## Tools

- `apocrypha_wake`: on-demand read of the shared context, paged below client response limits; refuses while any compression is pending.
- `apocrypha_note`: exactly one of a curated `text` note, explicitly authorized `turn`, or evidence-backed `resolve`. Only curated notes enter the Drive mirror.
- `apocrypha_sleep`: gets or settles the next merge-tree compression.
- `apocrypha_recall`: bounded-time regex search or pure-read zoom through settled blocks, notes and transcript leaves.
- `apocrypha_forget`: truncates a wrong summary and all summaries above it, without touching the log.

Wake intentionally returns every raw record while the log fits within its 96-line rendering budget. Once the log exceeds that budget, it tiles the full history with stored tree summaries toward the past and progressively finer detail toward the present. A note returns only the first newly-doable compression; each sleep response returns the next task in the cascade. Draining that cascade before wake is deliberate, because wake never renders from a partially built tree.

Compression follows OptMem's category-neutral rule: keep what has lasting effect, drop what does not, and invent nothing. The raw log remains authoritative regardless of what a summary omits.

## Local verification

```sh
npm install
npm test
```

The tests include a 2,000-memory OptMem stress run, fixed-record and tree invariants, paging, increasing detail toward the present, forget/rebuild byte identity, restart persistence, MCP schemas, and the Drive `batchUpdate` request.

## Development and deployment workflow

Source changes use the managed Praxis workspace: recover/sync the registered apocrypha project, edit and test there, review the diff, then obtain required publication approval before commit, push, and exact-main deployment_fast_forward. Never edit deployed source or use ad hoc worktrees. Existing runtime data and secrets are not development fixtures.

The v2 rollout, protocol additions, recovery rules, client verification checklist and draft capture instructions are in [V2.md](V2.md). Neither server tests nor a deployment prove Claude/ChatGPT refreshed their cached schemas.

## Google authorization (one time, on the laptop)

1. In Google Cloud, enable the Google Docs API and create a Desktop OAuth client.
2. Configure the OAuth consent screen and **publish it to Production**. Leaving it in Testing makes the refresh token expire after seven days.
3. Add `http://127.0.0.1:53682/oauth2callback` if the client configuration asks for an authorized redirect URI.
4. Run:

   ```sh
   GOOGLE_CLIENT_ID='...' GOOGLE_CLIENT_SECRET='...' npm run oauth:google
   ```

The helper requests `access_type=offline`, `prompt=consent`, and only `https://www.googleapis.com/auth/documents`. Put the printed refresh token in `/etc/apocrypha.env`; do not commit it.

The mirror targets `GOOGLE_DOC_ID`, not the document title. Renaming the Google Doc does not break synchronization and must not be replaced with title-based lookup.

The old scripts/deploy-alpha.ps1 helper is retained for historical reference only. It is legacy, not the supported deployment path; do not use it for v2 upgrades.

## Deploy on Alpha

The existing Alpha installation is managed through Praxis. For upgrades, follow the managed development and deployment workflow above; do not copy source into the live checkout, reinstall environment examples, recreate users, or overwrite existing secrets. Deployment preserves /var/lib/apocrypha and /etc/apocrypha.env. Initial provisioning is a separate operator task, not part of the v2 upgrade.

## Connect Claude

In Claude's custom connector dialog, enter `https://mcp.jensenabler.com/mcp` and leave the optional OAuth Client ID and Client Secret fields blank. Claude discovers Apocrypha's OAuth metadata and dynamically registers itself. When the Apocrypha authorization page opens, paste the private `OAUTH_ACCESS_KEY` and approve access. Do not use the Google OAuth client credentials here.

The approval key is only used at the authorization page. Claude receives a scoped, expiring access token and a rotating refresh token; it never receives the approval key or the static bearer token.

## Connect a bearer-token client

For an MCP client that supports custom headers, use Streamable HTTP at `https://mcp.jensenabler.com/mcp` with `Authorization: Bearer <MCP_BEARER_TOKEN>`. The static token is independent of Claude's OAuth credentials.

## Acceptance calls

```sh
curl https://mcp.jensenabler.com/healthz
curl -i -X POST https://mcp.jensenabler.com/mcp
```

For a protocol-level check, use the MCP Inspector with Streamable HTTP, URL `https://mcp.jensenabler.com/mcp`, and either its OAuth flow or the request header `Authorization: Bearer <MCP_BEARER_TOKEN>`.
