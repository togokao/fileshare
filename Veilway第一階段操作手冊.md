# Veilway 第一階段操作手冊：骨架

對應〈Veilway三階段執行計畫.md〉的第一階段。架構以〈Veilway2.md〉和〈Veilway架構圖v2.pdf〉為準。

**第一階段完成時能做到**：使用者從租戶子網域登入，前台呼叫 API，API 依租戶讀寫資料；整個環境可以用 IaC 重建。

**別忘了 Veilway 是產品底座**（見 Veilway2.md 第 11 節）：這一階段做出來的程式和 IaC，之後要讓保險業務員 AI、中原大學產學脈動平台等產品**重複套用**。所以除了「做得出來」，還要做到「換個產品名稱和網域就能再建一套」。和底座有關的要求標示為 🧩。

---

## 怎麼使用這份手冊

- 步驟依**相依順序**排列，請照順序做。每一步都有「目的 → 操作 → 驗證 → 注意事項」。
- **建議做法**：先在 dev 環境用主控台照手冊做一遍，弄懂每個設定的作用；接著在第 14 步把同樣的設定寫成 IaC，再用 IaC 建出 staging。之後一律只改 IaC，不再手動點主控台。
- 主控台路徑寫成「服務 → 頁面 → 按鈕」。
- 本手冊中的 `example.com` 請換成你們的網域，`<…>` 是要自行填入的值。
- 🧩 **命名規則**：手冊中以 `veilway` 開頭的名稱（例如 `veilway-dev`、`veilway-data`、`veilway_app`）都是「**產品代號**」加上用途。底座本身的代號是 `veilway`；之後的產品換成自己的代號，例如 `insai-dev`、`insai_app`。在 IaC 中，產品代號一律是參數，不要寫死。
- 標示 ⚠️ 的是容易出錯、事後很難改的地方。

### 名詞速查

| 名詞 | 白話說明 |
| --- | --- |
| VPC | 你在 AWS 上的私有網路 |
| 子網（Subnet） | VPC 裡的分區。公有子網可直接連外網，私有子網不行 |
| 可用區（AZ） | 同一區域內彼此獨立的機房。服務分散在多個 AZ，一個機房出事也不會停 |
| Security Group（SG） | 每個資源的防火牆規則 |
| NAT Gateway | 讓私有子網的服務可以「主動連出去」，但外面連不進來 |
| VPC endpoint | 讓私有子網不經過網際網路，直接連到 AWS 服務 |
| IAM role | 給程式或服務用的權限身分，不需要存放金鑰 |
| IaC | 用程式碼描述基礎設施，可以重複建立相同環境 |

---

## 第 0 步：開工前的決定

這些決定會影響後面每一步，請先定案。

| 項目 | 建議 | 說明 |
| --- | --- | --- |
| IaC 工具 | **AWS CDK（C#）** | 團隊用 C#，CDK 可以用同一種語言寫基礎設施；Terraform 也可以，二選一即可 |
| 帳號結構 | **每個環境一個 AWS 帳號**（dev、staging、prod） | 用 AWS Organizations 管理。環境之間權限和帳單完全隔開，dev 的錯誤不會影響正式環境 |
| 區域 | **台北 ap-east-2** | 少數服務必須在 us-east-1（見第 2、11 步） |
| 網域 | 例如 `example.com`；租戶用 `<租戶>.example.com` | 要能管理 DNS，建議 DNS 放在 Route 53 |
| 子網域命名規則 | 只允許小寫英數字和連字號；保留 `www`、`api`、`admin`、`app` 等名稱 | 子網域會成為租戶的識別，事後很難改 |
| MVP 規格 | dev：單 AZ 的 RDS、1 個 Fargate 容器、1 個 NAT<br>prod：多 AZ、至少 2 個容器、每個 AZ 一個 NAT | 照原圖，正式環境是 Fargate 至少 2 個容器、多可用區 RDS |
| 原始碼與 CI/CD | GitHub + GitHub Actions | 用 OIDC 連 AWS，不存放長期金鑰（第 13 步） |
| 🧩 產品代號 | 底座用 `veilway`；產品各自取一個短代號（小寫英數字，例如 `insai`、`cycu-pulse`） | 所有資源名稱、帳號、log group 都以產品代號開頭，多個產品同時存在時才不會混淆 |
| 🧩 專案結構 | 一個 solution，依套件邊界拆專案（見第 8 步） | 日後要把共用部分發佈成套件，邊界必須一開始就切好 |

> ⚠️ **台北區域的服務可用性**：台北區域於 2025 年 6 月開放，Cognito 於 2026 年 3 月上線台北。開工前請到 AWS 的「各區域服務清單」確認本手冊用到的服務（ECS Fargate、Cognito、ElastiCache、RDS、WAF、ACM、ECR、Secrets Manager、VPC endpoint）都已在台北提供。

---

## 第 1 步：帳號與安全基線

**目的**：在建立任何資源之前，先把帳號鎖好、把費用監控設好。

### 操作

1. **保護 root 帳號**
   - 以 root 登入 → 右上角帳號名稱 → **Security credentials** → 為 root 設定 **MFA**。
   - 刪除 root 的存取金鑰（如果有）。之後**不再用 root 做日常操作**。
2. **建立組織與環境帳號**（建議）
   - **AWS Organizations** → **Create an organization** → 新增帳號：`veilway-dev`、`veilway-staging`、`veilway-prod`。
