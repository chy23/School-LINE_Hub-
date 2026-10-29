# School LINE Hub API 規範與接入指南

School LINE Hub 是一個專門為學校與班級微型專案（作業清點系統、成績系統、聯絡簿、圖書館借還書等）打造的 **LINE 官方帳號推播與家長綁定統一管理中樞**。

其他專案不再需要直接設定 LINE 的 Channel Access Token，亦不再需要跨試算表竊讀個資，只需透過本規範定義的 RESTful API 即可實現即時推播與綁定查詢。

---

## 🔐 1. 身分驗證機制 (Authentication)

所有子專案呼叫中樞 API 時，必須在 HTTP POST 的 JSON Body 中帶入兩組憑證：
- `appId` (字串)：專案的唯一識別碼（由中樞管理員核發，例如 `PROJECT_HW`）。
- `appSecret` (字串)：專案接入密碼（例如 `sec_hw_demo_9823471`）。

若驗證失敗，中樞將回傳 HTTP `401 Unauthorized`：
```json
{
  "status": "unauthorized",
  "message": "身分驗證失敗：無效的 appId 或 appSecret，或專案已被停用"
}
```

---

## 📡 2. API 介面規格

- **端點 URL**：`https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec`
- **HTTP Method**：`POST`
- **Content-Type**：`application/json`

---

### (1) 測試連線與驗證 (Verify Connection)
供子專案設定後台檢查中樞連線是否正常，並取得目前授權配額與綁定概況。

**Request Payload:**
```json
{
  "action": "verify_client",
  "appId": "PROJECT_HW",
  "appSecret": "sec_hw_demo_9823471"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "message": "連線成功！",
  "projectName": "作業繳交手札系統 (RP_QR)",
  "appId": "PROJECT_HW",
  "monthlyQuota": 1000,
  "usedCount": 42,
  "activeBindingsCount": 28,
  "serverTime": "2026-10-29T08:15:20.123Z"
}
```

---

### (2) 查詢單一學生家長綁定狀態 (Get Student Binding)
確認某位學生是否已有家長綁定 LINE。

**Request Payload:**
```json
{
  "action": "get_student_binding",
  "appId": "PROJECT_HW",
  "appSecret": "sec_hw_demo_9823471",
  "target": {
    "seatNo": "05" // 可傳入 seatNo, studentId 或 token 任一
  }
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "isBound": true,
  "boundCount": 1,
  "studentName": "王○明",
  "seatNo": "05"
}
```

---

### (3) 批次取得全班綁定對照清單 (Get All Bindings Summary)
供子專案前端介面顯示全班各座號的「已綁定 / 未綁定」狀態指標（基於個資法保護，學生姓名自動去識別化，不曝露 LINE UID）。

**Request Payload:**
```json
{
  "action": "get_all_bindings_summary",
  "appId": "PROJECT_HW",
  "appSecret": "sec_hw_demo_9823471"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "totalBoundStudents": 25,
  "bindings": {
    "1": { "isBound": true, "studentName": "李○華", "seatNo": 1 },
    "2": { "isBound": false, "studentName": "陳○豪", "seatNo": 2 },
    "3": { "isBound": true, "studentName": "張○婷", "seatNo": 3 }
  }
}
```

---

### (4) 發送單一或批次推播 (Send Push Notification)
向已綁定家長發送即時通知訊息。若一位學生有多位家長綁定（如父、母各一），中樞會自動推播給該學生的所有家長。

#### 範例 A：單一學生推播（使用標題、內文與連結結構）
**Request Payload:**
```json
{
  "action": "send_push",
  "appId": "PROJECT_HW",
  "appSecret": "sec_hw_demo_9823471",
  "target": {
    "seatNo": "05",
    "studentName": "王小明",
    "title": "🚨 【今日作業缺交通知】",
    "body": "今日學校清點作業，尚有 2 項作業待補交：\n‧ 【數學】隨堂講義 P.15\n‧ 【國語】生字語詞簿 第七課",
    "url": "https://hw.example.com/parent?token=HW05"
  }
}
```

#### 範例 B：批次推播（共用樣板）
**Request Payload:**
```json
{
  "action": "send_push",
  "appId": "PROJECT_SCORE",
  "appSecret": "sec_score_demo_7182934",
  "messageTemplate": {
    "title": "📊 【第一次定期評量成績通知】",
    "body": "孩子本次評量成績單已完成登錄，請家長參閱。"
  },
  "targets": [
    { "seatNo": "01", "url": "https://score.example.com/s/01" },
    { "seatNo": "02", "url": "https://score.example.com/s/02" },
    { "seatNo": "05", "url": "https://score.example.com/s/05" }
  ]
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "sentCount": 3,
  "failedCount": 0,
  "skippedCount": 0,
  "details": [
    { "target": "01", "uid": "U123456789...", "status": "success" },
    { "target": "02", "uid": "U987654321...", "status": "success" },
    { "target": "05", "uid": "U112233445...", "status": "success" }
  ]
}
```

---

### (5) 學生名冊同步/預建 (Register Students Master)
子專案可在新學期開始時，批次將座號、學號、姓名與專屬代碼同步給中樞建立基礎資料。

**Request Payload:**
```json
{
  "action": "register_students",
  "appId": "PROJECT_HW",
  "appSecret": "sec_hw_demo_9823471",
  "students": [
    { "seatNo": "01", "studentName": "李小華", "token": "A101" },
    { "seatNo": "02", "studentName": "陳大豪", "token": "A102" }
  ]
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "message": "學生資料同步完成",
  "added": 2,
  "updated": 0
}
```
