param(
  [string]$AlphaHost = "31.97.135.128",
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\alphaclawd"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedIdentity = (Resolve-Path -LiteralPath $IdentityFile).Path

Push-Location $repoRoot
try {
  if (git status --porcelain) {
    throw "The local working tree is not clean. Commit or stash changes before deploying."
  }
  if ((git branch --show-current) -ne "main") {
    throw "Deployments must be made from the main branch."
  }

  git fetch origin main
  if ($LASTEXITCODE -ne 0) { throw "Could not fetch origin/main." }

  $localCommit = git rev-parse HEAD
  $publishedCommit = git rev-parse origin/main
  if ($localCommit -ne $publishedCommit) {
    throw "Local HEAD is not the published origin/main commit. Push or synchronize before deploying."
  }

  $remoteScript = @'
set -eu
cd /srv/apocrypha
git fetch origin main
git checkout main
git merge --ff-only origin/main
npm ci --omit=dev
systemctl restart apocrypha
attempt=0
until curl --fail --silent http://127.0.0.1:8787/healthz; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    journalctl -u apocrypha -n 30 --no-pager
    exit 1
  fi
  sleep 0.25
done
'@

  & ssh -i $resolvedIdentity "root@$AlphaHost" $remoteScript
  if ($LASTEXITCODE -ne 0) { throw "Alpha deployment failed." }
  Write-Host "Deployed $localCommit to Alpha."
} finally {
  Pop-Location
}
