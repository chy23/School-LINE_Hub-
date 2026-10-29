/**
 * =========================================================================
 * School LINE Hub - 校園 LINE 官方帳號推播與家長綁定統一管理中樞
 * =========================================================================
 * 
 * 核心職責：
 * 1. 唯一管理 LINE Messaging API Channel Access Token 與 Webhook
 * 2. 集中維護「全校/全班學生與家長 LINE UID」綁定主表（Single Source of Truth）
 * 3. 提供安全 RESTful API，供已授權子專案（作業繳交、成績系統、校園公告等）接入與推播
 * 4. 統一稽核、記錄推播發送狀態、管控各專案額度
 */

// 工作表常數定義
var SHEETS = {
  CONFIG: 'SystemConfig',
  PROJECTS: 'AuthorizedProjects',
  BINDINGS: 'ParentBindings',
  LOGS: 'PushLogs'
};

/**
 * 處理 HTTP GET 請求（健康檢查或管理後台頁面）
 */
function doGet(e) {
  var param = (e && e.parameter) || {};
  
  // 若呼叫 API 檢查健康狀態
  if (param.action === 'ping') {
    return createJsonResponse({
      status: 'ok',
      service: 'School-LINE-Hub',
      time: new Date().toISOString()
    });
  }

  // 預設渲染中樞管理儀表板 HTML
  try {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('School LINE Hub - 管理控制中心')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch(err) {
    return HtmlService.createHtmlOutput('<h2>School LINE Hub 中樞服務正常運作中</h2><p>時間：' + new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) + '</p>');
  }
}

