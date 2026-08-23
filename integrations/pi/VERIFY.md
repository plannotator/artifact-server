# Manual verification: the Pi bridge against a live Pi

The owner-run manual pass for behaviors only a live Pi proves. Recorded as
manual evidence; never claimed by the conformance ledger. Run every step in
order on one machine. Expected observations are listed after each step —
stop and investigate on any mismatch.

Prerequisites: this repository checked out, `pnpm install` done, `pi`
(`@earendil-works/pi-coding-agent` 0.84.x) installed, two terminals, one
browser.

## 1. Start the local server and publish something to annotate

```bash
pnpm start
```

- Expected: the server prints its loopback origin;
  `~/.artifact-server/local-service.json` and
  `~/.artifact-server/local-api-token` exist.

Publish any small site (or reuse an existing artifact), open it in the
browser, and leave two annotations on the current version: one with a text
selection, one without. Leave both threads open.

## 2. Start Pi with the bridge

In a second terminal, from any project directory:

```bash
pi -e /path/to/artifact-server/integrations/pi/index.ts
```

- Expected: no notice about a dormant bridge (local discovery resolved).
- Expected: within a few seconds the web app's agent picker (or
  `GET /api/v1/agents`) lists one connected agent named after the project
  directory, kind `pi`, with the right working directory.

## 3. The full round trip, mid-task

Give Pi a task that takes a while (for example: "count to 30, one line per
second, using bash sleep"). While it is streaming, select both annotations in
the review view and send them to the Pi agent.

- Expected: the annotations vanish from the review surfaces immediately.
- Expected: Pi is NOT interrupted. When its current work finishes, exactly
  one message arrives, beginning `Artifact Server: … sent 2 annotation(s) to
  address.`, with two numbered items (artifact name, version number, path,
  the quoted selection on the anchored one, body, thread id) and the closing
  instruction naming the `artifact_comments` tool.
- Expected: a TUI notification announced the delivery.
- Expected: Pi does the work, replies to both threads via
  `artifact_comments`, and resolves both without being asked.
- Expected: the dispatch shows `addressed` in the Sent filter; the threads
  are resolved; no annotation reappeared.

## 4. FIFO drain, one bundle per work boundary

While Pi works on the follow-up from step 3, send bundle B and then bundle C
(one annotation each).

- Expected: B and C stay queued on the server (one-active-claim), then drain
  strictly in order, exactly one bundle per work boundary — never merged.

## 5. Compaction hold

Queue a bundle, and immediately run `/compact` in Pi.

- Expected: the bundle is not injected during compaction; it arrives after
  compaction completes. Nothing is lost, nothing crashes.

## 6. `/resume` re-registration

Quit Pi, run `pi --resume` (or `/resume` into the same session) in the same
directory.

- Expected: `GET /api/v1/agents` shows the same agent id as before (same
  connection key), `lastSeenAt` fresh. A bundle sent now is delivered by the
  resumed session.

## 7. Fail-open: server down and back

Stop the Artifact Server while Pi is idle. Interact with Pi normally for a
minute, then restart the server and send a bundle.

- Expected: Pi is completely unaffected while the server is away (no errors
  surface in the session). After the restart the bridge recovers by itself
  and the bundle arrives.

## 8. Agent-unavailable failure returns the work

Queue a bundle, then quit Pi before it claims. Wait 15 minutes (or advance
per deployment guidance) and reload the review view.

- Expected: the dispatch reads `failed (agent_unavailable)` and the
  annotations are back on the artifact surfaces. Nothing was silently lost.

## 9. Dormant without configuration

Temporarily move `~/.artifact-server` aside and start Pi with the bridge and
no `ARTIFACT_SERVER_*` environment.

- Expected: exactly one notice that the bridge is dormant; no polling; Pi
  fully usable. Restore the directory afterwards.
