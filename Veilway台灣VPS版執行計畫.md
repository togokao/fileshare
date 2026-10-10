# Veilway 台灣 VPS 版執行計畫

架構說明見〈Veilway2.md〉。原本的建置順序見〈Veilway三階段執行計畫.md〉，AWS 簡化版見〈Veilway簡化版執行計畫.md〉。

> **狀態：草案，討論中（2026-10-10）。**這份是「Veilway 討論」session 的討論結果，**尚未取代**原三階段執行計畫，也**尚未更新** `CLAUDE.md` 的已定案決策。要不要採用、用什麼方式採用，見文末「待定案事項」。

---

## 為什麼改用台灣 VPS

考量重點是**費用**和**複雜度**。

| | 原三階段（AWS 完整版） | AWS 簡化版 | **台灣 VPS 版** |
| --- | --- | --- | --- |
| 要管的服務 | 十幾個 AWS 服務 + CDK | 約 10 個 AWS 服務 | **3 個：VPS、Cloudflare DNS、Anthropic API** |
| 基礎設施月費 | 最高 | 約 NT$5,600 | **約 NT$2,400～3,400** |
| 資料位置 | 台北 | 台北 | **台灣** |
| 三階段開發時間 | 最長（多 6～10 人週的基礎設施） | 約 21～26 人週 | **約 21～26 人週** |

隱道真正的價值只有兩件事：

1. **遮蔽 → 檢查 → 還原**：外部模型只看得到代號。
2. **租戶隔離**：A 租戶碰不到 B 租戶的資料。

這兩件事都寫在 **C# 程式和 PostgreSQL** 裡，和用哪一家雲端無關。台灣 VPS 版把基礎設施縮到最少，核心價值保持不變。

---

## 原則

- **服務越少越好**：能在同一台主機上用 PostgreSQL 或應用程式做到的，就不另外加服務。
- **核心規則不簡化**：租戶隔離、對照表、檢查點 fail-closed 都照原設計（見「不簡化的規則」）。
- **不綁特定廠商**：DNS、主機、模型三者各自可以替換。主機要搬家，只需要改 DNS 和設定。
- 🧩 **程式碼可以升級**：程式照套件邊界拆成專案，只用跨平台的 ASP.NET Core API。日後要搬到雲端、Linux 或容器，只需要換部署方式。
- ⚠️ **備份是生命線**：所有資料都在同一台機器上，沒有異地備份就等於沒有備份。
- **每個階段結束時，系統都要能完整運作。**

---

## 架構

```
使用者（iPad／瀏覽器）
   │ HTTPS（直接連到 VPS，中間沒有第三方解密）
   ▼
Cloudflare DNS（veilway.app、*.veilway.app → VPS 的 IP；只做 DNS，不開代理）
   │
   ▼
台灣 VPS（Windows Server + IIS）
   ├─ IIS：Let's Encrypt 萬用憑證（win-acme 自動續約）
   ├─ ASP.NET Core
   │   ├─ 前台靜態檔（wwwroot）
   │   ├─ 業務 API、租戶管理、ASP.NET Core Identity
   │   ├─ 隱道模組（遮蔽器 → 檢查點 → 還原器 → 計量）──→ Anthropic API（只送代號）
   │   └─ 背景工作（IHostedService）
   ├─ PostgreSQL（只聽本機）
   │   （租戶、使用者、Session、計量、對話、對照表、工作佇列、稽核）
   └─ 檔案目錄（依租戶分資料夾）
   │
   └──→ 異地備份（加密後才送出）
```

### 元件

