---
id: ARTSV-1.1
title: Insights 核心：core 型別、port、SQLite 實作、application service
status: Done
assignee: []
created_date: '2026-11-23T18:58:00Z'
updated_date: '2026-11-23T19:12:00Z'
labels: []
dependencies: []
parent_task_id: ARTSV-1
priority: high
type: task
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
src/core/insights.ts 型別；ports.ts 加 ArtifactInsightsRepository（readInsights、listActivity）；src/storage/sqlite-artifact-insights.ts 實作；src/application/artifact-insights.ts（授權、專案範圍、時間窗、純函式分桶）；Postgres/D1 組裝回 unsupported。conformance.yml 新增 DSH-001..005。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 總覽：排除已刪除 artifact 的 artifact 數、版本數、最近更新、tag 分布正確
- [x] #2 審閱：open/resolved 數、resolve 比例、dispatch 各狀態數正確
- [x] #3 用量：邏輯大小與 sha256 去重實際大小、按日成長、Git 歷史額度與已 committed 用量正確
- [x] #4 活動：合併 actions、留言/回覆/resolve、dispatch 事件，時間倒序、cursor 分頁穩定
- [x] #5 惡意：無權限 principal 被拒、跨專案/跨 installation 讀不到、不合法 window/cursor 被拒
- [x] #6 測試用真 SQLite 暫存庫、無 module mock，名稱帶 DSH ID
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
actions 表其實有 14 種動作（含 tag/存取/留言），時間軸以 actions + dispatch 轉換為主。actor 不經 registered_agents 解析（那是連線者 principal，不是 agent）。API key 名稱不外露。測試：tests/conformance/dsh-dashboard-insights.test.ts 10/10。
<!-- SECTION:NOTES:END -->
