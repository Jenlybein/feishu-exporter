// 将页面侧提取逻辑（feishu-shared.js + 对应提取脚本）注入 MAIN world 后调用
// window 上的函数。原先这些大段页面代码内联在 Service Worker 里（反模式），
// 现拆分为独立注入文件，行为保持不变。
export async function injectAndRun(tabId, files, windowFn) {
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (fnName) => window[fnName](),
    args: [windowFn]
  });
  return results && results[0] && results[0].result;
}

export function countDocumentImages(tabId) {
  return injectAndRun(
    tabId,
    ["src/injected/feishu-shared.js", "src/injected/count-images.js"],
    "__feishuCountImages"
  )
    .then((result) => Number(result) || 0)
    .catch(() => 0);
}

export function extractPdfHtml(tabId) {
  return injectAndRun(
    tabId,
    ["src/injected/feishu-shared.js", "src/injected/extract-html.js"],
    "__feishuExtractHtml"
  ).then((result) => result || { ok: false, error: "无法提取文档内容" });
}

export function extractAttachments(tabId) {
  return injectAndRun(
    tabId,
    ["src/injected/feishu-shared.js", "src/injected/extract-attachments.js"],
    "__feishuExtractAttachments"
  ).then((result) => result || { ok: false, error: "无法提取附件" });
}
