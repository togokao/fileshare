# Veilway 台灣 VPS 版第一階段執行計畫：骨架

依據〈Veilway台灣VPS版執行計畫.md〉的「第一階段：骨架」展開。架構說明見〈Veilway2.md〉。

> **狀態：討論結果，尚未實作（2026-10-16）。**這份是「VeilwayVPS-第一階段」session 的討論整理。主機依台灣 VPS 版主線採用 **Windows Server + IIS**。標示「**待決定**」的項目確定後再更新本文件。

---

## 前提

- 以台灣 VPS 版為準，不使用 AWS。
- 第一階段估計 **4～5 人週**。
- 不做：AI 功能、檔案上傳、背景工作。
- 原〈Veilway第一階段操作手冊.md〉（AWS 版）中和雲端無關的部分（RLS 的 SQL、EF Core 設定租戶的方式）可以直接沿用。

---

## 一、工作順序

計畫的範圍表有 14 類項目，彼此有先後關係，分成四段進行：

| 段 | 時間 | 內容 | 這段結束時能看到什麼 |
| --- | --- | --- | --- |
| A. 本機骨架 | 第 1～2 週 | `Veilway.sln` 專案結構、本機 PostgreSQL、資料表 + RLS、Identity、租戶核對、限流 | 本機用 `acme.localhost` 能登入，跨租戶測試通過 |
| B. 主機上線 | 第 2～3 週（和 A 並行） | VPS 開通、防火牆、RDP 走 Tailscale、DNS、萬用憑證、IIS、PostgreSQL | `https://acme.veilway.app/health` 從外面打得到 |
| C. 部署與金鑰 | 第 3～4 週 | 部署腳本、主金鑰與租戶資料金鑰、監控 | 一個指令就能把新版發佈上去 |
| D. 備份與驗收 | 第 4～5 週 | 異地備份、到另一台機器還原、建置清單、驗收 | 驗收清單全部打勾 |

**理由**：A 段不用等 VPS 廠商簽約。B 段要等 VPS 開通，開通前可以先在本機或測試用 VM 練習 IIS 設定。

---

## 二、各項目的做法

### 1. VPS 與主機安全

| 項目 | 做法 |
| --- | --- |
| 廠商 | 先問〈Veilway台灣VPS版執行計畫.md〉的「要問 VPS 廠商的事」。最重要的兩項：能不能做整機快照、硬體故障多久恢復 |
| 遠端管理 | 建議直接用 **Tailscale**，不用「限制固定 IP」。在家、外出時 IP 會變，到時候很容易為了方便就把 RDP 打開 |
| 防火牆 | 只開 443、80（80 只用來把 HTTP 轉到 HTTPS） |
| Windows Update | 設在週日凌晨。⚠️ 自動重開機後服務能不能自己恢復，要實際測一次（對應驗收標準「重開 VPS 後，服務自動恢復」） |
| 帳號 | 停用預設的 Administrator，另建管理帳號並使用強密碼 |

### 2. DNS 與憑證

- 憑證要**同時包含 `veilway.app` 和 `*.veilway.app`**：萬用憑證不包含網域本身。
- win-acme 使用的 Cloudflare API token，權限只給 `veilway.app` 這個 zone 的 DNS 編輯權。⚠️ token 外洩的話別人可以改 DNS，要存在 win-acme 的加密設定裡，不能寫在腳本裡。
- 網址規劃（建議）：

| 網址 | 用途 |
| --- | --- |
| `veilway.app` | 平台首頁 |
| `admin.veilway.app` | 平台管理（之後用） |
| `<租戶>.veilway.app` | 租戶 |

租戶子網域要排除保留字：`admin`、`www`、`api` 等。

### 3. IIS

- 一個網站，主機名稱綁 `*.veilway.app`。IIS 10 起支援萬用主機名稱綁定（待確認 VPS 提供的 Windows Server 版本）。
- App Pool 要設下面三件事，少一件背景工作就可能被停掉。背景工作是第三階段才用，但第一階段先設好：
  - `startMode = AlwaysRunning`
  - 閒置逾時設成 0
  - 網站開啟 `preloadEnabled`（要安裝 Application Initialization 功能）
- ⚠️ IIS 預設每 1740 分鐘（29 小時）回收一次 App Pool，要關掉或改到維護時段。

### 4. PostgreSQL

- 只聽 `localhost`，防火牆不開 5432。
- ⚠️ pgvector 在 Windows 上要自己用 Visual Studio 編譯（待確認現在有沒有預先編好的安裝檔）。第一階段用不到 pgvector，**建議延到第三階段**做 RAG 時再裝（待決定 4）。
- 帳號分三個：

| 帳號 | 用途 |
| --- | --- |
| `veilway_owner` | 資料表擁有者，只給 migration 用 |
| `veilway_app` | 業務 API 用；**不是**資料表擁有者，也沒有 `BYPASSRLS` |
| `veilway_platform` | 平台管理（建立租戶）用 |

