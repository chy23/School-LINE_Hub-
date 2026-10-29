/**
 * =========================================================================
 * School LINE Hub - 核心後端完整版 (gas/Code.gs)
 * =========================================================================
 * 
 * 核心職責：
 * 1. 唯一管理 LINE Messaging API Channel Access Token 與 Webhook
 * 2. 集中維護「全校/全班學生與家長 LINE UID」綁定主表（Single Source of Truth）
 * 3. 提供安全 RESTful API，供子專案（RP_QR_CC_HW、MPScore-Daily 等）接入
 * 4. 支援中文與英文工作表名稱自動雙向辨識，支援 A1 純 Token 字串讀取防呆
 * 5. 完全獨立執行，絕無 Loader.gs 遞迴呼叫 (Maximum call stack size exceeded) 錯誤
 */

// 取得工作表輔助函式（自動支援繁體中文與原本英文名稱）
function getSheet(type) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (type === 'CONFIG') return ss.getSheetByName('系統設定') || ss.getSheetByName('SystemConfig');
  if (type === 'PROJECTS') return ss.getSheetByName('授權專案名單') || ss.getSheetByName('AuthorizedProjects');
  if (type === 'BINDINGS') return ss.getSheetByName('家長綁定名冊') || ss.getSheetByName('ParentBindings');
  if (type === 'LOGS') return ss.getSheetByName('推播紀錄') || ss.getSheetByName('PushLogs');
  return null;
}

/**
 * 處理 HTTP GET 請求（管理網站入口 / 健康檢查）
 */
function doGet(e) {
  var param = (e && e.parameter) || {};
  
  if (param.action === 'ping') {
    return createJsonResponse({
      status: 'ok',
      service: 'School-LINE-Hub',
      activeBindings: getActiveBindingsCount(),
      time: new Date().toISOString()
    });
  }

  try {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('School LINE Hub - 管理控制中心')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    return HtmlService.createHtmlOutput('<h2>School LINE Hub 中樞服務正常運作中</h2><p>時間：' + new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) + '</p>');
  }
}