/**
 * 處理 HTTP POST 請求（雙軌處理：LINE Webhook 與 子專案 API 呼叫）
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000); // 避免併發寫入衝突
  } catch (err) {
    return createJsonResponse({ status: 'error', message: '系統忙碌中，請稍候重試' }, 429);
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ status: 'error', message: '缺少請求資料' }, 400);
    }

    var payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return createJsonResponse({ status: 'error', message: 'JSON 解析失敗' }, 400);
    }

    // =========================================================================
    // 軌道一：處理 LINE 官方帳號 Webhook 事件
    // =========================================================================
    if (payload.events !== undefined) {
      return handleLineWebhook(payload.events);
    }

    // =========================================================================
    // 軌道二：處理子專案 API 接入請求
    // =========================================================================
    if (payload.action) {
      return handleClientApi(payload);
    }

    return createJsonResponse({ status: 'error', message: '無效的請求格式' }, 400);

  } catch (fatalErr) {
    console.error('doPost 致命錯誤:', fatalErr);
    return createJsonResponse({ status: 'error', message: fatalErr.toString() }, 500);
  } finally {
    try { lock.releaseLock(); } catch(e) {}
  }
}

// =============================================================================
// LINE Webhook 處理邏輯
// =============================================================================

function handleLineWebhook(events) {
  // LINE 後台點擊「Verify (驗證)」按鈕時，events 為空陣列
  if (!events || events.length === 0) {
    return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
  }

  var token = getSystemConfig('lineChannelAccessToken');

  events.forEach(function(ev) {
    try {
      // 1. 關注 / 加好友事件
      if (ev.type === 'follow') {
        var welcomeMsg = "👋 您好！歡迎加入【校園班級智慧推播中樞】。\n\n" +
          "為了能精準接收孩子的作業缺繳、成績評量與學校重要通知，請傳送「學生專屬代碼」或「座號+姓名」進行綁定。\n\n" +
          "💡 範例：輸入「#B101」或「綁定 05 王小明」\n" +
          "隨時輸入「查詢」可檢視已綁定之學生資訊。";
        replyLine(token, ev.replyToken, welcomeMsg);
        return;
      }

      // 2. 文字訊息事件
      if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
        var userMsg = ev.message.text.trim();
        var userId = ev.source ? ev.source.userId : '';
        var replyToken = ev.replyToken;

        if (!userId) return;

        // (a) 輸入「查詢」、「狀態」
        if (userMsg === '查詢' || userMsg === '狀態' || userMsg === '查學生' || userMsg.toLowerCase() === 'info') {
          var bindings = getBindingsByLineUserId(userId);
          if (bindings.length === 0) {
            replyLine(token, replyToken, "ℹ️ 您目前尚未綁定任何學生。\n\n請輸入學生專屬綁定代碼（例如：#B101）完成連結！");
          } else {
            var msg = "📋 【已綁定學生名冊】\n";
            bindings.forEach(function(b, idx) {
              msg += "\n" + (idx + 1) + ". " + maskName(b.studentName) + "（" + (b.seatNo ? "座號 " + b.seatNo : b.studentId) + "）\n" +
                     "   綁定時間：" + b.boundAt.substring(0, 10);
            });
            msg += "\n\n💡 只要老師發布各項專案通知（作業手札、成績單等），系統將自動為您推播！";
            replyLine(token, replyToken, msg);
          }
          return;
        }

        // (b) 輸入「解除綁定」或「取消綁定」
        if (userMsg === '解除綁定' || userMsg === '取消綁定' || userMsg === '解綁') {
          var unbindCount = unbindByLineUserId(userId);
          if (unbindCount > 0) {
            replyLine(token, replyToken, "✅ 已成功解除 " + unbindCount + " 位學生的綁定。日後若要重新接收通知，可隨時再次輸入代碼綁定！");
          } else {
            replyLine(token, replyToken, "ℹ️ 您目前沒有任何已綁定的學生紀錄。");
          }
          return;
        }

        // (c) 綁定代碼解析：
        // 格式 1: #代碼 (如 #A102, #TOKEN...)
        // 格式 2: 綁定 座號 姓名 (如 綁定 05 王小明)
        // 格式 3: 純代碼 (6碼以上英數)
        var bindMatch = false;

        // 規則 1：#開頭 或 純代碼
        var tokenCandidate = "";
        if (userMsg.indexOf('#') === 0) {
          tokenCandidate = userMsg.substring(1).trim().toUpperCase();
        } else if (/^[A-Za-z0-9]{4,16}$/.test(userMsg) && !/^(查詢|狀態)$/.test(userMsg)) {
          tokenCandidate = userMsg.toUpperCase();
        }

        if (tokenCandidate) {
          var bindRes = bindByToken(tokenCandidate, userId);
          if (bindRes.success) {
            replyLine(token, replyToken, "🎉 綁定成功！\n\n已成功將 LINE 綁定至學生：【" + maskName(bindRes.studentName) + "】（座號 " + bindRes.seatNo + "）。\n日後作業缺繳、評量成果等最新通知將即時發送至此對話！");
            bindMatch = true;
          }
        }

        // 規則 2：輸入「綁定 05 王小明」
        if (!bindMatch && (userMsg.indexOf('綁定') === 0 || userMsg.indexOf('登記') === 0)) {
          var parts = userMsg.replace(/^(綁定|登記)[:\s]*/, '').trim().split(/\s+/);
          if (parts.length >= 2) {
            var seatCandidate = parts[0];
            var nameCandidate = parts[1];
            var bindSeatRes = bindBySeatAndName(seatCandidate, nameCandidate, userId);
            if (bindSeatRes.success) {
              replyLine(token, replyToken, "🎉 綁定成功！\n\n已成功將 LINE 綁定至學生：【" + maskName(bindSeatRes.studentName) + "】（座號 " + bindSeatRes.seatNo + "）。");
              bindMatch = true;
            }
          }
        }

        // 若不是系統指令且未命中綁定，保持靜默（保留親師真人 1 對 1 溝通空間）
      }
    } catch(evErr) {
      console.error('處理事件失敗:', evErr);
    }
  });

  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
}

// =============================================================================
// 子專案 API 接入邏輯 (Client API)
// =============================================================================