### 5. 資料表與 RLS

⚠️ **租戶設定的方式**：〈Veilway台灣VPS版執行計畫.md〉寫「EF Core 開連線時執行 `SET app.tenant_id`」，這樣會出事：設定會留在連線上，連線池把連線借給下一個請求時，下一個請求就帶著上一個租戶的身分。

正確做法（沿用原手冊 5.3～5.4）：

- **每個交易開始時**執行 `set_config('app.tenant_id', '<tenant_id>', true)`。第三個參數 `true` 表示只在這個交易內有效。
- 用 EF Core 的 `DbTransactionInterceptor`，在交易開始時執行；所有存取都包在明確的交易裡。
- 判斷式加 `nullif`：`nullif(current_setting('app.tenant_id', true), '')::uuid`，避免交易結束後設定變成空字串時查詢出錯。
- 每張帶 `tenant_id` 的資料表都要 `ENABLE` + `FORCE ROW LEVEL SECURITY`。

| 資料表 | 帶 `tenant_id` + RLS？ |
| --- | --- |
| `plans`、`tenants` | 否（平台層級）。API 只能透過 `resolve_tenant(子網域)` 函式查租戶 |
| `users`、`roles`、`user_roles` | 是 |
| `sessions`（登入票證） | 是 |
| `audit_logins`（登入紀錄，跨階段持續項目要求） | 是 |

### 6. 身分與 Session

請求進來時的處理順序：

```
子網域 → resolve_tenant() 找出租戶 → 設定目前租戶
  → Cookie 驗證（ITicketStore 讀 sessions 表，這時 RLS 已經有租戶）
  → 核對：Cookie 裡的 tenant_id = 子網域的租戶，不一致就拒絕
```

- ⚠️ Cookie 名稱用 **`__Host-`** 開頭，瀏覽器會強制這種 Cookie 不能設 `Domain`、必須是 `Secure`、`Path=/`。這樣「Cookie 不跨租戶」由瀏覽器保證，不是靠開發者記得不要設。
- 登出時刪除 `sessions` 中的紀錄，舊 Cookie 立即失效。
- `ITicketStore` 讀寫 `sessions` 時一樣要包在交易裡，才會套用 RLS。
- Email 唯一範圍：建議**每個租戶內唯一**（唯一鍵用 `tenant_id + email`），比較不會洩漏「這個 Email 在別的租戶有帳號」（待決定 2）。
- 忘記密碼：要寄信，但計畫的對外連線清單沒有寄信服務。建議第一階段**先不寄信**，由租戶管理員重設密碼（待決定 3）。
- MFA：Identity 內建 TOTP，第一階段要不要做（待決定 7）。

### 7. 租戶管理

- 租戶建立與子網域對應；方案與額度的資料結構先建好，計量在第二階段接上。
- 第一階段建議**先用命令列工具**建立租戶（用 `veilway_platform` 帳號），平台管理頁面之後再做。

### 8. 限流

都用 ASP.NET Core 內建的 RateLimiter，分三層：

| 對象 | 依據 | 用途 |
| --- | --- | --- |
| 登入端點 | IP | 防暴力破解；再加上 Identity 的帳號鎖定 |
| 已登入的請求 | 使用者 | 單一使用者不能打爆 API |
| 已登入的請求 | 租戶 | 單一租戶不能拖垮整台機器 |

超過門檻回 429。

### 9. 加密金鑰

⚠️ **DPAPI 綁定原本那台機器，換一台機器就解不開。**驗收標準要求「從異地備份還原到另一台機器」，一定會碰到這個問題。要處理的金鑰有兩組：

| 金鑰 | 用途 | 做法 |
| --- | --- | --- |
| 主金鑰 | 加密每個租戶的資料金鑰 | DPAPI 保護 + **離線備份**（例如密碼管理器加上紙本）。還原時用離線備份在新機器上重新以 DPAPI 保護 |
| ASP.NET Core Data Protection 金鑰 | 加密登入 Cookie | 存進 PostgreSQL，用主金鑰保護（不用預設的 DPAPI）。還原後使用者不必重新登入 |

第一階段還沒有要加密的業務資料，租戶資料金鑰**先把機制做好並測試**即可。

### 10. 備份

- 工具建議用 **restic**：內建加密、增量備份、支援多種目的地，Windows 上也能跑。
- 每天的流程：`pg_dump` → restic 備份（dump 檔 + 檔案目錄）→ 送到異地。
- 以下三樣要**分開**、**離線**保管：
  - restic 密碼
  - 主金鑰
  - `veilway_owner` 密碼
- 每天備份一次，最多會遺失 24 小時的資料（待決定 8）。
- 還原演練要用「另一台機器」（待決定 6）。

### 11. 部署

流程：

