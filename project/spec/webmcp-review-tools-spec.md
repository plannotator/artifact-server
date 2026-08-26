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
delegating work to a coding agent stays a human action in the UI — the
copilot can surface and triage feedback, but only the human clicks Send.

## 2. Out-of-the-box tool set (v1, seven tools)

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
| `list_artifacts` | Project scope (not view scope): artifacts with id, name, latest version, version count, tags — for "open the pricing page one" flows. Open-thread counts are not carried by the artifact listing endpoint today; adding them is server work recorded as a v2 item. |

**Comment loop** — each returns the updated thread plus the view's
`{open, resolved}` counts, so no follow-up read is ever needed. (Threads
inside an active dispatch are hidden from the view by server default —
send is consumptive — so there is no separate "sent" count; in-flight
dispatches surface through `get_view`'s `activeDispatches` instead.)
| Tool | Contract |
| --- | --- |
| `comment` | New thread on the current version `{body, path?}`. |
| `reply` | `{threadId, body}`. |
| `resolve` / `reopen` | `{threadId}`. |

**Navigate**
| Tool | Contract |
| --- | --- |
| `open` | `{artifactId, versionId?}` — drives the UI there and returns the new view's full `get_view` payload. |

## 3. Excluded from v1, deliberately

- Publishing and uploads (staged-upload ceremony, near-zero copilot value).
- Anything destructive: bulk clear, deletes, tombstoning.
- All administration: members, API keys, public links, project settings.
- Git history, linked-artifact, and tag operations.
- Any autonomous behavior: tools are inert until a human's agent calls
  them; nothing monitors, nothing wakes.
- `send_to_agent` (owner decision, August 26): dispatching work to a
  coding agent stays a human action — the copilot triages, the human
  clicks Send. `get_view` still reports connected agents and in-flight
  dispatches so the copilot can *recommend* a hand-off; it just cannot
  perform one. Revisit if real usage shows the extra click is friction.

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
- **No nudges in v1 (corrected at build time).** The first draft of this
  spec assumed WebMCP results could ride the MCP nudge composer; they
  cannot — that composer lives on the server's MCP surface, while these
  tools call the web API directly from the page. The human-present
  copilot also has a human present, which is the push channel. If
  mid-conversation context ever proves necessary here, it is a separate,
  page-side design.
- **Churn tolerance.** One thin adapter module wraps
  `document.modelContext`; every call is guarded, absence degrades
  silently (no console noise, no UI change), and the adapter is the only
  file that knows the API shape — a breaking spec change is a one-file
  fix. No server flag: presence-detection plus a per-user toggle in
  review settings (default on).

## 5. Conformance sketch (IDs reserved; ledger entries land with the build)

| ID | Behavior |
| --- | --- |
| WMC-001 | With a `modelContext` present (fake in the browser suite), the seven tools register with provenance-prefixed names; a `get_view`→`reply`→`resolve` sequence produces the same server state and UI updates as the equivalent human actions, with each mutation result carrying the updated thread and counts (no read-back); with no `modelContext`, the app behaves identically and logs nothing. |
| WMC-002 | Tools never widen authority: every call is rejected or allowed exactly as the same operation from the UI for that session; tools are absent on content origins; tool descriptions stay at or under 300 characters (the bound this spec sets, pending the WebMCP spec's own guidance) and quote no untrusted content. |

## 6. Known proof gap

The browser suite fakes `document.modelContext` with a fake written to
match the adapter (draft commit `bd99438`, August 2026). A mismatch
between the adapter and the real browser API is therefore untested until
a real WebMCP-capable browser or the origin-trial extension drives it;
the ledger entries carry this gap.

## 7. Cost and gate

~1–2 days: the adapter module, seven thin tool bindings over the existing
client, the settings toggle, two browser conformance tests with a faked
`modelContext`. Gate to build: owner call — the OpenAI consumption
announcement satisfied the demand trigger; remaining risk is API churn,
which the one-file adapter contains by design.
