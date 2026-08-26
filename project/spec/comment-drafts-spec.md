# Comment drafts

Status: design for owner review — revised August 26, 2026 after owner
review: "making a draft durable and hard to close in the UI is fine, but
we dont need a whole backend system for drafts." Frontend-only.

## 1. What exists and what this adds

Comments and replies are durable rows in all three backends. Drafts do not
exist: composer text is component state, so switching versions, navigating
to another artifact, reloading, or closing the tab discards it. This spec
makes typed feedback hard to lose — entirely in the web application.

## 2. Design (two layers)

**Layer 1 — in-app durability, no persistence.** Draft text lives in a
module-level store keyed by composer context
(`principal / artifact / threadId-or-new / versionId`), outside the
component tree. Every in-app movement — version switch, artifact
navigation, panel close, poll-driven re-render — leaves the draft intact;
reopening the same composer restores it silently with a quiet "Draft"
marker and a discard control. This covers the most common loss cases at
zero persistence risk.

**Layer 2 — hard to close, and reload survival.** While any non-empty
draft exists, a `beforeunload` handler prompts before the tab closes or
reloads ("hard to close"). Drafts also mirror to `localStorage` so a
reload or browser restart restores them:

- keys are principal-scoped (`draft:<principalId>:<context>`), so another
  account on the same browser profile never restores them;
- entries expire after 7 days (checked lazily on read);
- logout clears every draft key for the departing principal;
- one entry per context, last write wins, body capped at the comment
  bound (8 KiB).

Posting the comment deletes the store entry and the localStorage mirror;
so does the explicit discard.

Two behaviors added at build time, recorded here: a **failed** in-frame
pinpoint submit stashes its text as the version's new-thread draft rather
than losing it (only on failure — a success never leaves a draft); and
because the app's only new-thread composer lives inside the
`@plannotator/ui` viewer popup with no draft API, a minimal
"Comment on this version" composer is the drafted new-thread surface.

## 3. Accepted trades (owner decision)

- Comment content now touches browser storage. Until now localStorage
  held UI preferences only (theme, panel width). Accepted for drafts,
  mitigated by principal-keyed entries, the 7-day expiry, and
  clear-on-logout.
- No cross-device drafts and no server knowledge of drafts. Fine — the
  goal is "never lose typed feedback to navigation or accident," not a
  sync feature.
- The rejected alternative (server-side draft rows: one table across
  three backends, three routes, transactional delete-on-post) is recorded
  here so it can be revived if cross-device drafting is ever wanted.

## 4. Conformance sketch (IDs reserved; browser suite only)

| ID | Behavior |
| --- | --- |
| DRF-001 | Draft text survives a version switch, artifact navigation, and a page reload, restores into the same composer with the draft marker, and is gone after the comment posts and after explicit discard. |
| DRF-002 | Drafts are principal-scoped and bounded: a second signed-in principal on the same browser restores nothing, logout clears the first principal's drafts, a reply draft never restores into the new-thread composer, and closing the tab with a non-empty draft triggers the leave prompt. |

## 5. Cost

Small: one store + one hook in the review app, composer wiring, the
beforeunload guard, two browser conformance tests. No server work of any
kind.
