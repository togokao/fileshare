# CLAUDE.md

這個 repo（`togokao/fileshare`）存放 **隱道 Veilway** 的設計文件。Veilway 是一套多租戶 AI 應用的**產品底座**：所有 AI 請求在平台內把個資換成代號再送出，回覆回來後再換回真名。之後的各產品（例如保險業務員 AI 平台、中原大學產學脈動平台）從底座各自獨立出去（見 `Veilway2.md` 第 11 節）。

所有文件以**繁體中文**撰寫，回覆使用者也用繁體中文。

---

## Session 分工：每份檔案只由一個 session 修改

Veilway 的工作分成四個 session。**只修改自己負責的檔案**，其他檔案只讀不改。

| Session | 角色 | 負責修改 |
| --- | --- | --- |
| **Veilway 討論** | 整體架構與決策 | `Veilway2.md`、`Veilway三階段執行計畫.md`、`Veilway架構圖v2.html`、`Veilway架構圖v2.pdf`、`CLAUDE.md`、`README.md` |
| **第一階段** | 骨架 | `Veilway第一階段操作手冊.md` |
| **第二階段** | 隱道 | `Veilway第二階段操作手冊.md` |
| **第三階段** | 檔案與非同步 | `Veilway第三階段操作手冊.md` |

不確定自己是哪個 session 時，先問使用者。

### 需要改到別人負責的檔案時

- **階段 session 發現架構要調整**：不要直接改 `Veilway2.md`、執行計畫或架構圖。在自己的操作手冊最後加一節「**對架構的回饋**」，寫清楚要改什麼、為什麼，並告訴使用者把它帶到「Veilway 討論」session 處理。
- **討論 session 做了會影響操作手冊的決定**：在回覆中列出各階段操作手冊要配合修改的地方，由使用者帶到對應的階段 session。

---

## 修改流程

1. **修改前先同步**：`git fetch origin main`，從最新的 `main` 開始。工作分支如果是舊的、或對應的 PR 已經合併，先把分支重設到最新的 `main`。
2. 只改自己負責的檔案。
3. **改完就開 PR 合併到 `main`**，不要讓修改在分支上累積太久。
4. 合併時遇到衝突：以 `main` 上的版本為基礎，把自己的修改重新套上去，不要覆蓋別人的內容。

---

## 程式碼放在另一個 repo

- 這個 repo **只放文件**，不放程式碼。
- 程式碼（CDK、ASP.NET Core、前台、migration）放在獨立的程式碼 repo（預定名稱 `togokao/veilway`），結構依 `Veilway第一階段操作手冊.md` 第 8 步的 `Veilway.sln` 規劃。
- 三個階段 session 以程式碼 repo 為主；需要讀文件時，把本 repo 加進 session。

---

## 已定案的決策

修改任何文件時都要和以下決策一致。要推翻其中任何一項，必須在「Veilway 討論」session 決定，並同步更新本節。

| 主題 | 決策 | 出處 |
| --- | --- | --- |
| 名稱與定位 | Veilway 指整套前後台系統；隱道閘道是其中的元件。Veilway 也是可重複使用的產品底座，以「共用套件 + 範本 repo」讓各產品獨立出去 | `Veilway2.md` 開頭、第 11 節 |
| 區域 | AWS 台北 `ap-east-2`（CloudFront 憑證、WAF 等必須在 us-east-1） | 操作手冊第 0、2 步 |
| 網域 | `veilway.app`；租戶用 `<租戶>.veilway.app`；各環境用子網域 | 操作手冊第 0、2 步 |
| 系統元件 | 以原架構圖為準：CloudFront + WAF、S3 前台、ALB、ECS Fargate（正式環境至少 2 個容器）、RDS PostgreSQL（pgvector、多可用區）、ElastiCache（Session、限流）、S3 檔案（依租戶分 prefix）、SQS + Worker、Cognito | `Veilway2.md` 第 1 節 |
| 線上模型 | **Claude Platform on AWS**，閘道經 **PrivateLink** 連線。`inference_geo` 只有 `global`、`us`，推論與保存在境外；**只有代號化後的內容出境**，對照表留在台北 | `Veilway2.md` 第 6、7 節 |
| 閘道 | 隱道閘道是**獨立的 ECS service**（自己的 SG 與 task role），只有它能呼叫模型；第二階段上線 | `Veilway2.md` 第 6 節 |
| 特殊合規租戶 | 建議租戶自建地端 AI，經隱道連接器接入（不改走 Bedrock） | `Veilway2.md` 第 7.2 節 |
| 對照表 | 預設每個對話一張並設 TTL；RAG 才用租戶範圍；**絕不跨租戶**；ElastiCache 不放對照表或任何真名 | `Veilway2.md` 第 4 節 |
| 檢查點 | 自動補遮後重檢，仍命中就攔下；**檢查點故障一律 fail-closed** | `Veilway2.md` 第 5 節 |
| 租戶與使用者 | 每張業務資料表帶 `tenant_id` 並啟用 Row-Level Security；一位使用者只屬於一個租戶 | 操作手冊第 0、5 步 |
| 對外說法 | 「平台在台灣，只有代號化後的內容出境」；代號化屬於假名化，不宣稱匿名化 | `Veilway2.md` 第 9 節 |
| IaC | AWS CDK（C#），全面參數化；資源名稱以「產品代號」開頭（底座為 `veilway`） | 操作手冊第 0、14 步 |
| 建置順序 | 三階段：骨架 → 隱道 → 檔案與非同步；之後產品化 | `Veilway三階段執行計畫.md` |

---

## 文件撰寫慣例

- 檔名格式：`Veilway<主題>.md`，例如 `Veilway第二階段操作手冊.md`。
- 操作手冊每一步的格式：**目的 → 操作 → 驗證 → 注意事項**。
- 標示：⚠️ 容易出錯、事後很難改的地方；🧩 和產品底座（可重複套用）有關的要求。
- 多用表格整理比較與清單；查證過的外部事實要附上來源連結，無法查證的寫成「待確認」。
- 架構圖：修改 `Veilway架構圖v2.html` 後，用 Chromium（Playwright）以 A4、列印背景的設定轉出 `Veilway架構圖v2.pdf`，並逐頁檢查排版。
