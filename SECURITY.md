# Security policy

Artifact Server stores and serves untrusted files, connects agents to review workflows, and can run on infrastructure that a team controls. We treat authentication, content isolation, storage integrity, and the software supply chain as security boundaries.

## Supported versions

Security fixes apply to the latest tagged release and the current `main` branch. Update to the latest release before you report an issue that affects an older version.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/plannotator/artifact-server/security/advisories/new). If that form is not available to you, contact a repository administrator through an established private channel.

Include:

- the affected commit or version;
- the deployment mode;
- steps to reproduce the issue;
- the security impact;
- any proof-of-concept files or requests; and
- whether the issue is already public.

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

We will acknowledge a complete report, investigate it, and coordinate a repair and disclosure timeline with the reporter.