function handleClientApi(payload) {
  var action = payload.action;
  var appId = (payload.appId || '').toString().trim();
  var appSecret = (payload.appSecret || '').toString().trim();

  // 1. 系統公開 API (如中樞內部初始化)
  if (action === 'system_init') {
    initSpreadsheetStructure();
    return createJsonResponse({ status: 'success', message: '中樞工作表初始化建立完成' });
  }

  // 2. 驗證專案接入金鑰
  var project = verifyProjectAuth(appId, appSecret);
  if (!project) {
    return createJsonResponse({ 
      status: 'unauthorized', 
      message: '身分驗證失敗：無效的 appId 或 appSecret，或專案已被停用' 
    }, 401);
  }

  // (A) 測試連線 (Ping / Verify)
  if (action === 'ping' || action === 'verify_client') {
    var boundCount = getActiveBindingsCount();
    return createJsonResponse({
      status: 'success',
      message: '連線成功！',
      projectName: project.projectName,
      appId: project.appId,
      monthlyQuota: project.monthlyQuota,
      usedCount: project.usedCount,
      activeBindingsCount: boundCount,
      serverTime: new Date().toISOString()
    });
  }

  // (B) 查詢特定學生的綁定狀態
  if (action === 'get_student_binding') {
    var target = payload.target || {};
    var bindings = findBindings(target);
    return createJsonResponse({
      status: 'success',
      isBound: bindings.length > 0,
      boundCount: bindings.length,
      studentName: bindings.length > 0 ? maskName(bindings[0].studentName) : '',
      seatNo: bindings.length > 0 ? bindings[0].seatNo : ''
    });
  }

  // (C) 批次取得全班綁定對照表（回傳座號/代碼是否已綁定，保護個資不曝露 LINE UID）
  if (action === 'get_all_bindings_summary') {
    var allBindings = getAllBindingsSummary();
    return createJsonResponse({
      status: 'success',
      totalBoundStudents: Object.keys(allBindings).length,
      bindings: allBindings
    });
  }

  // (D) 同步/預先登記學生資料（供子專案將學生名冊或專屬代碼註冊進中樞）
  if (action === 'register_students') {
    var students = payload.students || [];
    var upsertRes = upsertStudentsMaster(students);
    return createJsonResponse({
      status: 'success',
      message: '學生資料同步完成',
      added: upsertRes.added,
      updated: upsertRes.updated
    });
  }

  // (E) 發送推播訊息 (Push Notification) - 單一或批次
  if (action === 'send_push') {
    var lineToken = getSystemConfig('lineChannelAccessToken');
    if (!lineToken) {
      return createJsonResponse({ status: 'error', message: '中樞尚未設定 LINE Channel Access Token' }, 500);
    }

    var targets = payload.targets || [];
    if (!Array.isArray(targets) || targets.length === 0) {
      if (payload.target) {
        targets = [payload.target];
      } else {
        return createJsonResponse({ status: 'error', message: '缺少推播目標 (target 或 targets)' }, 400);
      }
    }

    var pushResult = processPushMessages(project, lineToken, targets, payload.messageTemplate);
    return createJsonResponse({
      status: 'success',
      sentCount: pushResult.sentCount,
      failedCount: pushResult.failedCount,
      skippedCount: pushResult.skippedCount,
      details: pushResult.details
    });
  }

  return createJsonResponse({ status: 'error', message: '未知的 action: ' + action }, 400);
}

// =============================================================================
// 推播發送核心函式
// =============================================================================

