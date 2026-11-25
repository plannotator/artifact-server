---
id: ARTSV-6.4
title: 刪除改版後沒有引用的三個檔案
status: To Do
assignee: []
created_date: '2026-11-25T13:19:00Z'
labels: []
dependencies:
  - ARTSV-6.2
parent_task_id: ARTSV-6
priority: low
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
review-panel-edge.tsx、use-review-panel-motion.ts、use-review-resizable-panel.ts 已無任何引用。依「不刪除任何檔案」的規定，動手前需要 Scott 明確同意。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Scott 已同意刪除
- [ ] #2 刪除後 lint、typecheck、測試通過
<!-- AC:END -->
