# Veilway 第一階段操作手冊：骨架（修訂版）

對應〈Veilway三階段執行計畫.md〉的第一階段。架構以〈Veilway2.md〉和〈Veilway架構圖v2.pdf〉為準。

**第一階段完成時能做到**：使用者從租戶子網域登入，前台呼叫 API，API 依租戶讀寫資料；整個環境可以用 IaC 重建。

### 本版修訂重點

| 類別 | 修訂 |
| --- | --- |
| 已定案 | ① 隱道閘道在第二階段拆成**獨立的 ECS service**（自己的 SG 與 task role），第一階段的 IaC 先預留結構 ② **出口管控**（egress proxy／Network Firewall）延到第二階段 ③ **一位使用者只屬於一個租戶** |
| 修正錯誤 | pgvector 要建在 `veilway` 資料庫內；RLS 政策改用 `nullif(...)`，避免連線重用時出錯；EF Core 的 RLS 設定改用交易攔截器；Cognito 登入網域與 callback 網址拆成不同主機；CloudFront 連 ALB 改用 `origin-api.example.com`；限流需要分散式實作；migration 改在 VPC 內用 ECS 執行 |
| 補上漏項 | 租戶解析函式、方案資料表、平台開通流程、使用者建立流程、登入稽核、refresh token 撤銷、管理員 MFA、密碼輪替、sandbox 帳號 |

---

## 怎麼使用這份手冊

- 步驟依**相依順序**排列，請照順序做。每一步都有「目的 → 操作 → 驗證 → 注意事項」。
- **建議做法**：
  1. 先在 **sandbox 帳號**用主控台照手冊做一遍，弄懂每個設定的作用。做完就整個帳號清掉。
  2. 接著在第 14 步把設定寫成 IaC。**dev、staging、prod 一開始就用 IaC 建立**，不要拿手動建的環境轉成 IaC，因為手動建立的資源沒辦法用 `cdk destroy` 刪除，重建演練也做不了。
  3. 之後一律只改 IaC，不再手動點主控台。
- 主控台路徑寫成「服務 → 頁面 → 按鈕」。
- 本手冊中的 `example.com` 請換成你們的網域（Veilway 使用 `veilway.app`），`<…>` 是要自行填入的值。在 dev、staging、sandbox 環境，`example.com` 代表該環境的子網域，例如 dev 是 `dev.example.com`（見第 2 步）。
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
| ECS service／task | service 是一組長期執行的容器；task 是單次執行的容器（例如 migration） |
| IaC | 用程式碼描述基礎設施，可以重複建立相同環境 |

---

## 第 0 步：開工前的決定

這些決定會影響後面每一步，請先定案。

| 項目 | 建議 | 說明 |
| --- | --- | --- |
| IaC 工具 | **AWS CDK（C#）** | 團隊用 C#，CDK 可以用同一種語言寫基礎設施；Terraform 也可以，二選一即可 |
| 帳號結構 | **每個環境一個 AWS 帳號**（sandbox、dev、staging、prod） | 用 AWS Organizations 管理。環境之間權限和帳單完全隔開。sandbox 給手動練習用，可以隨時清空 |
| 區域 | **台北 ap-east-2** | 少數服務必須在 us-east-1（見第 2、11 步） |
| 網域 | **`veilway.app`**（已在 Route 53 購買，放在 veilway-prod）；租戶用 `<租戶>.veilway.app`；其他環境用子網域（`dev.veilway.app` 等） | 一個平台一個網域，不和其他產品共用。詳見第 2 步 |
| 子網域命名規則 | 只允許小寫英數字和連字號，長度 3～63；**保留名稱**：`www`、`api`、`admin`、`app`、`auth`、`login`、`origin-api`、`static`、`mail`、`sandbox`、`dev`、`staging` | 子網域會成為租戶的識別，事後很難改。`auth`、`login`、`origin-api` 在本手冊有固定用途（第 7、10、11 步）；`sandbox`、`dev`、`staging` 是各環境的子網域，和 prod 的租戶子網域在同一層，租戶不能使用 |
| 使用者與租戶 | **一位使用者只屬於一個租戶**；email 在整個平台唯一 | 同一個人要進兩個租戶，就用兩個 email 開兩個帳號。這個決定會寫進 Cognito 的設定，事後很難改 |
| 後端服務切分 | 第一階段只有 **API service**；第二階段新增獨立的 **閘道 service** | 閘道必須有自己的 SG 和 task role，第二階段的出口鎖定才有效（見第 9 步） |
| 出口管控 | **第二階段**再加 egress proxy 或 Network Firewall | 第一階段應用子網經 NAT 可以完整對外，這是已知、暫時的狀態（見第 3 步） |
| MVP 規格 | dev：單 AZ 的 RDS、1 個 Fargate 容器、1 個 NAT<br>prod：多 AZ、至少 2 個容器、每個 AZ 一個 NAT | 照原圖，正式環境是 Fargate 至少 2 個容器、多可用區 RDS |
| 原始碼與 CI/CD | GitHub + GitHub Actions | 用 OIDC 連 AWS，不存放長期金鑰（第 13 步） |

> ⚠️ **台北區域的服務可用性**：台北區域於 2025 年 6 月開放，Cognito 於 2026 年 3 月上線台北。開工前請到 AWS 的「各區域服務清單」確認本手冊用到的服務（ECS Fargate、Cognito、ElastiCache、RDS、WAF、ACM、ECR、Secrets Manager、KMS、Lambda、VPC endpoint）都已在台北提供。

### 開工前的試做：RLS 與 EF Core

計畫書把「Row-Level Security 和 EF Core 的整合」列為風險。請在第 5 步之前，先用本機的 PostgreSQL（例如 Docker）做一個小專案，驗證第 5.4 節的寫法：

- [ ] 連線被連線池重用時，不會帶著上一個請求的租戶
- [ ] 沒有設定租戶時查詢拿到 0 筆，**不會丟出錯誤**
- [ ] EF Core 的重試機制（retry）和明確交易可以一起運作

這三點沒有通過，就不要往下做第 5 步。

---

## 第 1 步：帳號與安全基線

**目的**：在建立任何資源之前，先把帳號鎖好、把費用監控設好。

### 操作

1. **保護 root 帳號**
   - 以 root 登入 → 右上角帳號名稱 → **Security credentials** → 為 root 設定 **MFA**。
   - 刪除 root 的存取金鑰（如果有）。之後**不再用 root 做日常操作**。
2. **建立組織與環境帳號**（詳細步驟見下方「1.2 建立組織與環境帳號」）
   - **AWS Organizations** → **Create an organization** → 新增帳號：`veilway-sandbox`、`veilway-dev`、`veilway-staging`、`veilway-prod`。
3. **啟用台北區域** ⚠️（詳細步驟見下方「1.3 啟用台北區域」）
   - 台北是「需要手動開啟」的區域（opt-in region），預設是關閉的。
   - 管理帳號和 4 個環境帳號**都要**開啟，開啟需要幾分鐘到數小時。
   - 必須在第 4 項 Identity Center **之前**完成，否則指派許可集時會卡住。
4. **人員登入改用 IAM Identity Center**（詳細步驟見下方「1.4 人員登入改用 IAM Identity Center」）
   - **IAM Identity Center** → **Enable** → 建立使用者與群組 → 指派權限集（例如開發者在 sandbox、dev 有 `PowerUserAccess`，在 prod 只有唯讀）。
   - 每位成員都要設定 MFA。
5. **費用告警**（詳細步驟見下方「1.5 費用告警」）
   - **Billing and Cost Management** → **Budgets** → **Create budget** → 每個帳號一份每月預算，並設定在花費達 50%、80%、預測 100% 時寄信通知。
6. **稽核紀錄**（詳細步驟見下方「1.6 稽核紀錄」）
   - **CloudTrail** → **Create trail** → 套用到組織的所有帳號、所有區域，紀錄存進專用的 S3 bucket（開啟加密，並禁止刪除）。

### 1.2 建立組織與環境帳號

#### 組織與帳號的關係

組織只有**一個**，底下有多個 AWS 帳號：

```
組織（Organization）
├── 管理帳號（建立組織的那個帳號）：只管組織和帳單，不放任何系統資源
├── veilway-sandbox
├── veilway-dev
├── veilway-staging
└── veilway-prod
```

#### 四個環境帳號的目的

| 帳號 | 用途 | 誰在用 | 資料 | 可以隨意修改嗎 |
| --- | --- | --- | --- | --- |
| **sandbox** | 照本手冊用主控台**手動練習**，弄懂每個設定在做什麼 | 開發人員 | 沒有 | 可以，練完整個清掉 |
| **dev** | 開發中的程式部署到這裡，每天測試新功能 | 開發人員 | 假資料 | 可以，壞了就用 IaC 重建 |
| **staging** | 上線前的**彩排**：規格和設定跟 prod 一樣（多 AZ、至少 2 個容器），跑第 15 步的驗收 | 開發、測試人員 | 假資料，量接近正式 | 不行，只能透過 CI/CD 部署 |
| **prod** | 正式環境，租戶真正在用 | 租戶 | **真實客戶資料** | 絕對不行，部署要人工核准 |

**為什麼要分成不同帳號**，而不是在同一個帳號裡用名稱區分環境：

1. **出錯不會波及正式環境**：在 dev 誤刪資源、改錯網路設定，prod 完全不受影響。帳號之間預設完全隔離。
2. **權限可以分開給**：開發人員在 dev 有完整權限，在 prod 只能唯讀，設定起來很單純。
3. **帳單一目了然**：每個帳號的花費分開列出，看得出是 dev 太貴還是 prod 用量增加。
4. **稽核範圍明確**：存放真實個資的只有 prod。對 Veilway 這種處理個資的平台特別重要。
5. **刪了能重建**：sandbox、dev 可以整個清掉重來，不怕留下沒人記得的資源。

**實際的使用順序**：sandbox 手動練習 → dev 用 CDK 建立、每天開發 → staging 用同一份 CDK、改成正式規格、跑驗收 → prod 同一份 CDK、驗收通過且人工核准後才部署。

> 只有一個人、想先省事時，可以**先只建 sandbox 和 dev**，staging、prod 等快上線再用 IaC 建立。帳號本身不收費，只有在裡面建立資源才會計費。

#### A. 建立組織

1. 主控台上方搜尋列輸入 **Organizations**，進入 **AWS Organizations**。
2. 按 **建立組織**（Create an organization）。
3. AWS 會寄驗證信到 root 的 email，點信裡的連結完成驗證。不驗證的話，後面無法建立或邀請帳號。

> ⚠️ 建立組織的帳號會成為**管理帳號**（management account）。它只用來管組織和帳單，**不要在裡面建立任何系統資源**，VPC、RDS 等都放在環境帳號裡。

#### B. 建立四個環境帳號

在 Organizations 頁面按 **新增 AWS 帳戶** → **建立 AWS 帳戶**，每個帳號做一次：

| 帳戶名稱 | 電子郵件（範例） |
| --- | --- |
| `veilway-sandbox` | `<信箱帳號>+veilway-sandbox@gmail.com` |
| `veilway-dev` | `<信箱帳號>+veilway-dev@gmail.com` |
| `veilway-staging` | `<信箱帳號>+veilway-staging@gmail.com` |
| `veilway-prod` | `<信箱帳號>+veilway-prod@gmail.com` |

- **IAM 角色名稱**：保留預設的 `OrganizationAccountAccessRole`，管理帳號可以透過這個角色切換進各環境帳號。
- 每個帳號的 email **必須不同**，也不能被其他 AWS 帳號用過。Gmail 在帳號後面加 `+` 的寫法，信都會寄到同一個信箱。公司使用時，建議用群組信箱（例如 `aws-dev@公司網域`），不要綁在某位員工的個人信箱。
- 建立需要幾分鐘，等狀態變成**作用中**（Active）再繼續。
- 之後要改成員帳號的 email：**Organizations** → **AWS 帳戶** → 點該帳號 → **主要電子郵件** → **更新**，驗證碼會寄到新的 email。

#### C. 收掉成員帳號的 root（建議）

新建立的帳號各自也有 root。雖然沒有設定密碼，但仍可以用「忘記密碼」把它啟用。建議統一收掉：

1. 在管理帳號：**IAM** → 左側 **Root access management**（根存取管理）→ **啟用**。
2. 兩個選項都勾選：**Root credentials management** 和 **Privileged root actions**。

這樣成員帳號的 root 就無法登入。真的需要 root 操作時，再從管理帳號臨時取得權限。

### 1.3 啟用台北區域

**目的**：讓各帳號可以在台北建立資源。台北是 opt-in 區域，沒開啟前，該區域的所有資源都建不起來。

⚠️ **順序很重要**：Identity Center 建在台北時，

- 管理帳號沒開台北 → 無法在台北啟用 Identity Center。
- 成員帳號沒開台北 → 指派許可集到該帳號時會一直卡在「進行中」，而且無法移除（見 1.4 G 的注意事項）。

所以本項要在 1.4 之前，把**管理帳號和 4 個環境帳號全部**開好。

#### A. 管理帳號（主控台）

1. 右上角區域選單 → **管理區域**（或 右上角帳號名稱 → **帳戶** → **AWS 區域**）。
2. 找到 **亞太地區（台北）ap-east-2** → 選取 → **啟用** → 確認。
3. 狀態從「啟用中」變成「已啟用」，通常幾分鐘，最久可能數小時。

> 區域選單打開時如果停在 **Local Zones** 分頁，那是個別城市的延伸據點，Veilway 用不到，切回 **區域** 分頁即可。在 Organizations 等全域服務的頁面，右上角會顯示「全球」，此時不能選區域，先進入任一區域服務（例如 IAM Identity Center）再切換。

#### B. 4 個環境帳號（管理帳號用 CloudShell 一次處理）

成員帳號的 root 已經收掉，從管理帳號統一開啟最方便。

