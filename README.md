# 💬 School LINE Hub - 校園官方帳號智慧推播與家長綁定統一管理中樞

[![Google Apps Script](https://img.shields.io/badge/Backend-Google%20Apps%20Script-4285F4?logo=google)](https://developers.google.com/apps-script)
[![LINE Messaging API](https://img.shields.io/badge/LINE-Messaging%20API-00C300?logo=line)](https://developers.line.biz/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**School LINE Hub** 是一個專為校園、班級與教育專案設計的 **LINE 官方帳號推播與家長綁定統一管理系統**。

---

## 📌 核心特色

- 🎯 **單一中樞管理**：只有本中樞持有 LINE Token 與接收 LINE Webhook，金鑰集中保管。
- 👨‍👩‍👧 **家長只需綁定一次**：家長在官方帳號綁定一次學生代碼，作業手札、成績單、校園聯絡簿全系統即時共享。
- 🔄 **永不失效自動熱更新**：試算表只需貼入 15 行 `Loader.gs` 引導碼，未來任何改版全自動無感同步，終生免手動重新複製貼上程式碼。
- 🇹🇼 **純繁體中文親民分頁**：試算表支援「系統設定」、「授權專案名單」、「家長綁定名冊」、「推播紀錄」，直覺易懂。
- 🔑 **專案代碼安全接入**：其他業務專案無須配置 LINE Token，只需在後台設定 `App ID` 與 `Secret Key`，即可透過標準 API 發送推播。
- 🛡️ **個資保護去識別化**：中樞對外提供之 API 均對姓名與 LINE UID 進行掩碼遮罩（如 `王○明`），全面保護學生與家長隱私。

---

## 🏛️ 系統架構圖

```mermaid
flowchart TD
    subgraph LINE [LINE 官方帳號平台]
        L_OA[LINE Messaging API / Webhook]
    end

    subgraph Hub [School LINE Hub (中樞專案)]
        H_API[API 閘道 doPost / doGet]
        H_Webhook[LINE Webhook 處理器<br>加好友 / 綁定碼 / 查詢 / 解綁]
        H_DB[(Google 試算表資料庫<br>1. 系統設定<br>2. 授權專案名單<br>3. 家長綁定名冊<br>4. 推播紀錄)]
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
├── CHANGELOG.md            # 詳細系統版本更新紀錄
├── API.md                  # 子專案接入 RESTful API 完整規範
├── index.html              # 現代化 Web 管理儀表板介面 (純淨校園風格)
├── gas/
│   ├── Loader.gs           # 穩健秒速自動熱更新引導碼 (用戶端唯一需要貼上的檔案)
│   ├── Core.js             # 中樞核心業務引擎 (由 Loader 動態載入執行)
│   └── appsscript.json     # GAS 資訊清單設定檔 (V8, Asia/Taipei)
└── client-sdk/
    └── LineHubClient.js    # 供子專案直接複製引用的輕量客戶端 SDK
```

---

## 🚀 部署指南（5 分鐘快速建置）

### 步驟 1：建立中樞專用 Google 試算表
1. 前往 Google 雲端硬碟，建立一份全新 Google 試算表，命名為 `【中樞】校園LINE推播管理總庫`。
2. 點選試算表頂端選單的 **「擴充功能」 ➔ 「Apps Script」**。

### 步驟 2：貼上穩健引導碼並執行初始化
1. 將本專案 `gas/Loader.gs` 的內容貼入 Apps Script 編輯器中並按儲存。
2. 在函式選單中選擇 **`initSpreadsheetStructure`** 並執行一次，試算表將在 1 秒內自動長出 4 個繁體中文分頁：
   - ⚙️ **`系統設定`**：儲存 LINE Channel Access Token 與基本設定。
   - 🔑 **`授權專案名單`**：管理允許接入之子專案代碼與金鑰。
   - 👨‍👩‍👧 **`家長綁定名冊`**：家長 LINE UID 與學生學號/座號對應主表。
   - 📜 **`推播紀錄`**：所有子專案的推播紀錄與稽核 Log。

### 步驟 3：設定 LINE Developers
1. 前往 [LINE Developers Console](https://developers.line.biz/)，開啟您的 Messaging API Channel。
2. 複製 **Channel access token (long-lived)**。
3. 回到試算表中的 **`系統設定`** 分頁，在 A1 的 JSON 物件中貼入此 Token。

### 步驟 4：發布中樞 Web App
1. 在 Apps Script 編輯器右上角點擊 **「部署」 ➔ 「新增部署作業」**。
2. 種類選擇 **「網頁應用程式 (Web App)」**：
   - **執行身分**：`我 (您的帳號)`
   - **誰可以存取**：`所有人 (Anyone)`
3. 部署完成後複製 **「網頁應用程式網址 (Web App URL)」**。

### 步驟 5：綁定 LINE Webhook
1. 回到 LINE Developers 後台的 **Messaging API** 標籤頁。
2. 將剛才複製的 Web App URL 貼到 **Webhook URL** 欄位。
3. 開啟 **Use webhook** 開關，並點擊 **Verify**，顯示 `Success` 即代表中樞架設完成！

---

## 💻 子專案接入方式

在子專案中引入 `client-sdk/LineHubClient.js`，填入中樞網址與代碼即可發送推播：

```javascript
// 初始化中樞客戶端
var hub = new LineHubClient({
  hubUrl: "https://script.google.com/macros/s/您的中樞DeploymentId/exec",
  appId: "PROJECT_HW",
  appSecret: "sec_hw_demo_9823471"
});

// 發送推播通知給指定學生家長 (中樞自動查找 LINE UID 並送出)
var result = hub.sendPushNotification({
  seatNo: "05",
  studentName: "王小明",
  title: "🚨 【今日作業缺交通知】",
  body: "國語生字語詞簿 第七課 尚未繳交，請今晚撥冗提醒孩子補齊！",
  url: "https://example.com/portal?token=HW05"
});
```

---

## 📜 更新歷程與授權
詳細版本歷史請參閱 [CHANGELOG.md](CHANGELOG.md)。本專案採用 MIT License 授權。
