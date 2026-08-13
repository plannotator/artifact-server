#!/usr/bin/env bash

set -euo pipefail

pnpm build
pnpm test:observability

bash scripts/with-shared-test-providers.sh \
  pnpm exec vitest run --coverage --config vitest.shared.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile=evidence/shared-runtime.json
