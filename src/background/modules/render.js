import { sendRuntimeMessageAsync } from "../../lib/message.js";
import { splitStringToChunks } from "../../lib/chunk.js";
import { Msg } from "../../lib/protocol.js";

// PDF 渲染标签页就绪等待者：key 为 renderTabId。
export const renderWaiters = new Map();
// Markdown 渲染分块结果收集者：key 为 requestId。
export const markdownRenderWaiters = new Map();

// 等待新建的渲染标签页加载到 complete 状态，超时则 reject。
export function waitForTabReady(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("渲染页加载超时"));
    }, timeoutMs);

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId) {
        return;
      }
      if (info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// 等待 PDF 渲染标签页通过 PDF_RENDER_READY 消息通知「已可打印」。
export function waitForRenderReady(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      renderWaiters.delete(tabId);
      reject(new Error("渲染内容超时"));
    }, timeoutMs);

    renderWaiters.set(tabId, { resolve, reject, timer });
  });
}

// 把（可能很大的）HTML 切块后依次发给渲染标签页，最后发结束标记。
export async function sendChunkedHtmlToRenderTab({
  targetTabId,
  renderType,
  title,
  html,
  requestId
}) {
  const chunks = splitStringToChunks(html);
  await sendRuntimeMessageAsync({
    type: Msg.RENDER_HTML_CHUNK_START,
    targetTabId,
    renderType,
    title: title || "",
    requestId,
    totalChunks: chunks.length
  });
  for (let i = 0; i < chunks.length; i += 1) {
    await sendRuntimeMessageAsync({
      type: Msg.RENDER_HTML_CHUNK,
      targetTabId,
      renderType,
      requestId,
      index: i,
      chunk: chunks[i]
    });
  }
  await sendRuntimeMessageAsync({
    type: Msg.RENDER_HTML_CHUNK_END,
    targetTabId,
    renderType,
    requestId
  });
}

// 等待 Markdown 渲染标签页回传分块结果，超时则 reject。
export function waitForMarkdownRenderResult(requestId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      markdownRenderWaiters.delete(requestId);
      reject(new Error("Markdown render timed out"));
    }, timeoutMs);
    markdownRenderWaiters.set(requestId, {
      resolve,
      reject,
      timer,
      totalChunks: 0,
      chunks: []
    });
  });
}

export function completeMarkdownRenderSuccess(requestId, payloadText) {
  const waiter = markdownRenderWaiters.get(requestId);
  if (!waiter) {
    return;
  }
  clearTimeout(waiter.timer);
  markdownRenderWaiters.delete(requestId);
  try {
    const parsed = JSON.parse(payloadText || "{}");
    waiter.resolve(parsed);
  } catch (error) {
    waiter.reject(new Error("Failed to parse markdown render result"));
  }
}

export function completeMarkdownRenderError(requestId, errorMessage) {
  const waiter = markdownRenderWaiters.get(requestId);
  if (!waiter) {
    return;
  }
  clearTimeout(waiter.timer);
  markdownRenderWaiters.delete(requestId);
  waiter.reject(new Error(errorMessage || "Markdown render failed"));
}
