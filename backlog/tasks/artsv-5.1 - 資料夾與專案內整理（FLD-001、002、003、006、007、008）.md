---
id: ARTSV-5.1
title: 資料夾與專案內整理（FLD-001、002、003、006、007、008）
status: Done
assignee: []
created_date: '2026-11-24T07:53:00Z'
updated_date: '2026-11-24T08:37:00Z'
labels: []
dependencies: []
parent_task_id: ARTSV-5
priority: high
ordinal: 18000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 schema 遷移、FolderService、HTTP/MCP/CLI/web 都有 B/F 測試
- [x] #2 verify:iteration 與 smoke 通過
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add transactional SQLite folder and placement persistence and authorization-aware services.
2. Expose shared operations through HTTP, MCP, CLI and the existing Review catalog.
3. Prove migration, parity, recovery and integrity with tests and run the iteration gate.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
完成 SQLite schema 13、資料夾與專案內 Artifact 整理、HTTP/MCP/CLI 操作、審閱目錄與繁中／英文介面。12 個 FLD B/F 測試及 2 個瀏覽器情境通過。verify:iteration（VITEST_MAX_WORKERS=5）及 smoke 通過。Conformance ledger 記錄後續階段的證據缺口。
<!-- SECTION:FINAL_SUMMARY:END -->
