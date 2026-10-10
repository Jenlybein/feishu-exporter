import { exportPdf } from "./debugger.js";
import {
  exportPdfFromHtml,
  exportHtml,
  exportAttachments,
  exportMarkdownFromModel,
  exportWordFromHtml,
  downloadMarkdown
} from "./exporters.js";
import {
  renderWaiters,
  renderResultWaiters,
  completeRenderResultSuccess,
  completeRenderResultError
} from "./render.js";
import {
  Msg,
  EXPORT_RESULT_KEY,
  replyAsync,
  ack
} from "../../lib/protocol.js";

// 从消息与发送方解析 tabId / title / requestId，省去各分支重复解构。
export function readTabContext(message, sender) {
  return {
    tabId: message.tabId || sender?.tab?.id,
    title: message.title || "feishu-document",
    requestId: message.requestId
  };
}

// 需要 tabId 的六个导出动作：消息类型 -> 用上下文构造任务的工厂。
// 附件成功返回的是 result 对象、其余返回 filename，用 EXPORT_RESULT_KEY 区分。
const EXPORT_HANDLERS = {
  [Msg.EXPORT_PDF]: (ctx) => exportPdf(ctx.tabId, ctx.title),
  [Msg.EXPORT_PDF_ADVANCED]: (ctx) => exportPdfFromHtml(ctx.tabId, ctx.title, ctx.requestId),
  [Msg.EXPORT_HTML]: (ctx) => exportHtml(ctx.tabId, ctx.title, ctx.requestId),
  [Msg.EXPORT_ATTACHMENTS]: (ctx) => exportAttachments(ctx.tabId, ctx.title),
  [Msg.EXPORT_MARKDOWN_ADVANCED]: (ctx) =>
    exportMarkdownFromModel(ctx.tabId, ctx.title, ctx.requestId),
  [Msg.EXPORT_WORD_ADVANCED]: (ctx) =>
    exportWordFromHtml(ctx.tabId, ctx.title, ctx.requestId)
};

// 注册唯一的 chrome.runtime.onMessage 监听器。所有消息类型在此集中分发，
// 渲染分块回调在这里被收拢成最终导出结果，导出动作经 EXPORT_HANDLERS 表驱动。
export function registerMessageHandler() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) {
      return;
    }

    if (message.type === Msg.EXPORT_PROGRESS) {
      ack(sendResponse);
      return;
    }

    if (message.type === Msg.PDF_RENDER_READY) {
      const waiter = renderWaiters.get(message.tabId);
      if (waiter) {
        clearTimeout(waiter.timer);
        renderWaiters.delete(message.tabId);
        waiter.resolve();
      }
      return;
    }

    if (message.type === Msg.RENDER_RESULT_CHUNK_START) {
      const waiter = renderResultWaiters.get(message.requestId);
      if (waiter) {
        waiter.totalChunks = Number(message.totalChunks) || 0;
        waiter.chunks = new Array(waiter.totalChunks || 0);
      }
      ack(sendResponse);
      return;
    }

    if (message.type === Msg.RENDER_RESULT_CHUNK) {
      const waiter = renderResultWaiters.get(message.requestId);
      if (waiter) {
        const index = Number(message.index);
        if (!Number.isNaN(index) && index >= 0) {
          waiter.chunks[index] = String(message.chunk || "");
        }
      }
      ack(sendResponse);
      return;
    }

    if (message.type === Msg.RENDER_RESULT_CHUNK_END) {
      const waiter = renderResultWaiters.get(message.requestId);
      if (!waiter) {
        ack(sendResponse);
        return;
      }
      const payloadText =
        Array.isArray(waiter.chunks) && waiter.chunks.length > 0
          ? waiter.chunks.join("")
          : "";
      completeRenderResultSuccess(message.requestId, payloadText);
      ack(sendResponse);
      return;
    }

    if (message.type === Msg.RENDER_RESULT_ERROR) {
      completeRenderResultError(message.requestId, message.error);
      ack(sendResponse);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(EXPORT_HANDLERS, message.type)) {
      const ctx = readTabContext(message, sender);
      if (!ctx.tabId) {
        sendResponse({ ok: false, error: "未找到活动标签页" });
        return;
      }
      return replyAsync(
        sendResponse,
        EXPORT_HANDLERS[message.type](ctx),
        EXPORT_RESULT_KEY[message.type] || "filename"
      );
    }

    if (message.type === Msg.DOWNLOAD_MARKDOWN) {
      const title = message.title || "feishu-document";
      return replyAsync(sendResponse, downloadMarkdown(message.markdown, title));
    }
  });
}
