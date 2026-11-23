---
id: ARTSV-1
title: Dashboard：artifact 總覽、審閱、用量、活動時間軸
status: In Progress
assignee: []
created_date: '2026-11-23T18:58:00Z'
updated_date: '2026-11-23T18:58:00Z'
labels: []
dependencies: []
priority: high
type: feature
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
在 fork 的 artifact-server 加 /review/dashboard，四塊：Artifact 總覽、留言／審閱狀態、儲存與用量、活動時間軸。已定：只做 SQLite（Postgres/D1 組裝層回 insights 不支援）、只留 fork（requirement ID 用 fork 專用 DSH-xxx）、時間窗預設 30 天（可切 7/30/90/全部）、前端內容區用 shadcn（chart=Recharts，移除 ChartStyle 以符合 CSP style-src 'self'），外框沿用 as-settings。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 四塊都能在 /review/dashboard 看到，數字與 DB 一致
- [ ] #2 沿用 requireArtifactListing 權限與專案範圍
- [ ] #3 pnpm check 與 pnpm verify:iteration 通過
- [ ] #4 正式 build 下瀏覽器無 CSP violation
<!-- AC:END -->
