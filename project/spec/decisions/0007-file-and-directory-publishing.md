# Decision 0007: Publish files and finished directories

Status: accepted

## Decision

The public publishing input is one filesystem file or one finished directory.
Agents and people do not send HTML, CSS, JavaScript, Markdown, or other source
text as JSON or MCP string arguments.

A single HTML file, image, video, PDF, archive, or other document is a normal
artifact. A finished website or client-side application is a directory artifact
with an entry file such as `index.html`. Both use the same verified upload and
commit rules.

The client owns the local filesystem path. A remote Artifact Server never reads
an arbitrary client path. The Artifact Server CLI reads the selected file,
uploads its bytes through a server-issued upload plan, and commits the version.
The artifact route of the Artifact Server skill invokes that CLI when a local path is involved. MCP may
manage the upload only when its own runtime can already access the bytes; a
remote MCP server never treats a user-local path as accessible. A local
installation may use the separately constrained local-import path.

The publishing client may use a one-request binary or multipart upload for a
small file when the server advertises that capability. Larger files and
directories use staged upload. This transport choice is hidden from the user.
Neither transport accepts base64 file contents inside JSON or MCP arguments.

## Agent experience

The user can ask an agent to publish a path. The client determines whether the
path is a file or directory, uploads it, commits it, and returns the artifact ID,
version ID, and browser link. The user does not supply a manifest, fingerprint,
upload ID, or size threshold.

MCP carries instructions, metadata, and bounded results. File bytes move through
the upload transport. The initial MCP surface therefore has upload creation and
commit tools but no raw-text or inline-content publishing tool.

## Implemented baseline

The Node client and `artifactserver publish <path>` command inspect and hash the
selected files, request a server upload plan, stream the bytes, and commit the
version. Local installations use their token file by default. Team deployments
use a configured origin and API token. Both return the same artifact, version,
and browser links.

The earlier base64 JSON publication routes and internal inline-publication
operations have been removed. Public HTTP now accepts publication bytes only
through the verified file-upload operation.

The manifest disposition value `inline` has a different meaning: it tells a
browser to display a stored file instead of downloading it. Decision 0007 does
not rename or remove that value.

ADR 0016 defines the shared CLI and MCP capability surface, authenticated CLI
profiles, and locality-based Agent Skill routing.

## Verification

Release tests must prove:

- an agent can publish one ordinary file without constructing a manifest;
- an agent can publish one finished directory through the same user-facing
  operation;
- small and large inputs select a supported transport without user involvement;
- public HTTP and MCP schemas reject raw source strings and base64-wrapped file
  contents;
- a remote server rejects client filesystem paths and arbitrary source URLs;
- the saved bytes match the selected file or directory; and
- browser display and download behavior still follows the stored media type and
  disposition.
