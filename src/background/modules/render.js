import { sendRuntimeMessageAsync } from "../../lib/message.js";
import { splitStringToChunks } from "../../lib/chunk.js";
import { Msg } from "../../lib/protocol.js";

// PDF 渲染标签页就绪等待者：key 为 renderTabId。
export const renderWaiters = new Map();
// 生成型渲染页（Markdown / Word）的分块结果收集者：key 为 requestId。
// 与格式无关——渲染页把产物序列化成字符串分块回传，这里只负责拼装。
export const renderResultWaiters = new Map();

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

// 等待生成型渲染页回传分块结果，超时则 reject。
export function waitForRenderResult(requestId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      renderResultWaiters.delete(requestId);
      reject(new Error("渲染结果回传超时"));
    }, timeoutMs);
    renderResultWaiters.set(requestId, {
      resolve,
      reject,
      timer,
      totalChunks: 0,
      chunks: []
    });
  });
}

export function completeRenderResultSuccess(requestId, payloadText) {
  const waiter = renderResultWaiters.get(requestId);
  if (!waiter) {
    return;
  }
  clearTimeout(waiter.timer);
  renderResultWaiters.delete(requestId);
  try {
    const parsed = JSON.parse(payloadText || "{}");
    waiter.resolve(parsed);
  } catch (error) {
    waiter.reject(new Error("Failed to parse render result"));
  }
}

export function completeRenderResultError(requestId, errorMessage) {
  const waiter = renderResultWaiters.get(requestId);
  if (!waiter) {
    return;
  }
  clearTimeout(waiter.timer);
  renderResultWaiters.delete(requestId);
  waiter.reject(new Error(errorMessage || "渲染失败"));
}