1. **先決條件**：**AWS Organizations** → **服務** → **AWS Account Management** → **啟用受信任存取**。
   - 注意不要選到名稱很像的 **Account access manager**，那是管理 IAM 角色存取權的另一個服務。
2. 開啟 **CloudShell**（主控台上方 `>_` 圖示）。
   - ⚠️ 台北目前**沒有 CloudShell**，會顯示「Region Unsupported」。先把右上角區域切到**東京**（ap-northeast-1）再開啟。下面的指令都已指定台北，在哪個區域的 CloudShell 執行結果都一樣。
3. 整段貼上執行，自動找出所有成員帳號（排除管理帳號）並啟用台北：

```bash
MGMT=$(aws organizations describe-organization --query Organization.MasterAccountId --output text)
for id in $(aws organizations list-accounts --query "Accounts[?Id!='$MGMT'].Id" --output text); do
  echo "啟用 $id ..."
  aws account enable-region --account-id $id --region-name ap-east-2
done
```

4. 查看狀態，等全部顯示 `ENABLED`（`ENABLING` 表示還在進行，過幾分鐘再查）：

```bash
for id in $(aws organizations list-accounts --query "Accounts[?Id!='$MGMT'].Id" --output text); do
  echo "$id: $(aws account get-region-opt-status --account-id $id --region-name ap-east-2 --query RegionOptStatus --output text)"
done
```

**CloudShell 使用提示**：

- 貼上：Windows 用 `Ctrl + Shift + V` 或右鍵貼上；Mac 用 `Cmd + V`。
- 手冊中的 `<帳號ID>` 這類寫法表示「換成實際的值」，**`< >` 不要打出來**。在終端機裡 `<` 代表從檔案讀取，會出現 `No such file or directory`。帳號 ID 是 12 位數字，不是使用者名稱。
- 畫面停在 `(END)` 時按 `q` 回到提示字元。
- 出現 `AccessDeniedException` 或提到 trusted access，表示第 1 步的受信任存取還沒啟用。

#### C. 確認

完成 1.4 之後，從 Identity Center 入口網站逐一進入各帳號（**AdministratorAccess**），右上角區域選單應該看得到 **亞太地區（台北）**，而且可以切換過去。

### 1.4 人員登入改用 IAM Identity Center

**目的**：建立每個人日常使用的登入帳號。一次登入就能切換到各環境帳號，權限依群組統一管理。做完之後就不用再登入 root。

以下都在**管理帳號**操作。

#### 名詞對照

| 名詞 | 白話說明 |
| --- | --- |
| 使用者 | 一個人的登入帳號（名稱、email、密碼、MFA） |
| 群組 | 一群權限相同的人，例如管理者、開發人員。權限指派給群組，不直接給個人 |
| 許可集（權限集） | 一組權限範本，例如「完整管理」「唯讀」。主控台顯示為「許可集」 |
| 指派 | 「哪個群組」在「哪個帳號」有「哪個許可集」 |
| AWS 存取入口網站 | 大家登入的網頁，登入後列出自己能進的帳號和權限 |

#### A. 區域與執行個體組態 ⚠️

Identity Center 只能有一個**主要區域**，建立後**不能更改**，要換只能整個刪除重建。

1. 確認 1.3 已完成：管理帳號和 4 個環境帳號的台北區域都是「已啟用」。
2. 主控台搜尋 **IAM Identity Center**，右上角區域切到 **亞太地區（台北）**。
   - 如果台北無法啟用 Identity Center，改選**東京**（ap-northeast-1）。這裡只存放人員的登入帳號，不影響系統放在台北。
3. 按 **啟用**。啟用頁面會以 AWS Organizations 建立**組織執行個體**，這是正確的，可以管理組織內所有帳號。
4. **執行個體組態**：選 **單一區域執行個體**（預設是「多區域」）。

| | 多區域（預設） | **單一區域（建議）** |
| --- | --- | --- |
| 資料放在哪裡 | 台北，並**複製到美國西部（奧勒岡）** | 只在台北 |
| 加密金鑰 | 必須用客戶自管的 KMS 金鑰，要自己管理金鑰政策 | AWS 擁有的金鑰，不用設定 |
| 好處 | 台北的 Identity Center 故障時，可以從美國登入 | 設定最簡單 |
| 對 Veilway 的影響 | 人員的帳號資料（姓名、email）會出境 | 跟「平台在台灣」的說法一致 |

   台北的 Identity Center 真的故障時，還有 root 可以緊急登入；之後需要備援時，也可以再新增區域。

5. 確認下方設定表格後按 **啟用**：

| 設定 | 值 | 之後能否變更 |
| --- | --- | --- |
| 靜態加密 | AWS 擁有的金鑰 | 可以 |
| 許可集 | 已啟用 | 不可以（必須啟用） |
| 主要區域 | 亞太區域（台北） | **不可以** |
| 其他區域 | 無 | 可以 |

身分來源保留預設的 **Identity Center 目錄**（使用者和密碼由 Identity Center 自己管理）。

#### B. 設定 MFA

**設定**（Settings）→ **身分驗證**（Authentication）分頁 → **多重要素驗證** → **設定**：

| 項目 | 選擇 | 理由 |
| --- | --- | --- |
| 提示使用者進行 MFA | **每次登入時（永遠開啟）** | 另一個選項只在換裝置、換地點時才要求，保護較弱 |
| 使用者可以使用的 MFA 類型 | **安全金鑰和內建驗證器**、**驗證器應用程式** 都勾選 | passkey、指紋、實體金鑰、Google Authenticator 都能用 |
| 如果使用者尚未註冊 MFA 裝置 | **要求他們在登入時註冊 MFA 裝置** | 新人第一次登入就得設定，不會有人漏掉 |
| 誰可以管理 MFA 裝置 | 勾選 **使用者可以新增和管理自己的 MFA 裝置** | 換手機或新增備用裝置時不用找管理者 |

按 **儲存變更**。同一頁的工作階段持續時間（預設 8 小時）保持不變。

#### C. 自訂登入網址

**設定** → **身分來源**（Identity source）分頁會顯示兩個 **AWS access portal URL**：

| 網址 | 說明 |
| --- | --- |
| 雙堆疊 `https://ssoins-…portal.ap-east-2.app.aws` | 新式網址，支援 IPv6，**不能自訂** |
| 僅限 IPv4 `https://d-xxxxxxxxxx.awsapps.com/start` | 可以把 `d-xxxxxxxxxx` 換成好記的名稱 |

**動作** → **自訂 AWS 存取入口網站 URL** → 輸入名稱（例如 `veilway`）→ **儲存**，網址就會變成 `https://veilway.awsapps.com/start`。

- ⚠️ 自訂網址**只能設定一次**，之後無法再改。
- 名稱在全 AWS 必須唯一，被用走時換一個（例如 `veilway-tw`）。
- 自訂後，原本的 `d-xxxxxxxxxx.awsapps.com` 會失效。
- 這個網址就是之後每個人的登入入口，請加入書籤，並告知團隊成員。

#### D. 建立群組

**群組** → **建立群組**，建立兩個（成員先不用選）：

| 群組名稱 | 描述 | 給誰 |
| --- | --- | --- |
| `veilway-admins` | Veilway 平台管理者 | 平台管理者 |
| `veilway-developers` | Veilway 開發人員 | 之後加入的開發人員 |

#### E. 建立使用者

**使用者** → **新增使用者**：

| 欄位 | 填什麼 |
| --- | --- |
| 使用者名稱 | 例如 `jeffkao`，登入時使用，**建立後不能改** |
| 密碼 | **傳送電子郵件給此使用者，並提供密碼設定說明** |
| 電子郵件地址 | 本人實際收信的信箱 |
| 名字、姓氏 | 必填 |
| 其他欄位 | 可以留空 |

**下一步** → 勾選要加入的群組（平台管理者加入 `veilway-admins`）→ **下一步** → **新增使用者**。

- 使用者會收到邀請信「Invitation to join AWS IAM Identity Center」。建議等 F、G 做完再接受邀請，一登入就能看到所有帳號。
- 邀請連結 **7 天內有效**，過期可以在使用者頁面按 **重設密碼** 重寄。

#### F. 建立許可集

**多帳戶許可** → **許可集** → **建立許可集** → **預先定義的許可集** → 選政策 → **下一步** → 填詳細資訊 → **建立**。建立三個：

| 許可集 | 描述（只能用英文） | 工作階段持續時間 | 用途 |
| --- | --- | --- | --- |
| `AdministratorAccess` | `Full admin access` | 4 小時 | 管理者 |
| `PowerUserAccess` | `Developer access without IAM` | 8 小時 | 開發人員在 sandbox、dev 使用 |
| `ReadOnlyAccess` | `Read-only access` | 8 小時 | 開發人員在 staging、prod 只能查看 |

- ⚠️ 許可集的**描述只接受英文字母、數字和一般符號**，輸入中文會出現「描述包含無效的字元」。描述也可以留空。
- **工作階段持續時間**是從入口網站點進某個帳號後多久要重新點一次。管理權限設短一點，忘了登出時風險比較小。
- **PowerUserAccess** 幾乎可以操作所有服務，但**不能建立或修改 IAM 角色和使用者**。之後 CDK 的 `cdk bootstrap` 需要建立 IAM 角色，要由管理者用 AdministratorAccess 執行一次；之後開發人員用 PowerUserAccess 執行 `cdk deploy` 即可。

#### G. 指派群組與許可集到各帳號

**多帳戶許可** → **AWS 帳戶** → 勾選帳號 → **指派使用者或群組** → **群組** 分頁選群組 → **下一步** → 選許可集 → **下一步** → **提交**。一次可以勾選多個帳號，所以分三輪：

| 輪次 | 勾選的帳號 | 群組 | 許可集 |
| --- | --- | --- | --- |
| 1 | 管理帳號、sandbox、dev、staging、prod（全部 5 個） | `veilway-admins` | AdministratorAccess |
| 2 | sandbox、dev | `veilway-developers` | PowerUserAccess |
| 3 | staging、prod | `veilway-developers` | ReadOnlyAccess |

完成後的權限對照：

| 帳號 | `veilway-admins` | `veilway-developers` |
| --- | --- | --- |
| 管理帳號 | AdministratorAccess | — |
| veilway-sandbox | AdministratorAccess | PowerUserAccess |
| veilway-dev | AdministratorAccess | PowerUserAccess |
| veilway-staging | AdministratorAccess | ReadOnlyAccess |
| veilway-prod | AdministratorAccess | ReadOnlyAccess |

- 提交後 AWS 會在各帳號建立對應的角色，畫面顯示「正在佈建」，通常一兩分鐘完成。
- 開發人員群組目前沒有成員也可以先指派，之後新人只要加進群組就自動有權限。
- ⚠️ **指派一直卡在「進行中」**（超過 5 分鐘）：幾乎都是該成員帳號還沒啟用台北。
  - 進行中的項目**無法選取或移除**，這是正常的。直接按 **關閉**，請求不會因此取消；視窗說的「遺失佇列」只指還沒送出的項目。
  - 照 1.3 B 幫該帳號啟用台北，等狀態變成 `ENABLED`。之後卡住的指派會自動完成，或顯示失敗；失敗的話重新指派一次即可。
  - 最後到 **多帳戶許可** → **許可集**，確認三個許可集都是 **已佈建**。
- 許可集顯示 **未佈建**：表示還沒指派到任何帳號，不是錯誤，指派後就會變成已佈建。之後修改**已佈建**的許可集時，要按頁面上的 **更新帳戶**（佈建）才會套用到各帳號。

#### H. 第一次登入

1. 打開邀請信 → **Accept invitation** → 設定密碼。
2. 依畫面**註冊 MFA**。建議用跟 root 不同的裝置或 passkey，其中一個遺失時還有另一個可用。
3. 登入後，入口網站列出 5 個帳號，每個都有 `AdministratorAccess`。
4. 點 `veilway-dev` → **AdministratorAccess** → 進入主控台，右上角顯示的應該是 dev 的帳號 ID。
5. 確認都能登入後，**登出 root**。之後一律從入口網址登入，root 的密碼和 MFA 裝置收好，只在緊急時使用。

#### 新增團隊成員時

1. **使用者** → **新增使用者**，加入對應的群組（通常是 `veilway-developers`）。
2. 對方收到邀請信 → 設定密碼 → 第一次登入時註冊 MFA。
3. 不需要再做指派，權限跟著群組走。
4. 成員離職時，在 **使用者** 頁面**停用**或刪除該使用者，所有帳號的存取立即失效。

### 1.5 費用告警

**目的**：每個帳號設定每月預算，花費接近或可能超過時寄信通知，避免帳單意外暴增。

以下從 Identity Center 入口網站進入各帳號操作。

#### 為什麼在各帳號裡分別建立

本來可以在管理帳號用「連結帳戶」篩選，替每個環境帳號各建一份預算。但篩選清單的資料來自成本資料，**新建立、還沒產生費用的帳號不會出現在清單裡**（通常要開始產生費用後最多 24 小時才出現）。所以：

- **管理帳號**的預算，在管理帳號建立。
- **4 個環境帳號**的預算，各自進入該帳號建立。在成員帳號裡，預算本來就只計算該帳號自己的費用，不需要篩選條件。

#### A. 建立預算（每個帳號做一次）

1. 入口網站 → 點帳號 → **AdministratorAccess**。
2. 主控台搜尋 **Budgets** → **建立預算**。
3. 選 **自訂（進階）** → **成本預算** → **下一步**。
4. 設定預算：

| 欄位 | 設定 |
| --- | --- |
| 預算名稱 | `veilway-<環境>-monthly`，例如 `veilway-dev-monthly` |
| 期間 | 每月 |
| 預算續約類型 | 週期性預算 |
| 預算編列方法 | 固定 |
| 預算金額 | 依下表 |
| 預算範圍 | **所有 AWS 服務**，不用設篩選條件 |

