---
id: ARTSV-6.1
title: 合併 feat/workbench-files 進 main
status: To Do
assignee: []
created_date: '2026-11-25T13:19:00Z'
labels: []
dependencies: []
parent_task_id: ARTSV-6
priority: high
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
feat/workbench-files（b22120b）比 main 多 55 個 commit，包含檔案頁、連結資料夾、垃圾桶、FLD-008，目前沒有 PR。改版依賴這些頁面，必須先合併。b22120b 已有 verify:iteration 證據，主要工作是開 PR、等 CI、review。不可夾帶 docs/repo-xray-pm/、graft 相關檔案、.artifact-server symlink。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PR 開到 ShiGaChenTW/artifact-server，base main
- [ ] #2 CI 全綠並合併
<!-- AC:END -->
