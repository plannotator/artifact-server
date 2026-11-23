---
id: ARTSV-1.4
title: 整體驗證與瀏覽器實測
status: Done
assignee: []
created_date: '2026-11-23T18:58:00Z'
updated_date: '2026-11-23T20:04:00Z'
labels: []
dependencies:
  - ARTSV-1.3
parent_task_id: ARTSV-1
priority: medium
type: task
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
跑 pnpm check、pnpm verify:iteration（完後還原 project/evidence/local-foundation.json），正式 build 下用 ego-browser 實測 dashboard、截圖、確認無 CSP violation；回報仍未證明的 requirement。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 pnpm check 與 pnpm verify:iteration 通過
- [x] #2 正式 build 瀏覽器實測四塊正常、console 無 CSP violation、附截圖
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
pnpm check 全過（339 + Cloudflare 37）。verify:iteration 通過到 perf:capacity（含 test:web、pulumi、object-storage、external-storage、coverage、local-package、perf），另跑 test:oidc、test:helm-static 通過。卡在 package:oci：Dockerfile 鎖的 AWS RDS global-bundle.pem checksum (e5bb…) 已過期，AWS 2026-10-14 更新為 90a6…；未經同意不改信任根 pin，因此 compact-compose、external-storage-compose、helm 整合未跑。順手修正 tests/cli/mcp-onboarding.test.ts 讀到真實 HOME 的隔離漏洞（ce83fc2）。瀏覽器實測（正式 build、ego-browser）：四塊正常、篩選寫入 URL、深淺色、390px、tooltip；無 style-src 違規，唯一 script-src 回報來自既有 zod chunk。

2026-11-24 經 Scott 同意更新 RDS CA checksum（9046955，兩次 HTTPS 下載 digest 一致，114 張憑證全由 Amazon Web Services 簽發）；修 CMT-017 axe 檢查在 popover 淡入中量色的不穩定（等動畫結束再量，單測連跑 6 次全過）。verify:iteration 全段 EXIT=0。
<!-- SECTION:NOTES:END -->
