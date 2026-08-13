#!/usr/bin/env bash

set -euo pipefail

pnpm build
pnpm test:observability

bash scripts/with-external-storage-test-providers.sh \
  pnpm exec vitest run --coverage --config vitest.external-storage.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile=evidence/external-storage-runtime.json