| 層 | 元件 | 說明 |
| --- | --- | --- |
| DNS | Cloudflare（免費方案，**只做 DNS**） | `veilway.app` 和 `*.veilway.app` 用 A 記錄指向 VPS。⚠️ **不開 Cloudflare 代理**（橘色雲朵），理由見下方「為什麼不開 Cloudflare 代理」 |
| 憑證 | Let's Encrypt 萬用憑證 | 萬用憑證只能用 DNS 驗證（[Let's Encrypt 驗證方式](https://letsencrypt.org/docs/challenge-types/)）。在 VPS 上用 [win-acme](https://www.win-acme.com/) 搭配 Cloudflare API token 自動申請、續約，並綁定到 IIS |
| 主機 | 台灣 VPS，4 核 8 GB，Windows Server | 跑 IIS、ASP.NET Core、PostgreSQL。⚠️ 4 GB 放 Windows + IIS + PostgreSQL 會很吃緊，建議 8 GB |
| 前台 | IIS | SPA 靜態檔放在同一個 IIS 網站的 `wwwroot`，API 走 `/api/*` |
| 後端 | IIS + ASP.NET Core | In-Process 模式。App Pool 設成 **AlwaysRunning** 並關閉閒置逾時，背景工作才不會被停掉（[IIS 進階設定](https://learn.microsoft.com/aspnet/core/host-and-deploy/iis/advanced)） |
| 資料庫 | PostgreSQL（裝在 VPS 上） | **只聽 `localhost`**，不對外開放；啟用 pgvector（給之後的 RAG） |
| Session | PostgreSQL | Identity 用 Cookie 登入，登入票證存在 PostgreSQL（`ITicketStore`）；登出時刪除紀錄，舊 Cookie 立即失效 |
| 限流 | 記憶體 + PostgreSQL | 每秒請求頻率用 ASP.NET Core 內建 RateLimiter（[Rate limiting](https://learn.microsoft.com/aspnet/core/performance/rate-limit)）；AI 額度與計量寫進 PostgreSQL |
| 身分 | ASP.NET Core Identity | 使用者表帶 `tenant_id`；一位使用者只屬於一個租戶 |
| 檔案 | VPS 本機磁碟 | 依租戶分資料夾（`tenants/{tenant_id}/…`），放在網站根目錄**以外**；只能經由 API 下載，API 先檢查租戶 |
| 非同步 | 本機背景工作 | `IHostedService` + PostgreSQL 工作表，用 `FOR UPDATE SKIP LOCKED` 取工作（[PostgreSQL 鎖定子句](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)）；也可以直接用 Hangfire 的 PostgreSQL 版本 |
| AI | Anthropic API 直連 | 用 API key 驗證；只有隱道模組讀得到這把 key |
| 加密金鑰 | 應用程式自己加密 | 主金鑰用 Windows DPAPI 保護；每個租戶一把資料金鑰，以主金鑰加密後存在 PostgreSQL。⚠️ 主金鑰要**離線備份**，否則備份檔無法還原 |
| 備份 | 異地備份 | 每天 `pg_dump` 加檔案目錄，**加密後**送到異地（目的地見待定案事項 3） |
| 監控 | 外部監測 + 應用程式日誌 | 服務是否存活由**外部**監測（Uptime Kuma 裝在另一台機器，或免費的外部監測服務）；應用程式日誌寫檔案，或寫到 Seq |

### 為什麼不開 Cloudflare 代理

開了 Cloudflare 代理後，HTTPS 會在 Cloudflare 的節點解密，**使用者輸入的真名會經過 Cloudflare**。這樣「平台在台灣，只有代號化後的內容出境」的說法就不完全成立。

| | 只做 DNS（**建議**） | 開代理 |
| --- | --- | --- |
| 誰看得到明文 | 只有 VPS | VPS + Cloudflare |
| 對外說法 | 「平台在台灣」完全成立 | 要另外揭露 Cloudflare 是處理者 |
| 憑證 | Let's Encrypt（win-acme 自動續約） | Cloudflare 代管 |
| DDoS 防護 | 靠 VPS 廠商 | 有 |
| 防火牆 | 443 對公網開放 | 可以只接受 Cloudflare 的 IP |

日後真的遇到攻擊，再評估是否開代理，同時更新隱私權政策。

### 網路與主機安全

| 項目 | 做法 |
| --- | --- |
| 對外連入 | Windows 防火牆只開 **443**（以及 80，只用來把 HTTP 轉到 HTTPS） |
| PostgreSQL | 只聽 `localhost`，防火牆不開 5432 |
| 遠端管理 | ⚠️ **RDP 不能對公網開放**：只允許固定 IP，或經過 VPN（例如 Tailscale） |
| 更新 | Windows Update 設在固定的維護時段（例如週日凌晨），接受短暫停機 |
| 帳號 | 停用預設的 Administrator，另建管理帳號並使用強密碼 |
| 對外連線 | 需要連出的只有 Anthropic API、Windows Update、備份目的地、Let's Encrypt、Cloudflare API |

---

## 和其他版本的差異

| 項目 | 原三階段（AWS） | 台灣 VPS 版 | 失去什麼 | 什麼時候要補回來 |
| --- | --- | --- | --- | --- |
| 邊緣 | CloudFront + WAF | IIS 直接對外 | CDN、WAF | 遇到攻擊時（可以開 Cloudflare 代理，但要更新揭露） |
| 後端 | ECS Fargate，至少 2 個容器 | 1 台 VPS | **高可用**：機器掛掉或 Windows Update 重開機時，服務會中斷 | 有付費客戶、簽 SLA 時 |
| 閘道 | 獨立 ECS service | 同一個程式裡的模組 | **用網路強制「唯一出口」**：只能靠程式紀律加架構測試 | 有要求嚴格的租戶時 |
| 模型 | Claude Platform on AWS + PrivateLink | Anthropic API 直連 | IAM 驗證、AWS 帳單、PrivateLink | — |
| 資料庫 | RDS 多可用區（代管） | VPS 上自己裝 | 自動備份、自動切換、自動更新 | 資料量或可用性要求變高時，改用代管資料庫 |
| 快取 | ElastiCache | PostgreSQL + 記憶體 | 多台機器共用 | 主機超過 1 台時 |
| 身分 | Cognito | ASP.NET Core Identity | 內建 MFA、密碼重設、Email 驗證 | — |
| 檔案 | S3 | 本機磁碟 | 幾乎無限的容量、高耐久性 | 檔案量變大時，改用物件儲存 |
| 非同步 | SQS + Worker | 本機背景工作 | 獨立擴充 Worker | 長任務影響 API 時 |
| 金鑰 | KMS | DPAPI + 應用程式加密 | 硬體保護的金鑰、稽核紀錄 | 有資安稽核要求時 |
| IaC | CDK（C#） | 安裝腳本 + 建置清單 | 一鍵重建 | 要開第二個產品時 |

---

## 不簡化的規則

以下規則和原設計一致，台灣 VPS 版照做：

| 規則 | 台灣 VPS 版的做法 |
| --- | --- |
| 每張業務資料表帶 `tenant_id` 並啟用 RLS | EF Core 開連線時執行 `SET app.tenant_id`；應用程式用的 DB 帳號**不是**資料表擁有者，也沒有 `BYPASSRLS`；migration 用另一個帳號 |
| 一位使用者只屬於一個租戶 | 登入時核對「子網域對應的租戶」和「使用者的 `tenant_id`」一致，不一致就拒絕 |
| ⚠️ Cookie 不跨租戶 | Cookie **不設** `Domain=.veilway.app`，讓每個租戶子網域的 Cookie 各自獨立 |
| 檔案不跨租戶 | 檔案放在網站根目錄以外，只能經由 API 存取；API 先核對租戶，再讀取檔案 |
| 對照表預設每個對話一張並設 TTL；**絕不跨租戶** | 存在 PostgreSQL，用租戶的資料金鑰加密；背景工作定期清除過期的對照表 |
| 檢查點補遮後仍命中就攔下；**故障一律 fail-closed** | 同〈Veilway2.md〉第 5 節 |
| 只有隱道能呼叫模型 | 只有 `Veilway.Gateway` 專案引用 Anthropic SDK，也只有它讀得到 API key；用架構測試（例如 NetArchTest）檢查，並接進 CI |
| 日誌不印原始 prompt | 定期抽查日誌 |
| 對外說法 | 「平台在台灣，只有代號化後的內容出境」；代號化屬於假名化，不宣稱匿名化 |
| 網域 | `veilway.app`；租戶用 `<租戶>.veilway.app` |
| 🧩 套件邊界 | `Veilway.MultiTenancy`、`Veilway.Gateway`、`Veilway.Files` 各自獨立專案，另有最小範例產品；底座不寫產品專屬邏輯 |

---

## 第一階段：骨架（約 4～5 人週）

### 範圍

| 類別 | 項目 |
| --- | --- |
| VPS | 選定廠商並開通 4 核 8 GB Windows Server；防火牆（只開 443、80）；RDP 限制來源 IP 或走 VPN；Windows Update 維護時段 |
| DNS 與憑證 | Cloudflare 管理 `veilway.app`（只做 DNS）；`veilway.app` 與 `*.veilway.app` 指向 VPS；win-acme 申請 Let's Encrypt 萬用憑證並自動續約 |
| IIS | 安裝 ASP.NET Core Hosting Bundle；App Pool 設成 AlwaysRunning；萬用憑證綁定 443；HTTP 轉 HTTPS |
| 資料庫 | 安裝 PostgreSQL（只聽本機）、pgvector；EF Core migrations；應用程式帳號與 migration 帳號分開 |
| 專案結構 | `Veilway.sln`：`Veilway.MultiTenancy`、`Veilway.Gateway`（空殼）、`Veilway.Files`（空殼）、範例產品（前台 + API） |
| 身分 | ASP.NET Core Identity；使用者帶 `tenant_id`；Session 票證存 PostgreSQL；登入時核對子網域與租戶 |
| 租戶管理 | 租戶建立與子網域對應；方案與額度的資料結構（計量在第二階段接上） |
| 資料表 | 租戶、使用者、角色、Session；**每張表都帶 `tenant_id` 並啟用 RLS** |
| 限流 | ASP.NET Core RateLimiter（依租戶、依使用者） |
| 加密金鑰 | DPAPI 保護的主金鑰；每個租戶的資料金鑰；主金鑰離線備份 |
| 備份 | 每天 `pg_dump` + 檔案目錄 → 加密 → 異地；**完成第一次還原測試** |
| 部署 | 本機建置後，用腳本發佈到 IIS（先手動執行，之後再接 GitHub Actions） |
| 監控 | 外部監測 `/health`；應用程式日誌；磁碟空間告警 |
| 建置清單 | VPS、IIS、PostgreSQL、防火牆的每一項設定寫成清單與安裝腳本，作為重建或搬家的依據 |

### 不做

AI 功能、檔案上傳、背景工作。

### 驗收標準

- [ ] 使用者能從租戶子網域登入，前台呼叫 API 成功；用 A 租戶的帳號登入 B 租戶的子網域會被拒絕
- [ ] API 依登入者的租戶讀寫資料；A 租戶**讀不到** B 租戶的資料（有自動化測試，包含直接用應用程式帳號下 SQL）
- [ ] 從外部掃描，只有 443 和 80 開放；PostgreSQL 和 RDP 從公網連不到
- [ ] 登出後，舊 Cookie 立即失效；超過限流門檻的請求回 429
- [ ] 重開 VPS 後，服務自動恢復
- [ ] **從異地備份還原到另一台機器，資料完整、能登入**
- [ ] 萬用憑證能自動續約（用 win-acme 的測試模式驗證）

---

## 第二階段：隱道（約 8～10 人週）

### 範圍

| 類別 | 項目 |
| --- | --- |
| 模型接入 | 開通 Anthropic API 帳號與 workspace；API key 只放在隱道模組的加密設定中；決定 `inference_geo`（`global` 或 `us`） |
| 隱道管線 | `IChatClient` + `DelegatingChatClient`：遮蔽 → 檢查點 → 送出 → 還原 → 計量，全部寫在 `Veilway.Gateway`；業務 API 只透過公開介面呼叫 |
| 出口紀律 | 架構測試：只有 `Veilway.Gateway` 引用 Anthropic SDK；接進 CI |
| 遮蔽設定化 | 個資類型、正規表示式、租戶字典、提示詞、檢查點政策都由設定提供 |
| 遮蔽器 | 正規表示式 + 租戶字典（管理介面與匯入）；NER 列為後段項目 |
| 檢查點 | 對照表原值比對、正規表示式重掃、字典比對；處理規則同〈Veilway2.md〉第 5 節；故障時 fail-closed |
| 還原器 | 能容錯的代號比對；串流緩衝區 |
| 資料表 | 對話、訊息、對照表（每個對話一張、TTL、加密）、`AI_REQUEST_LOG`（只存遮蔽後的內容與 `usage.inference_geo`）、攔截紀錄 |
| 計量與額度 | 每次的 token 用量寫進 PostgreSQL；超過方案額度就拒絕 |
| 前台 | 對話介面（串流顯示）、對話列表、檢查點攔截的提示與確認畫面 |
| 測試集 v1 | 格式類個資 + 字典命中案例，接進 CI |

### 後段項目

- 繁中 NER 與別名展開（CPU 執行；要量測 VPS 的記憶體與 CPU 夠不夠）
- 測試集 v2：困難案例，加上遮蔽前後回答品質的比較
- Ollama 當開發替身，驗證隱道連接器只改 endpoint 就能切換

### 不做

Tool calling、RAG、檔案上傳。

### 驗收標準

- [ ] 使用者能在網頁上和 AI 多輪對話，回覆以串流顯示
- [ ] 從 `AI_REQUEST_LOG` 抽查，送出的內容找不到測試資料裡的個資
- [ ] 架構測試證明只有 `Veilway.Gateway` 能呼叫模型
- [ ] 測試集上，格式類個資召回率 99.9% 以上，字典類 100%
- [ ] 檢查點故障時，請求會被拒絕，不會放行
- [ ] 每個租戶的 token 用量能查詢；超過方案額度時會被擋下
- [ ] 日誌中找不到原始 prompt 或 API key（抽查）

### 風險

- 推論在境外（`inference_geo` 只有 `global`、`us`，見〈Veilway2.md〉第 7.1 節）：上線前要完成跨境傳輸的揭露文字與合約條款
- 零資料保留（ZDR）要向 Anthropic 申請，審核時間要預留
- 模型可能不會原樣保留代號，還原器的容錯規則要用實際回覆來調整
- 只有一台 VPS：遮蔽（尤其 NER）、串流、資料庫都在同一台機器上，要量測延遲與資源用量
- API key 外洩就能直接呼叫模型：設定用量上限、定期更換，外洩時立即撤銷

---

## 第三階段：檔案與背景工作（約 5～6 人週）

### 範圍

| 類別 | 項目 |
| --- | --- |
| 上傳 | 前台上傳到 API，API 以串流方式寫進該租戶的資料夾；限制檔案大小與類型；IIS 的上傳大小上限要配合調整 |
| 背景工作 | PostgreSQL 工作表（狀態、重試次數、錯誤訊息）；`IHostedService` 用 `FOR UPDATE SKIP LOCKED` 取工作；失敗超過次數就標成「失敗」並告警 |
| 文件處理 | 抽出文字（PDF、Office 檔）→ 遮蔽 → 存進 PostgreSQL；呼叫 AI 一樣經過 `Veilway.Gateway` |
| 工作狀態 | 前台顯示處理進度（輪詢） |
| 文件問答 | 「針對這份文件提問」；大型文件切段處理 |
| 生命週期 | 刪除對話或租戶時，連同檔案、對照表、相關紀錄一起清除；監控磁碟空間 |
| 備份 | 檔案目錄納入每日異地備份 |
| 套件化 | 上傳、工作框架、抽文字與遮蔽寫在 `Veilway.Files` |

### 可選項目

- RAG：pgvector + 租戶範圍的對照表；嵌入模型用平台內 CPU 模型
- Tool calling：參數還原 → 平台內執行 → 結果重新遮蔽
- 影像 OCR、錄音轉文字（⚠️ 很吃 CPU，可能要升級 VPS 規格，或另外開一台處理用的 VPS）

### 驗收標準

- [ ] 上傳 50 MB 的 PDF 後，API 立即回應，進度正確顯示，處理完成後可以對文件提問
- [ ] 處理失敗的工作會標成失敗並告警，不會遺失；VPS 重開後，未完成的工作會繼續處理
- [ ] 送給模型的文件內容經過遮蔽（抽查 `AI_REQUEST_LOG`）
- [ ] 刪除對話後，檔案、對照表、相關紀錄都一併清除
- [ ] A 租戶拿不到 B 租戶的檔案（直接猜檔案路徑或 ID 也一樣）

---

## 費用估算（每月）

VPS 價格來自廠商網頁與比較文章（2026-10 查詢），**是行情，待確認**，簽約前要向廠商問清楚。台幣以 1 USD ≈ 32 TWD 粗估。

### 基礎設施

| 項目 | 建議規格 | 每月（台幣） | 來源 |
| --- | --- | --- | --- |
| VPS | 台灣機房，4 核 8 GB | 1,800～2,520 | [台灣 VPS 價格比較](https://www.nss.com.tw/virtual-hosting-charging)、[遠振台灣 VPS](https://host.com.tw/%E5%8F%B0%E7%81%A3VPS%E4%B8%BB%E6%A9%9F) |
| Windows 授權 | 依廠商（可能另外收費） | 525～699 | [ServerZoo（中華電信機房）](https://serverzoo.com/taiwan-taipei-hinet-cloud-cheap-vps) |
| 異地備份 | 依目的地 | 0～100 | 待確認 |
| Cloudflare DNS | 免費方案 | 0 | |
| Let's Encrypt 憑證 | | 0 | |
| 網域 `veilway.app` | 年費攤到每月 | 約 50 | 待確認 |
| 開通設定費 | 部分廠商一次收取 | （一次 1,500） | [台灣 VPS 價格比較](https://www.nss.com.tw/virtual-hosting-charging) |
| **合計** | | **約 2,400～3,400** | |

| 其他規格 | 每月（台幣） | 說明 |
| --- | --- | --- |
| 2 核 4 GB + Windows | 約 1,800～2,000 | 只適合 PoC，記憶體很吃緊 |
| 4 核 8 GB + Linux（Kestrel + Nginx） | 約 1,900～2,700 | 省下 Windows 授權費，同一份 C# 程式照樣能跑 |

### AI 模型（依用量而定）

價格以 Anthropic 第一方 API 牌價計算（2026-10）。

| 模型 | 輸入／每百萬 token | 輸出／每百萬 token |
| --- | --- | --- |
| Claude Opus 5.5 | $4 | $20 |
| Claude Sonnet 5.5 | $2 | $10 |
| Claude Haiku 5.5 | $0.10 | $0.50 |

**估算情境**：20 位使用者，每人每天 30 次對話，每月 22 個工作天，共 13,200 次。每次輸入約 3,000 token、輸出約 500 token。

| 模型 | 每月（USD） | 每月（台幣） |
| --- | --- | --- |
| Opus 5.5 | 約 290 | 約 9,300 |
| Sonnet 5.5 | 約 145 | 約 4,600 |
| Haiku 5.5 | 約 7 | 約 230 |

- 思考（thinking）的 token 按輸出計費，實際費用可能比上表高。
- prompt caching 可以降低輸入的費用。
- `inference_geo` 設成 `us` 時，費用乘以 1.1。

### 合計與比較

| | AWS 簡化版 | **台灣 VPS 版** |
| --- | --- | --- |
| 基礎設施 | 約 NT$5,600 | **約 NT$2,400～3,400** |
| AI（20 人，Sonnet 5.5） | 約 NT$4,600 | 約 NT$4,600 |
| **每月合計** | **約 NT$10,000** | **約 NT$7,000～8,000** |

**未計入**：人力、ZDR 是否另外收費、VPS 規格升級。

---

## 時程估算

**前提**：開發者熟悉 C#／ASP.NET Core；只算必做項目；開發時搭配 Claude Code 這類 AI 輔助工具（不用的話，大約再多 3～5 成）。

| 階段 | 人週 |
| --- | --- |
| 第一階段：骨架 | 4～5 |
| 第二階段：隱道 | 8～10 |
| 第三階段：檔案與背景工作 | 5～6 |
| 緩衝（整合、除錯、調整還原器容錯），加 25% | 4～5 |
| **合計** | **約 21～26 人週** |

| 人力 | 日曆時間 |
| --- | --- |
| 1 人全職 | 約 5～6 個月 |
| 2 人全職 | 約 3～3.5 個月（各工作之間有先後順序，不會剛好減半） |
| 1 人兼職（每週約一半時間） | 約 10～12 個月 |

| 可選項目 | 人週 |
| --- | --- |
| 繁中 NER + 別名展開 | 2～3 |
| 測試集 v2 | 1～2 |
| RAG | 2～3 |
| 影像 OCR、錄音轉文字 | 2～4 |

最不確定的是**第二階段的遮蔽品質**：召回率要調到 99.9%，需要用實際的模型回覆反覆調整。

### ⚠️ 不在開發者手上、要提早開始的事

| 事項 | 建議時間點 |
| --- | --- |
| 選定 VPS 廠商並簽約（問清楚下方「要問廠商的事」） | 第一階段一開始 |
| 開通 Anthropic API 帳號、設定付款與用量上限 | 第一階段 |
| 向 Anthropic 申請 ZDR（審核時間待確認） | 第一階段 |
| 法務：跨境傳輸的揭露文字、合約條款 | 第一到第二階段 |
| 準備合成測試資料（不使用真實客戶資料） | 第一階段後段 |

### 要問 VPS 廠商的事

| 問題 | 為什麼重要 |
| --- | --- |
| Windows 授權是否含在月費內 | 每月差 NT$500～700 |
| 硬體故障時怎麼處理、多久可以恢復（SLA） | 只有一台機器，這就是服務的可用性 |
| 能不能做整機快照、費用多少 | 更新或升級前可以先拍快照 |
| 流量上限、超量怎麼計費 | 檔案上傳下載會用到流量 |
| 是否有 DDoS 防護 | 不開 Cloudflare 代理時，只能靠廠商 |
| 能不能隨時升級規格（CPU、記憶體、磁碟） | NER、OCR 會需要更多資源 |
| 是否要年繳、有沒有設定費 | 影響第一年的現金流 |
| 機房位置 | 確認在台灣，對外說法才成立 |

---

## 升級路徑

程式碼照套件邊界拆分，日後可以逐項升級，不必一次全換。

| 觸發條件 | 升級項目 |
| --- | --- |
| VPS 資源不夠 | 先升級規格；再把 PostgreSQL 搬到另一台 VPS 或代管資料庫 |
| 需要高可用（付費客戶、SLA） | 主機加到 2 台，前面加負載平衡；PostgreSQL 改成主從複寫或代管資料庫；頻率限流改成共用 |
| 需要強制「唯一出口」 | `Veilway.Gateway` 拆到另一台主機，只有它的防火牆允許連到 Anthropic |
| 遇到攻擊 | 開 Cloudflare 代理（同時更新隱私權政策，揭露 Cloudflare 為處理者） |
| 長任務影響 API | 背景工作搬到另一台處理用的 VPS，佇列留在 PostgreSQL |
| 要開第二個產品 | 依建置清單與安裝腳本建立新環境；或改用雲端並寫成 IaC |

---

## 跨階段持續項目

| 項目 | 第一階段 | 第二階段 | 第三階段 |
| --- | --- | --- | --- |
| 測試集 | — | v1 格式類 + 字典 | 加入文件案例 |
| 稽核 | 登入紀錄 | AI 請求、攔截紀錄 | 檔案存取紀錄 |
| 監控 | 存活監測、磁碟空間 | 遮蔽與攔截統計、模型延遲 | 工作佇列堆積、失敗工作 |
| 成本 | VPS 月費 | 每個租戶的 token 計量與額度；Anthropic 用量上限 | 磁碟用量 |
| 安全檢查 | 跨租戶存取測試、外部埠掃描 | 出口架構測試、日誌抽查 | 檔案權限測試 |
| 維運 | 每日異地備份、**每月還原測試**、憑證續約、Windows Update | API key 定期更換 | 磁碟清理 |

---

## 待定案事項

要採用台灣 VPS 版，以下幾點需要在「Veilway 討論」session 決定：

1. **和原計畫的關係**（**建議選 A**）
   - A. 台灣 VPS 版是**先行版**：先做出能上線的系統，原三階段計畫保留為升級目標。
   - B. 台灣 VPS 版**取代**原計畫。
2. **AWS 簡化版要不要保留**：只留作比較參考，或直接刪除〈Veilway簡化版執行計畫.md〉。
3. **異地備份放哪裡**：
   - 另一家台灣廠商的儲存空間：資料不出台灣。
   - 海外物件儲存（例如 Cloudflare R2）：比較便宜。備份在送出前就加密、金鑰留在台灣，但仍屬於資料出境，要寫進揭露。
4. **Windows + IIS 或 Linux**：選 Windows 每月多約 NT$500～700；團隊熟悉 IIS 就值得。
5. **Cloudflare 只做 DNS 或開代理**：建議只做 DNS（見「為什麼不開 Cloudflare 代理」）。
6. **VPS 廠商**：依「要問廠商的事」比較後決定。

### 定案後要配合修改的文件

| 文件 | 負責 session | 要改的地方 |
| --- | --- | --- |
| `CLAUDE.md` | Veilway 討論 | 已定案決策表中的「區域」「系統元件」「線上模型」「閘道」「對照表（ElastiCache 那句）」「IaC」「建置順序」 |
| `Veilway2.md` | Veilway 討論 | 第 1 節（元件）、第 6 節（出口管控）、第 7 節（模型接入改成 Anthropic API 直連）、第 11 節（產品各自的 AWS 帳號改成各自的 VPS） |
| `Veilway三階段執行計畫.md` | Veilway 討論 | 標明和本文件的關係（升級目標或已被取代） |
| `Veilway簡化版執行計畫.md` | Veilway 討論 | 保留作比較，或刪除 |
| `Veilway架構圖v2.html`／`.pdf` | Veilway 討論 | 加一張台灣 VPS 版架構圖 |
| `Veilway第一階段操作手冊.md` | 第一階段 | 改動最大：AWS、CDK、ECS、Cognito 改成 VPS、IIS、Cloudflare DNS、win-acme、本機 PostgreSQL、Identity、備份與還原 |
| `Veilway第二階段操作手冊.md` | 第二階段 | 閘道改成同程式內的模組 + 架構測試；模型改成 Anthropic API 直連（API key 管理） |
| `Veilway第三階段操作手冊.md` | 第三階段 | S3 改成本機檔案目錄；SQS + Worker 改成 PostgreSQL 工作表 + 背景工作 |
