#!/usr/bin/env bash

set -euo pipefail

pnpm build

bash scripts/with-shared-test-providers.sh \
  pnpm exec tsx performance/run-shared-baseline.ts "$@"
