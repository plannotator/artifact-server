---
id: ARTSV-6
title: 內容先行閱讀器改版導入 main（審閱、檔案、儀表板）
status: To Do
assignee: []
created_date: '2026-11-25T13:18:00Z'
labels: []
dependencies: []
references:
  - >-
    /Users/scottchen/Documents/-Inbox/2026-11-25_proposal_reader-redesign/README.md
priority: high
type: feature
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
把 feat/reader-redesign（worktree fork-artifact-server-reader，基底 b22120b）的介面改版導入 main：theme-reader 淺深兩套色票、審閱頁目錄／留言／版本資訊改為預設收起的抽屜、← → T C V 快捷鍵、底列路徑與上一個／下一個、檔案頁與儀表板重排。前提是 feat/workbench-files（比 main 多 55 個 commit）先合併。預估最低 2 天、含收尾 3–4 天。示範檔、截圖、驗收表見 ~/Documents/-Inbox/2026-11-25_proposal_reader-redesign/。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 feat/workbench-files 與改版都已合併進 main
- [ ] #2 新行為都有帶需求編號的 B/F 瀏覽器測試，ledger 證據已記錄
- [ ] #3 pnpm verify:iteration 通過
<!-- AC:END -->
