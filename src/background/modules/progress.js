import { progressMessage } from "../../lib/protocol.js";

// 向页面侧（渲染标签页 / 侧边栏）广播导出进度。
// 没有接收者（例如渲染标签页还没加载完）时 sendMessage 会抛错，这里统一吞掉。
export function sendExportProgress(tabId, requestId, exportType, progress, message) {
  if (!requestId) {
    return;
  }
  try {
    const maybePromise = chrome.runtime.sendMessage(
      progressMessage({ tabId, requestId, exportType, progress, message })
    );
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch {
    // 没有接收者时忽略。
  }
}
