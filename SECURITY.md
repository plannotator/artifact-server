# Security policy

Artifact Server stores and serves untrusted files, connects agents to review workflows, and can run on infrastructure that a team controls. We treat authentication, content isolation, storage integrity, and the software supply chain as security boundaries.

## Supported versions

Artifact Server is in private pre-release development. Until the first tagged release, only the latest commit on `main` receives security fixes. We will publish a supported-version table before the repository becomes public.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability.

While the repository is private, report the issue directly to a repository administrator through an established private channel. Include:

- the affected commit or version;
- the deployment mode;
- steps to reproduce the issue;
- the security impact;
- any proof-of-concept files or requests; and
- whether the issue is already public.

Before the repository becomes public, we will enable GitHub private vulnerability reporting and replace this paragraph with the repository's private report link.

Do not include real credentials, access tokens, private artifact contents, or personal data in a report. Use a minimal synthetic reproduction when possible.

## Scope

Security-sensitive areas include:

- authentication, authorization, project membership, and API keys;
- separation between the management application and untrusted artifact content;
- immutable artifact versions, linked artifacts, and version pointers;
- HTTP, CLI, MCP, and agent-dispatch boundaries;
- local, object, database, and Git-backed storage providers;
- path, hostname, token, and installation identifier handling;
- deployment templates and default network exposure; and
- build, package, container, and release integrity.

The repository's conformance requirements remain the source of truth for product behavior. A security fix is not complete until its observable boundary and recovery behavior are tested.

## Disclosure

We will acknowledge a complete report, investigate it, and coordinate a repair and disclosure timeline with the reporter. We do not promise a fixed response window during private development. We will add explicit response targets before the public release.