1. `dotnet publish`
2. 放入 `app_offline.htm`（IIS 會暫停網站）
3. 複製檔案
4. 執行 migration（EF Core migration bundle，用 `veilway_owner`）
5. 移除 `app_offline.htm`

會有幾秒停機，台灣 VPS 版計畫已接受。先手動執行腳本，之後再接 GitHub Actions。

### 12. 監控

- `/health` 要檢查資料庫連得上，不能只回 200。
- 外部監測先用免費服務；Uptime Kuma 要另一台機器，之後再說。
- 磁碟空間告警。
- 告警送到哪裡，計畫沒有寫（待決定 5）。

### 13. 建置清單

- 每完成一項主機設定，就寫一段 PowerShell，最後合成一份安裝腳本。
- 這份腳本在還原演練時就能一起測到：用它在另一台機器上把環境建起來。

---

## 三、驗收標準

〈Veilway台灣VPS版執行計畫.md〉的驗收標準，加上本次討論補充的項目（標「補」）。

- [ ] 使用者能從租戶子網域登入，前台呼叫 API 成功；用 A 租戶的帳號登入 B 租戶的子網域會被拒絕
- [ ] API 依登入者的租戶讀寫資料；A 租戶**讀不到** B 租戶的資料（有自動化測試，包含直接用應用程式帳號下 SQL）
- [ ] （補）**同一條連線**先處理 A 租戶的請求、再處理 B 租戶的請求，B 看不到 A 的資料（驗證連線池不會外洩租戶設定）
- [ ] （補）CI 檢查：有 `tenant_id` 欄位、但沒有開啟 `ENABLE` 和 `FORCE ROW LEVEL SECURITY` 的資料表，測試就失敗
- [ ] 從外部掃描，只有 443 和 80 開放；PostgreSQL 和 RDP 從公網連不到
- [ ] 登出後，舊 Cookie 立即失效；超過限流門檻的請求回 429
- [ ] 重開 VPS 後，服務自動恢復
- [ ] **從異地備份還原到另一台機器，資料完整、能登入**
- [ ] （補）還原時使用離線備份的主金鑰；還原後舊的登入 Cookie 仍然有效
- [ ] 萬用憑證能自動續約（用 win-acme 的測試模式驗證）
- [ ] （補）抽查日誌，找不到密碼、Cookie、連線字串

---

## 四、待決定事項

| # | 事項 | 建議 |
| --- | --- | --- |
| 1 | VPS 廠商 | 第一段先在本機開發，同時去問廠商 |
| 2 | Email 唯一範圍 | 每個租戶內唯一 |
| 3 | 忘記密碼 | 第一階段先由租戶管理員重設，不接寄信服務 |
| 4 | pgvector | 延到第三階段再裝 |
| 5 | 告警送到哪裡 | Email、LINE、Telegram 等擇一 |
| 6 | 還原演練用的機器 | 臨時租一台 VPS，或本機 VM |
| 7 | MFA（TOTP） | 第一階段要不要做 |
| 8 | 備份頻率 | 每天一次（最多遺失 24 小時資料）是否可以接受 |

---

## 對架構的回饋

以下要改的地方在〈Veilway台灣VPS版執行計畫.md〉或 `CLAUDE.md`，由「Veilway 討論」session 處理：

| # | 文件 | 要改什麼 | 為什麼 |
| --- | --- | --- | --- |
| 1 | 〈Veilway台灣VPS版執行計畫.md〉「不簡化的規則」第一列 | 「EF Core 開連線時執行 `SET app.tenant_id`」改成「每個交易開始時執行 `set_config('app.tenant_id', …, true)`，判斷式加 `nullif`」 | `SET` 會讓租戶設定留在連線上，連線池重用時會外洩到下一個請求 |
| 2 | 〈Veilway台灣VPS版執行計畫.md〉「元件」表的「加密金鑰」 | 補上：DPAPI 綁定機器，還原到另一台機器時要用離線備份的主金鑰重新保護；Data Protection 金鑰存 PostgreSQL、以主金鑰保護 | 否則「還原到另一台機器」的驗收標準做不到 |
| 3 | 〈Veilway台灣VPS版執行計畫.md〉「元件」表的「憑證」 | 寫明憑證同時包含 `veilway.app` 和 `*.veilway.app` | 萬用憑證不包含網域本身 |
| 4 | 〈Veilway台灣VPS版執行計畫.md〉「元件」表的「資料庫」 | pgvector 在 Windows 上要自己編譯，安裝延到第三階段 | 第一階段用不到，減少不確定的工作 |
| 5 | 〈Veilway台灣VPS版執行計畫.md〉「網路與主機安全」的「對外連線」 | 補上寄信服務（如果決定要寄信）與告警通知管道 | 目前清單沒有列出 |
| 6 | `CLAUDE.md` 的 session 分工表 | 加上「VeilwayVPS-第一階段」session，負責本文件 | 目前分工表沒有這個 session |
