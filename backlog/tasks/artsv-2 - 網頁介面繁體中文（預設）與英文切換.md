---
id: ARTSV-2
title: 網頁介面繁體中文（預設）與英文切換
status: In Progress
assignee: []
created_date: '2026-11-23T21:50:00Z'
updated_date: '2026-11-23T21:50:00Z'
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
- [ ] #1 預設以繁中顯示 /review、/review/dashboard、/review/settings/*
- [ ] #2 settings 可切換英文並保留選擇；英文模式文案與原本逐字相同
- [ ] #3 既有 Playwright 測試以英文跑全過；新增繁中測試
- [ ] #4 verify:iteration 通過
<!-- AC:END -->
