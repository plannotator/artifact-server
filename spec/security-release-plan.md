# Security and release plan

This plan separates controls we can prove in a private repository without external accounts from public-release integrity controls that require a stable version, a tag, or public verification.

## Tier 1: private-repository baseline

Tier 1 must not require a scanner account, license key, or source upload.

### Repository policy

- Publish `SECURITY.md` with scope and private reporting instructions.
- Pin every third-party GitHub Action to a complete commit SHA. Keep the readable release tag in a comment.
- Give workflows the smallest practical permissions.
- Disable persisted checkout credentials when later steps do not push.
- Keep the release path free of dependency caches.

### Continuous integration

- Run the TypeScript, lint, test, conformance, and build gate on Linux.
- Run the portable code gate on macOS 14.
- Treat warnings as errors through the repository's existing zero-warning lint command.
- Keep `pnpm verify:iteration` as the canonical end-of-iteration proof.

### Security automation

- Run Gitleaks against complete Git history on pull requests, merge-queue candidates, `main`, and a weekly schedule.
- Install Gitleaks from a pinned release archive, verify its SHA-256 digest, and prove the detector with a synthetic token before scanning the repository.
- Run zizmor offline against GitHub workflows and Dependabot configuration.
- Install zizmor from a pinned release archive, verify its SHA-256 digest, and prove the detector with a synthetic unsafe workflow before auditing the repository.
- Run weekly Dependabot checks for pnpm and GitHub Actions with a seven-day version-update cooldown. Security updates are not intentionally delayed.
- Enable GitHub dependency-graph vulnerability alerts and automated security fixes.

### Known pre-publication gates

The following controls need product or dependency cleanup before they can block every change:

- Resolve the current production dependency audit findings, including the Cloudflare deployment toolchain.
- Choose the final project license and review transitive license exceptions.
- Replace the wildcard `typebox` peer range in the Pi integration with a reviewed compatibility range.
- Enable GitHub private vulnerability reporting when the repository becomes public.

These are explicit gates. A green Tier 1 workflow does not claim that they are complete.

## Tier 2: release integrity

Tier 2 begins when the repository has a final license, a non-placeholder package version, and an approved public release tag.

- Build releases only from an annotated version tag that belongs to the approved `main` history.
- Verify that the tag, package version, and release version agree.
- Build the local Node package and OCI image from the tagged commit without dependency caches in the release workflow.
- Publish one SHA-256 checksum file for every downloadable asset. Installation instructions must verify the checksum before using an asset.
- Generate a CycloneDX or SPDX SBOM for each release surface.
- Attach GitHub build-provenance attestations to packages and container outputs.
- Attest the SBOM and attach it to the release.
- Create the GitHub release only after the tag, tests, security checks, checksums, SBOM, and attestations pass.
- Publish a security page that explains each control and gives users exact verification commands.

Artifact Server's existing local-package and OCI builders already create useful manifests. Tier 2 should extend those builders instead of introducing a second packaging implementation.

## Deferred by design

The first public release does not require project-owned signing keys, fuzzing, or a large hosted scanning platform. GitHub's keyless attestations, repository-native scanners, conformance tests, and reproducible checksums are the initial trust model.
