---
id: ARTSV-1.2
title: Insights HTTP API
status: To Do
assignee: []
created_date: '2026-11-23T18:58:00Z'
labels: []
dependencies:
  - ARTSV-1.1
parent_task_id: ARTSV-1
priority: high
type: task
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GET /api/v1/insights?project=&window=30d 與 GET /api/v1/insights/activity?project=&cursor=，沿用 runHttpApplicationEffect 與現有錯誤對映。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 未登入 401、無讀取權限 403、不合法參數 400、不存在專案不洩漏資訊
- [ ] #2 非 SQLite 部署回明確的 unsupported 回應
- [ ] #3 真 HTTP 邊界測試通過，pnpm smoke 通過
<!-- AC:END -->
