---
id: ARTSV-5
title: 檔案管理：資料夾、垃圾桶、檔案總覽、連結專案資料夾、更多預覽
status: Done
assignee: []
created_date: '2026-11-24T07:53:00Z'
updated_date: '2026-11-24T12:48:00Z'
labels: []
dependencies: []
references:
  - project/spec/file-management-spec.md
priority: high
type: feature
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
依 project/spec/file-management-spec.md（ADR 0029–0031）實作 FLD、TRS、FOV、LFD、PRV-006..010。只在本機（SQLite）部署提供。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 所有 FLD/TRS/FOV/LFD/PRV-006..010 條目有 B/F 測試並通過
- [x] #2 pnpm verify:iteration 與 pnpm smoke 通過
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
全部子票完成並合併到 feat/workbench-files（e1e1a0a）。FLD/TRS/FOV/LFD-002..008 為 verified；LFD-001、PRV-006..010 為 behavior_verified（只在本機部署提供）。verify:iteration 與 smoke 在 e1e1a0a 通過。
<!-- SECTION:FINAL_SUMMARY:END -->
