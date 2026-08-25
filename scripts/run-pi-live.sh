#!/usr/bin/env bash

# Runs the live-Pi bridge suite: a REAL pi process in a real PTY, loaded with
# integrations/pi/index.ts, against a real Artifact Server on a temporary data
# directory and an offline scripted model. No API key and no network provider
# are involved. This suite is deliberately NOT part of pnpm verify:iteration.

set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repository_root}"

# 1. Find a pi CLI: an explicit override, the installed pi, or a local checkout
#    build. The checkout is only read, never built.
pi_cli="${ARTIFACT_SERVER_PI_LIVE_CLI:-}"
if [[ -z "${pi_cli}" ]] && command -v pi >/dev/null 2>&1; then
  pi_cli="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$(command -v pi)")"
fi
if [[ -z "${pi_cli}" ]]; then
  candidate="${HOME}/oss-agents/pi/packages/coding-agent/dist/cli.js"
  if [[ -f "${candidate}" ]]; then
    pi_cli="${candidate}"
  fi
fi
if [[ -z "${pi_cli}" || ! -f "${pi_cli}" ]]; then
  cat >&2 <<'MESSAGE'
No pi CLI was found, so the live-Pi suite cannot run.

Install it (npm install -g @earendil-works/pi-coding-agent), or point the suite
at a built checkout:

  ARTIFACT_SERVER_PI_LIVE_CLI=/path/to/pi/packages/coding-agent/dist/cli.js \
    pnpm test:pi-live
MESSAGE
  exit 1
fi
export ARTIFACT_SERVER_PI_LIVE_CLI="${pi_cli}"
echo "Using pi CLI: ${pi_cli}"
node "${pi_cli}" --version

# 2. node-pty ships a prebuilt spawn-helper whose executable bit does not
#    survive npm/pnpm tarball extraction; without it every PTY spawn fails with
#    "posix_spawnp failed".
node -e '
const {chmodSync, constants, accessSync} = require("node:fs");
const path = require("node:path");
const helper = path.join(
  path.dirname(require.resolve("node-pty/package.json")),
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper",
);
try {
  accessSync(helper, constants.X_OK);
} catch {
  chmodSync(helper, 0o755);
  console.log(`Restored the executable bit on ${helper}`);
}
'

# 3. Run the suite serially; PTY-driven agents are timing sensitive.
pnpm exec vitest run --config vitest.pi-live.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile.json=project/evidence/pi-live.json