function processPushMessages(project, lineToken, targets, defaultTemplate) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logSheet = ss.getSheetByName(SHEETS.LOGS);
  
  var sentCount = 0;
  var failedCount = 0;
  var skippedCount = 0;
  var details = [];
  var logRows = [];
  var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

  targets.forEach(function(item) {
    // 尋找目標學生的家長 LINE UID
    var boundList = findBindings(item);
    if (!boundList || boundList.length === 0) {
      skippedCount++;
      details.push({
        target: item.seatNo || item.studentId || item.token,
        status: 'skipped',
        reason: '該學生未綁定任何家長 LINE'
      });
      return;
    }

    // 組裝訊息內文
    var textMsg = item.customMessage || '';
    if (!textMsg) {
      var title = item.title || (defaultTemplate && defaultTemplate.title) || '【校園智慧通知】';
      var body = item.body || (defaultTemplate && defaultTemplate.body) || '';
      var url = item.url || (defaultTemplate && defaultTemplate.url) || '';
      
      textMsg = title + "\n\n" +
                maskName(item.studentName || boundList[0].studentName) + " 家長您好：\n" +
                body;
      if (url) {
        textMsg += "\n\n🔗 點此開啟明細查看：\n" + url;
      }
      textMsg += "\n\n（由 " + project.projectName + " 自動發送）";
    }

    // 推播給該學生所有已綁定之家長 UID
    boundList.forEach(function(parent) {
      try {
        var pushResp = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + lineToken
          },
          payload: JSON.stringify({
            to: parent.lineUserId,
            messages: [{ type: "text", text: textMsg }]
          }),
          muteHttpExceptions: true
        });

        var respCode = pushResp.getResponseCode();
        var respBody = pushResp.getContentText();
        var isOk = (respCode === 200);

        if (isOk) {
          sentCount++;
          details.push({ target: parent.studentId, uid: parent.lineUserId, status: 'success' });
        } else {
          failedCount++;
          details.push({ target: parent.studentId, uid: parent.lineUserId, status: 'failed', error: respBody });
        }

        // 準備寫入日誌
        logRows.push([
          nowStr,
          project.appId,
          project.projectName,
          parent.studentId || parent.seatNo,
          parent.studentName,
          parent.lineUserId,
          textMsg.substring(0, 100),
          isOk ? 'SUCCESS' : 'FAILED',
          respCode + ': ' + respBody.substring(0, 120)
        ]);

      } catch (pushErr) {
        failedCount++;
        details.push({ target: parent.studentId, status: 'error', error: pushErr.toString() });
        logRows.push([
          nowStr,
          project.appId,
          project.projectName,
          parent.studentId || parent.seatNo,
          parent.studentName,
          parent.lineUserId,
          textMsg.substring(0, 100),
          'ERROR',
          pushErr.toString()
        ]);
      }
    });
  });

  // 批次寫入日誌
  if (logRows.length > 0 && logSheet) {
    var lastRow = logSheet.getLastRow();
    logSheet.getRange(lastRow + 1, 1, logRows.length, logRows[0].length).setValues(logRows);
  }

  // 更新專案累積使用量
  incrementProjectUsage(project.appId, sentCount);

  return {
    sentCount: sentCount,
    failedCount: failedCount,
    skippedCount: skippedCount,
    details: details
  };
}

// =============================================================================
// LINE API 輔助函式
// =============================================================================

function replyLine(token, replyToken, text) {
  if (!token || !replyToken) return;
  try {
    UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      payload: JSON.stringify({
        replyToken: replyToken,
        messages: [{ type: "text", text: text }]
      }),
      muteHttpExceptions: true
    });
  } catch(e) {
    console.error("replyLine 失敗:", e);
  }
}

// =============================================================================
// 資料庫與試算表存取邏輯
// =============================================================================

function getBindingsByLineUserId(lineUserId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BINDINGS);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var uidCol = headers.indexOf('LINE_UID');
  var nameCol = headers.indexOf('學生姓名');
  var seatCol = headers.indexOf('座號');
  var idCol = headers.indexOf('學號');
  var dateCol = headers.indexOf('綁定時間');
  var statusCol = headers.indexOf('狀態');

  var results = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[uidCol] === lineUserId && (statusCol === -1 || row[statusCol] !== 'DISABLED')) {
      results.push({
        studentId: row[idCol] || '',
        seatNo: row[seatCol] || '',
        studentName: row[nameCol] || '',
        boundAt: row[dateCol] ? row[dateCol].toString() : ''
      });
    }
  }
  return results;
}

