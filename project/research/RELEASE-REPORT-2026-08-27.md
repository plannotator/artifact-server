# Artifact Server release-readiness report

- Date: 2026-08-27
- Updated: 2026-08-28
- Qualified source revision: `8c9c54a2c55f449f67fbf5f15176397cec2fa03f`
- Current integration base: `f172d5ef5aaa634abeaf2dfd03bfaf140159b39f`
- Target version: `0.1.0`
- Release status: not published

## Result

Artifact Server can build a portable Node archive and a multi-platform OCI image. The private release workflow has exercised packaging, checksums, SPDX SBOM generation, GitHub attestations, and clean-install verification. No public `0.1.0` release, public server package, or public adapter package has shipped.

The temporary private `v0.1.0` tag was deleted after qualification. Publication-specific download URLs, image references, package names, and install commands remain release-day placeholders.

## Planned release surfaces

| Surface | Planned location | Status |
| --- | --- | --- |
| Portable Node package | `<GitHub release asset>` | Pending public release |
| OCI image | `<public GHCR image by digest>` | Private qualification only |
| Pi adapter | `<published Pi adapter package>` | Not published |
| OpenCode adapter | `<published OpenCode adapter package>` | Not published |
| Claude Code channel | `<published Claude Code channel package>` | Not published |

## Verification history

| Proof | Run | Result |
| --- | --- | --- |
| Release workflow PR simulation | [33122368219](https://github.com/plannotator/artifact-server/actions/runs/33122368219) | Pass |
| Release workflow dry run from exact `main` | [33125545066](https://github.com/plannotator/artifact-server/actions/runs/33125545066) | Pass |
| Clean install from dry-run assets | [33128331071](https://github.com/plannotator/artifact-server/actions/runs/33128331071) | Pass on Ubuntu and macOS; adapter package loaded |
| First tagged attempt | [33128388757](https://github.com/plannotator/artifact-server/actions/runs/33128388757) | Failed during reference verification before publication; tag deleted |
| Second tagged attempt | [33129865385](https://github.com/plannotator/artifact-server/actions/runs/33129865385) | Passed the canonical gate and package build, then failed before publication because the image build did not receive its push flag; tag deleted |
| Private image-attestation qualification | Pull request 18 | Pass; GHCR remained private |
| Public tagged release | `<release-day run>` | Not run |
| Clean install from public assets | `<release-day run>` | Not run |

The clean-install workflow uses fresh Ubuntu and macOS runners without a repository checkout. It verifies checksums and attestations, runs the packaged CLI, starts the server, publishes and fetches an artifact, and checks the URL printed by `artifactserver open`. A separate job verifies the immutable GHCR image and exercises the compact Compose profile. Another job installs an adapter package into a scratch environment and imports it.

## Conformance ledger

`DEP-019` covers the portable local package and remains behavior verified. `DEP-018` combines the released image with a separately packaged and signed Helm chart. The workflow verifies the chart source but does not publish a standalone chart artifact, so `DEP-018` must not be marked behavior verified. `REL-001` and `REL-002` also remain specified. This report changes no ledger status.

## Release-day work

- Make the repository public when the owner chooses.
- Create the final annotated tag from the selected `main` revision.
- Publish the portable archive, checksums, SBOMs, and attestations.
- Publish the OCI image and record its immutable digest.
- Publish the three adapter packages.
- Replace documentation placeholders with the exact release URLs, package identities, and verification commands.
- Run the clean-install workflow against the public assets.

## Repository settings for publication

When the owner makes the repository public, enable or confirm:

- secret scanning;
- secret-scanning push protection;
- code scanning default setup;
- private vulnerability reporting; and
- recognition of the repository `SECURITY.md` policy.

Also make the release image public so unauthenticated users can pull the documented digest.

## Deferred

- npm provenance is deferred until the repository is public.
- The Agent Skill remains repository-native. Its public install path is finalized on release day.
- AWS and Google Cloud live deployments were not run. Their Pulumi projects are checked in the release gate, and the shared PostgreSQL/S3-compatible runtime is exercised with pinned Postgres and MinIO.
- Hosted-service quota and abuse-policy work is outside the core self-hosted release.