/**
 * 處理 HTTP POST 請求（雙軌：LINE Webhook 與 子專案推播 API）
 */
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

    // 軌道一：處理 LINE 官方帳號 Webhook 事件
    if (payload.events !== undefined) {
      return handleLineWebhook(payload.events);
    }

    // 軌道二：處理子專案 API 接入請求 (如 MPScore-Daily, RP_QR_CC_HW)
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
// 軌道一：LINE Webhook 處理邏輯
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
        var welcomeMsg = "👋 您好！歡迎加入【校園智慧推播中樞】。\n\n" +
          "為了精準接收孩子的作業缺繳、成績成果與校園重要通知，請傳送「學生查詢代碼」完成綁定。\n\n" +
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

        // (a) 查詢指令
        if (userMsg === '查詢' || userMsg === '狀態' || userMsg === '查學生' || userMsg.toLowerCase() === 'info') {
          var bindings = getBindingsByLineUserId(userId);
          if (bindings.length === 0) {
            replyLine(token, replyToken, "ℹ️ 您目前尚未綁定任何學生。\n\n請輸入學生專屬查詢代碼完成連結！");
          } else {
            var msg = "📋 【已綁定學生名冊】\n";
            bindings.forEach(function(b, idx) {
              msg += "\n" + (idx + 1) + ". " + maskName(b.studentName) + "（" + (b.seatNo ? "座號 " + b.seatNo : b.studentId) + "）\n" +
                     "   綁定時間：" + (b.boundAt ? b.boundAt.substring(0, 10) : "已綁定");
            });
            msg += "\n\n💡 只要老師發布各項專案通知（作業缺交、成績單等），系統將自動為您推播！";
            replyLine(token, replyToken, msg);
          }
          return;
        }

        // (b) 解除綁定指令
        if (userMsg === '解除綁定' || userMsg === '取消綁定' || userMsg === '解綁') {
          var unbindCount = unbindByLineUserId(userId);
          if (unbindCount > 0) {
            replyLine(token, replyToken, "✅ 已成功解除 " + unbindCount + " 位學生的綁定。日後若要重新接收通知，隨時可再次輸入代碼綁定！");
          } else {
            replyLine(token, replyToken, "ℹ️ 您目前沒有任何已綁定的學生紀錄。");
          }
          return;
        }

        // (c) 代碼綁定比對 (相容純代碼如 g1dl5u、#g1dl5u、大寫、小寫、或綁定 g1dl5u)
        var codeCandidate = userMsg.replace(/^[#＃]/, '').replace(/^綁定\s*/i, '').trim().toUpperCase();

        if (codeCandidate && /^[A-Z0-9]{4,16}$/.test(codeCandidate) && !/^(查詢|狀態)$/.test(codeCandidate)) {
          var bindRes = bindByToken(codeCandidate, userId);
          if (bindRes.success) {
            replyLine(token, replyToken, "🎉 綁定成功！\n\n已成功將 LINE 綁定至學生：【" + maskName(bindRes.studentName) + "】（座號 " + bindRes.seatNo + " 號）。\n日後作業缺繳、評量成果等最新通知將即時發送至此對話！");
            return;
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
// 軌道二：子專案 API 接入邏輯 (供 MPScore-Daily, RP_QR 等系統呼叫)
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

  // 2. 驗證金鑰
  var project = verifyProjectAuth(appId, appSecret);
  if (!project) {
    return createJsonResponse({
      status: 'unauthorized',
      message: '身分驗證失敗：無效的 appId 或 appSecret，或專案已被停用'
    }, 401);
  }

  // (A) 測試連線 (Ping / Verify)
  if (action === 'ping' || action === 'verify_client') {
    return createJsonResponse({
      status: 'success',
      message: '連線成功！',
      projectName: project.projectName,
      appId: project.appId,
      monthlyQuota: project.monthlyQuota,
      usedCount: project.usedCount,
      activeBindingsCount: getActiveBindingsCount(),
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

  // (C) 批次取得全班綁定對照清單
  if (action === 'get_all_bindings_summary') {
    var allBindings = getAllBindingsSummary();
    return createJsonResponse({
      status: 'success',
      totalBoundStudents: Object.keys(allBindings).length,
      bindings: allBindings
    });
  }

  // (D) 發送推播訊息 (Push Notification)
  if (action === 'send_push') {
    var lineToken = getSystemConfig('lineChannelAccessToken');
    if (!lineToken) {
      return createJsonResponse({ status: 'error', message: '中樞尚未設定 LINE Channel Access Token' }, 500);
    }

    var targets = payload.targets || (payload.target ? [payload.target] : []);
    if (!Array.isArray(targets) || targets.length === 0) {
      return createJsonResponse({ status: 'error', message: '缺少推播目標 (target 或 targets)' }, 400);
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
  var logSheet = getSheet('LOGS');
  
  var sentCount = 0;
  var failedCount = 0;
  var skippedCount = 0;
  var details = [];
  var logRows = [];
  var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss");

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
          parent.studentId || parent.seatNo,
          parent.lineUserId,
          textMsg.substring(0, 100),
          isOk ? 'SUCCESS' : ('FAILED ' + respCode)
        ]);

      } catch (pushErr) {
        failedCount++;
        details.push({ target: parent.studentId, status: 'error', error: pushErr.toString() });
        logRows.push([
          nowStr,
          project.appId,
          parent.studentId || parent.seatNo,
          parent.lineUserId,
          textMsg.substring(0, 100),
          'ERROR: ' + pushErr.toString()
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
// LINE 輔助與資料庫存取
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

function bindByToken(token, lineUserId) {
  var sheet = getSheet('BINDINGS');
  if (!sheet) return { success: false };

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var tokenCol = headers.indexOf('查詢代碼');
  var uidCol = headers.indexOf('LINE_UID');
  var nameCol = headers.indexOf('學生姓名');
  var seatCol = headers.indexOf('座號');
  var dateCol = headers.indexOf('綁定時間');
  var statusCol = headers.indexOf('狀態');

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rawTok = (row[tokenCol] || '').toString().trim().toUpperCase();
    if (tokenCol !== -1 && rawTok === token) {
      var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss");
      sheet.getRange(i + 1, uidCol + 1).setValue(lineUserId);
      if (dateCol !== -1) sheet.getRange(i + 1, dateCol + 1).setValue(nowStr);
      if (statusCol !== -1) sheet.getRange(i + 1, statusCol + 1).setValue('已綁定');
      
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
  var sheet = getSheet('BINDINGS');
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
  var sheet = getSheet('BINDINGS');
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

function getBindingsByLineUserId(lineUserId) {
  var sheet = getSheet('BINDINGS');
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
  var sheet = getSheet('BINDINGS');
  if (!sheet || sheet.getLastRow() <= 1) return 0;

  var data = sheet.getDataRange().getValues();
  var uidCol = data[0].indexOf('LINE_UID');
  var statusCol = data[0].indexOf('狀態');
  if (uidCol === -1) return 0;

  var count = 0;
  for (var i = 1; i < data.length; i++) {
    if (data[i][uidCol] === lineUserId) {
      sheet.getRange(i + 1, uidCol + 1).setValue('');
      if (statusCol !== -1) sheet.getRange(i + 1, statusCol + 1).setValue('已解除');
      count++;
    }
  }
  return count;
}

function getActiveBindingsCount() {
  var sheet = getSheet('BINDINGS');
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

  var sheet = getSheet('PROJECTS');
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
  var sheet = getSheet('PROJECTS');
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

// 支援純 Token 字串與 JSON 雙相容讀取
function getSystemConfig(key) {
  var sheet = getSheet('CONFIG');
  if (!sheet) return '';
  
  var val = (sheet.getRange("A1").getValue() || '').toString().trim();
  if (!val) return '';

  // 1. 若為純 Token 字串 (直接回傳)
  if (key === 'lineChannelAccessToken') {
    if (val.length > 30 && val.indexOf('{') === -1) {
      return val;
    }
  }

  // 2. 若為 JSON 格式
  try {
    var obj = JSON.parse(val);
    return obj[key] || '';
  } catch(e) {}
  
  return val;
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