3. **人員登入改用 IAM Identity Center**
   - **IAM Identity Center** → **Enable** → 建立使用者與群組 → 指派權限集（例如開發者在 dev 有 `PowerUserAccess`，在 prod 只有唯讀）。
   - 每位成員都要設定 MFA。
4. **啟用台北區域** ⚠️
   - 台北是「需要手動開啟」的區域（opt-in region），預設是關閉的。
   - 主控台右上角帳號名稱 → **Account** → **AWS Regions** → 找到 **Asia Pacific (Taipei)** → **Enable**。
   - 每個環境帳號都要各自開啟，開啟需要幾分鐘到數小時。
5. **費用告警**
   - **Billing and Cost Management** → **Budgets** → **Create budget** → 每月預算，並設定在實際花費達 50%、80%、100% 時寄信通知。
6. **稽核紀錄**
   - **CloudTrail** → **Create trail** → 套用到組織的所有帳號、所有區域，紀錄存進專用的 S3 bucket（開啟加密，並禁止刪除）。

### 驗證

- [ ] root 已設定 MFA，且沒有存取金鑰
- [ ] 可以用 Identity Center 帳號登入各環境
- [ ] 區域選單看得到「亞太地區（台北）」，並能切換過去
- [ ] 收到 Budgets 的測試通知

### 注意事項

- 台北區域沒開啟前，該區域的所有資源都建不起來，錯誤訊息也不一定直接說明原因。
- Budgets 和帳單相關的設定在全域頁面，不屬於台北區域。

---

## 第 2 步：網域與憑證

**目的**：準備 DNS 和 HTTPS 憑證。憑證要等 DNS 驗證，越早申請越好。

### 操作

1. **DNS**
   - **Route 53** → **Hosted zones** → **Create hosted zone** → `example.com`。
   - 如果網域在其他註冊商，把註冊商的 NS 記錄改成 Route 53 給的四筆 NS。
2. **給 CloudFront 的憑證** ⚠️ **必須在 us-east-1（維吉尼亞北部）申請**
   - 切換區域到 **US East (N. Virginia)** → **Certificate Manager** → **Request** → **Request a public certificate**。
   - 網域名稱填兩筆：`example.com` 和 `*.example.com`。
   - 驗證方式選 **DNS validation** → **Create records in Route 53**。
3. **給 ALB 的憑證**（在台北申請）
   - 切回 **台北** → **Certificate Manager** → 同樣申請 `example.com`、`*.example.com`，用 DNS 驗證。

### 驗證

- [ ] 兩張憑證的狀態都是 **Issued**（一張在 us-east-1，一張在台北）

### 注意事項

- ⚠️ CloudFront 只能用 **us-east-1** 的憑證。在台北申請的憑證，CloudFront 的設定畫面選不到。
- ⚠️ 萬用憑證 `*.example.com` **只涵蓋一層**：`acme.example.com` 可以，`api.acme.example.com` 不行，`example.com` 本身也不包含，所以要另外列出。
- ACM 憑證會自動續約，前提是 DNS 驗證用的 CNAME 記錄不能刪掉。

---

## 第 3 步：VPC 網路

**目的**：建立私有網路。這一步決定了日後「唯一出口」能不能做到。

### 規劃

| 子網類型 | 放什麼 | 能不能直接連外 |
| --- | --- | --- |
| 公有子網 | ALB、NAT Gateway | 可以 |
| 私有應用子網 | Fargate 容器 | 只能經 NAT 或 VPC endpoint 連出去 |
| 私有資料子網 | RDS、ElastiCache | **完全不能連外** |

每種子網在每個 AZ 各一個。dev 可以用 2 個 AZ，prod 建議 3 個 AZ（台北有 3 個 AZ）。

### 操作

1. **VPC** → **Create VPC** → 選 **VPC and more**：
   - 名稱：`veilway-dev`；IPv4 CIDR：`10.0.0.0/16`
   - Number of AZs：2（prod：3）
   - Public subnets：2；Private subnets：4（每個 AZ 一個應用子網、一個資料子網）
   - NAT gateways：dev 選 **In 1 AZ**；prod 選 **1 per AZ**
   - VPC endpoints：勾選 **S3 Gateway**
2. **調整資料子網的路由**：資料子網的路由表**不要**有指向 NAT 的路由（`0.0.0.0/0`），確保 RDS、ElastiCache 完全連不出去。
3. **建立 VPC interface endpoint**（減少走 NAT 的流量，也比較安全）
   - **VPC** → **Endpoints** → **Create endpoint**，依序建立：`ecr.api`、`ecr.dkr`、`logs`、`secretsmanager`、`sts`。
   - 子網選私有應用子網，並開啟 **Private DNS**。
4. **建立 Security Group**（先建空的，後面的步驟再引用）

| SG 名稱 | 允許連入 | 來源 |
| --- | --- | --- |
| `sg-alb` | 443 | CloudFront 的 managed prefix list `com.amazonaws.global.cloudfront.origin-facing` |
| `sg-app` | 8080（容器的服務埠） | `sg-alb` |
| `sg-rds` | 5432 | `sg-app` |
| `sg-cache` | 6379 | `sg-app` |
| `sg-endpoints` | 443 | `sg-app` |

### 驗證

- [ ] 資料子網的路由表裡沒有 `0.0.0.0/0`
- [ ] `sg-rds`、`sg-cache` 只允許 `sg-app` 連入

