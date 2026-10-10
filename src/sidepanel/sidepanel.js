import { createReactiveStore } from "../lib/reactive.js";
import { Msg, exportCommand } from "../lib/protocol.js";

const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progress-bar");
const formatSelect = document.getElementById("export-format");
const formatHint = document.getElementById("format-hint");
const runButton = document.getElementById("run-export");
const KEEP_RENDER_TAB_TIP = "请勿关闭新打开的页面";

// 下拉框各选项的说明文案，随选中项显示在操作区下方
const FORMAT_HINTS = {
  markdown: "下载 .zip 压缩包到本地",
  pdf: "自动渲染生成高清 PDF",
  html: "下载完整网页文件",
  attachments: "批量下载图片和文件",
  word: "下载 .docx 文档（保留标题/表格/代码块/图片）"
};

const DEFAULT_BACKEND_URL = "https://api.weiweiniesi.top";
const CLIENT_VERSION = (() => {
  try {
    return chrome.runtime.getManifest().version || "unknown";
  } catch (error) {
    return "unknown";
  }
})();
const ANONYMOUS_ID_KEY = "anonymousId";
let anonymousId = "";

// —— UI 状态：唯一数据源 ——
// 以前是「每次状态变化手动逐个赋值 DOM」：几个 setXxxUi 函数互相调用、各自 set
// 十几个元素，共 100+ 行，且容易漏同步。现在只维护状态，DOM 一律由 renderUi()
// 从状态推导；状态一改自动重渲染（createReactiveStore 会把同一轮内的多次赋值
// 合并成一次渲染）。
const ui = createReactiveStore(
  {
    status: "准备就绪，等待操作…",
    statusError: false,
    progress: 0,
    busy: false,
    format: "markdown"
  },
  renderUi
);

// —— 状态写入口：保持原有调用方式，但内部只改状态，不再直接碰 DOM ——
function setStatus(message, isError = false) {
  ui.status = message;
  ui.statusError = isError;
}

function setProgress(value) {
  ui.progress = value;
}

function setBusy(isBusy) {
  ui.busy = isBusy;
}

// —— 渲染：所有 DOM 都由状态推导 ——
function renderUi() {
  statusEl.textContent = ui.status;
  statusEl.classList.toggle("error", ui.statusError);

  progressBar.style.width = `${Math.max(0, Math.min(100, Number(ui.progress) || 0))}%`;

  formatSelect.value = ui.format;
  formatHint.textContent = FORMAT_HINTS[ui.format] || "";
  formatSelect.disabled = ui.busy;
  runButton.disabled = ui.busy;
}

renderUi();

function formatExportMessage(message, exportType) {
  if (!message) {
    return message;
  }
  if (exportType === "pdf" || exportType === "markdown" || exportType === "word") {
    if (message.includes(KEEP_RENDER_TAB_TIP)) {
      return message;
    }
    return `${message}\n${KEEP_RENDER_TAB_TIP}`;
  }
  return message;
}

function getErrorMessage(error, fallback = "请求失败") {
  if (!error) {
    return fallback;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error && typeof error.message === "string" && error.message !== "[object Object]") {
    return error.message || fallback;
  }
  if (typeof error.message === "string" && error.message !== "[object Object]") {
    return error.message || fallback;
  }
  if (typeof error.detail === "string" && error.detail) {
    return error.detail;
  }
  if (error.detail && typeof error.detail.message === "string") {
    return error.detail.message;
  }
  try {
    const text = JSON.stringify(error);
    if (text && text !== "{}") {
      return text;
    }
  } catch (jsonError) {
  }
  return fallback;
}

function storageGet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.get(values, (result) => resolve(result));
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve();
    });
  });
}

