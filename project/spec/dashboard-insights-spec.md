# Dashboard insights (fork-local)

Status: fork-local feature of `ShiGaChenTW/artifact-server`; not proposed upstream.
Backlog: ARTSV-1.

## Purpose

One read-only page, `/review/dashboard`, answers four questions about an
installation or one of its projects:

1. **Overview**: how many live artifacts and versions exist, which changed most
   recently, how tags are distributed, and how many artifacts have public links.
2. **Review**: how many comment threads are open or resolved, how many open
   threads were dispatched to an agent, and where each dispatch stands.
3. **Storage**: bytes declared by every retained version, bytes actually stored
   after content deduplication, growth over the window, and Git-history mirror
   consumption.
4. **Activity**: who published, restored, deleted, captured, linked, retagged,
   or changed the access of an artifact, who commented, and how dispatches
   moved, newest first.

## Contract

- `GET /api/v1/insights?projectId=&window=` returns the four-section summary.
- `GET /api/v1/insights/activity?projectId=&window=&cursor=&limit=` returns one
  newest-first page of activity with an opaque cursor.
- `window` is one of `7d`, `30d` (default), `90d`, `all`. A bounded window
  starts at 00:00 UTC of its first day, so it holds exactly that many whole UTC
  days, today included.
- Omitting `projectId` reads every project of the caller's installation.
- Reading requires artifact-listing authority and comment-read authority. An
  unknown project answers `PROJECT_NOT_FOUND`; malformed input answers
  `INVALID_INPUT`.
- Deleted artifacts never appear in overview, review, or ranked lists. Storage
  still counts their versions, because deletion keeps immutable bytes.
- Growth is daily; a span longer than 90 days folds into 7-day buckets starting
  on the first day. Bytes published before the window form the baseline.
- Activity names a member or registered agent; an API key actor carries only
  its kind, because key names are an administration detail. Inferred
  addressing, delivery failure, and cancellation carry no actor, because the
  record keeps none.
- Only the SQLite (local) persistence implements these queries. Every other
  deployment answers `CAPABILITY_UNAVAILABLE` (HTTP 501).

## Conformance requirements

DSH-001 through DSH-005 in `conformance.yml` index these promises.