### 注意事項

- ⚠️ CIDR 一旦決定很難更改。如果未來可能和公司內網或租戶機房做 VPN 互連（第三階段的隱道連接器），請先確認 `10.0.0.0/16` 不會跟對方的網段重疊。
- NAT Gateway 按小時和流量計費，是 dev 環境裡最容易被忽略的費用。
- SG 的規則要用「另一個 SG」當來源，不要寫死 IP。
- 第二階段會在這個 VPC 加上 Claude Platform on AWS 的 PrivateLink endpoint，屆時只允許閘道連到它。

---

## 第 4 步：KMS 與 Secrets Manager

**目的**：準備加密金鑰和密碼的存放位置。

### 操作

1. **KMS** → **Customer managed keys** → **Create key**，建立平台用的金鑰：
   - `veilway-data`：加密 RDS、S3、ElastiCache
   - `veilway-logs`：加密 CloudWatch Logs
   - 開啟 **Automatic key rotation**（每年自動輪替）
2. **每個租戶一把 KMS key 的機制**（第一階段只建立機制，不需要先建立所有金鑰）
   - 建立租戶時，由程式呼叫 KMS API 建立金鑰，加上別名 `alias/veilway/tenant/<tenant_id>`，並把金鑰 ARN 存進租戶資料表。
   - 金鑰政策只允許後端的 IAM role 使用。
3. **Secrets Manager**：這一步先不手動建立，RDS 的密碼會在第 5 步由 RDS 自動放進來。

### 注意事項

- ⚠️ **費用與上限**：每把客戶管理的 KMS 金鑰每月都有固定費用，帳號內的金鑰數量也有上限。租戶很多時，可以改成「一把主金鑰 + 每個租戶各自的資料金鑰（envelope encryption）」，請在租戶數量規劃確定後再決定。
- KMS 金鑰刪除時有 7 到 30 天的等待期，刪除後用它加密的資料就永遠無法解開，刪除前要特別小心。

---

## 第 5 步：RDS PostgreSQL

**目的**：建立資料庫，並把多租戶隔離（Row-Level Security）在第一天就設定好。

### 5.1 建立資料庫

1. **RDS** → **Subnet groups** → **Create DB subnet group** → 只選**私有資料子網**。
2. **RDS** → **Create database**：

| 設定 | dev | prod |
| --- | --- | --- |
| Engine | PostgreSQL（選目前 RDS 提供的最新穩定主版本） | 同左 |
| Template | Dev/Test | Production |
| 部署方式 | Single-AZ | **Multi-AZ** |
| 帳密 | **Manage master credentials in AWS Secrets Manager** | 同左 |
| 執行個體 | Graviton 小型機型（例如 `db.t4g` 系列） | 依負載評估 |
| 儲存 | gp3，開啟 storage autoscaling | 同左 |
| 網路 | 第 3 步的 VPC、DB subnet group；**Public access：No**；SG：`sg-rds` | 同左 |
| 加密 | 開啟，用 `veilway-data` | 同左 |
| 備份 | 保留 7 天 | 保留 14～35 天 |
| 刪除保護 | 可關閉 | **開啟** |
| Performance Insights | 開啟 | 開啟 |

3. **強制使用 SSL**：建立自訂的 parameter group，設定 `rds.force_ssl = 1`，套用到資料庫後重新啟動。

### 5.2 建立帳號與擴充（用管理帳號連進去執行）

資料庫在私有子網，從外面連不進去。可以用 ECS Exec 進到一個暫時的容器，或用 Session Manager 搭配一台跳板機，再用 `psql` 連線。

```sql
-- 啟用 pgvector（第三階段的 RAG 才會用到，先啟用沒有額外成本）
CREATE EXTENSION IF NOT EXISTS vector;

-- 擁有資料表的帳號：只給 migration 工具使用
CREATE ROLE veilway_owner LOGIN PASSWORD '<由 Secrets Manager 產生>';

-- 應用程式使用的帳號：不能擁有資料表，也不能略過 RLS
CREATE ROLE veilway_app LOGIN PASSWORD '<由 Secrets Manager 產生>' NOBYPASSRLS;

CREATE DATABASE veilway OWNER veilway_owner;
```

兩個帳號的密碼都要另外存進 Secrets Manager（例如 `veilway/dev/db/owner`、`veilway/dev/db/app`）。

### 5.3 Row-Level Security 的寫法（由 migration 建立）

```sql
CREATE TABLE tenants (
  id         uuid PRIMARY KEY,
  subdomain  text NOT NULL UNIQUE,
  name       text NOT NULL,
  plan       text NOT NULL,
  kms_key_arn text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  cognito_sub text NOT NULL UNIQUE,
  email      text NOT NULL,
  role       text NOT NULL
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;   -- 連資料表擁有者也要遵守

CREATE POLICY tenant_isolation ON users
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON users TO veilway_app;
```

**之後每張帶 `tenant_id` 的資料表都要照這個模式建立。**`tenants` 表本身由平台管理功能存取，權限另外控管。

應用程式在**每個交易開始時**設定目前的租戶：

```sql
SELECT set_config('app.tenant_id', '<tenant_id>', true);  -- 第三個參數 true：只在這個交易內有效
```

### 驗證

