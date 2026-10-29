# 💬 School LINE Hub - 校園官方帳號智慧推播與家長綁定統一管理中樞

[![Google Apps Script](https://img.shields.io/badge/Backend-Google%20Apps%20Script-4285F4?logo=google)](https://developers.google.com/apps-script)
[![LINE Messaging API](https://img.shields.io/badge/LINE-Messaging%20API-00C300?logo=line)](https://developers.line.biz/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**School LINE Hub** 是一個專為校園、班級與教育專案設計的 **LINE 官方帳號推播與家長綁定統一管理系統**。

---

## 📌 為什麼需要 School LINE Hub？

在學校或班級環境中，老師可能同時使用多個微型系統：
- 📝 **作業清點與手札系統** (`RP_QR_CC_HW`)
- 📊 **平時成績與評量系統** (`MPScore-Daily`)
- 🏫 **未來可能擴充之出席、聯絡簿或活動通知系統**

#### 傳統分散模式的痛點：
1. **家長體驗混亂**：各系統分散運作時，家長需要在不同的介面重複綁定 LINE，或者加多個官方帳號，親師溝通體驗割裂。
2. **架構高度耦合**：成績系統為了取得家長 LINE UID，必須寫程式跨表讀取作業系統的試算表（`openByUrl`），一旦試算表更名或欄位變更，推播立刻中斷。
3. **金鑰管理困難**：每個專案都必須持有 LINE Channel Access Token，權杖更換時必須手動更新所有專案。
4. **配額無法掌控**：LINE 官方帳號每月有免費訊息額度上限，多個專案各自分散發送極易超量。

#### School LINE Hub 的解決方案：
- 🎯 **單一中樞管理**：只有本中樞持有 LINE Token 與接收 LINE Webhook。
- 👨‍👩‍👧 **家長只需綁定一次**：家長綁定一次學生，全校/全班所有業務系統即時共享該綁定關係（Single Source of Truth）。
- 🔑 **專案代碼安全接入**：其他業務專案無須配置 LINE Token，只需在中樞後台申請 **`App ID`** 與 **`Secret Key`**，即可透過標準 API 發送推播。
- 🛡️ **個資保護去識別化**：中樞對外提供之 API 均對姓名與 LINE UID 進行掩碼遮罩，保護學生與家長隱私。

---

## 🏛️ 系統架構圖

```mermaid
flowchart TD
    subgraph LINE [LINE 官方帳號平台]
        L_OA[LINE Messaging API / Webhook]
    end

    subgraph Hub [School LINE Hub (本專案)]
        H_API[API 閘道 doPost / doGet]
        H_Webhook[LINE Webhook 處理器<br>加好友 / 綁定碼 / 查詢 / 解綁]
        H_DB[(Google 試算表資料庫<br>1. SystemConfig<br>2. AuthorizedProjects<br>3. ParentBindings<br>4. PushLogs)]
        H_Pusher[推播發送引擎<br>配額計算 / 速率保護]

        H_API <--> H_DB
        H_Webhook <--> H_DB
        H_API --> H_Pusher
        H_Pusher -->|LINE Push API| L_OA
    end

    subgraph Clients [業務端系統]
        C1[作業繳交系統 (RP_QR)]
        C2[成績管理系統 (MPScore)]
        C3[未來校園新專案...]
    end

    L_OA <-->|唯一 Webhook 端點| H_Webhook
    C1 -->|帶入 AppID + Secret| H_API
    C2 -->|帶入 AppID + Secret| H_API
    C3 -.->|帶入 AppID + Secret| H_API
```

---

## 📂 目錄結構

```text
School-LINE_Hub-/
├── README.md               # 專案總覽與建置教學
├── API.md                  # 子專案接入 RESTful API 完整規範
├── index.html              # 現代化 Web 管理儀表板介面
├── gas/
│   ├── Code.gs             # 中樞核心後端程式（GAS 伺服端）
│   └── appsscript.json     # GAS 資訊清單設定檔 (V8, Asia/Taipei)
└── client-sdk/
    └── LineHubClient.js    # 供子專案直接複製引用的輕量客戶端 SDK
```

---

## 🚀 部署指南（5 分鐘快速建置）

### 步驟 1：建立中樞專用 Google 試算表
1. 前往 [Google 雲端硬碟](https://drive.google.com/)，建立一份新的 Google 試算表，命名為 `【中樞】校園LINE智慧管理資料庫`。
2. 點選試算表頂端選單的 **「擴充功能」** > **「Apps Script」**。

### 步驟 2：匯入中樞後端程式碼
1. 將本專案 `gas/Code.gs` 的內容完整貼入 Apps Script 的 `程式碼.gs`。
2. 在 Apps Script 編輯器中新增一個 HTML 檔案，命名為 `index.html`，並將本專案的 `index.html` 貼入。
3. （選用）在 Apps Script 設定中勾選顯示 `appsscript.json`，並複製貼入本專案之設定。
4. 在函式下拉選單中選擇 **`initSpreadsheetStructure`** 並執行一次，授權 Google 權限後，系統將自動於試算表中建立四大標準工作表：
   - ⚙️ **`SystemConfig`**：儲存 LINE Channel Access Token 與基本設定。
   - 🔑 **`AuthorizedProjects`**：管理允許接入之子專案代碼與金鑰。
   - 👨‍👩‍👧 **`ParentBindings`**：家長 LINE UID 與學生學號/座號對應主表。
   - 📊 **`PushLogs`**：所有子專案的推播紀錄與稽核 Log。

### 步驟 3：設定 LINE Developers
1. 前往 [LINE Developers Console](https://developers.line.biz/)，開啟您的 Messaging API Channel。
2. 複製 **Channel access token (long-lived)**。
3. 回到試算表中的 **`SystemConfig`** 工作表，在 A1 的 JSON 物件中貼入此 Token：
   ```json
   {
     "lineChannelAccessToken": "您的 Channel Access Token 貼在這裡",
     "schoolName": "幸福國小 6年1班"
   }
   ```

### 步驟 4：發布中樞 Web App
1. 在 Apps Script 編輯器右上角點擊 **「部署」** > **「新增部署作業」**。
2. 種類選擇 **「網頁應用程式 (Web App)」**：
   - **執行身分**：`我 (您的帳號)`
   - **誰可以存取**：`所有人 (Anyone)`
3. 部署完成後複製 **「網頁應用程式網址 (Web App URL)」**。

### 步驟 5：綁定 LINE Webhook
1. 回到 LINE Developers 後台的 **Messaging API** 標籤頁。
2. 將剛才複製的 Web App URL 貼到 **Webhook URL** 欄位。
3. 開啟 **Use webhook** 開關，並點擊 **Verify**，顯示 `Success` 即代表中樞架設完成！

---

## 💻 子專案如何「輸入代碼」接入？

任何其他專案（如 `RP_QR_CC_HW` 或 `MPScore-Daily`）只需以下 2 個步驟即可完成推播整合：

### 1. 取得專案代碼
在中樞試算表的 `AuthorizedProjects` 工作表中查看或新增您的專案：
- **App ID**：例如 `PROJECT_HW`
- **Secret Key**：例如 `sec_hw_demo_9823471`

### 2. 在子專案中引入 Client SDK
將 `client-sdk/LineHubClient.js` 複製到子專案，並於後台填入代碼即可發送：

```javascript
// 初始化客戶端
var hub = new LineHubClient({
  hubUrl: "https://script.google.com/macros/s/您的中樞DeploymentId/exec",
  appId: "PROJECT_HW",
  appSecret: "sec_hw_demo_9823471"
});

// 測試連線
var status = hub.testConnection();
Logger.log(status);

// 發送推播通知
var result = hub.sendPushNotification({
  seatNo: "05",
  studentName: "王小明",
  title: "🚨 【今日作業缺交通知】",
  body: "國語生字語詞簿 第七課 尚未繳交，請今晚撥冗陪伴孩子補齊！",
  url: "https://example.com/portal?token=HW05"
});
```

---

## 👨‍👩‍👧 家長端使用體驗

1. **加好友與歡迎訊息**：家長加入班級 LINE 官方帳號時，中樞自動提示綁定方式。
2. **免手續費/快速代碼綁定**：家長在對話框中傳送 `#學生代碼`（例如 `#A102`）或輸入 `綁定 05 王小明`，中樞即可完成安全綁定。
3. **主動查詢**：平時傳送「`查詢`」，中樞自動列出已綁定之學生資訊。
4. **自主解除**：傳送「`解除綁定`」，即可隨時退出通知。
5. **親師私訊保護**：非系統關鍵字與代碼時，機器人完全靜默，完整保留親師 1 對 1 真人交談空間。

---

## 📜 開源授權
本專案採用 [MIT License](LICENSE) 授權釋出。
