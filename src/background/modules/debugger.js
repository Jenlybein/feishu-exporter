import { sanitizeFilename } from "../../lib/filename.js";
import { downloadFile } from "./download.js";

const DEBUGGER_PROTOCOL_VERSION = "1.3";

// 用 Chrome 调试协议（CDP）把标签页附着为调试目标。导出供其他模块复用，
// 失败时抛出带原始错误信息的 Error，由调用方决定降级路径。
function attachDebugger(tabId) {
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

function sendCommand(tabId, method, params) {
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

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

// 用 CDP 的 Page.printToPDF 把页面打印成 PDF，**只回传 base64 数据**（不落盘）。
//
// 拆出这一层是为了让批量导出复用：批量要把每篇的 PDF 收进同一个 ZIP，不能像单篇
// 那样打印完立刻下载。附着调试器后用 try/finally 确保无论如何都会解附着，
// 避免标签页被长期占用（否则下一次 attach 会报「已被占用」）。
export async function printToPdfData(tabId) {
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
    return result.data;
  } finally {
    if (attached) {
      await detachDebugger(tabId);
    }
  }
}

// 单篇：打印当前标签页并立刻下载为 .pdf。
export async function exportPdf(tabId, title) {
  const data = await printToPdfData(tabId);
  const filename = `${sanitizeFilename(title, "feishu-document")}.pdf`;
  await downloadFile(`data:application/pdf;base64,${data}`, filename, true);
  return filename;
}