- [ ] 從公網連不到資料庫
- [ ] 用 `veilway_app` 連線、**沒有設定** `app.tenant_id` 時，查詢 `users` 拿到 0 筆
- [ ] 設定租戶 A 之後，只看得到 A 的資料；嘗試寫入租戶 B 的資料會被拒絕

### 注意事項

- ⚠️ **RLS 最常見的兩個漏洞**：
  1. 應用程式用了資料表擁有者或主帳號連線 → RLS 被略過。所以應用程式只能用 `veilway_app`，並且要加上 `FORCE ROW LEVEL SECURITY`。
  2. 用 `SET`（整個連線有效）而不是交易範圍的設定 → 連線池把連線借給下一個請求時，租戶設定還留著，造成資料外洩。一定要用 `set_config(..., true)`，並在交易內使用。
- 主帳號（master）只用來做管理，不要給應用程式使用。
- Multi-AZ 在建立後也可以修改，但修改時會有短暫的效能影響，請在離峰時間進行。

---

## 第 6 步：ElastiCache（Session 與限流）

**目的**：存放登入狀態與限流計數。

### 操作

1. **ElastiCache** → **Subnet groups** → 只選**私有資料子網**。
2. **ElastiCache** → **Create cache**：
   - 引擎：**Valkey**（與 Redis 相容的開源版本）或 Redis OSS
   - 部署：dev 可用單節點；prod 選 **Multi-AZ** 並開啟自動容錯移轉（或直接用 Serverless）
   - **Encryption in transit：開啟**；**Encryption at rest：開啟**（用 `veilway-data`）
   - 驗證：開啟 **AUTH** 或 RBAC 使用者，密碼存進 Secrets Manager
   - SG：`sg-cache`

### 存放內容規劃

| 用途 | key 範例 | 存活時間 |
| --- | --- | --- |
| Session（登出後讓 token 失效） | `session:revoked:<jti>` | 等於 token 剩餘的有效時間 |
| API 限流 | `rl:<tenant_id>:<user_id>:<分鐘>` | 1～2 分鐘 |
| 第二階段：AI 額度 | `quota:<tenant_id>:<日期>` | 1 天 |

### 驗證

- [ ] 從容器內可以用 TLS 連到 ElastiCache；沒帶密碼時被拒絕

### 注意事項

- ⚠️ **不放對照表、不放任何真名或個資**（這是 Veilway2.md 的規則）。key 只能用 ID。
- 開啟傳輸加密後，程式端的連線字串必須加上 `ssl=true`，否則會一直逾時，而且錯誤訊息不明確。
- 快取的資料要當成「隨時可能消失」來設計：快取掛掉時，限流可以暫時放寬，但登出名單要有替代做法（例如縮短 token 的有效時間）。

---

## 第 7 步：Cognito（登入）

**目的**：建立使用者登入，並讓 token 帶上 `tenant_id`。

### 操作

1. **Cognito** → **User pools** → **Create user pool**：
   - 應用程式類型：**Single-page application (SPA)**
   - 登入方式：Email
   - 密碼原則與 **MFA**：至少讓租戶管理員必須使用 MFA
2. **自訂屬性**：新增 `custom:tenant_id`（字串）。
   - ⚠️ 在 app client 的屬性權限中，把 `custom:tenant_id` 設為**使用者不可寫入**，只能由後端（管理 API）設定。否則使用者可以把自己改到別的租戶。
3. **App client**：
   - 類型：Public client（**不要有 client secret**，SPA 無法安全保存它）
   - OAuth：Authorization code grant + **PKCE**
   - Callback URL：`https://*.example.com/callback` 這種萬用字元**不被允許**，見下方注意事項
   - Token 有效時間：access token 短（例如 15～60 分鐘），refresh token 依需求
4. **讓 access token 帶上 `tenant_id`**：
   - 加上 **Pre token generation** Lambda trigger，把 `custom:tenant_id` 加進 access token。
   - ⚠️ 自訂 **access token** 需要 Cognito 的 **Essentials 或 Plus** 方案；Lite 方案只能自訂 ID token。
5. **登入頁網域**：設定 Cognito 的登入網域（例如 `auth.example.com`，自訂網域需要 us-east-1 的憑證）。

### 驗證

- [ ] 建立測試使用者後能登入，解開 access token 看得到 `tenant_id`
- [ ] 使用者無法自行修改 `custom:tenant_id`

### 注意事項

- ⚠️ **多個租戶子網域的回呼網址**：Cognito 不接受萬用字元的 callback URL。常見做法有兩種：
  1. 登入一律走同一個網址（例如 `https://auth.example.com/callback`），登入完成後再導回原本的租戶子網域（**建議**）。
  2. 每建立一個租戶，就用 API 把該租戶的 callback URL 加進 app client（數量有上限，租戶多時不適合）。
- 自訂屬性建立後**無法刪除，也無法改名**，命名前請想清楚。
- API 端應驗證 **access token**，不要拿 ID token 當授權依據。

---

## 第 8 步：後端程式的必要設定（ASP.NET Core）

**目的**：在部署前，把第一階段驗收需要的行為寫進程式。

