---
id: ARTSV-1.3
title: Dashboard 前端頁 /review/dashboard
status: Done
assignee: []
created_date: '2026-11-23T18:58:00Z'
updated_date: '2026-11-23T19:22:00Z'
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
- [x] #1 四塊與時間窗切換可用，載入/空/錯誤狀態都有畫面
- [x] #2 shadcn 產生碼過 oxlint，未放寬規則；未引入執行時 <style>
- [x] #3 深淺主題下圖表分類色可辨識
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
shadcn 元件用 --view 取原始碼寫入，不讓 CLI 裝 cn 套件（改用 @/lib/utils）。chart.tsx 精簡為 ChartContainer（CSSOM 設色，無 <style>）+ 依自家資料索引的 tooltip；toggle-group 拿掉 inline 自訂屬性。Recharts 鎖 3.10.0（3.11.0 未滿兩週）。dispatch 狀態屬 status，用標籤+數字，不用分類色；單一系列色 --insight-series 經 dataviz validator 驗證（深色改 L0.64）。正式 build 實測：無 style-src 違規；唯一 script-src 回報來自既有 zod schemas chunk，/review 與 settings 也有。手機 390px 無裁切。
<!-- SECTION:NOTES:END -->
