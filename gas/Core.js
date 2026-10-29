/**
 * =========================================================================
 * School LINE Hub - 核心業務引擎 (Core.js)
 * 由 Loader.gs 動態從 GitHub 載入執行，實現免重新部署的自動熱更新！
 * =========================================================================
 */

var SHEETS = {
  CONFIG: 'SystemConfig',
  PROJECTS: 'AuthorizedProjects',
  BINDINGS: 'ParentBindings',
  LOGS: 'PushLogs'
};

var HUB_VERSION = "2.1.0-live";

function doGet(e) {
  var param = (e && e.parameter) || {};
  
  // API 健康檢查或狀態確認
  if (param.action === 'ping') {
    return createJsonResponse({
      status: 'ok',
      version: HUB_VERSION,
      service: 'School-LINE-Hub',
      activeBindings: getActiveBindingsCount(),
      serverTime: new Date().toISOString()
    });
  }

  // 匯出/備份名冊
  if (param.action === 'export_bindings') {
    return createJsonResponse({
      status: 'success',
      bindings: getAllBindingsRaw()
    });
  }

  // 嘗試載入 index.html 模板，若不存在則動態生成高質感管理中心 HTML
  try {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('School LINE Hub - 管理控制中心')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    return renderDynamicAdminPanel();
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
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

    // 軌道一：處理 LINE Webhook
    if (payload.events !== undefined) {
      return handleLineWebhook(payload.events);
    }

    // 軌道二：處理子專案 API 呼叫
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
  if (!events || events.length === 0) {
    return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
  }

  var token = getSystemConfig('lineChannelAccessToken');

  events.forEach(function(ev) {
    try {
      // 1. 加好友事件 (Follow)
      if (ev.type === 'follow') {
        var welcomeMsg = "👋 您好！歡迎加入【校園班級智慧推播中樞】。\n\n" +
          "為了精準接收孩子的作業缺繳、成績成果與校園重要通知，請傳送「學生專屬代碼」或「座號+姓名」進行綁定。\n\n" +
          "💡 範例：輸入「#B101」或「綁定 05 王小明」\n" +
          "隨時輸入「查詢」可檢視已綁定之學生資訊。";
        replyLine(token, ev.replyToken, welcomeMsg);
        return;
      }

      // 2. 接收文字訊息
      if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
        var userMsg = ev.message.text.trim();
        var userId = ev.source ? ev.source.userId : '';
        var replyToken = ev.replyToken;

        if (!userId) return;

        // (a) 查詢已綁定學生
        if (userMsg === '查詢' || userMsg === '狀態' || userMsg === '查學生' || userMsg.toLowerCase() === 'info') {
          var bindings = getBindingsByLineUserId(userId);
          if (bindings.length === 0) {
            replyLine(token, replyToken, "ℹ️ 您目前尚未綁定任何學生。\n\n請輸入學生專屬綁定代碼（例如：#A102）完成連結！");
          } else {
            var msg = "📋 【已綁定學生名冊】\n";
            bindings.forEach(function(b, idx) {
              msg += "\n" + (idx + 1) + ". " + maskName(b.studentName) + "（" + (b.seatNo ? "座號 " + b.seatNo : b.studentId) + "）\n" +
                     "   綁定時間：" + (b.boundAt ? b.boundAt.substring(0, 10) : "已綁定");
            });
            msg += "\n\n💡 只要老師發布各項專案通知（作業手札、成績單等），系統將自動為您推播！";
            replyLine(token, replyToken, msg);
          }
          return;
        }

        // (b) 自主解除綁定
        if (userMsg === '解除綁定' || userMsg === '取消綁定' || userMsg === '解綁') {
          var unbindCount = unbindByLineUserId(userId);
          if (unbindCount > 0) {
            replyLine(token, replyToken, "✅ 已成功解除 " + unbindCount + " 位學生的綁定。日後若要重新接收通知，隨時可再次輸入代碼綁定！");
          } else {
            replyLine(token, replyToken, "ℹ️ 您目前沒有任何已綁定的學生紀錄。");
          }
          return;
        }

        // (c) 綁定代碼比對
        var bindMatch = false;
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

        // (d) 輸入「綁定 05 王小明」
        if (!bindMatch && (userMsg.indexOf('綁定') === 0 || userMsg.indexOf('登記') === 0)) {
          var parts = userMsg.replace(/^(綁定|登記)[:\s]*/, '').trim().split(/\s+/);
          if (parts.length >= 2) {
            var bindSeatRes = bindBySeatAndName(parts[0], parts[1], userId);
            if (bindSeatRes.success) {
              replyLine(token, replyToken, "🎉 綁定成功！\n\n已成功將 LINE 綁定至學生：【" + maskName(bindSeatRes.studentName) + "】（座號 " + bindSeatRes.seatNo + "）。");
              bindMatch = true;
            }
          }
        }
      }
    } catch (err) {
      console.error('Webhook 處理例外:', err);
    }
  });

  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
}

