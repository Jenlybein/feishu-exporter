import { getCurrentTabId } from "./tab.js";
import { Msg } from "./protocol.js";

// 渲染页（md-render / pdf-render）接收「分片 HTML」的通用逻辑。
//
// 背景脚本因单条消息长度限制，会把整篇 HTML 切成 RENDER_HTML_CHUNK_* 系列消息发送；
// 两个渲染页原先各自实现了一份几乎相同的接收/拼装/收尾流程，仅 renderType 与收尾
// 动作不同，因此抽成本工厂函数，由各渲染页传入差异部分。
//
// @param {string} renderType      只处理该类型的分片消息（"md" / "pdf"）
// @param {Function} onComplete    收尾回调，收到 { tabId, requestId, title, html }
// @param {Function} [onError]     出错回调，收到 { requestId, error }；不传则向上抛出
// @returns {Function} 可直接挂到 chrome.runtime.onMessage 的消息处理函数
export function createChunkedRenderHandler({ renderType, onComplete, onError }) {
  const incomingHtmlChunks = new Map();

  return async function handleChunkedRenderMessage(message) {
    const tabId = await getCurrentTabId();
    if (!tabId || tabId !== message.targetTabId) {
      return;
    }
    const requestId = message.requestId;
    if (!requestId) {
      return;
    }

    try {
      if (message.type === Msg.RENDER_HTML_CHUNK_START && message.renderType === renderType) {
        const totalChunks = Number(message.totalChunks) || 0;
        incomingHtmlChunks.set(requestId, {
          title: message.title || "",
          chunks: new Array(totalChunks || 0)
        });
        return;
      }

      if (message.type === Msg.RENDER_HTML_CHUNK && message.renderType === renderType) {
        const entry = incomingHtmlChunks.get(requestId);
        if (!entry) {
          return;
        }
        const index = Number(message.index);
        if (!Number.isNaN(index) && index >= 0) {
          entry.chunks[index] = String(message.chunk || "");
        }
        return;
      }

      if (message.type === Msg.RENDER_HTML_CHUNK_END && message.renderType === renderType) {
        const entry = incomingHtmlChunks.get(requestId);
        incomingHtmlChunks.delete(requestId);
        if (!entry) {
          return;
        }
        await onComplete({
          tabId,
          requestId,
          title: entry.title,
          html: entry.chunks.join("")
        });
      }
    } catch (error) {
      // pdf-render 原本没有 try/catch，未传 onError 时保持「向上抛出」的原始行为
      if (!onError) {
        throw error;
      }
      await onError({ requestId, error });
    }
  };
}
