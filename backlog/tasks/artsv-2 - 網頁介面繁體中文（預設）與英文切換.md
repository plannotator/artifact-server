---
id: ARTSV-2
title: 網頁介面繁體中文（預設）與英文切換
status: Done
assignee: []
created_date: '2026-11-23T21:50:00Z'
updated_date: '2026-11-23T22:23:00Z'
labels: []
dependencies: []
priority: high
type: feature
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
fork 的網頁介面加入 i18n：預設繁中（zh-TW），英文為第二語言，可在 settings 切換。用語依 /Users/scottchen/Documents/-Inbox/2026-11-24_proposal_zh-tw-glossary.md（已定：Artifact 與 Agent 不翻、派工、發布、你、中英數間加空格）。不含 iframe 內 plannotator 標註工具、給 Agent 的提示詞與 WebMCP 工具說明（刻意保留英文）。接在 feat/redesign 之後（branch feat/i18n）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 預設以繁中顯示 /review、/review/dashboard、/review/settings/*
- [x] #2 settings 可切換英文並保留選擇；英文模式文案與原本逐字相同
- [x] #3 既有 Playwright 測試以英文跑全過；新增繁中測試
- [x] #4 verify:iteration 通過
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
LANG-001 verified（browser.json）。4 個 subagent 平行抽字串，各自擁有不重疊的檔案。英文逐字不變（含 SND-002 等規格鎖定文案）；給 Agent 的內容保留英文；伺服器錯誤以 displayError() 依代碼翻譯。測試以 englishContext() 固定英文；browserStorage() 排序 key，允許清單加入已登記的 artifact-review-locale。已知原有問題：storage 被封鎖時 main.tsx 讀主題會讓 app 崩潰（不在本次範圍）。
<!-- SECTION:NOTES:END -->
