---
id: ARTSV-6.3
title: 規格與 ledger 對齊抽屜版面與新快捷鍵
status: To Do
assignee: []
created_date: '2026-11-25T13:19:00Z'
labels: []
dependencies:
  - ARTSV-6.2
parent_task_id: ARTSV-6
priority: high
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
抽屜、T/C/V/←/→ 快捷鍵、上一個/下一個連動在 project/spec/conformance.yml 沒有需求編號。要新增 UXR 編號並把 reader-layout.spec.ts 的測試改成帶編號；UXR-004-F 的「預設 inspector 寬度」改寫為版本資訊抽屜；快捷鍵一覽條文（UXR-008 附近）補上新按鍵；artifact-server-product-spec.html 版面段落同步。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 新增的 UXR 需求各有 -B、-F 測試並通過
- [ ] #2 UXR-004-F 與快捷鍵條文已更新，check-conformance-test-ids 與 validate-conformance 通過
- [ ] #3 產品規格版面描述與實作一致
<!-- AC:END -->
