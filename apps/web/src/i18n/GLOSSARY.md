# Artifact Server 繁中用語表

介面翻譯一律照這份；要改用詞，先改這裡再改字典（`apps/web/src/i18n/messages/`）。2026-11-24 定案。

- 用途：fork 的網頁介面加入繁體中文（預設），英文保留為第二語言。
- 範圍：`/review`、`/review/dashboard`、`/review/settings/*`。不含 iframe 內的標註工具、給 agent 的提示詞、CLI 與 MCP 輸出。
- 次數是英文字串裡出現的大約次數，只用來判斷優先順序。
- ★ 表示需要你決定；其他項目沒意見就照「建議」走。
- ✅ 表示 2026-11-24 已由 Scott 定案。

## 一、核心名詞

| 英文 | 次數 | 建議 | 替代 | 備註 |
|---|---|---|---|---|
| ✅ artifact | 231 | Artifact（不翻） | 產出物、成品 | 產品名稱是 Artifact Server，和 Claude 的 Artifact 用法一致 |
| project | 117 | 專案 | 計畫 | |
| folder / project root | | 資料夾／專案根目錄 | | |
| version | 72 | 版本 | | `v3` 這類版本號維持原樣 |
| current version | 20 | 目前版本 | 最新版本 | 還原舊版之後，「目前」不一定是「最新」 |
| comment | 131 | 留言 | 註解、評論 | |
| thread | 16 | 留言串 | 討論串 | |
| reply | 35 | 回覆 | | |
| resolve / resolved | 32 | 標為已解決／已解決 | 結案 | |
| open（留言狀態） | | 未解決 | 開啟中 | 對應 resolved |
| reopen | | 重新開啟 | | |
| tag | 28 | 標籤 | | |
| ✅ agent | 56 | Agent（不翻） | AI 代理、代理程式 | 這個領域在台灣多半直接講 Agent |
| ✅ dispatch | 22 | 派工 | 指派、送交 | 把留言打包交給 agent 處理 |
| send to agent | 19 | 交給 Agent | 傳給 Agent | |
| bundle | 1 | 一批留言 | 批次 | |
| mailbox | 2 | 收件匣 | | |

## 二、動作

| 英文 | 建議 | 替代 | 備註 |
|---|---|---|---|
| ✅ publish / published | 發布／已發布 | 發佈 | 教育部標準寫法是「發布」，「發佈」也很常見，全站統一用一個 |
| review（動詞與模式） | 審閱 | 檢閱、審查 | 「Back to review」翻成「返回審閱」 |
| share | 分享 | | |
| download | 下載 | | |
| delete | 刪除 | | |
| move / rename | 移動／重新命名 | | |
| restore | 還原 | | |
| make current | 設為目前版本 | | |
| compare | 比較 | 對照 | |
| capture | 擷取 | 抓取 | 連結來源時擷取一個版本 |
| link／relink（來源） | 連結／重新連結 | | |
| archive／unarchive | 封存／取消封存 | | |
| revoke | 撤銷 | 註銷 | API 金鑰 |
| rotate | 輪替 | 更換 | API 金鑰 |
| sign in／sign out | 登入／登出 | | |
| refresh／reload | 重新整理／重新載入 | | |
| copy | 複製 | | |

## 三、介面區塊與模式

| 英文 | 建議 | 替代 |
|---|---|---|
| catalog | 目錄 | 清單、列表 |
| inspector | 資訊面板 | 檢視器 |
| details | 詳細資料 | 細節 |
| files | 檔案 | |
| preview | 預覽 | |
| full screen | 全螢幕 | |
| raw artifact | 原始檔 | 原始內容 |
| focus mode | 專注模式 | |
| annotate mode／interact mode | 標註模式／互動模式 | |
| keyboard shortcuts | 鍵盤快捷鍵 | |
| danger zone | 危險操作 | 危險區域 |
| settings | 設定 | |
| dashboard | 儀表板 | 總覽 |
| activity | 活動 | 動態 |
| workspace | 工作區 | |
| draft | 草稿 | |

## 四、存取與權限

| 英文 | 建議 | 替代 | 備註 |
|---|---|---|---|
| access | 存取權限 | | |
| account required | 需要帳號 | 僅限成員 | |
| public link | 公開連結 | | |
| member／administrator／owner | 成員／管理員／擁有者 | | |
| ★ installation | 這台伺服器（暫定） | 安裝實例、站台 | 依上下文翻，例如「這台伺服器只有一個封閉的成員群組」 |
| API key | API 金鑰 | | |
| capability | 權限 | 能力 | 例如 `artifact:read` 這類代碼維持原樣 |
| token | 權杖 | Token | |
| scope | 範圍 | | |
| MCP／WebMCP | 不翻 | | |

## 五、狀態

| 英文 | 建議 |
|---|---|
| queued／claimed／delivered／addressed／failed／canceled（派工） | 排隊中／已領取／已送達／已處理／失敗／已取消 |
| idle／working／replying／disconnected（Agent 狀態） | 閒置／工作中／回覆中／已中斷連線 |
| in sync／modified／missing／unreadable（連結來源） | 已同步／已修改／找不到／無法讀取 |
| active／archived（專案） | 使用中／已封存 |
| active／revoked（金鑰） | 有效／已撤銷 |
| private／public link（存取） | 不公開／公開連結 |

## 六、Dashboard 與儲存空間

| 英文 | 建議 | 替代 |
|---|---|---|
| storage／stored | 儲存空間／已儲存 | |
| across every version | 所有版本合計 | |
| saved by deduplication | 去重省下 | 重複資料節省 |
| git history／mirror | Git 歷史／鏡像 | |
| budget | 額度 | 預算 |
| 7 days／30 days／90 days／all time | 7 天／30 天／90 天／全部 | |
| readings | 讀數 | 指標 |

## 七、寫作規則

1. ✅ 稱呼：全站用「你」。
2. ✅ 中文和英文、數字之間加半形空格（例如「3 個版本」「Artifact 名稱」）。
3. 標點用全形：，。：；「」（）。英文代碼、檔名、指令照原樣放在 `code` 裡。
4. 按鈕用動詞，2 到 4 個字，例如「發布」「交給 Agent」「標為已解決」，不加「請」。
5. 錯誤訊息的寫法：先說發生什麼事，能說明原因就說，最後說怎麼處理；不用「哎呀」，不用驚嘆號。
6. 數字、單位、日期：數字和單位之間有空格（`213.0 kB`）；日期和相對時間跟著介面語言格式化（例如「3 小時前」）。
7. 規格逐字鎖定的英文文案（例如 SND-002）：英文模式照原文；繁中模式另訂譯文，並補一個繁中測試。