5. **下一步** → **新增警示閾值**，加三個，通知都寄到負責人的 email：

| 閾值 | 觸發條件 | 說明 |
| --- | --- | --- |
| 50% | **實際**成本 | 提早注意 |
| 80% | **實際**成本 | 該檢查有沒有忘記關的資源 |
| 100% | **預測**成本 | 依目前速度月底會超過預算時就通知，不用等真的超支 |

6. **下一步** → 確認 → **建立預算**。

#### B. 各帳號的起始金額

先用下面的金額，之後依實際花費調整：

| 帳號 | 預算名稱 | 每月金額（美元） |
| --- | --- | --- |
| 管理帳號 | `veilway-management-monthly` | 10（不放資源，正常接近 0） |
| sandbox | `veilway-sandbox-monthly` | 50（練習完就清掉） |
| dev | `veilway-dev-monthly` | 100 |
| staging | `veilway-staging-monthly` | 100（還沒建資源前幾乎是 0） |
| prod | `veilway-prod-monthly` | 100，上線前依試算調整 |

#### 注意事項

- 預算建立後，資料最多要 24 小時才會出現，看到 0 是正常的。
- 每個帳號每月前 2 份預算免費，之後每份每月約 0.02 美元。
- Budgets 是全域服務，不屬於台北區域。
- 預算只會**通知**，不會自動停止資源。收到通知後要自己去查是哪個服務在花錢（**Billing and Cost Management** → **Cost Explorer**）。

### 1.6 稽核紀錄（CloudTrail）

**目的**：記錄組織內**所有帳號**的每一個 API 操作（誰、什麼時間、從哪裡、做了什麼），出事時可以追查。

做法是在管理帳號建立一個**組織追蹤**（organization trail）：只設定一次就涵蓋所有帳號，以後新增的帳號也會自動納入；成員帳號看得到它，但**無法修改或停用**。

以下在**管理帳號**操作，右上角區域選 **亞太地區（台北）**。

#### A. 建立組織追蹤

1. 主控台搜尋 **CloudTrail** → 左側 **追蹤**（Trails）→ **建立追蹤**。
2. **選擇追蹤屬性**：

| 欄位 | 設定 | 說明 |
| --- | --- | --- |
| 追蹤名稱 | `veilway-org-trail` | |
| 為我組織中的所有帳戶啟用 | **勾選** | 這就是組織追蹤，最重要的一項 |
| 儲存位置 | **建立新的 S3 儲存貯體** | |
| 追蹤日誌儲存貯體和資料夾 | `veilway-cloudtrail-<管理帳號ID>` | S3 名稱全球唯一，加上管理帳號 ID 就不會重複。下方會顯示日誌路徑 `…/AWSLogs/<組織ID>/<帳號ID>` |
| 日誌檔 SSE-KMS 加密 | **已啟用** | |
| 客戶受管 AWS KMS 金鑰 | **全新** | 這是二選一的選項，不是勾選框。「全新」會自動建立金鑰並設好金鑰政策；「現有」要自己調整金鑰政策 |
| AWS KMS 別名 | `veilway-cloudtrail` | KMS 金鑰和 S3 儲存貯體必須在同一區域，區域選台北就會一致。金鑰每月約 1 美元 |
| 日誌檔案驗證 | **啟用** | 可以證明日誌事後沒被竄改 |
| SNS 通知傳遞 | 不勾選 | |
| CloudWatch Logs | 不勾選 | 需要即時告警時再開，會另外計費 |

3. **下一步** → **選擇日誌事件**：

| 事件類型 | 設定 | 說明 |
| --- | --- | --- |
| 管理事件 | **勾選**，讀取和寫入都勾 | 建立、修改、刪除資源、登入等操作。第一份免費 |
| 資料事件 | 不勾選 | 例如每次讀寫 S3 檔案，量很大、費用高 |
| Insights 事件 | 不勾選 | 異常偵測，另外計費 |
| 網路活動事件 | 不勾選 | |

4. **下一步** → 確認 → **建立追蹤**。如果提示要啟用 CloudTrail 在 Organizations 的受信任存取，同意即可。

#### B. 防止日誌被刪除

照這個順序做：**先開版本控制，再設生命週期，最後加禁止刪除的規則**。最後一步會連生命週期和版本控制設定都一起鎖住，所以要先設好。

**1. 開啟版本控制**

**S3** → 點 `veilway-cloudtrail-<管理帳號ID>` → **屬性** → **儲存貯體版本控制** → **編輯** → **啟用** → **儲存變更**。

**2. 設定生命週期（節省儲存費用）**

**管理** → **生命週期規則** → **建立生命週期規則**：

| 欄位 | 設定 |
| --- | --- |
| 規則名稱 | `archive-old-logs` |
| 規則範圍 | **套用至儲存貯體中的所有物件**，勾選確認 |
| 規則動作 | 只勾 **在儲存類別之間移轉物件的目前版本** |
| 儲存類別 | **Glacier Instant Retrieval** |
| 建立物件後的天數 | `90` |

**不要**勾選任何「過期」或「永久刪除」的動作，日誌要一直保留。Glacier Instant Retrieval 的儲存費用約為標準類別的 1/5，仍然可以立即讀取。

**3. 在 bucket policy 加上禁止刪除的規則**

**許可** → **儲存貯體政策** → **編輯**。把游標放在 `"Statement": [` 這一行的最後面，換行後貼上下面這段（把 `<管理帳號ID>` 換成實際的 12 位數字，**最後的逗號要保留**）：

```json
    {
      "Sid": "DenyLogDeletion",
      "Effect": "Deny",
      "Principal": "*",
      "Action": [
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:DeleteBucket",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketVersioning"
      ],
      "Resource": [
        "arn:aws:s3:::veilway-cloudtrail-<管理帳號ID>",
        "arn:aws:s3:::veilway-cloudtrail-<管理帳號ID>/*"
      ]
    },
```

- CloudTrail 自動產生的其他規則**不要刪除或修改**，那是讓 CloudTrail 能寫入日誌用的。
- 儲存時出現紅字錯誤，通常是逗號或括號沒對齊。
- 這樣連管理者也刪不掉日誌。之後真的要刪除這個 bucket（例如整個環境要清掉），要先把 `DenyLogDeletion` 這段移除。

#### 注意事項

- 即使沒有建立追蹤，CloudTrail 的**事件歷史記錄**也會免費保留最近 90 天，但只限單一帳號、單一區域。建立追蹤後，所有帳號的日誌會長期存在 S3。
- 加完政策後，回到 **CloudTrail** → **追蹤** 確認狀態仍是「記錄中」。如果變成錯誤，代表不小心改到 CloudTrail 原本的規則。

### 驗證

- [ ] root 已設定 MFA，且沒有存取金鑰
- [ ] Organizations 的帳戶清單裡有管理帳號和 4 個環境帳號，狀態都是「作用中」
- [ ] 成員帳號已啟用 Root access management
- [ ] Identity Center 的主要區域是台北，執行個體為單一區域
- [ ] 可以用 Identity Center 帳號從自訂網址登入各環境，登入時會要求 MFA
- [ ] 入口網站顯示的帳號和權限符合 1.4 G 的對照表
- [ ] 管理帳號和 4 個環境帳號的台北區域都是「已啟用」（`ENABLED`）
- [ ] 三個許可集都是「已佈建」
- [ ] 管理帳號和 4 個環境帳號各有一份每月預算，各有三個警示閾值
- [ ] `veilway-org-trail` 狀態是「記錄中」，「組織追蹤」欄顯示「是」
- [ ] 約 15 分鐘後，CloudTrail bucket 裡出現 `AWSLogs/<組織ID>/` 資料夾，底下有各帳號 ID 的子資料夾
- [ ] CloudTrail bucket 已開啟版本控制、有生命週期規則 `archive-old-logs`，政策裡有 `DenyLogDeletion`
- [ ] 嘗試刪除 CloudTrail bucket 裡的日誌檔，會顯示 Access Denied

### 注意事項

- 台北區域沒開啟前，該區域的所有資源都建不起來，錯誤訊息也不一定直接說明原因。
- Budgets 和帳單相關的設定在全域頁面，不屬於台北區域。

---

## 第 2 步：網域與憑證

**目的**：準備網域、各環境的 DNS 和 HTTPS 憑證。憑證要等 DNS 驗證，越早申請越好。

### 2.1 網域規劃

#### 網域代表什麼

網域是使用者在網址列看到的品牌。Veilway 的租戶網址是 `<租戶>.<網域>`，所以這個網域**專門給 Veilway 平台使用**。

- **一個平台一個網域**：其他獨立產品（例如另一個業務平台）另外購買網域，不和 Veilway 共用。cookie、憑證、DNS 完全隔離，一個平台出事不會波及其他平台，也方便之後各自交接。每個網域每年約 15～20 美元。
- **客戶是 Veilway 的租戶時，不用另外買網域**：例如保險業務、學校客戶就是 `insurance.veilway.app`、`cycu.veilway.app`。客戶想用自己的網域（例如 `ai.cycu.edu.tw`）時，之後再做「客戶自訂網域」功能，不在第一階段範圍。

#### 後綴怎麼選

| | `.com` | `.app` | `.io` |
| --- | --- | --- | --- |
| 類型 | 通用頂級網域 | 新通用頂級網域，Google 營運 | 國家代碼網域（英屬印度洋領地） |
| 一般人熟悉度 | 最高 | 中等，科技業熟悉 | 科技圈熟悉，一般人較陌生 |
| 每年價格（約） | 15 美元 | 20 美元 | 70 美元以上 |
| 強制 HTTPS | 否 | **是**（瀏覽器內建） | 否 |
| 長期穩定性 | 最穩定 | 穩定 | 主權可能移轉，有不確定性 |

順序建議：`.com` → `.app` → 其他。`.tw`、`.com.tw` 在 Route 53 買不到，要在台灣的註冊商購買，再把 NS 指到 Route 53。

**Veilway 使用 `veilway.app`**。`.app` 強制 HTTPS，正好符合全站 HTTPS 的設計；唯一限制是不能用 HTTP 測試這個網域，開發在本機或 dev 環境進行即可。

#### 各環境的網域與帳號

主網域放在 **veilway-prod**，其他環境用子網域，並把子網域**委派**給各自的帳號管理：

| 環境 | 網域 | 託管區域放在 | 租戶網址範例 |
| --- | --- | --- | --- |
| prod | `veilway.app` | veilway-prod | `acme.veilway.app` |
| staging | `staging.veilway.app` | veilway-staging | `acme.staging.veilway.app` |
| dev | `dev.veilway.app` | veilway-dev | `acme.dev.veilway.app` |
| sandbox | `sandbox.veilway.app` | veilway-sandbox | 練習用 |

- 主網域放 prod：正式環境最重要，權限也最嚴格。**不要**放在管理帳號。
- 委派之後，dev 的人可以自由調整 `dev.veilway.app` 底下的 DNS，碰不到 prod。
- 後續步驟寫的 `example.com`，在各環境就換成該環境的網域。例如 dev 的 `auth.example.com` 是 `auth.dev.veilway.app`，都在 `*.dev.veilway.app` 憑證的範圍內。
- `sandbox`、`dev`、`staging` 已加入第 0 步的保留名稱，租戶不能使用。

### 2.2 購買網域（在 veilway-prod）

1. 入口網站 → **`veilway-prod`** → **AdministratorAccess**。
2. **Route 53** → 左側 **已註冊的網域** → **註冊網域**。
3. 搜尋名稱 → 選一個可用的後綴 → **選取** → **繼續結帳**。
4. 設定：

| 欄位 | 設定 |
| --- | --- |
| 期間 | 1 年 |
| 自動續約 | **開啟**，過期會被別人搶走 |
| 聯絡人資訊 | 填真實資料，email 要能收信 |
| 隱私權保護 | **開啟**，公開的 WHOIS 查詢不會顯示姓名、地址 |

5. **提交**。費用算在組織的帳單上。

購買後：

- ⚠️ **15 天內**點 ICANN 驗證信（主旨類似「Verify your email address」）裡的連結，否則網域會被暫停。
- 註冊通常幾分鐘到幾小時完成。**Route 53** → **已註冊的網域** 顯示完成後，**託管區域** 會自動出現 `veilway.app`（含 NS、SOA 兩筆記錄）。

### 2.3 委派子網域給各環境帳號

先做目前要用的 sandbox 和 dev，staging 等快上線再做，步驟相同。Route 53 是**全域服務**，右上角顯示「全球」，不用選區域。

以 sandbox 為例：

**1. 在環境帳號建立託管區域**

1. 入口網站 → **`veilway-sandbox`** → **AdministratorAccess**。
2. **Route 53** → **託管區域** → **建立託管區域**：網域名稱 `sandbox.veilway.app`，類型 **公有託管區域** → **建立託管區域**。
3. 點進去，把 **NS** 記錄的 4 行值複製下來，例如：

```
ns-123.awsdns-15.com.
ns-456.awsdns-57.net.
ns-789.awsdns-34.org.
ns-1011.awsdns-12.co.uk.
```

**2. 在 prod 帳號加上委派記錄**

1. 入口網站 → **`veilway-prod`** → **Route 53** → **託管區域** → `veilway.app` → **建立記錄**：

| 欄位 | 設定 |
| --- | --- |
| 記錄名稱 | `sandbox`（自動組成 `sandbox.veilway.app`） |
| 記錄類型 | **NS** |
| 值 | 貼上剛才的 4 行，每行一個 |
| TTL | `300`，確認沒問題後可改成 `172800`（2 天） |

2. **建立記錄**。

**3. 其他環境照做**：`veilway-dev` 建立 `dev.veilway.app` → 在 prod 新增名稱 `dev` 的 NS 記錄；staging 之後同樣做法。

**4. 驗證委派**

開 CloudShell（台北沒有 CloudShell，切到東京等其他區域）。CloudShell 預設沒有 `dig`，先安裝：

