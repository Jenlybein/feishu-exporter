import { sanitizeFilename } from "../../lib/filename.js";
import { downloadFile } from "./download.js";

const DEBUGGER_PROTOCOL_VERSION = "1.3";

// 用 Chrome 调试协议（CDP）把标签页附着为调试目标。导出供其他模块复用，
// 失败时抛出带原始错误信息的 Error，由调用方决定降级路径。
export function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve();
    });
  });
}

export function sendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(result);
    });
  });
}

export function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

// 用 CDP 的 Page.printToPDF 把页面打印成 PDF 并下载。
// 附着调试器后用 try/finally 确保无论如何都会解附着，避免标签页被长期占用。
export async function exportPdf(tabId, title) {
  let attached = false;
  try {
    await attachDebugger(tabId);
    attached = true;

    const result = await sendCommand(tabId, "Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true
    });

    if (!result || !result.data) {
      throw new Error("未获取到 PDF 数据");
    }

    const filename = `${sanitizeFilename(title, "feishu-document")}.pdf`;
    const dataUrl = `data:application/pdf;base64,${result.data}`;
    await downloadFile(dataUrl, filename, true);
    return filename;
  } finally {
    if (attached) {
      await detachDebugger(tabId);
    }
  }
}