function unbindByLineUserId(lineUserId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BINDINGS);
  if (!sheet || sheet.getLastRow() <= 1) return 0;

  var data = sheet.getDataRange().getValues();
  var uidCol = data[0].indexOf('LINE_UID');
  var statusCol = data[0].indexOf('狀態');
  if (uidCol === -1) return 0;

  var count = 0;
  for (var i = 1; i < data.length; i++) {
    if (data[i][uidCol] === lineUserId) {
      if (statusCol !== -1) {
        sheet.getRange(i + 1, statusCol + 1).setValue('DISABLED');
      } else {
        sheet.deleteRow(i + 1);
        data.splice(i, 1);
        i--;
      }
      count++;
    }
  }
  return count;
}

function bindByToken(token, lineUserId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BINDINGS);
  if (!sheet) return { success: false };

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var tokenCol = headers.indexOf('查詢代碼');
  var uidCol = headers.indexOf('LINE_UID');
  var nameCol = headers.indexOf('學生姓名');
  var seatCol = headers.indexOf('座號');
  var idCol = headers.indexOf('學號');
  var dateCol = headers.indexOf('綁定時間');
  var statusCol = headers.indexOf('狀態');

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (tokenCol !== -1 && (row[tokenCol] || '').toString().trim().toUpperCase() === token) {
      // 寫入/更新 LINE_UID
      sheet.getRange(i + 1, uidCol + 1).setValue(lineUserId);
      if (dateCol !== -1) {
        sheet.getRange(i + 1, dateCol + 1).setValue(Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"));
      }
      if (statusCol !== -1) {
        sheet.getRange(i + 1, statusCol + 1).setValue('ACTIVE');
      }
      return {
        success: true,
        studentName: row[nameCol],
        seatNo: row[seatCol],
        studentId: row[idCol]
      };
    }
  }

  return { success: false };
}

function bindBySeatAndName(seat, name, lineUserId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BINDINGS);
  if (!sheet) return { success: false };

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var seatCol = headers.indexOf('座號');
  var nameCol = headers.indexOf('學生姓名');
  var uidCol = headers.indexOf('LINE_UID');
  var dateCol = headers.indexOf('綁定時間');
  var statusCol = headers.indexOf('狀態');

  var normSeat = seat.toString().replace(/^0+/, '');

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var sVal = (row[seatCol] || '').toString().replace(/^0+/, '');
    var nVal = (row[nameCol] || '').toString().trim();

    if (sVal === normSeat && nVal === name.trim()) {
      sheet.getRange(i + 1, uidCol + 1).setValue(lineUserId);
      if (dateCol !== -1) {
        sheet.getRange(i + 1, dateCol + 1).setValue(Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"));
      }
      if (statusCol !== -1) {
        sheet.getRange(i + 1, statusCol + 1).setValue('ACTIVE');
      }
      return {
        success: true,
        studentName: row[nameCol],
        seatNo: row[seatCol]
      };
    }
  }

  return { success: false };
}

function findBindings(target) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BINDINGS);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.indexOf('學號');
  var seatCol = headers.indexOf('座號');
  var nameCol = headers.indexOf('學生姓名');
  var tokenCol = headers.indexOf('查詢代碼');
  var uidCol = headers.indexOf('LINE_UID');
  var statusCol = headers.indexOf('狀態');

  var tSeat = target.seatNo ? target.seatNo.toString().replace(/^0+/, '') : '';
  var tId = target.studentId ? target.studentId.toString().trim() : '';
  var tToken = target.token ? target.token.toString().trim().toUpperCase() : '';
  var tName = target.studentName ? target.studentName.toString().trim() : '';

  var matched = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var uid = (row[uidCol] || '').toString().trim();
    if (!uid || uid.indexOf('U') !== 0) continue;
    if (statusCol !== -1 && row[statusCol] === 'DISABLED') continue;

    var sSeat = (row[seatCol] || '').toString().replace(/^0+/, '');
    var sId = (row[idCol] || '').toString().trim();
    var sToken = (row[tokenCol] || '').toString().trim().toUpperCase();
    var sName = (row[nameCol] || '').toString().trim();

    var isMatch = false;
    if (tToken && sToken && tToken === sToken) isMatch = true;
    else if (tId && sId && tId === sId) isMatch = true;
    else if (tSeat && sSeat && tSeat === sSeat) isMatch = true;
    else if (tName && sName && tName === sName) isMatch = true;

    if (isMatch) {
      matched.push({
        lineUserId: uid,
        studentId: sId,
        seatNo: sSeat,
        studentName: sName
      });
    }
  }

  return matched;
}

function getAllBindingsSummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BINDINGS);
  if (!sheet || sheet.getLastRow() <= 1) return {};

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var seatCol = headers.indexOf('座號');
  var idCol = headers.indexOf('學號');
  var nameCol = headers.indexOf('學生姓名');
  var uidCol = headers.indexOf('LINE_UID');
  var tokenCol = headers.indexOf('查詢代碼');

  var summary = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var key = row[seatCol] || row[idCol] || row[tokenCol] || ('row_' + i);
    var hasUid = !!((row[uidCol] || '').toString().trim());

    summary[key] = {
      isBound: hasUid,
      studentName: maskName((row[nameCol] || '').toString()),
      seatNo: row[seatCol]
    };
  }
  return summary;
}

function getActiveBindingsCount() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BINDINGS);
  if (!sheet || sheet.getLastRow() <= 1) return 0;
  var data = sheet.getDataRange().getValues();
  var uidCol = data[0].indexOf('LINE_UID');
  if (uidCol === -1) return 0;

  var count = 0;
  for (var i = 1; i < data.length; i++) {
    var u = (data[i][uidCol] || '').toString().trim();
    if (u.indexOf('U') === 0) count++;
  }
  return count;
}

function upsertStudentsMaster(students) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BINDINGS);
  if (!sheet) return { added: 0, updated: 0 };

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var seatCol = headers.indexOf('座號');
  var idCol = headers.indexOf('學號');
  var nameCol = headers.indexOf('學生姓名');
  var tokenCol = headers.indexOf('查詢代碼');
  var dateCol = headers.indexOf('建檔時間');

  var added = 0;
  var updated = 0;
  var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

  students.forEach(function(st) {
    var matchedRow = -1;
    for (var r = 1; r < data.length; r++) {
      if ((st.studentId && data[r][idCol] == st.studentId) ||
          (st.seatNo && data[r][seatCol] == st.seatNo)) {
        matchedRow = r + 1;
        break;
      }
    }

    if (matchedRow !== -1) {
      if (st.studentName && nameCol !== -1) sheet.getRange(matchedRow, nameCol + 1).setValue(st.studentName);
      if (st.token && tokenCol !== -1) sheet.getRange(matchedRow, tokenCol + 1).setValue(st.token);
      updated++;
    } else {
      var newRow = [];
      for (var c = 0; c < headers.length; c++) {
        var h = headers[c];
        if (h === '學號') newRow.push(st.studentId || '');
        else if (h === '座號') newRow.push(st.seatNo || '');
        else if (h === '學生姓名') newRow.push(st.studentName || '');
        else if (h === '查詢代碼') newRow.push(st.token || '');
        else if (h === 'LINE_UID') newRow.push('');
        else if (h === '狀態') newRow.push('ACTIVE');
        else if (h === '建檔時間') newRow.push(nowStr);
        else newRow.push('');
      }
      sheet.appendRow(newRow);
      added++;
    }
  });

  return { added: added, updated: updated };
}

// =============================================================================
// 專案授權與設定管理
// =============================================================================

function verifyProjectAuth(appId, appSecret) {
  if (!appId || !appSecret) return null;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.PROJECTS);
  if (!sheet || sheet.getLastRow() <= 1) return null;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    // 欄位順序：專案名稱, App_ID, Secret_Key, 狀態, 每月配額, 本月已用則數
    if (row[1] === appId && row[2] === appSecret) {
      if (row[3] === 'ACTIVE' || row[3] === '啟用') {
        return {
          rowIdx: i + 1,
          projectName: row[0],
          appId: row[1],
          monthlyQuota: row[4] || 1000,
          usedCount: row[5] || 0
        };
      }
    }
  }
  return null;
}

