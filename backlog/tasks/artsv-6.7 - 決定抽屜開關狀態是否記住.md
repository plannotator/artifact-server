---
id: ARTSV-6.7
title: 決定抽屜開關狀態是否記住
status: Done
assignee: []
created_date: '2026-11-25T13:19:00Z'
updated_date: '2026-11-25T13:20:00Z'
labels: []
dependencies: []
parent_task_id: ARTSV-6
priority: low
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
改版後留言欄預設收起，常用留言的人每次都要按 C。是否要記住使用者上次的抽屜狀態（例如存在 localStorage）？這是新功能，需要 Scott 決定，決定要做再另開實作單。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Scott 已做出決定並記錄在本單
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
決定：目前不記住抽屜開關狀態。理由：設計方向明定目錄、留言、版本資訊預設收起；記住狀態是 prompt 未要求的新功能。ARTSV-6.5 的 QA 若發現常用留言者負擔明顯，再另開實作單。（Scott 2026-11-25 同意依建議）
<!-- SECTION:FINAL_SUMMARY:END -->
