/**
 * =========================================================================
 * School LINE Hub - 穩健秒速版 (Loader.gs)
 * =========================================================================
 * 
 * 💡 特色：
 * 1. 內建秒速初始化函式，建立 4 個工作表完全不依賴網路，1 秒搞定。
 * 2. 徹底消除同名函式造成的無限遞迴 (Call Stack Exceeded) 錯誤。
 * 3. 貼上後永久自動熱更新，未來 GitHub 改版無感同步。
 */

var GITHUB_CORE_URL = "https://raw.githubusercontent.com/chy23/School-LINE_Hub-/main/gas/Core.js";
var CACHE_EXPIRATION_SEC = 300;

function doGet(e) { return executeRemoteCore("doGet", [e]); }
function doPost(e) { return executeRemoteCore("doPost", [e]); }

/**
 * ⚡ 本機秒速建立 4 個分頁（不需等待網路下載，1秒搞定！）
 */
function initSpreadsheetStructure() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. SystemConfig
  var cfg = ss.getSheetByName('SystemConfig') || ss.insertSheet('SystemConfig');
  if (cfg.getLastRow() === 0) {
    cfg.getRange("A1").setValue(JSON.stringify({
      lineChannelAccessToken: "請在此貼上LINE_CHANNEL_ACCESS_TOKEN",
      schoolName: "幸福校園"
    }, null, 2));
  }

  // 2. AuthorizedProjects
  var proj = ss.getSheetByName('AuthorizedProjects') || ss.insertSheet('AuthorizedProjects');
  if (proj.getLastRow() === 0) {
    proj.appendRow(['專案名稱', 'App_ID', 'Secret_Key', '狀態', '每月配額', '本月已用則數']);
    proj.getRange(1, 1, 1, 6).setBackground('#1e293b').setFontColor('#ffffff').setFontWeight('bold');
    proj.appendRow(['作業繳交手札系統', 'PROJECT_HW', 'sec_hw_demo_9823471', 'ACTIVE', 1000, 0]);
    proj.appendRow(['平時成績管理系統', 'PROJECT_SCORE', 'sec_score_demo_7182934', 'ACTIVE', 1000, 0]);
  }

  // 3. ParentBindings
  var bind = ss.getSheetByName('ParentBindings') || ss.insertSheet('ParentBindings');
  if (bind.getLastRow() === 0) {
    bind.appendRow(['座號', '學號', '學生姓名', '查詢代碼', 'LINE_UID', '綁定時間', '狀態']);
    bind.getRange(1, 1, 1, 7).setBackground('#0f766e').setFontColor('#ffffff').setFontWeight('bold');
  }

  // 4. PushLogs
  var log = ss.getSheetByName('PushLogs') || ss.insertSheet('PushLogs');
  if (log.getLastRow() === 0) {
    log.appendRow(['時間戳', '來源 App_ID', '學生座號', 'LINE_UID', '訊息內容', '狀態']);
    log.getRange(1, 1, 1, 6).setBackground('#334155').setFontColor('#ffffff').setFontWeight('bold');
  }

  Logger.log("🎉 4 個工作表分頁建立完成！");
}

/**
 * 自動熱更新遠端調用
 */
function executeRemoteCore(fnName, args) {
  var cache = CacheService.getScriptCache();
  var sourceCode = cache.get("line_hub_core_source");
  if (!sourceCode) {
    try {
      var resp = UrlFetchApp.fetch(GITHUB_CORE_URL + "?t=" + new Date().getTime(), { muteHttpExceptions: true });
      if (resp.getResponseCode() === 200) {
        sourceCode = resp.getContentText();
        cache.put("line_hub_core_source", sourceCode, CACHE_EXPIRATION_SEC);
      }
    } catch(e) {}
  }
  if (sourceCode) {
    eval(sourceCode);
    if (typeof this[fnName] === 'function') return this[fnName].apply(this, args);
  }
  return ContentService.createTextOutput("School LINE Hub 核心載入中...");
}