| 項目 | 做法 |
| --- | --- |
| JWT 驗證 | 使用 `Microsoft.AspNetCore.Authentication.JwtBearer`，Authority 設為 Cognito user pool 的網址；驗證簽章、到期時間、`token_use = access`、client ID |
| 租戶解析 | 中介軟體（middleware）從 Host 標頭取出子網域 → 查 `tenants` 得到 tenant_id → **必須等於** token 裡的 `tenant_id`，不一致回 403 |
| RLS 設定 | 用 EF Core 的 `DbConnectionInterceptor` 或交易攔截器，在每個交易開始時執行 `set_config('app.tenant_id', …, true)` |
| 登出 | 把 token 的 `jti` 寫進 ElastiCache 的失效名單；驗證 token 時一併檢查 |
| 限流 | ASP.NET Core 內建 Rate Limiter，計數放在 ElastiCache（多個容器才能共用計數）；超過門檻回 **429** |
| 健康檢查 | `/healthz`：只檢查程式本身是否正常，給 ALB 用；`/readyz`：額外檢查 DB 與快取 |
| 設定與密碼 | 從 Secrets Manager 讀取，不寫進程式碼或映像檔 |
| 日誌 | 結構化日誌（JSON）。⚠️ **不記錄** Authorization 標頭、token、密碼、請求內容 |
| 服務埠 | 容器監聽 8080，不用 root 身分執行 |

### 注意事項

- ⚠️ 前面經過 CloudFront 和 ALB，程式收到的 Host 和來源 IP 都可能被改寫。請在 CloudFront 用 **CloudFront Function** 把使用者的原始 Host 複製到自訂標頭（例如 `X-Tenant-Host`），程式從這個標頭解析租戶（見第 11 步）。
- 租戶判斷**只信任 token 和這個標頭**，不要信任前台自己傳上來的 tenant_id 參數。

### 🧩 程式要放在哪裡：依套件邊界拆專案

上表的功能幾乎都是**每個產品都需要**的，所以不要寫在產品的 API 專案裡，而是寫在共用專案中：

```
Veilway.sln
├─ src/
│  ├─ Veilway.MultiTenancy/        ← 本階段：JWT 驗證設定、租戶解析、RLS 攔截器、
│  │                                  登出、限流、健康檢查、日誌過濾、租戶共用資料表
│  ├─ Veilway.Gateway/             ← 第二階段：隱道閘道（本階段先建空專案）
│  ├─ Veilway.Files/               ← 第三階段：檔案與非同步（本階段先建空專案）
│  └─ Veilway.Infrastructure/      ← CDK 元件（第 14 步）
├─ samples/
│  └─ SampleProduct/               ← 最小範例產品：Api、Web（SPA）、Cdk 三個專案
│                                     只透過公開介面使用上面的共用專案
└─ tests/
```

| 規則 | 說明 |
| --- | --- |
| 共用專案只提供擴充方法 | 例如產品的 `Program.cs` 只要寫 `builder.AddVeilwayMultiTenancy(config)`、`app.UseVeilwayMultiTenancy()` 就能啟用整套功能 |
| 所有差異都是設定 | Cognito 網址、子網域規則、限流門檻、日誌過濾的關鍵字等，都從設定讀取 |
| 共用專案不引用範例產品 | 相依方向只能是「產品 → 共用專案」，反過來就無法拆成套件 |
| 共用資料表與產品資料表分開 | 租戶、使用者、角色等共用資料表的 migration 放在 `Veilway.MultiTenancy`；產品自己的資料表放在產品專案 |

---

## 第 9 步：ECR 與 ECS Fargate

**目的**：把後端跑起來。

### 操作

1. **ECR** → **Create repository** → `veilway-api`：
   - 開啟 **Scan on push**（推上去時自動掃描弱點）
   - 開啟 **Tag immutability**（同一個版本標籤不能被覆蓋）
   - 設定 lifecycle policy，只保留最近 N 個映像
2. **IAM role**（兩個角色用途不同，不要搞混）：

| 角色 | 誰使用 | 權限 |
| --- | --- | --- |
| Task execution role | ECS 本身 | 從 ECR 拉映像、寫入 CloudWatch Logs、讀取啟動時需要的 Secrets |
| Task role | 你的程式 | 讀取 Secrets Manager 中的 DB、快取密碼；使用 KMS；之後第二階段的權限也加在這裡 |

3. **ECS** → **Clusters** → **Create cluster** → 名稱 `veilway-dev`，基礎設施選 **AWS Fargate**，開啟 **Container Insights**。
4. **Task definition** → **Create**：
   - Launch type：Fargate；CPU 架構：**ARM64**（Graviton 較便宜，映像也要用 ARM64 建置）
   - CPU / 記憶體：dev 先用 0.5 vCPU / 1 GB
   - 容器埠：8080
   - 環境變數放一般設定；密碼用 **secrets** 欄位引用 Secrets Manager 的 ARN
   - 日誌：awslogs，log group `/veilway/dev/api`
5. **Service** → **Create**：
   - Desired tasks：dev 1；**prod 至少 2**
   - 子網：**私有應用子網**；**Public IP：關閉**；SG：`sg-app`
   - 開啟 **Deployment circuit breaker** 和 **rollback**（部署失敗時自動退回上一版）
   - Load balancer 在第 10 步建立後再接上（也可以先建 ALB 再建 service）

### 驗證

- [ ] 容器狀態為 RUNNING，CloudWatch Logs 看得到啟動訊息
- [ ] 容器沒有 public IP

### 注意事項

- ⚠️ 映像架構要和 task definition 一致：在 Mac（Apple Silicon）上建的是 ARM64，在一般 CI 機器上預設是 x86。不一致時容器會一直啟動失敗。
- ECS Exec（進到容器內除錯）在 dev 很方便，prod 建議關閉或嚴格限制。