async function fetchJson(url, options) {
  const mergedHeaders = {
    "Content-Type": "application/json",
    ...(options?.headers || {})
  };
  const response = await fetch(url, {
    ...options,
    headers: mergedHeaders
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.detail;
    let detailText = null;
    if (typeof detail === "string") {
      detailText = detail;
    } else if (Array.isArray(detail)) {
      const messages = detail
        .map((item) => {
          if (!item) {
            return null;
          }
          if (typeof item === "string") {
            return item;
          }
          if (typeof item.msg === "string") {
            return item.msg;
          }
          if (typeof item.message === "string") {
            return item.message;
          }
          return null;
        })
        .filter(Boolean);
      if (messages.length) {
        detailText = messages.join("；");
      }
    } else if (detail && typeof detail.message === "string") {
      detailText = detail.message;
    }
    throw new Error(detailText || "请求失败");
  }
  return data;
}

async function ensureAnonymousId() {
  if (anonymousId) {
    return anonymousId;
  }
  const stored = await storageGet({ [ANONYMOUS_ID_KEY]: "" });
  const saved = stored[ANONYMOUS_ID_KEY];
  if (saved) {
    anonymousId = saved;
    return anonymousId;
  }
  const randomPart = Math.random().toString(36).slice(2, 10);
  anonymousId = `anon_${Date.now().toString(36)}_${randomPart}`;
  await storageSet({ [ANONYMOUS_ID_KEY]: anonymousId });
  return anonymousId;
}

// 匿名埋点上报：不带任何账号凭据，失败一律忽略，不影响导出主流程
async function reportAnalytics(action, exportType, docUrl, docTitle) {
  try {
    const payload = {
      action,
      export_type: exportType || null,
      doc_url: docUrl || null,
      doc_title: docTitle || null,
      client_version: CLIENT_VERSION,
      client_ts: Date.now(),
      anonymous_id: await ensureAnonymousId()
    };
    await fetchJson(`${DEFAULT_BACKEND_URL}/analytics/event`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  } catch (error) {
    // 忽略上报失败
  }
}

let activeExport = null;

function beginExport(type, tabId) {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  activeExport = { type, requestId, tabId };
  setProgress(5);
  setStatus("开始导出...");
  return requestId;
}

function endExport() {
  activeExport = null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== Msg.EXPORT_PROGRESS) {
    return;
  }
  const ack = () => {
    if (typeof sendResponse === "function") {
      sendResponse({ ok: true });
    }
  };
  if (!activeExport || message.requestId !== activeExport.requestId) {
    ack();
    return;
  }
  if (message.exportType !== activeExport.type) {
    ack();
    return;
  }
  if (activeExport.tabId && message.tabId && message.tabId !== activeExport.tabId) {
    ack();
    return;
  }
  if (typeof message.progress === "number") {
    setProgress(message.progress);
  }
  if (message.message) {
    setStatus(formatExportMessage(message.message, message.exportType));
  }
  ack();
});

const FEISHU_HOST_SUFFIXES = [
  ".feishu.cn",
  ".feishu.net",
  ".feishu.cttq.com"
];

function isFeishuUrl(url) {
  try {
    const parsedUrl = new URL(url || "");
    return parsedUrl.protocol === "https:" &&
      FEISHU_HOST_SUFFIXES.some((suffix) => parsedUrl.hostname.endsWith(suffix));
  } catch (error) {
    return false;
  }
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs ? tabs[0] : undefined);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      resolve(response || { ok: false, error: "未收到响应" });
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      resolve(response || { ok: false, error: "未收到响应" });
    });
  });
}

function isReceivingEndMissingError(errorMessage) {
  return /receiving end does not exist|could not establish connection/i.test(String(errorMessage || ""));
}

