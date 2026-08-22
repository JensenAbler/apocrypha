# Apocrypha

Apocrypha is Jensen's single-user, append-only remote MCP memory for useful personal context an assistant judges it should not place in its normal built-in memory. Claude and ChatGPT share the same standard Streamable HTTP endpoint at `/mcp`. It supports standards-based OAuth 2.1 for clients such as Claude, while retaining a separate static bearer token for clients that can set an authorization header directly.

## Scope: exceptional memory only

Apocrypha follows OptMem's general memory and compression semantics with one specialization: it is not a second general-purpose memory store. An assistant should write here only when personal context is worth remembering but the assistant judges it is not supposed to save that context in its own personal memory bank—for example, housing, income, financial runway, socioeconomic circumstances, or related work-pipeline context. Facts eligible for ordinary built-in memory belong there and should not also be copied into Apocrypha. This separation avoids redundant or conflicting memories across systems.

`LOG.txt` is authoritative. It uses OptMem's 320-byte fixed-width records (one newline-terminated memory per record), and `TREE/<size>` uses its 288-byte fixed-width binary-merge records. Corrections are later log entries; raw memories are never edited or deleted. Google Drive is only a phone-readable mirror.

## Tools

- `apocrypha_wake`: mandatory standing-context read, paged below client response limits; refuses while any compression is pending.
- `apocrypha_note`: records only otherwise-disallowed durable context, collapses whitespace, appends a dated memory, mirrors Drive, and returns the next newly-doable compression.
- `apocrypha_sleep`: gets or settles the next merge-tree compression.
- `apocrypha_recall`: case-insensitive regex search of the complete raw log.
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

`C:\Users\Jensen\code\apochrypha` is the development checkout. GitHub's public `main` branch is the release source, and Alpha deploys that published branch rather than unpublished local files.

1. Make changes in the local checkout and run `npm test`.
2. Commit the changes and push `main` to GitHub.
3. From PowerShell, run `./scripts/deploy-alpha.ps1`.

The deployment script refuses a dirty tree, a non-`main` branch, or a local commit that differs from `origin/main`. On Alpha it performs a fast-forward-only update, installs locked production dependencies, restarts the service, and verifies the local health endpoint. Runtime state remains separate: credentials live in `/etc/apocrypha.env`, while the append-only log, summary tree, and OAuth state live in `/var/lib/apocrypha`; none are part of Git.

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

## Deploy on Alpha

Copy this project to `/srv/apocrypha`, then run as root:

```sh
cd /srv/apocrypha
npm ci --omit=dev
useradd --system --home /var/lib/apocrypha --shell /usr/sbin/nologin apocrypha || true
chown -R apocrypha:apocrypha /var/lib/apocrypha
install -o root -g root -m 600 deploy/apocrypha.env.example /etc/apocrypha.env
install -o root -g root -m 644 deploy/apocrypha.service /etc/systemd/system/apocrypha.service
systemctl daemon-reload
systemctl enable --now apocrypha
```

Edit `/etc/apocrypha.env` with real, independent `MCP_BEARER_TOKEN` and `OAUTH_ACCESS_KEY` values before starting the service. The process always binds `127.0.0.1`; nginx is the only public listener.

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