---

## 第 10 步：ALB

**目的**：把 CloudFront 送來的 API 請求分配給後端容器。

### 操作

1. **EC2** → **Target groups** → **Create**：
   - Target type：**IP**（Fargate 必須用 IP 類型）
   - Protocol / Port：HTTP 8080
   - Health check：`/healthz`
2. **EC2** → **Load balancers** → **Create Application Load Balancer**：
   - Scheme：Internet-facing；子網：**公有子網**；SG：`sg-alb`
   - Listener **HTTPS 443**：使用第 2 步在**台北**申請的憑證
   - 預設動作：**回傳固定的 403**
   - 新增一條規則：**標頭 `X-Origin-Verify` 等於 `<一段隨機密鑰>`** 時，才轉送到 target group
3. 把 ECS service 接上這個 target group。
4. 把 `<隨機密鑰>` 存進 Secrets Manager，並安排定期更換。

### 驗證

- [ ] 直接連 ALB 的網址會被拒絕（SG 只允許 CloudFront；就算連得到，沒有密鑰標頭也會拿到 403）
- [ ] target group 裡的容器顯示 healthy

### 注意事項

- 這樣設定之後，**只有經過 CloudFront 的請求**能到達後端，WAF 的防護才不會被繞過。
- 另一種做法是 CloudFront 的 **VPC origin**，ALB 可以放在私有子網、完全不對外。請確認台北區域是否支援後再評估。

---

## 第 11 步：S3 前台、CloudFront、WAF 與 DNS

**目的**：讓使用者透過租戶子網域打開前台，並把 `/api/*` 轉給後端。

### 操作

1. **S3 前台 bucket**（台北）
   - 名稱例如 `veilway-dev-web`；**Block all public access：開啟**；加密：開啟
2. **WAF** ⚠️ **必須建在 us-east-1，範圍選 CloudFront（Global）**
   - **WAF & Shield** → **Web ACLs** → **Create** → Resource type：**Amazon CloudFront distributions**
   - 加入 AWS managed rules：Core rule set、Known bad inputs、IP reputation
   - 加入 rate-based rule（例如每個 IP 每 5 分鐘的請求上限）
3. **CloudFront** → **Create distribution**：
   - **Origin 1**：S3 前台 bucket，使用 **Origin Access Control（OAC）**；建立後依提示把 bucket policy 貼到 S3
   - **Origin 2**：ALB；Protocol：HTTPS only；加上自訂標頭 `X-Origin-Verify: <隨機密鑰>`
   - **Behavior `/api/*`** → ALB：允許所有 HTTP 方法；Cache policy：**CachingDisabled**；Origin request policy：轉送需要的標頭、查詢字串、Cookie（**不要轉送原始 Host**）
   - **Default behavior `/*`** → S3：Cache policy：CachingOptimized
   - **Alternate domain names**：`example.com`、`*.example.com`；憑證：第 2 步在 **us-east-1** 申請的那張
   - **Web ACL**：選第 2 項建立的 WAF
   - Viewer protocol policy：**Redirect HTTP to HTTPS**
4. **CloudFront Functions**（viewer request）：
   - 綁在 `/api/*`：把使用者的 Host 複製到 `X-Tenant-Host` 標頭
   - 綁在 `/*`：把沒有副檔名的路徑改寫成 `/index.html`（SPA 前端路由需要）
5. **DNS**：**Route 53** → 新增兩筆 **A（Alias）** 記錄，指向這個 CloudFront distribution：
   - `example.com`
   - `*.example.com`
6. **部署前台**：`aws s3 sync` 上傳建置好的檔案 → 對 CloudFront 執行 invalidation `/index.html`。

### 驗證

- [ ] `https://acme.example.com` 可以打開前台，重新整理任何頁面都不會出現 404
- [ ] `https://acme.example.com/api/healthz` 會回應，而且後端收到的 `X-Tenant-Host` 是 `acme.example.com`
- [ ] 直接開 S3 bucket 的網址會被拒絕

### 注意事項

- ⚠️ **不要用 CloudFront 的「自訂錯誤回應」（把 403/404 改成 index.html）來處理 SPA 路由**。它對整個 distribution 生效，連 `/api/*` 的 404 也會被換成首頁，API 的錯誤會變得很難除錯。請用上面第 4 項的 CloudFront Function。
- ⚠️ 前台的 `index.html` 要設定短快取或不快取，其他帶雜湊值檔名的 JS、CSS 檔可以長期快取，否則使用者會一直看到舊版。
- CloudFront 設定變更需要幾分鐘才會在全球生效。

---

## 第 12 步：CloudWatch 監控與告警

**目的**：出問題時第一時間知道。

### 操作

1. **Log groups**：`/veilway/<env>/api` 等，設定保留天數（dev 14 天、prod 依稽核規定），並用 `veilway-logs` 加密。
2. **告警**（**CloudWatch** → **Alarms**，通知送到 SNS 主題 → Email 或 Slack）：

| 告警 | 條件範例 |
| --- | --- |
| ALB 5xx 偏多 | 5 分鐘內 5xx 超過一定比例 |
| 後端不健康 | target group 的 healthy 數量 < 期望數量 |
| ECS | CPU 或記憶體持續 > 80% |
| RDS | CPU > 80%、可用儲存空間 < 20%、連線數接近上限 |
| ElastiCache | 記憶體使用率 > 80%、evictions > 0 |
| WAF | 被擋下的請求突然大量增加 |

