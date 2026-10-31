/**
 * =========================================================================
 * School LINE Hub - 核心後端完整版 (gas/Code.gs)
 * 建立於：新北市林口區麗園國小 楊家驊老師 (Chiahua Yang)
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

  // 支援子專案透過 GET 請求呼叫 API (如 get_all_bindings_summary, verify_client, send_push 等)，100% 免疫瀏覽器跨域 CORS OPTIONS 限制
  if (param.action) {
    if (typeof param.target === 'string') {
      try { param.target = JSON.parse(param.target); } catch(e) {}
    }
    if (typeof param.targets === 'string') {
      try { param.targets = JSON.parse(param.targets); } catch(e) {}
    }
    if (typeof param.students === 'string') {
      try { param.students = JSON.parse(param.students); } catch(e) {}
    }
    if (typeof param.messageTemplate === 'string') {
      try { param.messageTemplate = JSON.parse(param.messageTemplate); } catch(e) {}
    }
    return handleClientApi(param);
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
      return handleLineWebhook(payload);
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

function handleLineWebhook(input) {
  var events = Array.isArray(input) ? input : (input && input.events ? input.events : []);
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

        // (c) 只有「學生專屬查詢代碼」才能觸發綁定 (相容純代碼如 de865y、#de865y、綁定 de865y)
        // 任何日常中文字、閒聊、貼圖、請假私訊，一律 100% 忽略，絕不回覆、絕不干擾！
        var codeCandidate = userMsg.replace(/^[#＃]/, '').replace(/^綁定\s*/i, '').trim().toUpperCase();

        if (codeCandidate && /^[A-Z0-9]{4,12}$/.test(codeCandidate) && !/^(查詢|狀態|查學生|解除綁定|取消綁定|解綁)$/.test(userMsg)) {
          var bindRes = bindByToken(codeCandidate, userId);
          if (bindRes && bindRes.success) {
            replyLine(token, replyToken, "🎉 綁定成功！\n\n已成功將 LINE 綁定至學生：【" + maskName(bindRes.studentName) + "】（座號 " + bindRes.seatNo + " 號）。\n日後作業缺繳、評量成果等最新通知將即時發送至此對話！");
            return;
          }
        }
        // 若不是有效代碼或為一般聊天，完全不處理直接結束，絕不干擾老師與家長！
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
    var pushMsg = '';
    if (pushResult.sentCount > 0) {
      pushMsg = '成功發送 ' + pushResult.sentCount + ' 則成績推播！';
    } else if (pushResult.skippedCount > 0) {
      var tInfo = targets[0] ? ((targets[0].seatNo ? targets[0].seatNo + ' 號 ' : '') + (targets[0].studentName || '')) : '';
      pushMsg = '推播略過：學生【' + tInfo + '】尚未綁定家長 LINE（LINE_UID 為空）！';
    } else {
      pushMsg = '推播發送失敗，請檢視推播紀錄。';
    }

    return createJsonResponse({
      status: (pushResult.sentCount > 0) ? 'success' : 'skipped',
      message: pushMsg,
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
    var resp = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
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
    console.log("replyLine status: " + resp.getResponseCode() + " " + resp.getContentText());
  } catch(e) {
    console.error("replyLine 失敗:", e);
  }
}

