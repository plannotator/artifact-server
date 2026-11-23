---
id: ARTSV-1.3
title: Dashboard 前端頁 /review/dashboard
status: To Do
assignee: []
created_date: '2026-11-23T18:58:00Z'
labels: []
dependencies:
  - ARTSV-1.2
parent_task_id: ARTSV-1
priority: high
type: task
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
apps/web/src/dashboard/，React.lazy 拆 chunk；shadcn add card/table/progress/skeleton/empty/tooltip/toggle-group/chart（Recharts 鎖版本）；移除 ChartStyle；theme-tokens.css 補分類語意色（深淺模式分開）；api/client.ts 加 zod schema；review 頁首加入口。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 四塊與時間窗切換可用，載入/空/錯誤狀態都有畫面
- [ ] #2 shadcn 產生碼過 oxlint，未放寬規則；未引入執行時 <style>
- [ ] #3 深淺主題下圖表分類色可辨識
<!-- AC:END -->