3. **Dashboard**：把上面的指標放在同一個畫面。

### 注意事項

- ⚠️ 定期用 **Logs Insights** 抽查日誌，確認沒有 token、密碼或個資（第一階段的驗收項目之一）。
- 日誌保留天數不設定的話，預設是**永久保存**，費用會一直累積。

---

## 第 13 步：CI/CD（GitHub Actions）

**目的**：程式推上 GitHub 後自動部署，不需要手動上傳。

### 操作

1. **讓 GitHub 不用金鑰就能存取 AWS（OIDC）**
   - **IAM** → **Identity providers** → **Add provider** → OpenID Connect → `https://token.actions.githubusercontent.com`，Audience：`sts.amazonaws.com`
   - 建立 IAM role，信任條件限制在**特定 repo 與分支**（例如只有 `main` 可以部署到 staging）
2. **後端流程**：測試 → 建置 ARM64 映像 → 推到 ECR（標籤用 commit SHA）→ 更新 ECS task definition → 部署 service
3. **前台流程**：測試 → 建置 → `s3 sync` → CloudFront invalidation
4. **資料庫 migration**：作為部署中的一個步驟，用 `veilway_owner` 帳號執行，在新版程式上線前完成
5. **環境保護**：在 GitHub 的 Environments 設定 prod 需要人工核准才能部署
6. 🧩 **workflow 可重複使用**：把建置、部署的步驟寫成 GitHub 的 **reusable workflow**，產品代號、AWS 帳號、網域用輸入參數帶入。之後的產品直接呼叫同一份 workflow
7. 🧩 **共用專案的檢查**：每次 CI 都要確認共用專案可以單獨建置與測試，不依賴範例產品（產品化時才能直接打包成 NuGet 套件）

### 注意事項

- ⚠️ **不要**把 AWS access key 存在 GitHub Secrets 裡，一律用 OIDC。
- ⚠️ IAM role 的信任條件一定要限制 repo 和分支，否則任何 GitHub repo 都可能拿到你的 AWS 權限。
- migration 要寫成「新舊版程式都能運作」（例如先加欄位、之後才刪欄位），避免部署途中出錯。

---

## 第 14 步：IaC 化與重建驗證

**目的**：把第 2 到 13 步的設定寫成 CDK，確保環境可以一鍵重建；🧩 而且寫成**可參數化的元件**，讓之後的每個產品都能套用同一份 IaC。

### 操作

1. 🧩 **把 IaC 分成兩層**：

| 層 | 放在哪裡 | 內容 |
| --- | --- | --- |
| 元件層（共用） | `src/Veilway.Infrastructure` | 每個 stack 寫成可重複使用的類別（construct／stack），所有名稱與規格都來自參數 |
| 組裝層（每個產品一份） | `samples/SampleProduct/Cdk` | 只負責填入參數、把元件組起來。之後的產品也只寫這一層 |

2. **參數清單**（定義成一個設定類別，例如 `VeilwayProductConfig`）：

| 參數 | 例子 |
| --- | --- |
| 產品代號 | `veilway`、`insai` |
| 環境 | `dev`、`staging`、`prod` |
| AWS 帳號與區域 | `<account-id>`、`ap-east-2` |
| 網域 | `example.com` |
| AZ 數量、NAT 數量 | dev：2、1；prod：3、3 |
| 容器數量與規格 | dev：1、0.5 vCPU；prod：2 以上 |
| RDS 規格與 Multi-AZ | dev：小型、關閉；prod：依負載、開啟 |
| 刪除保護與保留政策 | dev：關閉；prod：開啟、RETAIN |
| 日誌保留天數 | dev：14 天；prod：依稽核規定 |

3. 元件層依 AWS 資源分成幾個 stack：

| Stack | 內容 | 區域 |
| --- | --- | --- |
| `GlobalStack` | us-east-1 的 ACM 憑證、CloudFront 用的 WAF | us-east-1 |
| `NetworkStack` | VPC、子網、NAT、VPC endpoint、SG | 台北 |
| `DataStack` | KMS、RDS、ElastiCache、Secrets | 台北 |
| `AuthStack` | Cognito、Pre token generation Lambda | 台北 |
| `AppStack` | ECR、ECS、ALB | 台北 |
| `EdgeStack` | S3 前台、CloudFront、DNS | 台北（引用 us-east-1 的資源） |

4. 環境差異與產品差異全部寫成參數，**元件層裡不能出現任何寫死的名稱、網域或帳號**。
5. 用 CDK 部署 staging，跑完第 15 步的驗收清單。
6. **重建演練**：用 CDK 刪除 dev，再用 CDK 重建一次，確認可以完全重現。
7. 🧩 **套用演練**：用另一組參數（例如產品代號 `demo`、另一個網域、另一個 AWS 帳號）部署一套全新的環境，確認**不需要修改元件層**就能建起來，而且和原本的環境完全不互相影響。這就是之後開新產品時要做的事。

### 注意事項

