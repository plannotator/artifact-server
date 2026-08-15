# Conformance

`conformance.yml` is the executable checklist for the Artifact Server product specification. The HTML specification explains the product; the ledger identifies the observable behavior and failure proof required to claim that an implementation conforms.

## Status meanings

- `specified`: the requirement exists, but its normal behavior has not been proved on an applicable deployment.
- `implementing`: implementation work is active, but passing proof is not complete.
- `behavior_verified`: at least one applicable deployment has passing evidence for the normal behavior. Full hostile and cross-deployment proof remains incomplete.
- `verified`: the normal and hostile tests pass on every applicable deployment and the ledger records that evidence.
- `blocked`: a named external decision or dependency prevents progress.
- `not_applicable`: the requirement does not apply, with the reason recorded in the ledger.

Do not mark a requirement `verified` because its code exists or one local test passes. `verified` is the release-level state defined above.

## Test IDs

Every requirement owns two acceptance IDs:

- `*-B` proves the documented behavior.
- `*-F` proves the hostile, invalid, or failure case.

Put each implemented acceptance ID in exactly one test title. A single end-to-end test may prove several IDs when one observable workflow genuinely covers them together. Do not attach an ID to a test that proves only a convenient approximation of the requirement.

## Evidence

Passing evidence records:

- the deployment that ran the test;
- the exact acceptance IDs proved;
- the durable report or CI run containing the result;
- the recording time.

The local test report is `evidence/local-foundation.json`. Other deployments must produce their own evidence; local results cannot stand in for a server, Kubernetes, Cloudflare, AWS, or GCP run. Azure uses the Kubernetes path on AKS rather than a separate deployment target.

## MCP release critical path

The official connection paths are release gates, not documentation-only goals:

- `MCP-016`: local `artifactserver connect` and stdio setup without a browser,
  visible key, copied secret, Docker requirement, or startup-log inspection;
- `MCP-017`: hosted `/mcp` connection followed by browser approval, renewal,
  revoke, disconnect, and reconnect;
- `MCP-018`: administration-issued user and service API keys for self-hosted
  fallback, CI, scripts, and unattended agents, with no secret leakage; and
- `MCP-019`: real-client installation and stale-state tests in every advertised
  Codex, Claude Code, Cursor, and VS Code surface.

A deployment cannot be released by passing protocol conformance while failing
its human connection experience.

## Iteration gate

Run the complete gate after every implementation iteration:

```sh
pnpm verify:iteration
```

For focused checks while developing:

```sh
pnpm conformance:validate
pnpm conformance:tests
```

The validator checks ledger structure, status contracts, evidence files, and per-deployment proof. The test-ID checker rejects unknown or multiply claimed acceptance IDs.

## Release gate

A deployment is conformant only when this command succeeds for that deployment:

```sh
ruby scripts/validate-conformance.rb spec/conformance.yml --require-verified local
```

Replace `local` with the deployment being released. A failed gate is a product status, not a reason to weaken the ledger or its tests.