function injectContentScript(tabId) {
  return new Promise((resolve) => {
    if (!chrome.scripting || !chrome.scripting.executeScript) {
      resolve({ ok: false, error: "当前浏览器不支持主动注入内容脚本，请刷新飞书文档页面后重试" });
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["src/content.js"]
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

async function sendTabMessageWithAutoInject(tabId, message) {
  const firstResponse = await sendTabMessage(tabId, message);
  if (!firstResponse || firstResponse.ok || !isReceivingEndMissingError(firstResponse.error)) {
    return firstResponse;
  }

  const injectResponse = await injectContentScript(tabId);
  if (!injectResponse || !injectResponse.ok) {
    return {
      ok: false,
      error: `飞书页面脚本未就绪，自动注入失败：${injectResponse?.error || "未知错误"}。请刷新飞书文档页面后重试`
    };
  }

  const retryResponse = await sendTabMessage(tabId, message);
  if (!retryResponse || retryResponse.ok || !isReceivingEndMissingError(retryResponse.error)) {
    return retryResponse;
  }

  return {
    ok: false,
    error: "飞书页面脚本未就绪，请刷新飞书文档页面后重试"
  };
}

async function ensureFeishuTab() {
  const tab = await queryActiveTab();
  if (!tab || !tab.id || !isFeishuUrl(tab.url)) {
    setStatus("请在飞书文档页面使用该功能。", true);
    return null;
  }
  return tab;
}

async function prepareDocument(tabId, requestId, exportType) {
  const prepare = await sendTabMessageWithAutoInject(tabId, {
    type: Msg.PREPARE_EXPORT,
    requestId,
    exportType
  });
  if (!prepare || !prepare.ok) {
    throw new Error(prepare?.error || "无法加载文档内容");
  }
}

// 六个导出动作（Markdown / PDF / HTML / 附件 / 诊断 / 缓存）原本各自实现了一份
// 几乎相同的流程：定位飞书标签 -> 上报埋点 -> 预加载 -> 发消息给后台 ->
// 成功/失败/异常收尾。差异只在导出类型、消息类型、进度文案与是否预加载，
// 因此收敛为下面的通用流程 + 配置表。
//
// @param {string}   type            导出类型，用于埋点上报
// @param {string}   messageType     发给后台 Service Worker 的消息类型
// @param {boolean}  [prepare]       是否先预加载文档（长文档导出需要）
// @param {number}   [startProgress] 起始进度
// @param {string}   [startText]     起始阶段文案
// @param {number}   [workProgress]  发消息前的进度
// @param {string}   [workText]      发消息前的文案
// @param {Function} successText     成功文案，接收后台响应
// @param {string}   [failureLabel]  失败文案前缀
async function runExportTask({
  type,
  messageType,
  prepare = false,
  startProgress = 10,
  startText = "正在加载文档内容…",
  workProgress = 0,
  workText = "",
  successText,
  failureLabel = "导出"
}) {
  const tab = await ensureFeishuTab();
  if (!tab) {
    return;
  }

  reportAnalytics("export_start", type, tab.url, tab.title);

  setProgress(startProgress);
  setStatus(startText);

  let requestId = null;
  try {
    if (prepare) {
      requestId = beginExport(type, tab.id);
      await prepareDocument(tab.id, requestId, type);
    }

    if (workProgress) {
      setProgress(workProgress);
      setStatus(workText);
    }

    const response = await sendRuntimeMessage(
      exportCommand(messageType, {
        tabId: tab.id,
        title: tab.title,
        url: tab.url,
        ...(requestId ? { requestId } : {})
      })
    );

    if (!response || !response.ok) {
      setProgress(0);
      setStatus(`${failureLabel}失败：${response?.error || "未知错误"}`, true);
      reportAnalytics("export_failed", type, tab.url, tab.title);
      return;
    }

    setProgress(100);
    setStatus(successText(response));
    reportAnalytics("export_success", type, tab.url, tab.title);
  } catch (error) {
    setProgress(0);
    setStatus(`${failureLabel}失败：${getErrorMessage(error)}`, true);
    reportAnalytics("export_failed", type, tab.url, tab.title);
  } finally {
    if (requestId) {
      endExport();
    }
  }
}

const handleExportMarkdown = () =>
  runExportTask({
    type: "markdown",
    messageType: Msg.EXPORT_MARKDOWN_ADVANCED,
    prepare: true,
    startProgress: 6,
    startText: "正在预加载文档内容...",
    successText: (response) => `Markdown 压缩包已生成：${response.filename}`
  });

const handleExportPdf = () =>
  runExportTask({
    type: "pdf",
    messageType: Msg.EXPORT_PDF_ADVANCED,
    prepare: true,
    startProgress: 6,
    startText: "正在预加载文档内容...",
    successText: (response) => `PDF 已生成：${response.filename}`
  });

const handleExportHtml = () =>
  runExportTask({
    type: "html",
    messageType: Msg.EXPORT_HTML,
    prepare: true,
    startProgress: 6,
    startText: "正在预加载文档内容...",
    successText: (response) => `HTML 已生成：${response.filename}`
  });

const handleExportWord = () =>
  runExportTask({
    type: "word",
    messageType: Msg.EXPORT_WORD_ADVANCED,
    prepare: true,
    startProgress: 6,
    startText: "正在预加载文档内容...",
    successText: (response) => `Word 已生成：${response.filename}`
  });

const handleExportAttachments = () =>
  runExportTask({
    type: "attachments",
    messageType: Msg.EXPORT_ATTACHMENTS,
    workProgress: 60,
    workText: "正在导出附件…",
    successText: (response) => {
      const result = response.result || {};
      return `附件导出完成：图片 ${result.imageCount || 0}，文件 ${result.fileCount || 0}`;
    }
  });

// 下拉框选中格式 -> 执行动作
const EXPORT_ACTIONS = {
  markdown: handleExportMarkdown,
  pdf: handleExportPdf,
  html: handleExportHtml,
  word: handleExportWord,
  attachments: handleExportAttachments
};

// 「执行」按钮触发下拉框选中格式对应的导出动作，共用同一套收尾：置忙、进度归零、
// 异常兜底、结束复原
async function runAction(action) {
  setBusy(true);
  setProgress(0);
  try {
    if (action) {
      await action();
    } else {
      setStatus("该功能暂未支持。", true);
    }
  } catch (error) {
    setStatus(`操作失败：${getErrorMessage(error)}`, true);
    setProgress(0);
  } finally {
    setBusy(false);
  }
}

formatSelect.addEventListener("change", () => {
  ui.format = formatSelect.value;
});

runButton.addEventListener("click", () => {
  runAction(EXPORT_ACTIONS[ui.format]);
});

async function bootstrap() {
  await ensureAnonymousId();
  reportAnalytics("panel_open", null, null, null);
}

bootstrap();
