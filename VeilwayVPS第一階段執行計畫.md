# Veilway 台灣 VPS 版第一階段執行計畫：骨架

依據〈Veilway台灣VPS版執行計畫.md〉的「第一階段：骨架」展開。架構說明見〈Veilway2.md〉。

> **狀態：討論結果，尚未實作（2026-10-16 更新）。**這份是「VeilwayVPS-第一階段」session 的討論整理。主機依台灣 VPS 版主線採用 **Windows Server + IIS**。已決定的事項見「已決定事項」；標示「**待決定**」的項目確定後再更新本文件。

---

## 前提

- 以台灣 VPS 版為準，不使用 AWS。
- 第一階段估計 **4～5 人週**。
- 不做：AI 功能、檔案上傳、背景工作。
- 原〈Veilway第一階段操作手冊.md〉（AWS 版）中和雲端無關的部分（RLS 的 SQL、EF Core 設定租戶的方式）可以直接沿用。

### 已決定事項

| 主題 | 決定 | 說明 |
| --- | --- | --- |
| 主機 | Windows Server + IIS | 台灣 VPS 版主線 |
| 前台框架 | **Vue 網頁版 → PWA 在 iPad 上試用 → 需要上架或推播時用 Capacitor 打包** | 見第三節 A8 |
| 角色 | **固定角色**（`tenant_admin`、`member`） | `roles` 是平台層級，不帶 `tenant_id`；`user_roles` 帶 `tenant_id` + RLS。見第二節第 5 項 |
| 開發機作業系統 | **Windows** | 開發機上也能試 IIS |
| PostgreSQL | **18** | 本機、CI、VPS 都用同一個大版本。Windows 上的安裝與 pgvector 見第四節 |
| 範例業務功能 | **業務員 AI 工作台**（依使用者提供的原型 `index.html`） | 第一階段只做客戶管理、今日、展示模式、業務員帳號管理。見第三節 A8 |

---

## 一、工作順序

計畫的範圍表有 14 類項目，彼此有先後關係，分成四段進行：

| 段 | 時間 | 內容 | 這段結束時能看到什麼 |
| --- | --- | --- | --- |
| A. 本機骨架 | 第 1～2 週 | `Veilway.sln` 專案結構、本機 PostgreSQL 18、資料表 + RLS、Identity、租戶核對、限流、Vue 前台與範例（詳見第三節） | 本機用 `acme.dev.localhost` 能登入範例，跨租戶測試通過 |
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

- 版本 **PostgreSQL 18**；安裝步驟見第四節。
- 只聽 `localhost`，防火牆不開 5432。
- ⚠️ pgvector 官方沒有 Windows 安裝檔，要自己用 Visual Studio 的 C++ 工具編譯（見第四節）。第一階段用不到 pgvector，**建議延到第三階段**做 RAG 時再安裝到 VPS（待決定 4），但第一階段先在測試機上編譯驗證一次。
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
| `roles` | 否（平台層級）。固定角色，所有租戶共用同一份清單 |
| `users`、`user_roles` | 是 |
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

## 三、A 段：本機骨架

**目標**：第 1～2 週結束時，在 Windows 開發機上用 `https://acme.dev.localhost` 能登入「業務員 AI 工作台」範例，跨租戶測試通過。這一段完全不需要 VPS。

### 開發環境

| 項目 | 選擇 | 說明 |
| --- | --- | --- |
| 作業系統 | Windows 11 | 已決定 |
| .NET | **.NET 10（LTS）** | VPS 上的 Hosting Bundle 也裝同一版 |
| IDE | Visual Studio 2026 或 Rider | Visual Studio 的「使用 C++ 的桌面開發」也可以拿來編譯 pgvector（見第四節） |
| PostgreSQL | **18**：日常開發與測試用 Docker，Windows 原生安裝只用來演練 VPS 的安裝步驟 | 見第四節 |
| Docker | Docker Desktop（WSL 2） | 本機 PostgreSQL 與整合測試（Testcontainers）都要用 |
| Node.js | LTS 版 | 建置 Vue 前台 |
| 程式碼 repo | `togokao/veilway`（新開） | 依 `CLAUDE.md`，程式碼不放在本文件 repo |