// =============================================================================
// 子專案 API 接入邏輯
// =============================================================================

function handleClientApi(payload) {
  var action = payload.action;
  var appId = (payload.appId || '').toString().trim();
  var appSecret = (payload.appSecret || '').toString().trim();

  // 1. 初始化資料庫
  if (action === 'system_init') {
    initSpreadsheetStructure();
    return createJsonResponse({ status: 'success', message: '中樞工作表初始化建立完成' });
  }

  // 2. 從舊專案試算表一鍵匯入家長綁定
  if (action === 'import_legacy_bindings') {
    var legacyUrl = payload.legacySpreadsheetUrl;
    var importResult = importFromLegacySpreadsheet(legacyUrl);
    return createJsonResponse(importResult);
  }

  // 3. 驗證金鑰
  var project = verifyProjectAuth(appId, appSecret);
  if (!project) {
    return createJsonResponse({
      status: 'unauthorized',
      message: '身分驗證失敗：無效的 appId 或 appSecret，或專案已被停用'
    }, 401);
  }

  // (A) 測試連線
  if (action === 'ping' || action === 'verify_client') {
    return createJsonResponse({
      status: 'success',
      message: '連線成功！',
      projectName: project.projectName,
      appId: project.appId,
      monthlyQuota: project.monthlyQuota,
      usedCount: project.usedCount,
      activeBindingsCount: getActiveBindingsCount(),
      hubVersion: HUB_VERSION,
      serverTime: new Date().toISOString()
    });
  }

  // (B) 查詢特定學生
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

  // (C) 批次取得全班綁定摘要
  if (action === 'get_all_bindings_summary') {
    var allBindings = getAllBindingsSummary();
    return createJsonResponse({
      status: 'success',
      totalBoundStudents: Object.keys(allBindings).length,
      bindings: allBindings
    });
  }

  // (D) 發送推播
  if (action === 'send_push') {
    var lineToken = getSystemConfig('lineChannelAccessToken');
    if (!lineToken) {
      return createJsonResponse({ status: 'error', message: '中樞尚未設定 LINE Channel Access Token' }, 500);
    }

    var targets = payload.targets || [payload.target];
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
  var logSheet = (ss.getSheetByName('推播紀錄') || ss.getSheetByName('PushLogs'));
  
  var sentCount = 0;
  var failedCount = 0;
  var skippedCount = 0;
  var details = [];
  var logRows = [];
  var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

  targets.forEach(function(item) {
    if (!item) return;
    var boundList = findBindings(item);
    if (!boundList || boundList.length === 0) {
      skippedCount++;
      details.push({
        target: item.seatNo || item.studentId || item.token,
        status: 'skipped',
        reason: '該學生尚未綁定家長 LINE'
      });
      return;
    }

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

  if (logRows.length > 0 && logSheet) {
    var lastRow = logSheet.getLastRow();
    logSheet.getRange(lastRow + 1, 1, logRows.length, logRows[0].length).setValues(logRows);
  }

  incrementProjectUsage(project.appId, sentCount);

  return {
    sentCount: sentCount,
    failedCount: failedCount,
    skippedCount: skippedCount,
    details: details
  };
}

// =============================================================================
// LINE 輔助與資料庫函式
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

function getBindingsByLineUserId(lineUserId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = (ss.getSheetByName('家長綁定名冊') || ss.getSheetByName('ParentBindings'));
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var uidCol = headers.indexOf('LINE_UID');
  var nameCol = headers.indexOf('學生姓名');
  var seatCol = headers.indexOf('座號');
  var idCol = headers.indexOf('學號');
  var dateCol = headers.indexOf('綁定時間');

  var results = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[uidCol] === lineUserId) {
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
  var sheet = (ss.getSheetByName('家長綁定名冊') || ss.getSheetByName('ParentBindings'));
  if (!sheet || sheet.getLastRow() <= 1) return 0;

  var data = sheet.getDataRange().getValues();
  var uidCol = data[0].indexOf('LINE_UID');
  if (uidCol === -1) return 0;

  var count = 0;
  for (var i = 1; i < data.length; i++) {
    if (data[i][uidCol] === lineUserId) {
      sheet.getRange(i + 1, uidCol + 1).setValue('');
      count++;
    }
  }
  return count;
}

function bindByToken(token, lineUserId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = (ss.getSheetByName('家長綁定名冊') || ss.getSheetByName('ParentBindings'));
  if (!sheet) return { success: false };

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var tokenCol = headers.indexOf('查詢代碼');
  var uidCol = headers.indexOf('LINE_UID');
  var nameCol = headers.indexOf('學生姓名');
  var seatCol = headers.indexOf('座號');
  var dateCol = headers.indexOf('綁定時間');

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (tokenCol !== -1 && (row[tokenCol] || '').toString().trim().toUpperCase() === token) {
      sheet.getRange(i + 1, uidCol + 1).setValue(lineUserId);
      if (dateCol !== -1) {
        sheet.getRange(i + 1, dateCol + 1).setValue(Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"));
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

function bindBySeatAndName(seat, name, lineUserId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = (ss.getSheetByName('家長綁定名冊') || ss.getSheetByName('ParentBindings'));
  if (!sheet) return { success: false };

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var seatCol = headers.indexOf('座號');
  var nameCol = headers.indexOf('學生姓名');
  var uidCol = headers.indexOf('LINE_UID');
  var dateCol = headers.indexOf('綁定時間');

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
  var sheet = (ss.getSheetByName('家長綁定名冊') || ss.getSheetByName('ParentBindings'));
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.indexOf('學號');
  var seatCol = headers.indexOf('座號');
  var nameCol = headers.indexOf('學生姓名');
  var tokenCol = headers.indexOf('查詢代碼');
  var uidCol = headers.indexOf('LINE_UID');

  var tSeat = target.seatNo ? target.seatNo.toString().replace(/^0+/, '') : '';
  var tId = target.studentId ? target.studentId.toString().trim() : '';
  var tToken = target.token ? target.token.toString().trim().toUpperCase() : '';
  var tName = target.studentName ? target.studentName.toString().trim() : '';

  var matched = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var uid = (row[uidCol] || '').toString().trim();
    if (!uid || uid.indexOf('U') !== 0) continue;

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
  var sheet = (ss.getSheetByName('家長綁定名冊') || ss.getSheetByName('ParentBindings'));
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
  var sheet = (ss.getSheetByName('家長綁定名冊') || ss.getSheetByName('ParentBindings'));
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

function verifyProjectAuth(appId, appSecret) {
  if (!appId || !appSecret) return null;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = (ss.getSheetByName('授權專案名單') || ss.getSheetByName('AuthorizedProjects'));
  if (!sheet || sheet.getLastRow() <= 1) return null;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[1] === appId && row[2] === appSecret) {
      if (row[3] === 'ACTIVE' || row[3] === '啟用') {
        return {
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
  var sheet = (ss.getSheetByName('授權專案名單') || ss.getSheetByName('AuthorizedProjects'));
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
  var sheet = ss.getSheetByName('系統設定') || ss.getSheetByName('SystemConfig');
  if (!sheet) return '';
  
  var val = (sheet.getRange("A1").getValue() || '').toString().trim();
  if (!val) return '';

  // 1. 若為 JSON 格式
  try {
    var obj = JSON.parse(val);
    if (obj && obj[key]) return obj[key];
  } catch(e) {}

  // 2. 防呆容錯：若使用者直接在 A1 貼上純 Token 字串
  if (key === 'lineChannelAccessToken') {
    if (val.length > 30 && val.indexOf('{') === -1) {
      return val;
    }
  }

  return '';
}

// =============================================================================
// 一鍵從舊專案（作業手札/成績）試算表匯入家長資料
// =============================================================================

function importFromLegacySpreadsheet(legacyUrl) {
  if (!legacyUrl) return { status: 'error', message: '請提供舊專案試算表網址！' };

  try {
    var srcSs = SpreadsheetApp.openByUrl(legacyUrl);
    var sheets = srcSs.getSheets();
    var targetSheet = null;

    for (var s = 0; s < sheets.length; s++) {
      var name = sheets[s].getName();
      if (name.indexOf('LINE用戶綁定') !== -1 || name.indexOf('家長綁定') !== -1) {
        targetSheet = sheets[s];
        break;
      }
    }

    if (!targetSheet) {
      return { status: 'error', message: '在來源試算表找不到包含「LINE用戶綁定」的分頁！' };
    }

    var sData = targetSheet.getDataRange().getValues();
    if (sData.length <= 1) return { status: 'error', message: '來源工作表為空！' };

    var headers = sData[0];
    var seatCol = -1, nameCol = -1, tokenCol = -1, uidCol = -1;

    for (var c = 0; c < headers.length; c++) {
      var h = (headers[c] || '').toString().trim();
      if (h === '座號') seatCol = c;
      if (h === '姓名' || h === '學生姓名') nameCol = c;
      if (h === '防偽代碼' || h === '查詢代碼' || h === 'Token') tokenCol = c;
      if (h.indexOf('LINE') !== -1 || h === 'UID') uidCol = c;
    }

    var destSs = SpreadsheetApp.getActiveSpreadsheet();
    var destSheet = destSs.getSheetByName(SHEETS.BINDINGS) || destSs.insertSheet(SHEETS.BINDINGS);
    var destData = destSheet.getDataRange().getValues();
    var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

    var importedCount = 0;
    for (var r = 1; r < sData.length; r++) {
      var row = sData[r];
      var sSeat = seatCol !== -1 ? (row[seatCol] || '') : '';
      var sName = nameCol !== -1 ? (row[nameCol] || '') : '';
      var sTok = tokenCol !== -1 ? (row[tokenCol] || '') : '';
      var sUid = uidCol !== -1 ? (row[uidCol] || '').toString().trim() : '';

      if (!sSeat && !sName && !sUid) continue;

      // 檢查是否已存在
      var existRow = -1;
      for (var d = 1; d < destData.length; d++) {
        if (destData[d][0] == sSeat || destData[d][2] == sName) {
          existRow = d + 1;
          break;
        }
      }

      if (existRow !== -1) {
        if (sUid) destSheet.getRange(existRow, 5).setValue(sUid);
        if (sTok) destSheet.getRange(existRow, 4).setValue(sTok);
      } else {
        destSheet.appendRow([sSeat, '', sName, sTok, sUid, nowStr, 'ACTIVE']);
      }
      importedCount++;
    }

    return {
      status: 'success',
      message: '成功從舊專案匯入 ' + importedCount + ' 筆家長綁定資料！',
      importedCount: importedCount
    };

  } catch(err) {
    return { status: 'error', message: '匯入失敗: ' + err.toString() };
  }
}

// =============================================================================
// 初始化資料庫結構
// =============================================================================

function initSpreadsheetStructure() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. SystemConfig
  var cfgSheet = (ss.getSheetByName('系統設定') || ss.getSheetByName('SystemConfig')) || ss.insertSheet(SHEETS.CONFIG);
  if (cfgSheet.getLastRow() === 0) {
    var defaultCfg = {
      lineChannelAccessToken: "請在此貼上LINE_CHANNEL_ACCESS_TOKEN",
      schoolName: "幸福班級"
    };
    cfgSheet.getRange("A1").setValue(JSON.stringify(defaultCfg, null, 2));
  }

  // 2. AuthorizedProjects
  var projSheet = (ss.getSheetByName('授權專案名單') || ss.getSheetByName('AuthorizedProjects')) || ss.insertSheet(SHEETS.PROJECTS);
  if (projSheet.getLastRow() === 0) {
    projSheet.appendRow(['專案名稱', 'App_ID', 'Secret_Key', '狀態', '每月配額', '本月已用則數', '建立時間']);
    projSheet.getRange(1, 1, 1, 7).setBackground('#1e293b').setFontColor('#ffffff').setFontWeight('bold');
    var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
    projSheet.appendRow(['作業繳交手札系統 (RP_QR)', 'PROJECT_HW', 'sec_hw_demo_9823471', 'ACTIVE', 1000, 0, nowStr]);
    projSheet.appendRow(['平時成績管理系統 (MPScore)', 'PROJECT_SCORE', 'sec_score_demo_7182934', 'ACTIVE', 1000, 0, nowStr]);
  }

  // 3. ParentBindings
  var bindSheet = (ss.getSheetByName('家長綁定名冊') || ss.getSheetByName('ParentBindings')) || ss.insertSheet(SHEETS.BINDINGS);
  if (bindSheet.getLastRow() === 0) {
    bindSheet.appendRow(['座號', '學號', '學生姓名', '查詢代碼', 'LINE_UID', '綁定時間', '狀態']);
    bindSheet.getRange(1, 1, 1, 7).setBackground('#0f766e').setFontColor('#ffffff').setFontWeight('bold');
  }

  // 4. PushLogs
  var logSheet = (ss.getSheetByName('推播紀錄') || ss.getSheetByName('PushLogs')) || ss.insertSheet(SHEETS.LOGS);
  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow(['時間戳', '來源 App_ID', '專案名稱', '學生座號/學號', '學生姓名', 'LINE_UID', '訊息摘要', '發送狀態', 'LINE 回應']);
    logSheet.getRange(1, 1, 1, 9).setBackground('#334155').setFontColor('#ffffff').setFontWeight('bold');
  }

  return true;
}

function maskName(name) {
  if (!name) return "";
  var str = name.toString().trim();
  if (str.length === 2) return str.substring(0, 1) + "○";
  if (str.length >= 3) return str.substring(0, 1) + "○" + str.substring(2);
  return str;
}

function createJsonResponse(obj, code) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
