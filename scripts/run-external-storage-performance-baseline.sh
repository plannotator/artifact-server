#!/usr/bin/env bash

set -euo pipefail

pnpm build

bash scripts/with-external-storage-test-providers.sh \
  pnpm exec tsx performance/run-external-storage-baseline.ts "$@"