### 本機的租戶子網域

- 瀏覽器會把 `*.localhost` 直接解析到本機，**不用改 hosts 檔**。
- ⚠️ `__Host-` 開頭的 Cookie 一定要走 HTTPS，所以本機也要有 HTTPS。
- .NET 10 的開發憑證已包含 `*.dev.localhost`，所以本機租戶網址用 `acme.dev.localhost`、`beta.dev.localhost`。執行 `dotnet dev-certs https --trust` 信任憑證即可（[dotnet dev-certs](https://learn.microsoft.com/dotnet/core/tools/dotnet-dev-certs)、[localhost TLD](https://learn.microsoft.com/aspnet/core/test/localhost-tld)）。
- 只有 Windows 上的 Edge、Chrome、Firefox 要用到這組網址；macOS 的 Safari 不支援，但我們的開發機是 Windows，不受影響。

### 方案結構

```
veilway/
├─ src/
│  ├─ Veilway.MultiTenancy/      🧩 租戶解析、租戶 context、RLS 攔截器、Identity 擴充、Session 票證存放
│  ├─ Veilway.Gateway/           🧩 空殼（第二階段）
│  ├─ Veilway.Files/             🧩 空殼（第三階段）
│  ├─ Veilway.Sample.Api/        範例產品（業務員 AI 工作台）：API、DbContext、migrations；wwwroot 放前台建置結果
│  ├─ Veilway.Sample.Web/        範例產品的 Vue 前台原始碼（Vite）
│  └─ Veilway.Platform.Cli/      平台工具：建立租戶、建立第一位管理員
├─ tests/
│  ├─ Veilway.MultiTenancy.Tests/   單元測試
│  ├─ Veilway.IntegrationTests/     Testcontainers 起 PostgreSQL 18，跑跨租戶測試
│  └─ Veilway.ArchitectureTests/    NetArchTest：專案相依規則
├─ db/                           建立資料庫帳號的 SQL（不歸 migration 管）
├─ docker-compose.yml            本機 PostgreSQL 18
└─ .github/workflows/ci.yml      建置 + 全部測試
```

#### 專案相依規則（由架構測試檢查）

| 規則 | 為什麼 |
| --- | --- |
| `Veilway.MultiTenancy` 不引用任何範例產品的專案 | 🧩 底座不寫產品專屬邏輯 |
| 只有 `Veilway.Gateway` 能引用 Anthropic SDK | 第二階段的出口紀律，第一階段先把測試寫好 |
| 範例產品不能直接用 `NpgsqlConnection` 繞過 DbContext | 繞過的話，交易攔截器就不會設定租戶 |

#### DbContext 放哪裡

- 🧩 `Veilway.MultiTenancy` 提供基底類別 `VeilwayDbContextBase`，裡面有 Identity、租戶、方案、角色、Session 的資料表。
- 範例產品的 DbContext 繼承它，**migrations 放在產品專案**。
- 🧩 底座提供 migration 輔助方法，例如 `migrationBuilder.EnableTenantRls("clients")`，一次產生 `ENABLE`、`FORCE` 和政策，產品開新資料表時不會漏掉。

### 建立順序（最不確定的先做）

#### A1. 環境與 repo（半天）

- **目的**：把開發環境和 CI 先跑起來。
- **操作**：建 repo、方案和空專案；用 `docker-compose` 起 PostgreSQL 18；CI 先跑「建置 + 空測試」。CI 的 PostgreSQL 用 `pgvector/pgvector:pg18` 映像檔（之後要 pgvector 不必換）。
- **驗證**：push 之後 CI 是綠的。

#### A2. RLS 試做 ⚠️ 最先做（1～2 天）

- **目的**：先證明「交易開始時 `set_config` + RLS」在 EF Core 和 Npgsql 的連線池下不會外洩。這是整個平台隔離的基礎，有問題要最早發現。
- **操作**：
  - 一張測試表，加上三個帳號（`veilway_owner`、`veilway_app`、`veilway_platform`）。
  - 寫 `DbTransactionInterceptor`，交易開始時執行 `set_config('app.tenant_id', …, true)`。
  - 寫 `DbCommandInterceptor`：對帶 `tenant_id` 的資料表下指令時，如果不在交易內就丟例外。
- **驗證**（整合測試）：
  - 沒有設定租戶時，查到 0 筆。
  - 設定 A 之後只看得到 A 的資料；寫入 B 的資料會被拒絕。
  - **把連線池的最大連線數設成 1**，先跑 A 的請求、再跑 B 的請求，B 看不到 A 的資料。
  - 交易結束後，同一條連線再查詢不會出錯（驗證 `nullif`）。

#### A3. 正式的資料表與 migration（1～2 天）

- **目的**：建立第一階段所有資料表。
- **操作**：
  - `db/` 的 SQL 建立三個帳號（只在建環境時執行一次）。
  - migration 用 `veilway_owner` 執行，建立底座的資料表（`plans`、`tenants`、`roles`、Identity 的資料表、`user_roles`、`sessions`、`audit_logins`）、`resolve_tenant()` 函式，以及範例產品的資料表（見 A8）。
  - `roles` 用 seed 資料寫入兩個固定角色：`tenant_admin`（保經公司管理者）、`member`（一般業務）。
  - migration 結束時把權限授予 `veilway_app`。
- **Identity 要改的地方**：
  - 使用者表加 `tenant_id`。
  - 唯一索引從 `NormalizedEmail` 改成 `(tenant_id, NormalizedEmail)`，`NormalizedUserName` 也一樣（待決定 2 的建議做法）。
- **驗證**：CI 檢查「有 `tenant_id` 欄位但沒開 RLS 的資料表」。

#### A4. 租戶解析 middleware（1 天）

- **目的**：每個請求都知道自己屬於哪個租戶。
- **操作**：從 Host 取出子網域，呼叫 `resolve_tenant()`，結果放進 `ITenantContext`。
  - 找不到租戶，或租戶狀態是 `suspended`：回 404。
  - 保留字（`admin`、`www`、`api`）不當租戶。
  - 這個 middleware 要放在 `UseAuthentication()` **之前**。
- **驗證**：`acme.dev.localhost` 解析成 acme；`nobody.dev.localhost` 回 404。

#### A5. Identity、Session、Cookie（3～4 天，最花時間）

- **目的**：完成登入、登出，並保證 Session 不跨租戶。
- **操作**：
  - Cookie 登入；Cookie 名稱 `__Host-veilway`，`HttpOnly`、`Secure`、`SameSite=Lax`，**不設 Domain**。
  - `ITicketStore` 實作存進 `sessions` 表，Cookie 裡只放 Session ID。
  - 每次驗證時核對票證的 `tenant_id` 等於 `ITenantContext`，不一致就登出並回 401。
  - 登入、登出、登入失敗都寫進 `audit_logins`。
  - Identity 帳號鎖定，例如連續錯 5 次鎖 15 分鐘。
  - Data Protection 金鑰先存 PostgreSQL；用主金鑰保護的部分等 C 段再接。
- **驗證**：
  - A 的帳號在 `beta.dev.localhost` 登入被拒絕。
  - 登出後，用舊 Cookie 呼叫 API 回 401。
  - 把 A 子網域的 Cookie 手動貼到 B 子網域，回 401。
- **注意事項**：⚠️ Cookie 登入的 SPA 要防跨站請求偽造（CSRF）。用 `SameSite=Lax`，加上 ASP.NET Core 的 antiforgery token：前台在每個寫入請求帶 header，API 統一驗證。

#### A6. 平台工具 CLI（1 天）

- **目的**：不用寫管理頁面就能開租戶。
- **操作**：`veilway-cli tenant create --subdomain acme --name 示範保經 --plan basic --admin-email ...`，用 `veilway_platform` 帳號連線。
- **驗證**：建立後馬上能用該管理員帳號登入；子網域格式錯誤或用到保留字時會被拒絕。

#### A7. 限流（半天）

- **目的**：防暴力破解，避免單一使用者或租戶拖垮主機。
- **操作**：三個政策，分別依 IP（登入端點）、依使用者、依租戶，超過門檻回 429。
- **驗證**：整合測試連打登入端點，第 N+1 次回 429。

#### A8. 前台與範例業務功能（3～4 天）

##### 前台路線

| 階段 | 做法 | 什麼時候 |
| --- | --- | --- |
| 1. Vue 網頁版 | Vue 3 + Vite + TypeScript；建置結果放進 `Veilway.Sample.Api/wwwroot`，和 API 同一個網址 | A 段 |
| 2. PWA 在 iPad 上試用 | 加上 web app manifest 和 service worker（例如 vite-plugin-pwa），從 Safari「加入主畫面」 | B 段之後：iPad 要連到有正式憑證的 `acme.veilway.app` 才能安裝 PWA，連不到開發機的 `acme.dev.localhost` |
| 3. Capacitor 打包 | 需要上架 App Store 或推播時再做 | 之後 |

- 開發時，Vite 開發伺服器把 `/api` 轉給 ASP.NET Core。⚠️ 轉送時要**保留原本的 Host**（不要開 `changeOrigin`），否則後端看不到子網域、解析不出租戶。
- ⚠️ **PWA 的 service worker 只能快取前台靜態檔，不能快取 `/api` 的回應**。API 回應裡有客戶的真名和保單資料，快取下來就會留在 iPad 上。
- iPadOS 16.4 起，**加入主畫面的 PWA 也能收網頁推播**（[OneSignal：iOS 網頁推播](https://documentation.onesignal.com/docs/web-push-for-ios)）。所以「需要推播」不一定要用 Capacitor，到時候先試 PWA 推播。
- Capacitor 打包後，App 的網址不再是租戶子網域，Cookie 登入和租戶解析的方式要重新設計（待確認），**這部分留到要打包時再討論**。

##### 範例：業務員 AI 工作台

範例依使用者提供的原型 `index.html`（業務員 AI 工作台，資料皆為虛構）。原型有兩個角色、八個畫面，第一階段只做**不需要 AI、不需要上傳檔案**的部分，用來示範底座：

| 原型的畫面 | 角色 | 第一階段 | 原因 |
| --- | --- | --- | --- |
| App 外框（左側導覽，窄螢幕改底部導覽） | 兩者 | ✅ 做 | 導覽項目依**登入者的角色**決定，不再用下拉選單切換角色 |
| 今日 | 一般業務 | ✅ 簡化版 | 只顯示近期生日、待辦（下一步），來自客戶資料 |
| 客戶（列表、搜尋、詳細、往來紀錄、備註） | 一般業務 | ✅ 做 | **主要的範例業務表**：示範帶 RLS 的資料表從頭到尾怎麼做 |
| 客戶展示模式 | 一般業務 | ✅ 做 | 見下方注意事項 |
| 業務員與用量 | 保經公司管理者 | ✅ 部分 | 做業務員帳號的新增、停用、重設密碼；「AI 用量」欄位等第二階段計量接上 |
| 新聞彙整 | 一般業務 | ❌ 第二階段之後 | 要 AI 摘要與媒合客戶 |
| 需求與媒合 | 一般業務 | ❌ 第二階段之後 | 要 AI |
| 建議書簡化 | 一般業務 | ❌ 第三階段 | 要上傳檔案、抽文字、AI |
| 商品庫、合作保險公司 | 保經公司管理者 | ❌ 之後 | 不是示範底座所必需 |

角色對應：

| 原型的角色 | 固定角色 |
| --- | --- |
| 一般業務 | `member` |
| 保經公司管理者 | `tenant_admin` |

範例的資料表（都帶 `tenant_id` + RLS）：

| 資料表 | 內容 |
| --- | --- |
| `clients` | 客戶基本資料（姓名、年齡、職業、家庭、標籤、生日、下一步）、負責業務 `owner_user_id` |
| `client_policies` | 客戶已有的保單（保險公司、商品、保費、狀態） |
| `client_logs` | 往來紀錄（日期、內容） |

注意事項：

- ⚠️ **同租戶內的權限**：RLS 只負責「租戶之間」的隔離。一般業務只能看自己負責的客戶，這一層由 API 依 `owner_user_id` 篩選（待決定 9），並加整合測試：同租戶的業務 A 拿不到業務 B 的客戶。
- ⚠️ **展示模式要由 API 遮掉敏感欄位**：原型只用 CSS 把佣金、內部備註、其他客戶資料藏起來，資料其實已經在畫面上。正式做法是前台切到展示模式時，改呼叫回傳「客戶版」欄位的 API，佣金與內部備註根本不送到 iPad。
- ⚠️ **字型改成自己架**：原型從 Google Fonts 載入字型，使用者每次開啟都會連到 Google。正式版把 Noto Sans TC 等字型檔放在 wwwroot，不連第三方，也比較好設定 Content-Security-Policy。
- 客戶資料是真的個資，第二階段送給 AI 前都要經過隱道遮蔽；第一階段只用虛構資料測試。
- 原型的視覺（顏色、深色模式、iPad 橫向版面）直接沿用，改寫成 Vue 元件。

##### `/health`

`/health` 要檢查資料庫連得上，不能只回 200。

- **驗證**：
  - A、B 兩個租戶各建幾位客戶，互相看不到。
  - 一般業務登入後只看到「今日」「客戶」；管理者登入後只看到「業務員與用量」。
  - 一般業務直接呼叫管理者的 API 回 403。
  - 展示模式下，API 回應裡找不到佣金和內部備註。

#### A9. 補齊測試與 CI（1 天）

把第一階段驗收標準中和程式有關的條目寫成整合測試：跨租戶存取、連線池不外洩、同租戶內業務看不到彼此的客戶、登出後舊 Cookie 失效、429、資料表都有 RLS。

合計約 **11～15 個工作天**，範例功能比原本估的多，A 段可能會比 2 週多幾天。

---

## 四、PostgreSQL 18 在 Windows

### 1. 查到的事實

| 項目 | 結果 | 來源 |
| --- | --- | --- |
| pgvector 最新版本 | v0.8.7 | [pgvector 官方 GitHub](https://github.com/pgvector/pgvector) |
| pgvector 支援的 PostgreSQL 版本 | 13 以上；官方 Docker 映像檔涵蓋 13～18 | 同上 |
| pgvector 的 Windows 安裝方式 | 用 Visual Studio 的 C++ 工具，以 `nmake` 編譯。**官方的 Windows 範例就是用 PostgreSQL 18** | 同上 |
| pgvector 官方的 Windows 安裝檔 | **沒有** | 同上 |
| 社群編好的 Windows 版 | 有人在 GitHub 提供 PostgreSQL 13～18 的版本。**不建議使用**：沒辦法確認是誰編的、有沒有被動手腳 | [andreiramani/pgvector_pgsql_windows](https://github.com/andreiramani/pgvector_pgsql_windows/releases) |
| PostgreSQL 安裝程式的 StackBuilder 有沒有 pgvector | **待確認**（第 3 項演練時順便看） | — |
| PostgreSQL 安裝程式能不能用命令列無人值守安裝 | 可以：`--mode unattended`，搭配 `--superpassword`、`--servicename` 等參數 | [EDB：安裝程式命令列參數](https://www.enterprisedb.com/docs/supported-open-source/postgresql/installing/command_line_parameters/) |

### 2. 各環境怎麼裝

| 環境 | 安裝方式 | 理由 |
| --- | --- | --- |
| 開發機（日常開發） | Docker：`pgvector/pgvector:pg18` | 隨時能砍掉重來；已含 pgvector |
| CI 與整合測試 | Testcontainers，同一個映像檔 | 和開發機一致 |
| VPS（正式） | PostgreSQL 官方 Windows 安裝程式（EDB 提供），Windows 服務 | 台灣 VPS 版主線 |
| 測試機（演練 VPS 的安裝） | 同 VPS；可以直接用開發機，或開一台 Windows Server VM | 先把 VPS 的安裝步驟練過一次，寫進建置清單 |

### 3. 在 Windows 上安裝 PostgreSQL 18（演練 VPS 的步驟）

**目的**：把 VPS 上的安裝步驟先在測試機上走一次，確認可行並寫成腳本。

**操作**：

1. 從 PostgreSQL 官網的 Windows 下載頁取得 PostgreSQL 18 安裝程式（EDB 提供）。
2. 安裝（可以用命令列無人值守安裝，寫進安裝腳本）：
   - 資料目錄放在系統碟以外，例如 `D:\pgdata`（要看 VPS 有沒有第二顆磁碟）。
   - 超級使用者 `postgres` 用強密碼，**離線保管**；應用程式和 migration 都不用它。
   - 安裝時看一下 StackBuilder 的清單裡有沒有 pgvector（解決上表的待確認）。
3. 設定 `postgresql.conf`：
   ```
   listen_addresses = 'localhost'
   password_encryption = scram-sha-256
   ```
4. 設定 `pg_hba.conf`，只允許本機、只用 `scram-sha-256`：
   ```
   # TYPE  DATABASE  USER  ADDRESS        METHOD
   host    all       all   127.0.0.1/32   scram-sha-256
   host    all       all   ::1/128        scram-sha-256
   ```
5. 確認 Windows 服務設成「自動」啟動。
6. 執行 `db/` 的 SQL，建立 `veilway` 資料庫與三個帳號。

**驗證**：

- [ ] `netstat -ano | findstr 5432` 只看到 `127.0.0.1` 和 `[::1]`，沒有 `0.0.0.0`
- [ ] 重開機後 PostgreSQL 自動啟動
- [ ] 用 `veilway_app` 能連線；用錯密碼會被拒絕

### 4. 在 Windows 上編譯 pgvector（第一階段演練一次，第三階段才裝到 VPS）

**目的**：確認 PostgreSQL 18 + pgvector 在 Windows 上可行，並留下可以直接複製到 VPS 的檔案。

**操作**：

1. 在測試機（**不是 VPS**）安裝 Visual Studio Build Tools，只勾「使用 C++ 的桌面開發」。開發機已有 Visual Studio 的話，補勾這個工作負載即可。
2. 以系統管理員身分開啟「x64 Native Tools Command Prompt for VS」，執行（[pgvector 官方說明](https://github.com/pgvector/pgvector)）：
   ```
   set "PGROOT=C:\Program Files\PostgreSQL\18"
   cd %TEMP%
   git clone --branch v0.8.7 https://github.com/pgvector/pgvector.git
   cd pgvector
   nmake /F Makefile.win
   nmake /F Makefile.win install
   ```
3. 在 `veilway` 資料庫裡以 `veilway_owner` 或超級使用者執行：
   ```sql
   CREATE EXTENSION vector;
   SELECT extversion FROM pg_extension WHERE extname = 'vector';   -- 應該是 0.8.7
   SELECT '[1,2,3]'::vector <-> '[4,5,6]'::vector;               -- 能算出距離
   ```
4. 把產生的檔案收進建置清單（附上版本與 SHA-256）：
   - `C:\Program Files\PostgreSQL\18\lib\vector.dll`
   - `C:\Program Files\PostgreSQL\18\share\extension\vector.control`
   - `C:\Program Files\PostgreSQL\18\share\extension\vector--*.sql`

**驗證**：

- [ ] 第 3 步的查詢成功
- [ ] 把第 4 步的檔案複製到另一台只裝了 PostgreSQL 18 的機器，`CREATE EXTENSION vector;` 也成功（模擬 VPS 不裝編譯工具的做法）

**注意事項**：

- 正式主機**不裝** Visual Studio 這類開發工具；在測試機編好，複製檔案到 VPS 的相同目錄。
- ⚠️ 每次升級 PostgreSQL 的**大版本**（例如 18 升 19），pgvector 都要用新版重新編譯。這要寫進建置清單的「升級注意事項」。

### 5. 應用程式怎麼連 PostgreSQL 18

| 項目 | 做法 |
| --- | --- |
| NuGet 套件 | `Npgsql.EntityFrameworkCore.PostgreSQL`（主版本和 EF Core 10 對應）；第三階段要用 pgvector 時再加 `Pgvector.EntityFrameworkCore` |
| 連線字串 | 分兩條：API 用 `veilway_app`，migration 用 `veilway_owner`；平台工具 CLI 用 `veilway_platform` |
| 範例 | `Host=localhost;Port=5432;Database=veilway;Username=veilway_app;Password=…` |
| 開發機存放 | `dotnet user-secrets`，不寫進 `appsettings.json`、不進 Git |
| VPS 存放 | C 段和金鑰一起決定（用主金鑰加密的設定檔，或 IIS 應用程式的環境變數） |
| 連線池 | Npgsql 預設開啟。租戶設定一律用交易範圍的 `set_config(..., true)`（見第二節第 5 項） |

---

## 五、驗收標準

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
- [ ] （補）範例：同租戶內，一般業務拿不到其他業務的客戶；展示模式的 API 回應裡沒有佣金與內部備註

---

## 六、待決定事項

| # | 事項 | 建議 |
| --- | --- | --- |
| 1 | VPS 廠商 | 第一段先在本機開發，同時去問廠商 |
| 2 | Email 唯一範圍 | 每個租戶內唯一 |
| 3 | 忘記密碼 | 第一階段先由租戶管理員重設，不接寄信服務 |
| 4 | pgvector 何時裝到 VPS | 第一階段在測試機編譯驗證一次，第三階段再裝到 VPS（PostgreSQL 版本已決定為 18） |
| 5 | 告警送到哪裡 | Email、LINE、Telegram 等擇一 |
| 6 | 還原演練用的機器 | 臨時租一台 VPS，或本機 VM |
| 7 | MFA（TOTP） | 第一階段要不要做 |
| 8 | 備份頻率 | 每天一次（最多遺失 24 小時資料）是否可以接受 |
| 9 | 同租戶內，一般業務能不能看到其他業務的客戶 | 只看得到自己負責的客戶（由 API 依 `owner_user_id` 篩選），管理者看得到全部 |

---

## 對架構的回饋

以下要改的地方在〈Veilway台灣VPS版執行計畫.md〉或 `CLAUDE.md`，由「Veilway 討論」session 處理：

| # | 文件 | 要改什麼 | 為什麼 |
| --- | --- | --- | --- |
| 1 | 〈Veilway台灣VPS版執行計畫.md〉「不簡化的規則」第一列 | 「EF Core 開連線時執行 `SET app.tenant_id`」改成「每個交易開始時執行 `set_config('app.tenant_id', …, true)`，判斷式加 `nullif`」 | `SET` 會讓租戶設定留在連線上，連線池重用時會外洩到下一個請求 |
| 2 | 〈Veilway台灣VPS版執行計畫.md〉「元件」表的「加密金鑰」 | 補上：DPAPI 綁定機器，還原到另一台機器時要用離線備份的主金鑰重新保護；Data Protection 金鑰存 PostgreSQL、以主金鑰保護 | 否則「還原到另一台機器」的驗收標準做不到 |
| 3 | 〈Veilway台灣VPS版執行計畫.md〉「元件」表的「憑證」 | 寫明憑證同時包含 `veilway.app` 和 `*.veilway.app` | 萬用憑證不包含網域本身 |
| 4 | 〈Veilway台灣VPS版執行計畫.md〉「元件」表的「資料庫」 | 寫明 PostgreSQL 18；pgvector 官方沒有 Windows 安裝檔，要自己編譯，安裝到 VPS 延到第三階段 | 第一階段用不到，減少不確定的工作 |
| 5 | 〈Veilway台灣VPS版執行計畫.md〉「網路與主機安全」的「對外連線」 | 補上寄信服務（如果決定要寄信）與告警通知管道 | 目前清單沒有列出 |
| 6 | `CLAUDE.md` 的 session 分工表 | 加上「VeilwayVPS-第一階段」session，負責本文件 | 目前分工表沒有這個 session |
