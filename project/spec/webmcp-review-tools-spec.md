# WebMCP review tools

Status: design for owner review — not implemented.
Owner direction (August 26, 2026): spec what Artifact Server supports out
of the box. Context: WebMCP (webmachinelearning/webmcp, W3C WebML CG) lets
a page register schema'd tools on `document.modelContext` that
browser-resident agents discover and call inside the user's session.
Chrome 149 / Edge 150 origin trials; OpenAI has announced ChatGPT desktop
browser and Codex consumption — the watch-list trigger that motivated this
spec. The API is still churning (three breaking changes in August 2026),
which shapes the implementation posture below.

## 1. What this is and is not

WebMCP is the human-present lane: the user summons an agent in their own
browser, and the tools make our app operable — reliable typed calls
instead of DOM-driving, with the user's existing session as auth (no API
keys, no MCP config). It composes with, and never replaces, the dispatch
loop: there is no site-to-agent push, the human is the push channel, and
delegated work still flows through `send_to_agent` into the real
pipeline.

## 2. Out-of-the-box tool set (v1, eight tools)

All tools call the existing web API client — the same code path the UI
uses, so server-side validation and authorization are identical. Names
are prefixed `artifact_server_` on the wire for provenance.

Design rule (owner direction, August 26): **minimize hops — every tool
result carries enough state to continue without a read-back.** One
orientation call answers "where am I, what needs attention, who can
help"; every mutation echoes the updated state it changed.

**Orient**
| Tool | Contract |
| --- | --- |
| `get_view` | The one situational call: current project, artifact, version, and dispatch in flight; the view's threads (open-first, bodies included, bounded — `state?` filter, `limit?` default 20, `cursor?` for more); and connected agents with kind, tier, and activity. |
| `list_artifacts` | Project scope (not view scope): artifacts with id, name, latest version, open thread count — for "open the pricing page one" flows. |

**Comment loop** — each returns the updated thread plus the view's
remaining open/sent counts, so no follow-up read is ever needed.
| Tool | Contract |
| --- | --- |
| `comment` | New thread on the current version `{body, path?}`. |
| `reply` | `{threadId, body}`. |
| `resolve` / `reopen` | `{threadId}`. |

**Navigate**
| Tool | Contract |
| --- | --- |
| `open` | `{artifactId, versionId?}` — drives the UI there and returns the new view's full `get_view` payload. |

**The ramp**
| Tool | Contract |
| --- | --- |
| `send_to_agent` | `{threadIds, agentId?, note?}` — dispatches through the real pipeline (single connected agent needs no `agentId`, mirroring the one-click send rule). Returns the created dispatch and the target agent's presence. |

## 3. Excluded from v1, deliberately

- Publishing and uploads (staged-upload ceremony, near-zero copilot value).
- Anything destructive: bulk clear, deletes, tombstoning.
- All administration: members, API keys, public links, project settings.
- Git history, linked-artifact, and tag operations.
- Any autonomous behavior: tools are inert until a human's agent calls
  them; nothing monitors, nothing wakes.

## 4. Stances

- **Application origin only.** Tools register in the review application.
  Content origins never register our tools — and, honestly noted:
  artifact HTML running in content frames could register its own WebMCP
  tools, which we cannot prevent; ours carry the `artifact_server_`
  prefix and provenance descriptions so an agent can tell whose tools it
  is holding. The content-frame sandbox posture is unchanged.
- **Attribution: actions post as the signed-in user.** It is their
  session and they are present — assisted input, like autocomplete. If
  presence-of-an-agent attribution is ever wanted, it is a server-side
  model change and out of scope here.
- **Nudge reuse.** Tool results ride the same nudge composer specced in
  `tool-result-nudges-spec.md` (pending feedback, unfinished bundles), so
  the mid-conversation pull gap is patched the same way in both surfaces.
- **Churn tolerance.** One thin adapter module wraps
  `document.modelContext`; every call is guarded, absence degrades
  silently (no console noise, no UI change), and the adapter is the only
  file that knows the API shape — a breaking spec change is a one-file
  fix. No server flag: presence-detection plus a per-user toggle in
  review settings (default on).

## 5. Conformance sketch (IDs reserved; ledger entries land with the build)

| ID | Behavior |
| --- | --- |
| WMC-001 | With a `modelContext` present (fake in the browser suite), the eight tools register with provenance-prefixed names; a `get_view`→`reply`→`resolve`→`send_to_agent` sequence produces the same server state and UI updates as the equivalent human actions, with each mutation result carrying the updated thread and counts (no read-back); with no `modelContext`, the app behaves identically and logs nothing. |
| WMC-002 | Tools never widen authority: every call is rejected or allowed exactly as the same operation from the UI for that session; tools are absent on content origins; tool descriptions stay within the spec's size guidance and quote no untrusted content. |

## 6. Cost and gate

~1–2 days: the adapter module, eight thin tool bindings over the existing
client, the settings toggle, two browser conformance tests with a faked
`modelContext`. Gate to build: owner call — the OpenAI consumption
announcement satisfied the demand trigger; remaining risk is API churn,
which the one-file adapter contains by design.