```bash
sudo dnf install -y bind-utils
dig NS sandbox.veilway.app +short
dig NS dev.veilway.app +short
```

不想安裝的話，改用 Google 的公開 DNS 查詢：

```bash
curl -s "https://dns.google/resolve?name=sandbox.veilway.app&type=NS" | python3 -m json.tool
```

| 結果 | 意思 |
| --- | --- |
| 4 行 `ns-xxx.awsdns-xx...`，和環境帳號託管區域的 NS 相同 | 委派成功 |
| 沒有結果，或 `"Status": 3`（NXDOMAIN） | prod 的委派記錄還沒建、名稱打錯，或還在生效中，等幾分鐘再查 |
| 有 4 行，但和環境帳號的 NS 不同 | prod 那筆 NS 記錄的值貼錯了 |

### 2.4 申請憑證（在各環境帳號）

每個環境申請**兩張**內容相同、區域不同的憑證：

| 憑證 | 區域 | 給誰用 | 網域名稱（以 sandbox 為例） |
| --- | --- | --- | --- |
| 第 1 張 | **美國東部（維吉尼亞北部）us-east-1** | CloudFront、Cognito 自訂網域 | `sandbox.veilway.app`、`*.sandbox.veilway.app` |
| 第 2 張 | **亞太地區（台北）** | ALB | 同上 |

CloudFront 和 Cognito 只能用 us-east-1 的憑證，ALB 只能用同區域（台北）的憑證，所以要各申請一張。萬用憑證涵蓋 `acme.`、`auth.`、`login.`、`origin-api.` 等所有**一層**子網域。

**第 1 張：us-east-1**

1. 入口網站 → **`veilway-sandbox`** → **AdministratorAccess**。
2. ⚠️ 右上角區域切到 **美國東部（維吉尼亞北部）us-east-1**，這步最容易忘。
3. **Certificate Manager** → **請求** → **請求公有憑證** → **下一步**：

| 欄位 | 設定 |
| --- | --- |
| 完整網域名稱 | `sandbox.veilway.app` |
| 新增另一個名稱 | `*.sandbox.veilway.app` |
| 允許匯出 | **停用**（啟用會另外收費，用不到） |
| 驗證方法 | **DNS 驗證** |
| 金鑰演算法 | **RSA 2048**（預設） |

4. **請求**。畫面顯示「已成功請求具有 ID … 的憑證」，狀態是「等待驗證」。
5. 按 **檢視憑證** → 「網域」區塊按 **在 Route 53 中建立記錄** → 兩個網域都勾選 → **建立記錄**。兩個名稱共用同一筆驗證記錄，只建立一筆是正常的。

**第 2 張：台北**

1. **不用等第 1 張完成**，只要第 1 張的驗證記錄已經建好，就可以切到 **亞太地區（台北）**。
2. 重複上面第 3～5 步。按 **在 Route 53 中建立記錄** 時如果顯示**已存在**，直接略過：同一個帳號、同一個網域的驗證記錄在各區域相同，兩張會各自完成驗證。

**其他環境**：`veilway-dev` 申請 `dev.veilway.app`、`*.dev.veilway.app`，us-east-1 和台北各一張。prod 的 `veilway.app`、`*.veilway.app` 等快上線時在 veilway-prod 申請。

### 驗證

- [ ] `veilway.app` 註冊完成，ICANN 驗證信已確認
- [ ] veilway-prod 的 `veilway.app` 託管區域裡，有 `sandbox`、`dev` 兩筆 NS 委派記錄
- [ ] `dig NS sandbox.veilway.app`、`dig NS dev.veilway.app` 回傳的名稱伺服器和各環境帳號的託管區域一致
- [ ] sandbox、dev 帳號各有兩張憑證（us-east-1、台北），狀態都是 **已發行**（Issued），通常幾分鐘、最久約 30 分鐘

### 注意事項

- ⚠️ CloudFront 和 Cognito 自訂網域都只能用 **us-east-1** 的憑證。在台北申請的憑證，設定畫面選不到。
- ⚠️ 萬用憑證只涵蓋**一層**：`*.dev.veilway.app` 涵蓋 `acme.dev.veilway.app`，不涵蓋 `api.acme.dev.veilway.app`；`dev.veilway.app` 本身也不包含，所以要另外列出。
- ⚠️ **不要刪除** Route 53 裡的驗證 CNAME 記錄（名稱以 `_` 開頭）。ACM 每年自動續約要用到它，刪掉的話憑證會在到期時失效。
- 公有憑證免費；每個託管區域每月約 0.5 美元。

---

## 第 3 步：VPC 網路

**目的**：建立私有網路。這一步決定了日後「唯一出口」能不能做到。

以下以 **sandbox** 為例，在 **`veilway-sandbox` 帳號、亞太地區（台北）** 操作。dev、staging、prod 之後用 IaC 建立，設定相同，只有 AZ 數量、NAT 數量不同（見 3.2 的表格）。

### 3.1 規劃

| 子網類型 | 放什麼 | 能不能連外 | AZ a | AZ b |
| --- | --- | --- | --- | --- |
| 公有 | ALB、NAT Gateway | 可以 | public-a | public-b |
| 私有應用 | Fargate 容器（第一階段：API；第二階段加上閘道） | 經 NAT 或 VPC endpoint | app-a | app-b |
| 私有資料 | RDS、ElastiCache | **完全不能** | data-a | data-b |

每種子網在每個 AZ 各一個。sandbox、dev 用 2 個 AZ；prod 建議 3 個 AZ（台北有 3 個 AZ）。

### 3.2 用精靈建立 VPC

**VPC** → **建立 VPC** → 選 **VPC 及其他**：

| 欄位 | 設定 | 說明 |
| --- | --- | --- |
| 名稱標籤自動產生 | 勾選，輸入 `veilway-sandbox`（各環境用 `veilway-<環境>`） | 子網、路由表會自動加上這個前綴 |
| IPv4 CIDR | `10.0.0.0/16` | ⚠️ 之後很難改。未來要和公司內網或租戶機房 VPN 互連（第三階段的隱道連接器）時不能重疊 |
| IPv6 CIDR | 無 | |
| 租用 | 預設 | |
| 可用區域數量 | **2**（prod：3） | |
| 公有子網路數量 | **2**（prod：3） | |
| 私有子網路數量 | **4**（prod：6） | 每個 AZ 一個應用子網、一個資料子網 |
| NAT 閘道 | 見下表 | |
| VPC 端點 | **S3 閘道** | 免費 |
| DNS 主機名稱、DNS 解析 | **兩個都勾選** | VPC interface endpoint 的私有 DNS 需要 |

**NAT 閘道**有三個選項：

| 選項 | 說明 |
| --- | --- |
| 無 | 不建 NAT，私有子網完全不能連外。之後的 Fargate、Cognito 驗證等需要連外 |
| 區域性 – 全新 | 新推出的方式：一個 NAT 涵蓋整個區域，依各 AZ 的工作負載自動擴展 |
| Zonal | 傳統方式：放在指定的 AZ，再選「在 1 個 AZ 中」或「每個 AZ 各一個」 |

| 環境 | NAT 設定 |
| --- | --- |
| sandbox、dev | **Zonal → 在 1 個 AZ 中**：費用最低。該 AZ 故障時私有子網暫時無法連外，可接受 |
| prod | 手冊原設計是 **Zonal → 每個 AZ 各一個**（高可用，費用是 AZ 數倍）。「區域性」可能更簡單，建 prod 前確認台北支援情況與計費後再定案 |

右側預覽圖確認子網數量正確 → **建立 VPC**，約 1～3 分鐘。

### 3.3 子網與路由表改名

精靈產生的私有子網名稱類似 `veilway-sandbox-subnet-private1-ap-east-2a`，看不出用途。**VPC** → **子網路** → 逐一點選 → **標籤** → **管理標籤** → 修改 `Name`：

| 精靈產生的名稱 | 改成 |
| --- | --- |
| `…-public1-…a` | `veilway-sandbox-public-a` |
| `…-public2-…b` | `veilway-sandbox-public-b` |
| `…-private1-…a` | `veilway-sandbox-app-a` |
| `…-private2-…b` | `veilway-sandbox-app-b` |
| `…-private3-…a` | `veilway-sandbox-data-a` |
| `…-private4-…b` | `veilway-sandbox-data-b` |

AZ 字尾依實際顯示（可能是 `a`、`b`，也可能是 `a`、`c`）。

**路由表也要改名**：**VPC** → **路由表**，精靈會產生 6 張，對照「明確子網路關聯」欄位確認每張給哪個子網用：

| 精靈產生的名稱 | 改成 | 給誰用 |
| --- | --- | --- |
| `…-rtb-public` | 不用改 | 兩個公有子網共用 |
| `…-rtb-private1-…a` | `veilway-sandbox-rtb-app-a` | app-a |
| `…-rtb-private2-…b` | `veilway-sandbox-rtb-app-b` | app-b |
| `…-rtb-private3-…a` | `veilway-sandbox-rtb-data-a` | data-a |
| `…-rtb-private4-…b` | `veilway-sandbox-rtb-data-b` | data-b |
| `–`（沒有名稱） | `veilway-sandbox-rtb-main` | VPC 的**主路由表** |

- 改名方式：滑鼠移到 **Name** 欄位會出現鉛筆圖示，點下去直接輸入 → ✓；或點選路由表 → **標籤** → **管理標籤** → 修改 `Name`。
- **主路由表**是建立 VPC 時自動產生的，沒有明確指定路由表的子網會自動使用它。精靈建立的子網都已各自指定，所以目前沒有子網在用。它無法刪除，取名方便辨識即可。
- 確認主路由表的 **路由** 分頁**只有** `10.0.0.0/16 → local` 一條。這樣之後新建的子網即使忘了指定路由表，也不會意外連到外網。

### 3.4 讓資料子網完全不能連外 ⚠️

精靈會讓所有私有子網都經 NAT 連外，資料子網要拿掉這條路：

1. **VPC** → **路由表** → 選資料子網的路由表（`…-rtb-private3-…`、`…-rtb-private4-…`）。
2. **路由** → **編輯路由** → 移除目的地 `0.0.0.0/0`、目標 `nat-…` 的那一列 → **儲存變更**。
3. 保留 `10.0.0.0/16 → local` 和 S3 的 `pl-…` 路由。

### 3.5 刪除台北的預設 VPC（建議）

進入 **VPC** 會看到兩個 VPC、兩個 `default` 安全群組：

| | CIDR | 怎麼來的 |
| --- | --- | --- |
| 預設 VPC | `172.31.0.0/16` | AWS 在每個區域自動建立 |
| `veilway-sandbox` | `10.0.0.0/16` | 剛才建立的 |

每個 VPC 建立時都會附帶一個 `default` 安全群組，無法刪除，也**不要使用**。

預設 VPC 的子網全是公有、會自動配發公有 IP，資源誤建在裡面就會直接暴露在網路上。Veilway 用不到它：

1. **VPC** → **你的 VPC** → 找到 CIDR `172.31.0.0/16`、「預設 VPC」欄位為「是」的那一個。
2. ⚠️ 確認**不是** `veilway-<環境>` → **動作** → **刪除 VPC** → 輸入確認文字 → **刪除**。它的子網、網際網路閘道、`default` 安全群組會一起刪除。

需要時可以用 **動作** → **建立預設 VPC** 重建，沒有風險。每個環境帳號的台北區域都建議刪除。

### 3.6 VPC interface endpoint

讓私有子網不經過 NAT 直接連到 AWS 服務：`ecr.api`、`ecr.dkr`、`logs`、`secretsmanager`、`sts`、`kms`；要用 ECS Exec 再加 `ssmmessages`。

每個 endpoint 每個 AZ 都按小時計費，6 個 × 2 AZ **每月約 90 美元**：

| 環境 | 做法 |
| --- | --- |
| sandbox | 已經有 NAT，功能上不需要。想練習就只建一個（例如 `secretsmanager`），練完就刪 |
| dev、staging、prod | 用 IaC 建立 |

建立方式：**VPC** → **端點** → **建立端點** → 服務搜尋名稱（例如 `secretsmanager`）→ VPC 選 `veilway-<環境>` → 子網勾 **app-a、app-b** → 安全群組選 `veilway-endpoints-sg`（3.7 建立）→ 勾選 **啟用私有 DNS 名稱** → **建立端點**。

### 3.7 建立 Security Group

⚠️ **名稱不能以 `sg-` 開頭**（AWS 保留給安全群組 ID，例如 `sg-0fb38ed6…`），一律用 `veilway-<用途>-sg`。名稱建立後不能修改。名稱裡不用加環境，因為各環境在不同帳號。

**先全部建立空的，再回頭設定規則**，因為規則會互相引用。

**VPC** → **安全群組** → **建立安全群組**，⚠️ **VPC 一定要選 `veilway-<環境>`**，不要選到預設 VPC。輸入規則先不加：

| 名稱 | 描述（只能英文） | 階段 |
| --- | --- | --- |
| `veilway-alb-sg` | `ALB from CloudFront` | 1 |
| `veilway-api-sg` | `API containers` | 1 |
| `veilway-rds-sg` | `RDS PostgreSQL` | 1 |
| `veilway-cache-sg` | `ElastiCache` | 1 |
| `veilway-endpoints-sg` | `VPC interface endpoints` | 1 |
| `veilway-ops-sg` | `One-off tasks` | 1（migration、開通工具等單次 task 使用） |
| `veilway-gateway-sg` | `Veilway gateway` | **2**（第一階段不用建，IaC 預留） |

建好後逐一點選 → **傳入規則** → **編輯傳入規則** → **新增規則**：

