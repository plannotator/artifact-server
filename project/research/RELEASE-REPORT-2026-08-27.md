# Artifact Server 0.1.0 release report

Date: 2026-08-27  
Source revision: `8c9c54a2c55f449f67fbf5f15176397cec2fa03f`  
Release: `v0.1.0` prerelease

## Result

Artifact Server 0.1.0 is packaged as a portable Node archive and a multi-platform OCI image. The Pi, OpenCode, and Claude Code adapters are published as public npm packages. Every surface is built from the annotated tag by the same release workflow and is tied to checksums, SPDX SBOMs, and GitHub attestations.

## Published surfaces

| Surface | Published location | Immutable identity |
| --- | --- | --- |
| Portable Node package | GitHub prerelease asset | Pending tagged release |
| OCI image | `ghcr.io/plannotator/artifact-server` | Pending tagged release |
| Pi adapter | `@plannotator/artifact-server-pi@0.1.0` | Pending tagged release |
| OpenCode adapter | `@plannotator/artifact-server-opencode@0.1.0` | Pending tagged release |
| Claude Code channel | `@plannotator/artifact-server-claude-channel@0.1.0` | Pending tagged release |

## Verification

| Proof | Run | Result |
| --- | --- | --- |
| Release workflow PR simulation | [33122368219](https://github.com/plannotator/artifact-server/actions/runs/33122368219) | Pass |
| Release workflow dry run from exact `main` | [33125545066](https://github.com/plannotator/artifact-server/actions/runs/33125545066) | Pass |
| Clean install from dry-run assets | [33128331071](https://github.com/plannotator/artifact-server/actions/runs/33128331071) | Pass on Ubuntu and macOS; adapter package loaded |
| First tagged attempt | [33128388757](https://github.com/plannotator/artifact-server/actions/runs/33128388757) | Failed during reference verification before any publication; the failed tag was deleted |
| Second tagged attempt | [33129865385](https://github.com/plannotator/artifact-server/actions/runs/33129865385) | Passed the canonical gate and package build, then failed before publication because the image build did not receive its push flag; the failed tag was deleted |
| Tagged release | [33133676502](https://github.com/plannotator/artifact-server/actions/runs/33133676502) | Running |
| Clean install from published assets | Pending | Pending |

The clean-install workflow uses fresh Ubuntu and macOS runners without a repository checkout. It verifies the checksum and GitHub attestation, runs the packaged CLI, starts the server, publishes and fetches an artifact, and checks the URL printed by `artifactserver open`. A separate job verifies the immutable GHCR image and exercises the compact Compose profile. Another job installs the public OpenCode adapter into a scratch environment and imports it.

## Conformance ledger

`DEP-019` already covers the portable local package and remains behavior verified. The existing `DEP-018` requirement combines the released image with a separately packaged and signed Helm chart. This release publishes the image and verifies the chart source, but it does not publish a standalone chart artifact. Marking `DEP-018` behavior verified would therefore overclaim. `REL-001` and `REL-002` also remain specified. No ledger status changes are part of this release.

## Repository settings for publication

The repository remains private. When the owner makes it public, enable or confirm:

- secret scanning;
- secret-scanning push protection;
- code scanning default setup;
- private vulnerability reporting; and
- recognition of the repository `SECURITY.md` policy.

Also make the `ghcr.io/plannotator/artifact-server` package public so unauthenticated users can pull the documented image digest.

## Deferred

- npm provenance is deferred until the repository is public. The 0.1.0 adapter packages use the existing npm token path; their registry integrities are checked against the attested release tarballs.
- The Agent Skill remains repository-native. `npx skills add plannotator/artifact-server` becomes the public install path when the repository is public.
- AWS and Google Cloud live deployments were not run. Their Pulumi projects are checked in the release gate, and the shared PostgreSQL/S3-compatible runtime is exercised with pinned Postgres and MinIO.
- Cloudflare quota testing and backlog items B-18 through B-34 are outside this release pass.

## Owner decisions applied

- Version `0.1.0`, annotated tag `v0.1.0`, GitHub prerelease.
- Public adapter packages use the existing `@plannotator` npm scope because `@artifact-server` is not available to the publisher.
- The root package remains private because the server ships as a release archive and OCI image, not through npm.
