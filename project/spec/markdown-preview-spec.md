# Native Markdown review

This proposal extends the document-format exclusion in SCP-002. Review can
render declared `text/markdown` entries on demand in the browser. Publication,
storage, immutable version bytes, and database schemas do not change.

## Document views

Preview renders headings, paragraphs, tables, task lists, links, bundled images,
fenced code, and Mermaid diagrams. Source displays the original decoded text;
download retains the exact original file bytes. MIME essence selects the viewer,
including charset parameters. Unknown files are never sniffed into Markdown.

Original source remains available when a preview lease or renderer fails. Retry
requests the same version/path. Selecting another file or version cancels
abandoned work. Source suspends annotation and hides annotation controls while
preserving the user's previous mode. Preview reuses the existing exact-version
HTML review bridge and comment anchors.

## Rendering boundary

Authored HTML is escaped. Completed HTML and SVG are sanitized before reaching
the existing opaque HTML review sandbox. Relative resources must resolve to a
manifest member within the selected immutable version. External image loads,
unsafe protocols, and escaping paths are refused. Ordinary HTTP(S), mailto, and
local heading links remain available.

Mermaid executes in its own opaque frame, not the application document. That
frame loads one trusted bundled classic script and denies image, connection,
frame, and form traffic through CSP. Request/reply schemas, parent/source/origin
checks, cancellation, and a time limit bound the message bridge. The returned
markup must sanitize to one SVG root. User directives, frontmatter configuration,
interactive actions, and custom styling remain disabled. Resource-dependent
diagrams fall back to readable source. Diagrams do not receive app credentials.

The source limit is 1 MiB. Each document renders at most 12 diagrams, each with
20,000 characters, 200 flowchart edges, an eight-second render deadline, and a
2,000,000-character result limit. Highlighting supports a finite language set,
at most 128 blocks / 200,000 characters per document, and 20,000 characters per
block. Unknown languages and excess work remain readable as literal code.

## Conformance requirements

| ID | Behavior | Failure boundary |
| --- | --- | --- |
| MDV-001 | Formatted Preview, original Source and exact-version download | Declared MIME routing, source size limit, source recovery and retry |
| MDV-002 | Highlighted code and isolated Mermaid diagrams | Malformed/hostile diagrams, network denial, time and work limits |
| MDV-003 | Bundled resources and review comments belong to one version/path | Missing/escaping resources, cancellation and stale results |

Browser acceptance uses real publication, SQLite, HTTP and review frames. Unit
tests cover manifest resource resolution and stable unique heading anchors.
Existing HTML assets, native image/video previews and review sandbox isolation
remain regression checks. Evidence qualifies only the deployments actually run.

## Implementation and contribution

The renderer uses Marked with GFM, DOMPurify for completed output, a finite lazy
Shiki language/theme set, and an isolated lazy Mermaid bundle. No server
processing service, document editor, MDX execution, or offset-anchor schema is
introduced. The additional diagram script is fetched only for diagram fences.

This scope proposal is tracked in
[upstream issue #78](https://github.com/plannotator/artifact-server/issues/78).

Primary implementation references: [Marked](https://marked.js.org/using_pro),
[DOMPurify](https://github.com/cure53/DOMPurify),
[Mermaid configuration](https://mermaid.js.org/config/usage.html), and
[Shiki bundles](https://shiki.style/guide/bundles).