| 安全群組 | 類型 | 連接埠 | 來源 |
| --- | --- | --- | --- |
| `veilway-alb-sg` | HTTPS | 443 | **字首清單** `com.amazonaws.global.cloudfront.origin-facing` |
| `veilway-api-sg` | 自訂 TCP | 8080（容器的服務埠） | `veilway-alb-sg` |
| `veilway-rds-sg` | PostgreSQL | 5432 | `veilway-api-sg` |
| `veilway-rds-sg` | PostgreSQL | 5432 | `veilway-ops-sg` |
| `veilway-cache-sg` | 自訂 TCP | 6379 | `veilway-api-sg` |
| `veilway-endpoints-sg` | HTTPS | 443 | `veilway-api-sg` |
| `veilway-endpoints-sg` | HTTPS | 443 | `veilway-ops-sg` |
| `veilway-ops-sg` | 不加任何傳入規則 | | |
| `veilway-gateway-sg`（第二階段） | 自訂 TCP | 8080 | `veilway-api-sg` |

- 來源欄位輸入 `veilway-` 就會列出可選的安全群組。
- **傳出規則**保持預設（允許全部）。

### 3.8 暫時不用時：刪除 NAT（保留 VPC）

sandbox 帳號本身一直存在、免費，要刪的是帳號裡**會持續計費的資源**：

| 資源 | 費用 | 處理 |
| --- | --- | --- |
| VPC、子網、路由表、安全群組 | 免費 | 可以保留 |
| **NAT 閘道** | 按小時計費，**沒在用也收費**（每月約 35～45 美元） | 暫時不用時刪除 |
| NAT 用的**彈性 IP** | 公有 IPv4 按小時計費 | 刪 NAT 後一併釋放 |
| VPC interface endpoint | 按小時計費 | 練完就刪 |

各步驟是否需要 NAT：

| 步驟 | 需要 NAT 嗎 |
| --- | --- |
| 第 4 步 KMS、Secrets Manager | 不需要 |
| 第 5.1 步 建立 RDS | 不需要 |
| 第 5.2 步 連進資料庫建帳號 | **需要**（啟動暫時的容器或跳板機） |
| 第 6 步 ElastiCache、第 7 步 Cognito | 不需要 |
| 第 9 步 ECS Fargate | **需要**（從 ECR 下載映像檔，或改建 VPC endpoint） |

**刪除 NAT**：

1. **VPC** → **NAT 閘道** → 選 `veilway-sandbox-nat-…` → **動作** → **刪除 NAT 閘道** → 輸入 `delete`。
2. 等狀態變成「已刪除」（約 1 分鐘）。
3. **VPC** → **彈性 IP** → 選 NAT 用的那個 → **動作** → **釋放彈性 IP 位址**。要等 NAT 完全刪除後才能釋放。

刪除後，app 子網路由表的 `0.0.0.0/0` 會顯示「**黑洞**」（Blackhole），這是正常的。

**建回 NAT**：

1. **NAT 閘道** → **建立 NAT 閘道**：名稱 `veilway-sandbox-nat`、子網 `veilway-sandbox-public-a`、連線類型 **公有**、按 **配置彈性 IP** → 建立。
2. `app-a`、`app-b` 的路由表 → **編輯路由** → `0.0.0.0/0` 的目標改成新的 `nat-…` → **儲存**。

### 3.9 整輪練習結束：刪除整個 VPC

在 sandbox 照手冊走完一輪、改用 IaC 建 dev 之後，sandbox 的 VPC 就用不到了。依序：

1. 刪除 VPC 裡的其他資源：ECS service、ALB、RDS、ElastiCache 等（之後步驟建立的）。有資源還在使用子網或安全群組時，VPC 刪不掉。
2. 刪除 NAT 閘道、VPC interface endpoint（3.8）。
3. **VPC** → **你的 VPC** → 選 `veilway-sandbox` → **動作** → **刪除 VPC**。子網、路由表、網際網路閘道、安全群組、S3 閘道端點會一起刪除。
4. 釋放彈性 IP。

之後要再練習，用精靈重建只要幾分鐘。

### 驗證

- [ ] VPC `veilway-<環境>`（`10.0.0.0/16`）有正確數量的子網，名稱都已改好
- [ ] 路由表名稱都已改好；主路由表只有 `local` 一條路由
- [ ] 資料子網的路由表裡**沒有** `0.0.0.0/0`
- [ ] 應用子網的路由表有 `0.0.0.0/0 → nat-…`（NAT 刪除期間顯示黑洞）
- [ ] 台北的預設 VPC 已刪除
- [ ] 6 個安全群組都建立在 `veilway-<環境>` VPC；`veilway-rds-sg`、`veilway-cache-sg` 只允許上表列出的安全群組連入

### 注意事項

- ⚠️ **第一階段的已知限制**：應用子網經 NAT 可以連到任何外部網址。出口管控（egress proxy 或 AWS Network Firewall 加網域 allowlist）排在**第二階段**，和閘道 service 一起上線。在那之前，**任何環境都不放 AI 服務的 API key**。
- CloudFront 的字首清單在安全群組裡會佔用約 50 條規則的額度（每個安全群組預設上限 60 條），`veilway-alb-sg` 不要再加其他規則。
- 安全群組的規則要用「另一個安全群組」當來源，不要寫死 IP。
- NAT Gateway 按小時和流量計費，是 dev、sandbox 環境裡最容易被忽略的費用。
- 第二階段會在這個 VPC 加上 Claude Platform on AWS 的 PrivateLink endpoint，屆時只允許 `veilway-gateway-sg` 連到它。

---

## 第 4 步：KMS 與 Secrets Manager

**目的**：準備加密金鑰和密碼的存放位置。

以下在 **`veilway-<環境>` 帳號、亞太地區（台北）** 操作，不需要 NAT。

### 4.1 要建立的金鑰

| 別名 | 用途 | 金鑰政策 |
| --- | --- | --- |
| `veilway-data` | 加密 RDS、ElastiCache、應用程式的 S3 檔案 | **保持預設** |
| `veilway-logs` | 加密 CloudWatch Logs | **要另外允許 CloudWatch Logs**（4.3） |

每把金鑰每月約 1 美元；開啟自動輪替後，前兩次輪替各會多一點費用。

#### 為什麼只有 `veilway-logs` 要改金鑰政策

差別在於「誰去使用這把金鑰」：

| 金鑰 | 使用方式 | 預設政策夠不夠 |
| --- | --- | --- |
| `veilway-data` | RDS、ElastiCache、S3 是**代替建立資源的人**使用金鑰，用的是建立者的權限 | **夠** |
| `veilway-logs` | CloudWatch Logs 用 **AWS 服務自己的身分**（`logs.ap-east-2.amazonaws.com`）直接使用金鑰 | **不夠**，要另外允許 |

主控台產生的預設金鑰政策包含兩部分：

1. **帳號本身**（`arn:aws:iam::<帳號ID>:root`）有完整權限，意思是「交給 IAM 管理」：只要某個角色的 IAM 政策允許使用這把金鑰，它就能用。所以第 9 步 ECS task role 要使用 `veilway-data` 時，只要在 **task role 的 IAM 政策**加權限，不用改金鑰政策。
2. 建立時選的**金鑰管理員**可以管理金鑰。

> ⚠️ **例外**：凡是由 AWS 服務以**自己的身分**存取的資源（例如 CloudWatch Logs、CloudFront 透過 OAC 讀 S3），用客戶受管金鑰加密時都要在金鑰政策裡另外允許該服務。所以第 11 步的**前台 S3 bucket 使用 S3 預設加密（SSE-S3）**，不用 `veilway-data`；前台是公開的網頁靜態檔，不是機密資料。

### 4.2 建立 `veilway-data`

**KMS** → 左側 **客戶受管金鑰** → **建立金鑰**。

**步驟 1：設定金鑰**

| 欄位 | 設定 |
| --- | --- |
| 金鑰類型 | **對稱** |
| 金鑰用途 | **加密和解密** |
| 進階選項 → 金鑰材料來源 | **KMS**（預設） |
| 進階選項 → 區域性 | **單一區域金鑰**（預設） |

**步驟 2：新增標籤**

| 欄位 | 設定 |
| --- | --- |
| 別名 | `veilway-data` |
| 描述 | `Encrypt RDS, S3, ElastiCache`（建議用英文） |
| 標籤（選填） | `Project` = `veilway`、`Env` = `<環境>` |

標籤輸入方式：在「標籤金鑰」輸入 `Project` → 按 Enter 或點下方「使用：Project」確認 → 在「標籤值」輸入 `veilway` → 確認 → **新增標籤** 加下一組。「新增唯一的金鑰」只是提示：同一把 KMS 金鑰上，每個標籤名稱只能出現一次。各環境已經用帳號分開，帳單本來就分開列出，標籤現階段不是必要的；之後用 IaC 建立時會自動加上。

**步驟 3：定義金鑰管理許可**

- 金鑰管理員：勾選名稱類似 **`AWSReservedSSO_AdministratorAccess_xxxx`** 的角色（從 Identity Center 入口網站登入時使用的角色）。
- **允許金鑰管理員刪除此金鑰**：sandbox、dev 保留勾選；**prod 取消勾選**。

**步驟 4：定義金鑰用量許可**

**先不用選**。ECS task role 在第 9 步用 IAM 政策授權；RDS、ElastiCache 用建立者的權限使用金鑰。

**步驟 5：檢閱** → **完成**。

**開啟自動輪替**：點進 `veilway-data` → **金鑰輪換** 分頁 → **編輯** → 勾選 **自動輪換此 KMS 金鑰** → 輪替週期 **365 天** → **儲存**。輪替後舊資料仍能解密，不用重新加密。

### 4.3 建立 `veilway-logs` 並修改金鑰政策

照 4.2 再建一把，差別：別名 `veilway-logs`、描述 `Encrypt CloudWatch Logs`。同樣開啟自動輪替。

**修改金鑰政策**：

1. 點進 `veilway-logs` → **金鑰政策** 分頁 → **切換到政策檢視** → **編輯**。
2. 找到 `"Statement": [`，在它後面換行，貼上下面這段。把 `<帳號ID>` 換成該環境帳號的 12 位數 ID（右上角帳號名稱的下拉選單可以看到），**最後的逗號要保留**：

```json
    {
      "Sid": "AllowCloudWatchLogs",
      "Effect": "Allow",
      "Principal": { "Service": "logs.ap-east-2.amazonaws.com" },
      "Action": [
        "kms:Encrypt*",
        "kms:Decrypt*",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:Describe*"
      ],
      "Resource": "*",
      "Condition": {
        "ArnLike": {
          "kms:EncryptionContext:aws:logs:arn": "arn:aws:logs:ap-east-2:<帳號ID>:log-group:*"
        }
      }
    },
```

3. **儲存變更**。原本的兩段（帳號根身分、金鑰管理員）**不要刪除或修改**。

`Condition` 限制只有這個帳號在台北的 log group 能使用這把金鑰。

### 4.4 租戶金鑰：先決定做法，不用建立

第一階段只決定做法；真正用到是第二階段的對照表，現在不用建立任何租戶金鑰。

| 做法 | 優點 | 缺點 |
| --- | --- | --- |
| 每個租戶一把 KMS 金鑰 | 隔離最清楚，可以單獨停用某租戶的金鑰 | 每把每月約 1 美元；租戶多時費用與帳號內的金鑰數量上限要評估 |
| 一把主金鑰 + 每個租戶各自的資料金鑰（envelope encryption） | 費用固定 | 要自己管理資料金鑰的儲存與輪替 |

建議在租戶數量規劃確定、第二階段開始前定案。不論哪一種：

- **建立金鑰的權限只給「平台開通工具」**（第 9 步的 `veilway-provision` task）。API 的 task role 只有使用金鑰（Encrypt／Decrypt）的權限，**沒有** `kms:CreateKey`。
- 每個租戶一把金鑰時：別名 `alias/veilway/tenant/<tenant_id>`，金鑰 ARN 存進 `tenants.kms_key_arn`，金鑰政策只允許後端的 task role 使用。

### 4.5 Secrets Manager：這一步不用做

RDS 的主帳號密碼會在第 5 步由 RDS 自動存進 Secrets Manager；其他密碼（應用程式帳號、快取 AUTH、ALB 密鑰標頭）在各自的步驟建立。

### 4.6 刪除程序

⚠️ KMS 金鑰**不能立即刪除**，只能排程在 7～30 天後刪除，期間可以取消。刪除後，用它加密的資料**永遠無法解開**。

sandbox 整輪練習結束時：

1. 先確認用這把金鑰加密的資源都已刪除：RDS（含快照）、ElastiCache、log group、S3 物件等。
2. **KMS** → **客戶受管金鑰** → 選金鑰 → **金鑰動作** → **排程金鑰刪除** → 等待期間填 **7** 天 → 勾選確認 → **排程刪除**。
3. 等待期間內發現還有資料需要，可以選金鑰 → **金鑰動作** → **取消金鑰刪除**，取消後金鑰會是「已停用」，要再手動**啟用**。

暫時不用時不需要刪除：金鑰費用很低，刪除後重建反而要重新設定政策和輪替。

### 驗證

- [ ] **KMS** → **客戶受管金鑰**：有 `veilway-data`、`veilway-logs` 兩把，狀態「已啟用」
- [ ] 兩把的 **金鑰輪換** 都已開啟，週期 365 天
- [ ] `veilway-logs` 的金鑰政策裡有 `AllowCloudWatchLogs`，帳號 ID 正確
- [ ] 金鑰管理員是 Identity Center 的管理員角色

### 注意事項

- 金鑰政策寫錯，可能連管理員都無法再管理這把金鑰。政策裡一定要保留帳號根身分（`:root`）那一段。
- 金鑰和使用它的資源必須在**同一區域**。這兩把都建在台北。

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
| 部署方式 | Single-AZ | **Multi-AZ**（評估 Multi-AZ DB cluster，切換時間較短） |
| 帳密 | **Manage master credentials in AWS Secrets Manager** | 同左 |
| 執行個體 | Graviton 小型機型（例如 `db.t4g` 系列） | 依負載評估 |
| 儲存 | gp3，開啟 storage autoscaling | 同左 |
| 網路 | 第 3 步的 VPC、DB subnet group；**Public access：No**；SG：`veilway-rds-sg` | 同左 |
| 加密 | 開啟，用 `veilway-data` | 同左 |
| 備份 | 保留 7 天 | 保留 14～35 天 |
| 刪除保護 | 可關閉 | **開啟** |
| Performance Insights | 開啟 | 開啟 |