function bindByToken(tokenOrQuery, lineUserId) {
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

  var rawInput = (tokenOrQuery || '').toString().trim();
  var cleanInput = rawInput.replace(/^[#＃]/, '').replace(/^綁定\s*/i, '').replace(/^座號\s*/i, '').replace(/號$/, '').trim();
  var upperInput = cleanInput.toUpperCase();
  var seatNum = cleanInput.replace(/^0+/, '');

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rawTok = (tokenCol !== -1 && row[tokenCol]) ? row[tokenCol].toString().trim().toUpperCase() : '';
    var sSeat = (seatCol !== -1 && row[seatCol]) ? row[seatCol].toString().trim().replace(/^0+/, '') : '';
    var sName = (nameCol !== -1 && row[nameCol]) ? row[nameCol].toString().trim() : '';

    var isMatch = false;
    // 1. 代碼完全相符 (例如 de865y, y6mfz2, g1dl5u)
    if (rawTok && upperInput === rawTok) isMatch = true;
    // 2. 座號相符 (例如家長傳 18 或 18號 或 018)
    else if (seatNum && sSeat && seatNum === sSeat) isMatch = true;
    // 3. 學生姓名相符 (例如 蕭巧羚)
    else if (sName && cleanInput === sName) isMatch = true;

    if (isMatch) {
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
  var targetUid = String(lineUserId || '').trim();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var cellUid = String(row[uidCol] || '').trim();
    if (cellUid && cellUid === targetUid) {
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
  var targetUid = String(lineUserId || '').trim();
  for (var i = 1; i < data.length; i++) {
    var cellUid = String(data[i][uidCol] || '').trim();
    if (cellUid && cellUid === targetUid) {
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

// =============================================================================
// 診斷與測試輔助函式 (可直接在 GAS 編輯器上方選單選取執行)
// =============================================================================

/**
 * 🧪 一鍵測試推播 18 號 (蕭巧羚)
 * 若 18 號尚未綁定，會自動借用名冊中已綁定的測試 UID，讓您手機立即收到通知！
 */
function testPushSeat18() {
  Logger.log("=== 開始測試推播 18 號 (蕭巧羚) ===");
  var sheet = getSheet('BINDINGS');
  if (!sheet) {
    Logger.log("❌ 找不到【家長綁定名冊】分頁！");
    return;
  }
  
  var lineToken = getSystemConfig('lineChannelAccessToken');
  if (!lineToken) {
    Logger.log("❌ 尚未讀取到 LINE Channel Access Token！");
    return;
  }

  var data = sheet.getDataRange().getValues();
  var seatCol = data[0].indexOf('座號');
  var uidCol = data[0].indexOf('LINE_UID');
  var nameCol = data[0].indexOf('學生姓名');
  var tokenCol = data[0].indexOf('查詢代碼');
  var dateCol = data[0].indexOf('綁定時間');
  var statusCol = data[0].indexOf('狀態');

  var targetRow = -1;
  var existingValidUid = '';

  for (var i = 1; i < data.length; i++) {
    var sSeat = String(data[i][seatCol]).replace(/^0+/, '');
    var sUid = String(data[i][uidCol] || '').trim();
    if (sSeat === '18') {
      targetRow = i;
    }
    // 尋找名冊中任何既有的真實 LINE_UID (以 U 開頭且長度 33 碼)
    if (!existingValidUid && sUid.indexOf('U') === 0 && sUid.length > 25 && sUid !== 'U_TEST_DEBUG_UID') {
      existingValidUid = sUid;
    }
  }

  if (targetRow === -1) {
    Logger.log("❌ 名冊中找不到座號 18 號！");
    return;
  }

  var sName = data[targetRow][nameCol];
  var sTok = data[targetRow][tokenCol];
  var sUid = String(data[targetRow][uidCol] || '').trim();

  Logger.log("📌 18號學生資料：姓名=" + sName + ", 代碼=" + sTok + ", LINE_UID=" + (sUid || "(空白，尚未綁定)"));

  // 如果 18 號尚未綁定
  if (!sUid || sUid === 'U_TEST_DEBUG_UID') {
    if (existingValidUid) {
      Logger.log("💡 偵測到您在名冊其他學生（例如 2 號）已綁定之真實 LINE UID：" + existingValidUid);
      Logger.log("⚡ 正在將此真實 UID 自動關聯至 18 號，以利推播測試...");
      sheet.getRange(targetRow + 1, uidCol + 1).setValue(existingValidUid);
      if (dateCol !== -1) sheet.getRange(targetRow + 1, dateCol + 1).setValue(Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss"));
      if (statusCol !== -1) sheet.getRange(targetRow + 1, statusCol + 1).setValue('已綁定');
      sUid = existingValidUid;
      Logger.log("✅ 18 號已成功關聯真實 LINE UID！");
    } else {
      Logger.log("⚠️ 18 號目前沒有 LINE_UID，且名冊中尚無其他真實 LINE 帳號！");
      Logger.log("👉 請拿起手機開啟 LINE 官方帳號對話框，傳送「18」或「" + sTok + "」即可完成綁定！");
      return;
    }
  }

  // 立即發送真實 LINE 推播給 18 號
  Logger.log("🚀 正在發送【平時成績更新通知】給 18 號 (" + sUid + ")...");
  var testMsg = "📊 【平時成績更新通知】\n\n" +
                sName + " 家長您好：\n" +
                "平時評量成績已完成登錄，請家長參閱最新學習手札。\n\n" +
                "🔗 點此開啟明細查看：\n" +
                "https://chy23.github.io/MPScore-Daily/parent.html?t=" + encodeURIComponent(sTok || 'Y6MFZ2') + "\n\n" +
                "（由 School LINE Hub 自動發送）";

  try {
    var resp = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + lineToken
      },
      payload: JSON.stringify({
        to: sUid,
        messages: [{ type: "text", text: testMsg }]
      }),
      muteHttpExceptions: true
    });

    var code = resp.getResponseCode();
    var body = resp.getContentText();
    Logger.log("LINE API 回應代碼: " + code);
    if (code === 200) {
      Logger.log("🎉🎉 推播發送成功！請檢查您的手機 LINE，訊息應已送達！");
    } else {
      Logger.log("❌ LINE 回傳錯誤: " + body);
    }
  } catch(e) {
    Logger.log("❌ 發送異常: " + e.toString());
  }
  Logger.log("=== 測試結束 ===");
}

/**
 * 🔍 全自動中樞健康診斷
 */
function debugCheckAll() {
  Logger.log("=== 開始中樞診斷 ===");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log("1. 試算表名稱: " + ss.getName());

  var cfgSheet = getSheet('CONFIG');
  Logger.log("2. 系統設定分頁: " + (cfgSheet ? "✅ 存在 (" + cfgSheet.getName() + ")" : "❌ 找不到分頁！"));
  var token = getSystemConfig('lineChannelAccessToken');
  Logger.log("3. LINE Token: " + (token && token.length > 30 ? "✅ 正常讀取 (長度 " + token.length + ")" : "❌ 讀取失敗或為空！"));

  var bindSheet = getSheet('BINDINGS');
  Logger.log("4. 家長名冊分頁: " + (bindSheet ? "✅ 存在 (" + bindSheet.getName() + ")" : "❌ 找不到分頁！"));

  if (bindSheet) {
    var res18 = bindByToken('18', 'U_TEST_DEBUG_UID');
    Logger.log("5. 模擬以座號 18 綁定: " + JSON.stringify(res18));
  }
  Logger.log("=== 診斷結束 ===");
}
