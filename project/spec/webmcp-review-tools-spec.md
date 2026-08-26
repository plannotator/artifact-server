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

## 2. Out-of-the-box tool set (v1, ten tools)

All tools call the existing web API client — the same code path the UI
uses, so server-side validation and authorization are identical. Names
are prefixed `artifact_server_` on the wire for provenance.

**Orient**
| Tool | Contract |
| --- | --- |
| `get_view` | The agent's "where am I": current project, artifact, version, open/sent/resolved thread counts, whether a dispatch is in flight. No arguments. |
| `list_artifacts` | Current project's artifacts (id, name, latest version, open thread count). |
| `list_comments` | Threads for the current artifact/version with states, dispatch status, and reply summaries. |
| `list_agents` | Connected agents with kind, tier, and activity — so the copilot knows Pi is present and working before advising a hand-off. |

**Comment loop**
| Tool | Contract |
| --- | --- |
| `comment` | New thread on the current version `{body, path?}`. |
| `reply` | `{threadId, body}`. |
| `resolve` / `reopen` | `{threadId}`. |

**Navigate**
| Tool | Contract |
| --- | --- |
| `open` | `{artifactId, versionId?}` — drives the UI to that view, so "compare against v3" is an action. |

**The ramp**
| Tool | Contract |
| --- | --- |
| `send_to_agent` | `{threadIds, agentId?, note?}` — dispatches through the real pipeline (single connected agent needs no `agentId`, mirroring the one-click send rule). The copilot triages with the human; the bridge executes. |

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
| WMC-001 | With a `modelContext` present (fake in the browser suite), the ten tools register with provenance-prefixed names; a `comment`→`reply`→`resolve`→`send_to_agent` sequence through tool calls produces the same server state and UI updates as the equivalent human actions; with no `modelContext`, the app behaves identically and logs nothing. |
| WMC-002 | Tools never widen authority: every call is rejected or allowed exactly as the same operation from the UI for that session; tools are absent on content origins; tool descriptions stay within the spec's size guidance and quote no untrusted content. |

## 6. Cost and gate

~1–2 days: the adapter module, ten thin tool bindings over the existing
client, the settings toggle, two browser conformance tests with a faked
`modelContext`. Gate to build: owner call — the OpenAI consumption
announcement satisfied the demand trigger; remaining risk is API churn,
which the one-file adapter contains by design.