3. **強制使用 SSL**：建立自訂的 parameter group，設定 `rds.force_ssl = 1`，套用到資料庫後重新啟動。
4. **不要記錄含密碼的 SQL**：parameter group 的 `log_statement` 保持 `none` 或 `ddl`。設成 `ddl` 時，`CREATE ROLE ... PASSWORD` 也會被記錄，所以建立帳號時請照 5.2 的方式設定密碼。

### 5.2 建立帳號、資料庫與擴充

資料庫在私有子網，從外面連不進去。用 ECS Exec 進到一個暫時的容器（SG 用 `veilway-ops-sg`），或用 Session Manager 搭配一台跳板機，再用 `psql` 連線。

**先用主帳號連到預設的 `postgres` 資料庫：**

```sql
-- 擁有資料表的帳號：只給 migration 使用
CREATE ROLE veilway_owner LOGIN;

-- 應用程式使用的帳號：不能擁有資料表，也不能略過 RLS
CREATE ROLE veilway_app LOGIN NOBYPASSRLS;

-- 平台開通工具使用的帳號：可以建立租戶，但不能略過 RLS
CREATE ROLE veilway_platform LOGIN NOBYPASSRLS;

-- PostgreSQL 16 起，主帳號要先成為 veilway_owner 的成員，才能把資料庫交給它
GRANT veilway_owner TO CURRENT_USER;

CREATE DATABASE veilway OWNER veilway_owner;
REVOKE ALL ON DATABASE veilway FROM PUBLIC;
GRANT CONNECT ON DATABASE veilway TO veilway_app, veilway_platform;
```

**設定密碼**：用 `psql` 的 `\password veilway_owner`（依序對三個帳號執行），密碼不會出現在 SQL 文字或日誌裡。密碼由 Secrets Manager 產生（`aws secretsmanager get-random-password`），存成 `veilway/<env>/db/owner`、`veilway/<env>/db/app`、`veilway/<env>/db/platform`。

**再連到 `veilway` 資料庫**（`\c veilway`）：

```sql
-- ⚠️ 擴充是裝在「單一資料庫」裡的，一定要在 veilway 資料庫內執行
-- pgvector 第三階段的 RAG 才會用到，先啟用沒有額外成本
CREATE EXTENSION IF NOT EXISTS vector;

-- 資料表都放在 app schema，由 veilway_owner 擁有
CREATE SCHEMA app AUTHORIZATION veilway_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO veilway_app, veilway_platform;
```

### 5.3 資料表與 Row-Level Security（由 migration 建立）

以下由 migration 以 `veilway_owner` 身分執行。

```sql
SET search_path = app;

-- 方案：平台層級的資料，沒有 tenant_id
CREATE TABLE plans (
  id                 text PRIMARY KEY,          -- 例如 'basic'、'pro'
  name               text NOT NULL,
  max_users          int  NOT NULL,
  monthly_ai_tokens  bigint NOT NULL,           -- 第二階段的計量會用到
  max_storage_gb     int  NOT NULL              -- 第三階段的檔案會用到
);

-- 租戶：平台層級的資料，由平台開通工具管理
CREATE TABLE tenants (
  id          uuid PRIMARY KEY,
  subdomain   text NOT NULL UNIQUE
              CHECK (subdomain ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$'),
  name        text NOT NULL,
  plan_id     text NOT NULL REFERENCES plans(id),
  status      text NOT NULL DEFAULT 'active',   -- active／suspended
  kms_key_arn text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 使用者：一位使用者只屬於一個租戶，email 在整個平台唯一
CREATE TABLE users (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  cognito_sub text NOT NULL UNIQUE,
  email       text NOT NULL UNIQUE,
  role        text NOT NULL,                    -- tenant_admin／member
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 共用的租戶判斷式：沒有設定、或設定被清成空字串時都回傳 NULL
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;   -- 連資料表擁有者也要遵守

CREATE POLICY tenant_isolation ON users
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON users TO veilway_app, veilway_platform;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO veilway_app, veilway_platform;

-- 平台開通工具可以管理租戶和方案
GRANT SELECT, INSERT, UPDATE ON tenants, plans TO veilway_platform;

-- API 不能直接讀 tenants，只能透過這個函式用子網域查租戶
CREATE FUNCTION resolve_tenant(p_subdomain text)
  RETURNS TABLE (tenant_id uuid, status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$ SELECT id, status FROM app.tenants WHERE subdomain = p_subdomain $$;

REVOKE ALL ON FUNCTION resolve_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO veilway_app;
```

**之後每張帶 `tenant_id` 的資料表都要照 `users` 的模式建立**：`ENABLE` + `FORCE ROW LEVEL SECURITY`，政策用 `current_tenant_id()`。

建議在 CI 加一個檢查：查詢 `pg_class`，凡是有 `tenant_id` 欄位但沒有開啟 `relrowsecurity` 和 `relforcerowsecurity` 的資料表，測試就失敗。

### 5.4 應用程式怎麼設定租戶（EF Core）

應用程式在**每個交易開始時**設定目前的租戶：

```sql
SELECT set_config('app.tenant_id', '<tenant_id>', true);  -- 第三個參數 true：只在這個交易內有效
```

做法：

- **所有存取都包在明確的交易裡**。用 EF Core 的 `DbTransactionInterceptor`，在 `TransactionStarted` 時執行上面這句。
- **不要**在 `DbConnectionInterceptor`（開啟連線時）執行 `set_config(..., true)`：在交易之外執行時，它只對那一句自己的隱含交易有效，下一句查詢就沒有租戶了。
- **不要**用 `SET app.tenant_id = ...` 或 `set_config(..., false)`：設定會留在連線上，連線池把連線借給下一個請求時就會外洩。
- 開啟 `EnableRetryOnFailure` 時，明確交易要包在 `Database.CreateExecutionStrategy().ExecuteAsync(...)` 裡，否則 EF Core 會拒絕執行。
- 加一道保險：在 `DbCommandInterceptor` 裡檢查，對帶 `tenant_id` 的資料表下指令時如果不在交易內，就直接丟例外。

### 驗證

- [ ] 從公網連不到資料庫
- [ ] `veilway` 資料庫內查得到 vector 擴充：`SELECT extname FROM pg_extension;`
- [ ] 用 `veilway_app` 連線、**沒有設定** `app.tenant_id` 時，查詢 `users` 拿到 0 筆
- [ ] 在同一條連線上，先在一個交易裡設定租戶 A 並提交，再查詢 `users`：拿到 0 筆、**沒有錯誤**
- [ ] 設定租戶 A 之後，只看得到 A 的資料；嘗試寫入租戶 B 的資料會被拒絕
- [ ] `veilway_app` 直接 `SELECT * FROM app.tenants` 會被拒絕；呼叫 `app.resolve_tenant('acme')` 可以拿到結果

### 注意事項

- ⚠️ **RLS 最常見的三個漏洞**：
  1. 應用程式用了資料表擁有者或主帳號連線 → RLS 被略過。所以應用程式只能用 `veilway_app`，並且要加上 `FORCE ROW LEVEL SECURITY`。
  2. 用 `SET` 或 session 範圍的設定 → 連線池造成租戶設定殘留。
  3. `current_setting(...)::uuid` 沒有加 `nullif` → 交易結束後設定變成空字串，連線被重用時查詢直接出錯。
- 主帳號（master）只用來做管理，不要給應用程式或 migration 使用。
- `SECURITY DEFINER` 函式一定要設定 `search_path`，否則可能被同名物件劫持。
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
   - 驗證：開啟 **AUTH** 或 RBAC 使用者，密碼存進 Secrets Manager（`veilway/<env>/cache`）
   - SG：`veilway-cache-sg`

### 存放內容規劃

| 用途 | key 範例 | 存活時間 |
| --- | --- | --- |
| Session（登出後讓 token 失效） | `session:revoked:<jti>` | 等於 token 剩餘的有效時間 |
| API 限流 | `rl:<tenant_id>:<user_id>:<分鐘>` | 1～2 分鐘 |
| 第二階段：AI 額度 | `quota:<tenant_id>:<日期>` | 1 天 |

### 快取故障時的處理（請先定案）

| 功能 | 建議 | 理由 |
| --- | --- | --- |
| 一般 API 的限流 | **放行**（fail-open），並觸發告警 | 限流是保護措施，不該讓整個服務停擺 |
| 一般 API 的登出名單檢查 | **放行**，並觸發告警 | access token 有效時間短（15 分鐘），風險有限 |
| 管理功能（建立使用者、變更角色） | **拒絕**（fail-closed） | 權限高，寧可暫停 |

### 驗證

- [ ] 從容器內可以用 TLS 連到 ElastiCache；沒帶密碼時被拒絕

### 注意事項

- ⚠️ **不放對照表、不放任何真名或個資**（這是 Veilway2.md 的規則）。key 只能用 ID。
- 開啟傳輸加密後，程式端的連線字串必須加上 `ssl=true`，否則會一直逾時，而且錯誤訊息不明確。

---

## 第 7 步：Cognito（登入）

**目的**：建立使用者登入，並讓 token 帶上 `tenant_id`。

### 登入流程

Cognito 不接受萬用字元的 callback 網址，所以所有租戶共用一個登入入口，登入完成後再回到原本的租戶子網域：

| 主機 | 用途 |
| --- | --- |
| `auth.example.com` | Cognito 的登入頁（自訂網域，第 11 步才設定；在那之前用 Cognito 預設網域） |
| `login.example.com` | 共用的 callback 與登出頁，由同一個 SPA 提供 |
| `<租戶>.example.com` | 租戶的前台 |

1. 使用者在 `acme.example.com` 按登入。前台產生 PKCE 的 verifier 和隨機的 `state`，存在**自己的** sessionStorage，`state` 裡帶著租戶子網域。
2. 導向 Cognito 登入頁，`redirect_uri = https://login.example.com/callback`。
3. 登入成功後，Cognito 帶著 authorization code 導回 `login.example.com/callback`。
4. callback 頁**不換 token**，只做一件事：從 `state` 取出子網域，**驗證格式**（只能是 `^[a-z0-9-]+$`，且不在保留名稱內），再導向 `https://<子網域>.example.com/auth/complete?code=…&state=…`。
5. 租戶前台核對 `state`，用自己存的 verifier 和**同一個** `redirect_uri` 向 Cognito 換 token，換完立刻把網址上的 code 清掉（`history.replaceState`）。

> ⚠️ 第 4 步的驗證不能省。少了它，`login.example.com` 就是一個 open redirect，攻擊者可以把 code 導到自己的網站。

### 操作

1. **Cognito** → **User pools** → **Create user pool**：
   - 應用程式類型：**Single-page application (SPA)**
   - 登入方式：Email；**Email 不分大小寫**
   - **關閉自行註冊（self sign-up）**：使用者一律由租戶管理員或平台開通工具建立（見下方「使用者怎麼建立」）
   - 方案：**Essentials** 以上（自訂 access token 需要，見第 4 項）
   - MFA：設為 **Optional**（租戶管理員必須使用，做法見下方注意事項）
2. **自訂屬性**：新增 `custom:tenant_id`（字串，不可變更 **mutable = false**）。
   - ⚠️ 在 app client 的屬性權限中，把 `custom:tenant_id` 設為**使用者不可寫入**。否則使用者可以把自己改到別的租戶。
3. **App client**：
   - 類型：Public client（**不要有 client secret**，SPA 無法安全保存它）
   - OAuth：Authorization code grant + **PKCE**；scope：`openid`、`email`
   - Allowed callback URL：`https://login.example.com/callback`
   - Allowed sign-out URL：`https://login.example.com/logout`
   - Token 有效時間：access token **15 分鐘**；refresh token 依需求（例如 8 小時到 30 天）
   - 開啟 **Token revocation**（預設開啟，請確認）
4. **讓 access token 帶上 `tenant_id`**：
   - 加上 **Pre token generation** Lambda trigger（**V2 事件格式**），把 `custom:tenant_id` 加進 access token。
   - ⚠️ 自訂 **access token** 需要 Cognito 的 **Essentials 或 Plus** 方案；Lite 方案只能自訂 ID token。
5. **登入稽核**：加上 **Post authentication** Lambda trigger，每次登入成功時寫一筆結構化日誌到 `/veilway/<env>/audit/login`（`sub`、`tenant_id`、時間、來源 IP）。登入失敗與帳號鎖定的紀錄看 CloudTrail 中的 Cognito 事件。
6. **登入頁網域**：先用 Cognito 預設網域（`<prefix>.auth.ap-east-2.amazoncognito.com`）。自訂網域 `auth.example.com` 要等第 11 步建好根網域的 A 記錄後才能設定。

### 使用者怎麼建立

| 情況 | 誰執行 | 做法 |
| --- | --- | --- |
| 開通新租戶時的第一位管理員 | 平台開通工具（第 9 步的 `veilway-provision`） | 在 `tenants` 新增租戶 → Cognito `AdminCreateUser`（帶 `custom:tenant_id`）→ 在 `users` 新增一筆，角色 `tenant_admin` |
| 租戶內的其他使用者 | 租戶管理員透過 API | API 呼叫 `AdminCreateUser`（`custom:tenant_id` 由後端從 token 取得，不接受前台傳入）→ 在 `users` 新增一筆 |

兩個步驟中途失敗時，要能重跑（以 email 判斷是否已建立），不要留下只有一邊存在的使用者。

### 驗證

