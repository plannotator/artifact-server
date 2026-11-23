---
id: ARTSV-2.1
title: i18n 核心：字典、語言設定、中文字體、錯誤代碼對照
status: Done
assignee: []
created_date: '2026-11-23T21:50:00Z'
updated_date: '2026-11-23T21:53:00Z'
labels: []
dependencies: []
parent_task_id: ARTSV-2
priority: high
type: task
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
apps/web/src/i18n：en 為鍵的來源、zh-TW 以 satisfies 對齊；語言存 localStorage，切換後重新載入；<html lang> 同步；日期依語系；伺服器錯誤依代碼翻譯；字體加中文 fallback，:lang(zh) 標題字距 0。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 型別保證兩份字典鍵一致
- [x] #2 測試 fixture 固定英文
<!-- AC:END -->
