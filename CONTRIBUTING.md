# Contributing to Artifact Server

Artifact Server accepts bug fixes, documentation corrections, tests, and focused feature changes.

Do not use a public issue for a suspected security vulnerability. Read the [security policy](./SECURITY.md) for private reporting instructions.

## Before you start

Search the [open issues](https://github.com/plannotator/artifact-server/issues) before you start work.

Open an issue before a large feature or architecture change. Describe the user problem, the proposed behavior, and the affected deployment modes.

Small bug fixes and documentation corrections do not require an issue.

## Development setup

Install Node.js 24.12 or newer and pnpm 10.34.3.

```sh
git clone https://github.com/plannotator/artifact-server.git
cd artifact-server
pnpm install
pnpm dev
```

The development server prints the local review URL.

## Make a change

Read [`AGENTS.md`](./AGENTS.md) before you change product code. The file defines the engineering and test rules for this repository.

Build toward the contracts in [`project/spec/conformance.yml`](./project/spec/conformance.yml). Add tests for observable behavior and failure recovery.

Use a requirement ID in each conformance test name. For example, use `ART-004-B` for a test that proves that requirement.

Do not weaken TypeScript, Oxlint, or anti-slop rules. Do not use module mocks.

## Verify the change

Run focused tests while you work. Before you mark a pull request ready, run the complete gate:

```sh
pnpm verify:iteration
```

This command requires Docker. Report each test that you cannot run and explain why.

## Open a pull request

Keep each pull request focused on one change. Include:

- the user-visible behavior
- the affected requirement IDs
- the tests that you ran
- deployment or migration effects
- screenshots for interface changes

Update the documentation when the behavior or operator procedure changes.

The required GitHub checks must pass before merge.