- [ ] 建立測試使用者後能從 `acme.example.com` 登入，解開 access token 看得到 `tenant_id`
- [ ] 使用者無法自行修改 `custom:tenant_id`
- [ ] 竄改 `state` 中的子網域（例如改成 `evil.com`）時，callback 頁拒絕轉址

### 注意事項

- **租戶管理員的 MFA**：Cognito 的 MFA 是整個 user pool 一起設定，不能只對某些人強制。做法是 pool 設為 Optional，指派 `tenant_admin` 角色時，後端用 `AdminGetUser` 確認對方已設定 MFA，沒有就不給角色；設定後用 `AdminSetUserMFAPreference` 把 MFA 設為必要。
- 自訂屬性建立後**無法刪除，也無法改名**，命名前請想清楚。
- API 端應驗證 **access token**，不要拿 ID token 當授權依據。
- ⚠️ **登出要做三件事**：① 呼叫 Cognito 的 `RevokeToken` 撤銷 refresh token（否則前台可以再換到新的 access token）② 把 access token 的 `jti` 寫進 ElastiCache 的失效名單 ③ 導向 Cognito 的 `/logout`，清掉登入頁的 session。

---

## 第 8 步：後端程式的必要設定（ASP.NET Core）

**目的**：在部署前，把第一階段驗收需要的行為寫進程式。

| 項目 | 做法 |
| --- | --- |
| JWT 驗證 | 使用 `Microsoft.AspNetCore.Authentication.JwtBearer`，Authority 設為 Cognito user pool 的網址；驗證簽章、到期時間、`token_use = access`、`client_id` |
| 租戶解析 | 中介軟體從 `X-Tenant-Host` 標頭取出子網域 → 呼叫 `app.resolve_tenant()` 得到 tenant_id → **必須等於** token 裡的 `tenant_id`，不一致回 403；租戶狀態不是 `active` 也回 403。查詢結果可以在記憶體快取 1～5 分鐘 |
| RLS 設定 | 照第 5.4 節：明確交易 + `DbTransactionInterceptor` 執行 `set_config('app.tenant_id', …, true)` |
| 登出 | 照第 7 步的三件事；驗證 token 時一併檢查 ElastiCache 的失效名單 |
| 限流 | ⚠️ ASP.NET Core 內建的 Rate Limiter **只在單一容器的記憶體裡計數**，多個容器各算各的。請用 ElastiCache 實作分散式限流（自己寫固定視窗計數，或用 `RedisRateLimiting` 這類套件），再接到內建的 Rate Limiter 中介軟體；超過門檻回 **429** 並帶 `Retry-After` |
| 健康檢查 | `/healthz`：只檢查程式本身是否正常，給 ALB 用；`/readyz`：額外檢查 DB 與快取 |
| 資料庫密碼 | 用 Npgsql 的 `NpgsqlDataSourceBuilder.UsePeriodicPasswordProvider`，定期從 Secrets Manager 讀取 `veilway/<env>/db/app`。密碼輪替後不用重啟容器 |
| 其他設定 | 一般設定用環境變數；密碼一律從 Secrets Manager 讀取，不寫進程式碼或映像檔 |
| 資料庫重試 | 開啟 `EnableRetryOnFailure`，讓 RDS 切換可用區時能自動恢復（搭配第 5.4 節的 execution strategy） |
| 日誌 | 結構化日誌（JSON）。⚠️ **不記錄** Authorization 標頭、token、密碼、請求內容、authorization code |
| 服務埠 | 容器監聽 8080，不用 root 身分執行 |

### 注意事項

- ⚠️ 前面經過 CloudFront 和 ALB，程式收到的 Host 會是 `origin-api.example.com`，不是使用者的網址。請在 CloudFront 用 **CloudFront Function** 把使用者的原始 Host 寫進 `X-Tenant-Host` 標頭（見第 11 步），程式從這個標頭解析租戶。
- 租戶判斷**只信任 token 和這個標頭**，不要信任前台自己傳上來的 tenant_id 參數。
- 第一階段的程式不放任何呼叫 AI 的程式碼或套件。第二階段的閘道是另一個專案、另一個映像。

---

## 第 9 步：ECR 與 ECS Fargate

**目的**：把後端跑起來，並為第二階段的閘道預留結構。

### 服務切分

| 名稱 | 類型 | 階段 | 用途 | SG | Task role |
| --- | --- | --- | --- | --- | --- |
| `veilway-api` | service | 1 | 業務 API、租戶管理、媒體上傳 | `veilway-api-sg` | `veilway-api-task` |
| `veilway-migrate` | 單次 task | 1 | 執行資料庫 migration | `veilway-ops-sg` | `veilway-migrate-task` |
| `veilway-provision` | 單次 task | 1 | 平台開通工具：建立租戶、租戶金鑰、第一位管理員 | `veilway-ops-sg` | `veilway-provision-task` |
| `veilway-gateway` | service | **2** | 隱道閘道：唯一能連到外部模型的元件 | `veilway-gateway-sg` | `veilway-gateway-task` |

> **為什麼閘道要獨立**：SG 和 IAM role 都是以 task 為單位設定。閘道如果和業務 API 跑在同一個容器裡，第二階段「只有閘道能連到 PrivateLink endpoint、只有閘道的 role 能呼叫模型」就無法做到。

### 操作

1. **ECR** → **Create repository**：`veilway-api`、`veilway-migrate`（第二階段再加 `veilway-gateway`）：
   - 開啟 **Scan on push**（推上去時自動掃描弱點）
   - 開啟 **Tag immutability**（同一個版本標籤不能被覆蓋）
   - 設定 lifecycle policy，只保留最近 N 個映像
2. **IAM role**（execution role 和 task role 用途不同，不要搞混）：

| 角色 | 誰使用 | 權限 |
| --- | --- | --- |
| Task execution role（共用） | ECS 本身 | 從 ECR 拉映像、寫入 CloudWatch Logs |
| `veilway-api-task` | API 程式 | 讀取 `veilway/<env>/db/app`、`veilway/<env>/cache`；使用 KMS（Encrypt／Decrypt，不能建立金鑰）；Cognito `AdminCreateUser`、`AdminGetUser`、`AdminSetUserMFAPreference`（限定這個 user pool） |
| `veilway-migrate-task` | migration | 讀取 `veilway/<env>/db/owner` |
| `veilway-provision-task` | 開通工具 | 讀取 `veilway/<env>/db/platform`；`kms:CreateKey`、`kms:CreateAlias`；Cognito `AdminCreateUser` |
| `veilway-gateway-task` | 閘道（第二階段） | 呼叫 Claude Platform on AWS；**只有這個 role 有這個權限** |

3. **ECS** → **Clusters** → **Create cluster** → 名稱 `veilway-<env>`，基礎設施選 **AWS Fargate**，開啟 **Container Insights**。
   - 同時建立 **Service Connect** 的 namespace（例如 `veilway.internal`），第二階段 API 透過它呼叫閘道，不需要另外架內部 ALB。
4. **Task definition** → **Create**（`veilway-api`）：
   - Launch type：Fargate；CPU 架構：**ARM64**（Graviton 較便宜，映像也要用 ARM64 建置）
   - CPU / 記憶體：dev 先用 0.5 vCPU / 1 GB
   - 容器埠：8080
   - 環境變數放一般設定（Secrets 的名稱、user pool ID 等）；密碼由程式從 Secrets Manager 讀取（第 8 步）
   - 日誌：awslogs，log group `/veilway/<env>/api`
5. **Task definition**：`veilway-migrate`、`veilway-provision` 同樣方式建立，log group 分別為 `/veilway/<env>/migrate`、`/veilway/<env>/provision`。
6. **Service** → **Create**（`veilway-api`）：
   - Desired tasks：dev 1；**prod 至少 2**
   - 子網：**私有應用子網**；**Public IP：關閉**；SG：`veilway-api-sg`
   - 開啟 **Deployment circuit breaker** 和 **rollback**（部署失敗時自動退回上一版）
   - Load balancer 在第 10 步建立後再接上（也可以先建 ALB 再建 service）

### 驗證

- [ ] 容器狀態為 RUNNING，CloudWatch Logs 看得到啟動訊息
- [ ] 容器沒有 public IP
- [ ] 手動執行一次 `veilway-migrate` task，exit code 為 0
- [ ] 用 `veilway-provision` 建立測試租戶 `acme` 和它的第一位管理員

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
   - Scheme：Internet-facing；子網：**公有子網**；SG：`veilway-alb-sg`
   - Listener **HTTPS 443**：使用第 2 步在**台北**申請的憑證
   - 預設動作：**回傳固定的 403**
   - 新增一條規則：**標頭 `X-Origin-Verify` 等於 `<一段隨機密鑰>`** 時，才轉送到 target group
3. 把 ECS service 接上這個 target group。
4. **DNS**：在 Route 53 新增 `origin-api.example.com`，**A（Alias）** 指向這個 ALB。CloudFront 會用這個名稱連 ALB（第 11 步）。
5. 把 `<隨機密鑰>` 存進 Secrets Manager，並安排定期更換（更換時 ALB 規則先同時接受新舊兩組值，CloudFront 改完後再移除舊值）。

### 驗證

- [ ] `https://origin-api.example.com` 的憑證有效（瀏覽器不會出現憑證錯誤）
- [ ] 直接連 ALB 會被拒絕（SG 只允許 CloudFront；就算連得到，沒有密鑰標頭也會拿到 403）
- [ ] target group 裡的容器顯示 healthy

### 注意事項

- 這樣設定之後，**只有經過 CloudFront 的請求**能到達後端，WAF 的防護才不會被繞過。
- 另一種做法是 CloudFront 的 **VPC origin**，ALB 可以放在私有子網、完全不對外。請確認台北區域是否支援後再評估。

---

## 第 11 步：S3 前台、CloudFront、WAF 與 DNS

**目的**：讓使用者透過租戶子網域打開前台，並把 `/api/*` 轉給後端。

### 操作

1. **S3 前台 bucket**（台北）
   - 名稱例如 `veilway-dev-web`；**Block all public access：開啟**；加密：**SSE-S3（S3 預設）**，不要用 `veilway-data`，否則 CloudFront 透過 OAC 讀取時會被 KMS 拒絕（見 4.1）
2. **WAF** ⚠️ **必須建在 us-east-1，範圍選 CloudFront（Global）**
   - **WAF & Shield** → **Web ACLs** → **Create** → Resource type：**Amazon CloudFront distributions**
   - 加入 AWS managed rules：Core rule set、Known bad inputs、IP reputation
   - 加入 rate-based rule（例如每個 IP 每 5 分鐘的請求上限）
3. **CloudFront** → **Create distribution**：
   - **Origin 1**：S3 前台 bucket，使用 **Origin Access Control（OAC）**；建立後依提示把 bucket policy 貼到 S3
   - **Origin 2**：⚠️ Origin domain 填 **`origin-api.example.com`**（不要填 ALB 的 `*.elb.amazonaws.com`）；Protocol：HTTPS only；加上自訂標頭 `X-Origin-Verify: <隨機密鑰>`
   - **Behavior `/api/*`** → Origin 2：允許所有 HTTP 方法；Cache policy：**CachingDisabled**；Origin request policy：轉送需要的標頭、查詢字串、Cookie（**不要轉送原始 Host**）
   - **Default behavior `/*`** → S3：Cache policy：CachingOptimized
   - **Alternate domain names**：`example.com`、`*.example.com`；憑證：第 2 步在 **us-east-1** 申請的那張
   - **Web ACL**：選第 2 項建立的 WAF
   - Viewer protocol policy：**Redirect HTTP to HTTPS**
4. **CloudFront Functions**（viewer request）：
   - 綁在 `/api/*`：把使用者的 Host **覆寫**到 `X-Tenant-Host` 標頭（一律覆寫，不能保留使用者自己帶的值）
   - 綁在 `/*`：把沒有副檔名的路徑改寫成 `/index.html`（SPA 前端路由需要）
5. **DNS**：**Route 53** → 新增兩筆 **A（Alias）** 記錄，指向這個 CloudFront distribution：
   - `example.com`
   - `*.example.com`（`login.example.com` 和所有租戶子網域都由這筆涵蓋）
6. **Cognito 自訂網域**（根網域的 A 記錄建好後才能做）：
   - **Cognito** → user pool → **Domain** → 自訂網域 `auth.example.com`，選 us-east-1 的憑證。
   - 依畫面提示，在 Route 53 新增 `auth.example.com` 的 Alias 記錄。明確的記錄會優先於萬用字元記錄。
   - 前台的設定改用 `auth.example.com`。
7. **部署前台**：`aws s3 sync` 上傳建置好的檔案；`index.html` 上傳時設定 `Cache-Control: no-cache`，帶雜湊值檔名的 JS、CSS 設定長期快取 → 對 CloudFront 執行 invalidation `/index.html`。

### 驗證

- [ ] `https://acme.example.com` 可以打開前台，重新整理任何頁面都不會出現 404
- [ ] `https://acme.example.com/api/healthz` 會回應，而且後端收到的 `X-Tenant-Host` 是 `acme.example.com`
- [ ] 自己在請求中帶 `X-Tenant-Host: beta.example.com`，後端收到的仍然是 `acme.example.com`
- [ ] 直接開 S3 bucket 的網址會被拒絕
- [ ] `https://auth.example.com` 顯示 Cognito 登入頁

### 注意事項

- ⚠️ **CloudFront 會驗證 origin 的憑證**：不轉送原始 Host 時，CloudFront 用 origin domain 的名稱連線並比對憑證。origin 填 ALB 的預設網址時，和 `*.example.com` 的憑證對不上，會一直回 502。
- ⚠️ **不要用 CloudFront 的「自訂錯誤回應」（把 403/404 改成 index.html）來處理 SPA 路由**。它對整個 distribution 生效，連 `/api/*` 的 404 也會被換成首頁，API 的錯誤會變得很難除錯。請用上面第 4 項的 CloudFront Function。
- CloudFront 設定變更需要幾分鐘才會在全球生效。

---