function incrementProjectUsage(appId, count) {
  if (!count || count <= 0) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.PROJECTS);
  if (!sheet || sheet.getLastRow() <= 1) return;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === appId) {
      var current = Number(data[i][5]) || 0;
      sheet.getRange(i + 1, 6).setValue(current + count);
      break;
    }
  }
}

function getSystemConfig(key) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.CONFIG);
  if (!sheet) return '';
  
  try {
    var val = sheet.getRange("A1").getValue();
    var obj = JSON.parse(val);
    return obj[key] || '';
  } catch(e) {
    // 備用結構：Key-Value 兩欄式
    var data = sheet.getDataRange().getValues();
    for (var i = 0; i < data.length; i++) {
      if (data[i][0] === key) return data[i][1];
    }
  }
  return '';
}

// =============================================================================
// 資料庫結構自動初始化
// =============================================================================

function initSpreadsheetStructure() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. SystemConfig
  var cfgSheet = ss.getSheetByName(SHEETS.CONFIG) || ss.insertSheet(SHEETS.CONFIG);
  if (cfgSheet.getLastRow() === 0) {
    var defaultCfg = {
      lineChannelAccessToken: "",
      lineChannelSecret: "",
      schoolName: "幸福國小 6年1班",
      adminNotificationEmail: Session.getActiveUser().getEmail()
    };
    cfgSheet.getRange("A1").setValue(JSON.stringify(defaultCfg, null, 2));
  }

  // 2. AuthorizedProjects
  var projSheet = ss.getSheetByName(SHEETS.PROJECTS) || ss.insertSheet(SHEETS.PROJECTS);
  if (projSheet.getLastRow() === 0) {
    projSheet.appendRow(['專案名稱', 'App_ID', 'Secret_Key', '狀態', '每月配額', '本月已用則數', '建立時間']);
    projSheet.getRange(1, 1, 1, 7).setBackground('#1e293b').setFontColor('#ffffff').setFontWeight('bold');
    
    // 預設示範專案（作業手札與平時成績）
    var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
    projSheet.appendRow(['作業繳交手札系統 (RP_QR)', 'PROJECT_HW', 'sec_hw_demo_9823471', 'ACTIVE', 1000, 0, nowStr]);
    projSheet.appendRow(['平時成績管理系統 (MPScore)', 'PROJECT_SCORE', 'sec_score_demo_7182934', 'ACTIVE', 1000, 0, nowStr]);
  }

  // 3. ParentBindings
  var bindSheet = ss.getSheetByName(SHEETS.BINDINGS) || ss.insertSheet(SHEETS.BINDINGS);
  if (bindSheet.getLastRow() === 0) {
    bindSheet.appendRow(['座號', '學號', '學生姓名', '查詢代碼', 'LINE_UID', '家長暱稱', '綁定時間', '狀態', '建檔時間']);
    bindSheet.getRange(1, 1, 1, 9).setBackground('#0f766e').setFontColor('#ffffff').setFontWeight('bold');
  }

  // 4. PushLogs
  var logSheet = ss.getSheetByName(SHEETS.LOGS) || ss.insertSheet(SHEETS.LOGS);
  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow(['時間戳', '來源 App_ID', '來源專案名稱', '學生座號/學號', '學生姓名', '接收 LINE_UID', '訊息摘要', '發送狀態', 'LINE API 回應']);
    logSheet.getRange(1, 1, 1, 9).setBackground('#334155').setFontColor('#ffffff').setFontWeight('bold');
  }

  return true;
}

// =============================================================================
// 工具函式
// =============================================================================

function maskName(name) {
  if (!name) return "";
  var str = name.toString().trim();
  if (str.length === 2) {
    return str.substring(0, 1) + "○";
  } else if (str.length >= 3) {
    return str.substring(0, 1) + "○" + str.substring(2);
  }
  return str;
}

function createJsonResponse(obj, statusCode) {
  var output = ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}
