---
id: ARTSV-5.3
title: 檔案總覽頁與批次操作（FOV-001..004、FLD-005）
status: In Progress
assignee: []
created_date: '2026-11-24T07:53:00Z'
updated_date: '2026-11-24T10:41:00Z'
labels: []
dependencies: []
parent_task_id: ARTSV-5
priority: high
ordinal: 20000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 FOV-001..004、FLD-005 的 B/F 通過，含效能基準
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-11-24: merged into the integration branch (schema 16 after linked folders 15). FOV-001, FOV-002, FOV-004, FLD-005 verified; FOV-003-B proved by tests/smoke/file-management-performance.test.ts (every section 13 budget). AC #1 stays open: FOV-003-F is not proved — publish p95 during a 20,000-file scan rises 35-40% (budget 10%) because each synchronous scan-page transaction blocks the event loop. Reads stay within 10% and pages commit one at a time. Options in project/performance/FINDINGS.md (worker-thread scan writes, set-based lookups, checkpoint tuning).
<!-- SECTION:NOTES:END -->