## 第 12 步：CloudWatch 監控與告警

**目的**：出問題時第一時間知道。

### 操作

1. **Log groups**：`/veilway/<env>/api`、`/migrate`、`/provision`、`/audit/login` 等，設定保留天數（dev 14 天；prod 依稽核規定，登入稽核建議至少 1 年），並用 `veilway-logs` 加密。
2. **告警**（**CloudWatch** → **Alarms**，通知送到 SNS 主題 → Email 或 Slack）：

| 告警 | 條件範例 |
| --- | --- |
| ALB 5xx 偏多 | 5 分鐘內 5xx 超過一定比例 |
| 後端不健康 | target group 的 healthy 數量 < 期望數量 |
| ECS | CPU 或記憶體持續 > 80% |
| RDS | CPU > 80%、可用儲存空間 < 20%、連線數接近上限 |
| ElastiCache | 記憶體使用率 > 80%、evictions > 0 |
| 快取連線失敗 | 程式記錄的快取錯誤數 > 0（第 6 步的 fail-open 正在發生） |
| WAF | 被擋下的請求突然大量增加 |
| 登入 | 登入失敗次數突然大量增加 |

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
2. **後端流程**：測試（含跨租戶測試、RLS 檢查）→ 建置 ARM64 映像 → 推到 ECR（標籤用 commit SHA）→ **執行 migration** → 更新 ECS task definition → 部署 service
3. **資料庫 migration** ⚠️ GitHub 的 runner 在 VPC 外面，**連不到 RDS**：
   - 把 migration 打包成 `veilway-migrate` 映像。
   - 部署流程用 `aws ecs run-task` 在私有應用子網啟動它（SG `veilway-ops-sg`），等待結束，**exit code 不是 0 就中止部署**。
   - 在新版程式上線前完成。
4. **前台流程**：測試 → 建置 → `s3 sync` → CloudFront invalidation
5. **環境保護**：在 GitHub 的 Environments 設定 prod 需要人工核准才能部署

### 注意事項

- ⚠️ **不要**把 AWS access key 存在 GitHub Secrets 裡，一律用 OIDC。
- ⚠️ IAM role 的信任條件一定要限制 repo 和分支，否則任何 GitHub repo 都可能拿到你的 AWS 權限。
- 部署用的 role 只需要 `ecs:RunTask`、`ecs:DescribeTasks`、`iam:PassRole`（限定那幾個 task role）等權限，不需要資料庫密碼。
- migration 要寫成「新舊版程式都能運作」（例如先加欄位、之後才刪欄位），避免部署途中出錯。

---

## 第 14 步：IaC 化與重建驗證

**目的**：把第 2 到 13 步的設定寫成 CDK，確保環境可以一鍵重建。

### 操作

1. 建立 CDK（C#）專案，按層拆成幾個 stack：

| Stack | 內容 | 區域 |
| --- | --- | --- |
| `GlobalStack` | us-east-1 的 ACM 憑證（CloudFront、Cognito 自訂網域共用）、CloudFront 用的 WAF | us-east-1 |
| `NetworkStack` | VPC、子網、NAT、VPC endpoint、SG（含第二階段的 `veilway-gateway-sg` 預留開關） | 台北 |
| `DataStack` | KMS、RDS、ElastiCache、Secrets | 台北 |
| `AuthStack` | Cognito、Pre token generation 與 Post authentication Lambda | 台北 |
| `AppStack` | ECR、ECS cluster、Service Connect namespace、ALB、`veilway-api` service、`veilway-migrate` 與 `veilway-provision` task | 台北 |
| `EdgeStack` | S3 前台、CloudFront、DNS、Cognito 自訂網域 | 台北（引用 us-east-1 的資源） |
| `GatewayStack` | **第二階段**：`veilway-gateway` service、task role、PrivateLink endpoint、出口管控 | 台北 |

2. 每個 ECS 服務寫成同一個 construct（映像、task role、SG、log group、desired count），第二階段新增閘道時直接套用。
3. 環境差異（AZ 數量、容器數量、Multi-AZ、刪除保護、網域）寫成設定，不要寫死在程式碼裡。
4. 用 CDK 部署 dev 與 staging，跑完第 15 步的驗收清單。
5. **重建演練**：用 CDK 刪除 dev，再用 CDK 重建一次，確認可以完全重現（包含執行 migration 與 `veilway-provision` 建立測試租戶）。

### 注意事項

- ⚠️ 有狀態的資源（RDS、S3、KMS）在 CDK 中要設定 **RemovalPolicy.RETAIN**（prod）並開啟刪除保護，避免一次 `cdk destroy` 就把資料刪光。dev 可以設成 DESTROY，重建演練才做得起來。
- 跨區域引用（台北的 stack 用到 us-east-1 的憑證）要開啟 CDK 的 `crossRegionReferences`。
- 第 5.2 節的建立帳號 SQL 不屬於 migration（需要主帳號），請寫成一個由 CDK custom resource 或 `veilway-provision` 在建立環境時執行一次的初始化步驟，重建時才不用手動補。
- 手動在主控台改過的設定，下次 CDK 部署時會被覆蓋。導入 IaC 後就不要再手動修改。

---

## 第 15 步：第一階段驗收

對應〈Veilway三階段執行計畫.md〉的驗收標準：

| # | 驗收項目 | 怎麼測 |
| --- | --- | --- |
| 1 | 使用者從租戶子網域登入，前台呼叫 API 成功 | 用 `acme.example.com` 登入，呼叫一支需要授權的 API |
| 2 | 拿 B 租戶的 token 到 A 租戶的子網域會被拒絕 | 自動化測試，預期 403 |
| 3 | A 租戶讀不到 B 租戶的資料 | 自動化測試：直接用 `veilway_app` 帳號查資料庫，以及透過 API 查詢，兩種都要測；包含「連線被重用」的情境 |
| 4 | 登出後舊 token 立即失效 | 登出後再用舊 access token 呼叫 API，預期 401；用舊 refresh token 換新 token，預期失敗 |
| 5 | 超過限流門檻回 429 | 用腳本短時間大量呼叫，**請求分散到不同容器**時也要觸發 |
| 6 | RDS、後端從公網連不到 | 從外部嘗試連線 RDS 端點和 ALB 直連網址 |
| 7 | 停掉一個容器或切換 RDS 可用區時，服務自動恢復（prod／staging） | 手動停止一個 task：不出現錯誤。對 RDS 執行 **Reboot with failover**：切換期間（通常 1～2 分鐘）可能有短暫錯誤，**之後不需要人工介入即自動恢復**，期間沒有資料遺失 |
| 8 | 環境可以用 IaC 重建 | 第 14 步的重建演練 |
| 9 | 日誌中沒有 token、密碼等敏感資訊 | Logs Insights 搜尋 `Bearer`、`password`、`eyJ`、`code=` 等關鍵字 |
| 10 | 登入有稽核紀錄 | 登入後在 `/veilway/<env>/audit/login` 查得到這次登入 |
| 11 | 每張帶 `tenant_id` 的資料表都開啟了 RLS | CI 的 RLS 檢查通過 |

> 驗收第 7 項的「服務不中斷」改成「自動恢復」：RDS 切換可用區時連線一定會斷，能做到的是程式自動重試、不需人工處理。若要縮短中斷時間，評估 Multi-AZ DB cluster。

---

## 附錄 A：常見陷阱總表

| 陷阱 | 後果 | 對策（步驟） |
| --- | --- | --- |
| 台北區域沒有手動開啟 | 所有資源都建不起來 | 第 1 步 |
| 成員帳號沒開台北就指派 Identity Center 許可集 | 指派一直卡在「進行中」，且無法移除 | 先完成 1.3，再做 1.4 G |
| 在台北開 CloudShell | 顯示 Region Unsupported | 切到東京再開（1.3 B） |
| Budgets 篩選「連結帳戶」找不到新帳號 | 無法替環境帳號建立預算 | 進入各帳號自己建立（1.5） |
| 委派子網域時 prod 的 NS 記錄值貼錯 | 子網域解析不到，憑證無法驗證 | 用 `dig` 比對（2.3） |
| 租戶取名 `dev`、`staging` | 和環境子網域衝突 | 加入保留名稱（第 0 步） |
| 安全群組名稱用 `sg-` 開頭 | 建立時被拒絕 | 改用 `veilway-<用途>-sg`（3.7） |
| 建安全群組時 VPC 選到預設 VPC | 之後建 RDS、ALB 時找不到 | 選 `veilway-<環境>`，並刪除預設 VPC（3.5） |
| 練習完沒刪 NAT | 每月持續計費約 35～45 美元 | 3.8 |
| `veilway-logs` 沒加 CloudWatch Logs 的金鑰政策 | log group 無法使用這把金鑰加密 | 4.3 |
| 前台 S3 bucket 用 KMS 金鑰加密 | CloudFront 讀不到檔案，回 403 | 前台用 SSE-S3（4.1、第 11 步） |
| CloudTrail bucket 先加禁止刪除政策才設生命週期 | 生命週期、版本控制都改不了 | 依 1.6 B 的順序設定 |
| 手動建的環境想直接轉成 IaC | 無法用 `cdk destroy` 刪除，重建演練做不了 | 手動練習放 sandbox 帳號（怎麼使用這份手冊） |
| CloudFront、Cognito 自訂網域的憑證或 WAF 建在台北 | 設定畫面選不到 | 都要建在 us-east-1（第 2、11 步） |
| 萬用憑證沒包含根網域 | `example.com` 出現憑證錯誤 | 申請時同時列出兩個名稱（第 2 步） |
| pgvector 建在 `postgres` 資料庫 | `veilway` 資料庫裡沒有 vector 型別 | 連到 `veilway` 後再建立擴充（第 5.2 步） |
| 應用程式用資料表擁有者連線 | RLS 失效，跨租戶資料外洩 | 用 `veilway_app` 並加 `FORCE ROW LEVEL SECURITY`（第 5 步） |
| 用 `SET` 設定租戶 | 連線池造成租戶設定殘留 | 用 `set_config(..., true)`（第 5.4 步） |
| RLS 政策沒有 `nullif` | 連線被重用時查詢出錯 | 用 `current_tenant_id()`（第 5.3 步） |
| 在開啟連線時設定交易範圍的租戶 | 下一句查詢就沒有租戶 | 用明確交易 + 交易攔截器（第 5.4 步） |
| 使用者可以修改 `custom:tenant_id` | 使用者把自己改到別的租戶 | 設為不可寫入（第 7 步） |
| callback 頁轉址沒驗證子網域 | open redirect，authorization code 外洩 | 驗證格式與保留名稱（第 7 步） |
| 登出只撤銷 access token | 用 refresh token 又拿到新 token | 呼叫 `RevokeToken`（第 7 步） |
| 用內建 Rate Limiter 就以為是全域限流 | 每個容器各算各的，門檻形同放大 | 用 ElastiCache 做分散式計數（第 8 步） |
| CloudFront origin 填 ALB 預設網址 | 憑證不符，一直回 502 | 用 `origin-api.example.com`（第 10、11 步） |
| 用自訂錯誤回應處理 SPA 路由 | API 的 404 也變成首頁 | 用 CloudFront Function（第 11 步） |
| ALB 可以被直接存取 | WAF 被繞過 | SG 限制 CloudFront + 密鑰標頭（第 10 步） |
| 閘道和 API 跑在同一個容器 | 第二階段的出口鎖定無法做到 | 閘道拆成獨立 service（第 9 步） |
| 映像架構與 task definition 不一致 | 容器一直啟動失敗 | 統一用 ARM64（第 9 步） |
| GitHub Actions 直接連 RDS 跑 migration | 連不到私有子網 | 用 ECS run-task（第 13 步） |
| GitHub 存放 AWS 長期金鑰 | 金鑰外洩風險 | 改用 OIDC（第 13 步） |
| 日誌沒設保留天數 | 費用持續累積 | 每個 log group 都設定（第 12 步） |

## 附錄 B：費用注意

dev 環境放著不用也會持續計費的項目：**NAT Gateway、RDS、ElastiCache、ALB、Fargate 容器、VPC interface endpoint**（每個 endpoint 依可用區按小時計費）、WAF 的規則與請求數、Cognito Essentials 方案（依每月活躍使用者計費）。

省錢做法：

- dev 用最小規格、單 AZ。
- 下班或週末用排程把 dev 的 Fargate desired count 調成 0、暫停 RDS（RDS 暫停最多 7 天後會自動啟動）。
- sandbox 帳號練習完就清空。
- 用 Budgets 告警盯緊每月花費。

正式的費用估算，請用 AWS Pricing Calculator 依實際規格試算。

## 附錄 C：交接給第二階段的項目

第一階段刻意不做、但已經預留的項目：

| 項目 | 第一階段的狀態 | 第二階段要做 |
| --- | --- | --- |
| 隱道閘道 | IaC 有 `GatewayStack` 的位置、`veilway-gateway-sg` 預留、Service Connect namespace 已建立 | 建立 `veilway-gateway` service 與 task role；API 透過 Service Connect 呼叫閘道 |
| 出口管控 | 應用子網經 NAT 可以完整對外（已知限制） | egress proxy 或 Network Firewall 加網域 allowlist，**不放行任何 AI 服務的網域**；只有閘道能連 PrivateLink endpoint |
| 租戶金鑰 | 做法已定案、開通工具能建立 | 對照表用租戶金鑰加密 |
| 方案與額度 | `plans` 資料表已建立 | 閘道計量寫入、ElastiCache 做即時額度 |

---

## 參考

- [Amazon Cognito 已在台北區域上線（2026-03）](https://aws.amazon.com/about-aws/whats-new/2026/03/cognito-taipei-and-new-zealand-regions)
- [AWS 台北區域開放公告](https://aws.amazon.com/blogs/aws/now-open-aws-asia-pacific-taipei-region/)
- [啟用或停用 AWS 區域（opt-in regions）](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-regions.html)