- ⚠️ 有狀態的資源（RDS、S3、KMS）在 CDK 中要設定 **RemovalPolicy.RETAIN**（prod）並開啟刪除保護，避免一次 `cdk destroy` 就把資料刪光。
- 跨區域引用（台北的 stack 用到 us-east-1 的憑證）要開啟 CDK 的 `crossRegionReferences`。
- 手動在主控台改過的設定，下次 CDK 部署時會被覆蓋。導入 IaC 後就不要再手動修改。
- 🧩 S3 bucket 名稱在全球必須唯一，名稱要包含產品代號、環境和帳號 ID（例如 `<產品代號>-<env>-web-<account-id>`），否則第二個產品部署時會撞名失敗。
- 🧩 只能在 us-east-1 建立的資源（CloudFront 憑證、WAF）也要依產品代號命名，因為多個產品的這些資源會集中在 us-east-1。

---

## 第 15 步：第一階段驗收

對應〈Veilway三階段執行計畫.md〉的驗收標準：

| # | 驗收項目 | 怎麼測 |
| --- | --- | --- |
| 1 | 使用者從租戶子網域登入，前台呼叫 API 成功 | 用 `acme.example.com` 登入，呼叫一支需要授權的 API |
| 2 | 拿 B 租戶的 token 到 A 租戶的子網域會被拒絕 | 自動化測試，預期 403 |
| 3 | A 租戶讀不到 B 租戶的資料 | 自動化測試：直接用 `veilway_app` 帳號查資料庫，以及透過 API 查詢，兩種都要測 |
| 4 | 登出後舊 token 立即失效 | 登出後再用舊 token 呼叫 API，預期 401 |
| 5 | 超過限流門檻回 429 | 用腳本短時間大量呼叫 |
| 6 | RDS、後端從公網連不到 | 從外部嘗試連線 RDS 端點和 ALB 直連網址 |
| 7 | 停掉一個容器或切換 RDS 可用區，服務不中斷（prod／staging） | 手動停止一個 task；對 RDS 執行 **Reboot with failover** |
| 8 | 環境可以用 IaC 重建 | 第 14 步的重建演練 |
| 9 | 日誌中沒有 token、密碼等敏感資訊 | Logs Insights 搜尋 `Bearer`、`password`、`eyJ` 等關鍵字 |
| 10 | 🧩 只改參數就能建出另一套獨立環境 | 第 14 步的套用演練 |
| 11 | 🧩 共用專案不依賴範例產品，可以單獨建置與測試 | CI 中單獨建置 `src/` 下的專案；檢查共用專案沒有引用 `samples/` |

---

## 附錄 A：常見陷阱總表

| 陷阱 | 後果 | 對策（步驟） |
| --- | --- | --- |
| 台北區域沒有手動開啟 | 所有資源都建不起來 | 第 1 步 |
| CloudFront 的憑證、WAF 建在台北 | 設定畫面選不到 | 都要建在 us-east-1（第 2、11 步） |
| 萬用憑證沒包含根網域 | `example.com` 出現憑證錯誤 | 申請時同時列出兩個名稱（第 2 步） |
| 應用程式用資料表擁有者連線 | RLS 失效，跨租戶資料外洩 | 用 `veilway_app` 並加 `FORCE ROW LEVEL SECURITY`（第 5 步） |
| 用 `SET` 設定租戶 | 連線池造成租戶設定殘留 | 用 `set_config(..., true)`（第 5 步） |
| 使用者可以修改 `custom:tenant_id` | 使用者把自己改到別的租戶 | 設為不可寫入（第 7 步） |
| 用自訂錯誤回應處理 SPA 路由 | API 的 404 也變成首頁 | 用 CloudFront Function（第 11 步） |
| ALB 可以被直接存取 | WAF 被繞過 | SG 限制 CloudFront + 密鑰標頭（第 10 步） |
| 映像架構與 task definition 不一致 | 容器一直啟動失敗 | 統一用 ARM64（第 9 步） |
| GitHub 存放 AWS 長期金鑰 | 金鑰外洩風險 | 改用 OIDC（第 13 步） |
| 日誌沒設保留天數 | 費用持續累積 | 每個 log group 都設定（第 12 步） |
| 🧩 IaC 裡寫死名稱、網域或帳號 | 第二個產品無法套用，只能整份複製再改 | 全部改成參數，並做套用演練（第 14 步） |
| 🧩 共用功能寫在產品的 API 專案裡 | 之後拆不出套件，每個產品各寫一份 | 依套件邊界拆專案（第 8 步） |
| 🧩 S3 bucket 名稱沒有包含產品代號與帳號 | 第二個產品部署時撞名 | 依命名規則（第 14 步） |

## 附錄 B：費用注意

dev 環境放著不用也會持續計費的項目：**NAT Gateway、RDS、ElastiCache、ALB、Fargate 容器、VPC interface endpoint**（每個 endpoint 依可用區按小時計費）、WAF 的規則與請求數。

省錢做法：

- dev 用最小規格、單 AZ。
- 下班或週末用排程把 dev 的 Fargate desired count 調成 0、暫停 RDS（RDS 暫停最多 7 天後會自動啟動）。
- 用 Budgets 告警盯緊每月花費。

正式的費用估算，請用 AWS Pricing Calculator 依實際規格試算。

---

## 參考

- [Amazon Cognito 已在台北區域上線（2026-03）](https://aws.amazon.com/about-aws/whats-new/2026/03/cognito-taipei-and-new-zealand-regions)
- [AWS 台北區域開放公告](https://aws.amazon.com/blogs/aws/now-open-aws-asia-pacific-taipei-region/)
- [啟用或停用 AWS 區域（opt-in regions）](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-regions.html)
