/**
 * =========================================================================
 * School LINE Hub - 永不失效的「自動熱更新」引導程式 (Loader.gs)
 * =========================================================================
 * 
 * 💡 特色：
 * 只要在 Apps Script 貼上這段程式碼一次，未來任何功能改版、Bug 修復、
 * 介面優化，只要 GitHub 更新，本試算表就會「自動同步最新程式碼」！
 * 完全不需要手動重新複製貼上程式碼，也不需要重新發布部署！
 */

var GITHUB_CORE_URL = "https://raw.githubusercontent.com/chy23/School-LINE_Hub-/main/gas/Core.js";
var CACHE_EXPIRATION_SEC = 300; // 快取 5 分鐘，確保效能與即時更新兼備

function doGet(e) {
  return executeRemoteCore("doGet", [e]);
}

function doPost(e) {
  return executeRemoteCore("doPost", [e]);
}

function initSpreadsheetStructure() {
  return executeRemoteCore("initSpreadsheetStructure", []);
}

/**
 * 動態從 GitHub 載入最新版 Core.js 執行
 */
function executeRemoteCore(fnName, args) {
  var cache = CacheService.getScriptCache();
  var sourceCode = cache.get("line_hub_core_source");

  // 若快取過期或強制刷新，從 GitHub 抓取最新原始碼
  if (!sourceCode) {
    try {
      var resp = UrlFetchApp.fetch(GITHUB_CORE_URL + "?t=" + new Date().getTime(), {
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() === 200) {
        sourceCode = resp.getContentText();
        cache.put("line_hub_core_source", sourceCode, CACHE_EXPIRATION_SEC);
      }
    } catch (netErr) {
      Logger.log("遠端更新載入失敗，嘗試使用本機備用邏輯: " + netErr);
    }
  }

  if (sourceCode) {
    try {
      eval(sourceCode);
      if (typeof this[fnName] === 'function') {
        return this[fnName].apply(this, args);
      }
    } catch (evalErr) {
      Logger.log("執行核心程式碼失敗: " + evalErr);
      return ContentService.createTextOutput("系統執行錯誤: " + evalErr.toString());
    }
  }

  return ContentService.createTextOutput("School LINE Hub 核心程式碼載入中，請稍候重試。");
}

/**
 * 手動清除快取，立即強制抓取 GitHub 最新版本
 */
function forceRefreshFromGithub() {
  CacheService.getScriptCache().remove("line_hub_core_source");
  Logger.log("✅ 快取已清除，下次呼叫將立即從 GitHub 同步最新版本！");
}
