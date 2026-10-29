/**
 * =========================================================================
 * LineHubClient.js - School LINE Hub 客戶端 SDK
 * =========================================================================
 * 
 * 適用環境：Google Apps Script (GAS) 或任何現代 JavaScript 執行環境。
 * 作用：外部專案（如作業繳交系統、成績管理系統、圖書館借還書等）透過此 SDK，
 *      只需設定中樞網址 (Hub URL) 與專案接入代碼 (App ID + Secret)，
 *      即可免除直接操作 LINE Messaging API 的繁瑣步驟，實現免重複綁定推播！
 * 
 * 使用範例 (在 GAS 專案中)：
 * -------------------------------------------------------------
 * var hub = new LineHubClient({
 *   hubUrl: "https://script.google.com/macros/s/AKfycb.../exec",
 *   appId: "PROJECT_HW",
 *   appSecret: "sec_hw_demo_9823471"
 * });
 * 
 * // 1. 測試連線
 * var test = hub.testConnection();
 * Logger.log(test);
 * 
 * // 2. 單一學生推播
 * var result = hub.sendPushNotification({
 *   seatNo: "05",
 *   studentName: "王小明",
 *   title: "🚨 【今日作業缺交通知】",
 *   body: "今日數學講義第 12 頁尚未繳交，請今晚提醒孩子補齊！",
 *   url: "https://example.com/portal?token=B101"
 * });
 * Logger.log(result);
 * -------------------------------------------------------------
 */

(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LineHubClient = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {

  function LineHubClient(config) {
    if (!config || !config.hubUrl || !config.appId || !config.appSecret) {
      throw new Error("LineHubClient 初始化失敗：必須提供 hubUrl, appId 與 appSecret！");
    }
    this.hubUrl = config.hubUrl.trim();
    this.appId = config.appId.trim();
    this.appSecret = config.appSecret.trim();
    this.timeout = config.timeout || 30000;
  }

  /**
   * 內部 HTTP POST 封裝（相容 Google Apps Script UrlFetchApp 與標準 fetch）
   */
  LineHubClient.prototype._post = function(action, extraPayload) {
    var payload = Object.assign({
      action: action,
      appId: this.appId,
      appSecret: this.appSecret
    }, extraPayload || {});

    var jsonStr = JSON.stringify(payload);

    // GAS 環境
    if (typeof UrlFetchApp !== 'undefined') {
      try {
        var resp = UrlFetchApp.fetch(this.hubUrl, {
          method: 'post',
          contentType: 'application/json',
          payload: jsonStr,
          muteHttpExceptions: true
        });
        var code = resp.getResponseCode();
        var body = resp.getContentText();
        var parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          parsed = { status: 'error', code: code, raw: body };
        }
        return parsed;
      } catch (gasErr) {
        return { status: 'error', message: gasErr.toString() };
      }
    }

    // 瀏覽器或 Node.js fetch 環境
    if (typeof fetch !== 'undefined') {
      return fetch(this.hubUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonStr
      }).then(function(res) {
        return res.json();
      }).catch(function(err) {
        return { status: 'error', message: err.toString() };
      });
    }

    throw new Error("找不到可用的 HTTP 客戶端 (UrlFetchApp 或 fetch)！");
  };

  /**
   * 1. 測試中樞連線與驗證金鑰
   * @returns {Object} { status: 'success', projectName, activeBindingsCount, ... }
   */
  LineHubClient.prototype.testConnection = function() {
    return this._post('verify_client');
  };

  /**
   * 2. 查詢特定學生的家長綁定狀況
   * @param {Object} target - { seatNo: "01" } 或 { studentId: "S001" } 或 { token: "A102" }
   * @returns {Object} { isBound: true|false, boundCount: 1, studentName: "王○明", ... }
   */
  LineHubClient.prototype.getStudentBinding = function(target) {
    return this._post('get_student_binding', { target: target });
  };

  /**
   * 3. 批次取得全班綁定對照表（已去個資遮罩）
   * @returns {Object} { totalBoundStudents: 28, bindings: { "01": { isBound: true, ... } } }
   */
  LineHubClient.prototype.getAllBindingsSummary = function() {
    return this._post('get_all_bindings_summary');
  };

  /**
   * 4. 同步學生清冊名單到中樞（預設建檔）
   * @param {Array<Object>} studentsList - [{ seatNo: "01", studentName: "王小明", token: "A101" }, ...]
   */
  LineHubClient.prototype.registerStudents = function(studentsList) {
    return this._post('register_students', { students: studentsList });
  };

  /**
   * 5. 發送單一推播通知
   * @param {Object} options - 推播選項
   *   options.seatNo: 學生座號
   *   options.studentName: 學生姓名
   *   options.title: 通知主旨 (例: 🚨 【每日作業缺交通知】)
   *   options.body: 內文說明 (例: 國語講義 P.12 待補齊)
   *   options.url: (選填) 點擊手札或明細的專屬連結
   *   options.customMessage: (選填) 完全自訂純文字訊息
   */
  LineHubClient.prototype.sendPushNotification = function(options) {
    return this._post('send_push', {
      target: {
        seatNo: options.seatNo,
        studentId: options.studentId,
        studentName: options.studentName,
        token: options.token,
        title: options.title,
        body: options.body,
        url: options.url,
        customMessage: options.customMessage
      }
    });
  };

  /**
   * 6. 批次發送多人推播
   * @param {Array<Object>} targets - 每一項包含座號/姓名/各自內文
   * @param {Object} messageTemplate - 共用標題與格式範本
   */
  LineHubClient.prototype.sendBatchPush = function(targets, messageTemplate) {
    return this._post('send_push', {
      targets: targets,
      messageTemplate: messageTemplate
    });
  };

  return LineHubClient;
}));
