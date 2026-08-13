# Artifact Server agent instructions

Build toward the contracts in `spec/conformance.yml`. Product prose lives in `spec/artifact-server-product-spec.html`; the ledger is the machine-checkable index of its promises.

## Engineering rules

- Keep product logic independent of SQLite, disk storage, HTTP, MCP, and deployment providers.
- Put concrete providers behind narrow ports named for product behavior.
- Do not weaken TypeScript, Oxlint, or anti-slop rules to make a change pass.
- Do not use module mocks. Tests should use real application services, temporary disk storage, temporary SQLite databases, and real HTTP boundaries where those behaviors matter.
- Test observable behavior and failure recovery, not private implementation details.
- Name conformance tests with their requirement IDs, such as `ART-004-B` and `ART-004-F`.
- A feature is not complete until its normal and hostile tests pass and durable evidence can be attached to the ledger.
- Preserve immutable version bytes and IDs across retries, crashes, restarts, and restores.
- Never let untrusted paths, hostnames, tokens, or installation IDs select raw storage locations.

## Learning more about Effect

This repository uses the Effect TypeScript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the
guide does not cover, search through the source code in `node_modules/effect/src`.

## Performance verification

- `pnpm verify:iteration` is the canonical end-of-iteration gate. It runs the complete correctness, conformance, coverage, build, smoke, and bounded performance path.
- Run `pnpm smoke` after changing HTTP delivery, publication, SQLite, blob storage, restart behavior, or cleanup.
- Run `pnpm perf:baseline` before and after a performance-sensitive change. Compare the same machine, Node version, workload, and storage class.
- Treat `performance/FINDINGS.md` as the current risk register, not as a permanent excuse for a known bottleneck.
- Do not tighten machine-timing gates from one laptop run. CI smoke limits catch gross failures; controlled repeated baselines establish regression budgets.
- Do not raise the inline base64 limit to add large-file support. Implement the specified staged direct-upload and streaming-delivery paths.

## Before handing off work

Run `pnpm verify:iteration`. Report any requirement that is still specified but not proved; do not mark it verified optimistically.
