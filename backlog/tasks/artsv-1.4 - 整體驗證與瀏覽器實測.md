---
id: ARTSV-1.4
title: 整體驗證與瀏覽器實測
status: To Do
assignee: []
created_date: '2026-11-23T18:58:00Z'
labels: []
dependencies:
  - ARTSV-1.3
parent_task_id: ARTSV-1
priority: medium
type: task
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
跑 pnpm check、pnpm verify:iteration（完後還原 project/evidence/local-foundation.json），正式 build 下用 ego-browser 實測 dashboard、截圖、確認無 CSP violation；回報仍未證明的 requirement。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pnpm check 與 pnpm verify:iteration 通過
- [ ] #2 正式 build 瀏覽器實測四塊正常、console 無 CSP violation、附截圖
<!-- AC:END -->
