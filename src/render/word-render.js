import { stripInvisibleText } from "../lib/text.js";
import { buildDocxBlob } from "./html-docx.js";
import { splitStringToChunks } from "../lib/chunk.js";
import { sendRuntimeMessageAsync } from "../lib/message.js";
import { createChunkedRenderHandler } from "../lib/chunked-render.js";
import { Msg } from "../lib/protocol.js";

// Word 渲染页：接收 SW 分片推送的主干 HTML → 直接映射成 docx → 回传 base64。
// 与 md-render 的区别只在于「收尾动作」：这里是生成二进制 docx 而不是 Markdown，
// 因此结果以 data:URL 回传（SW 无 URL.createObjectURL，下载统一走 data:URL 通路）。
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取 docx 数据失败"));
    reader.readAsDataURL(blob);
  });
}

async function sendChunkedWordResult(requestId, payload) {
  const serialized = JSON.stringify(payload || {});
  const chunks = splitStringToChunks(serialized);
  await sendRuntimeMessageAsync({
    type: Msg.RENDER_RESULT_CHUNK_START,
    requestId,
    totalChunks: chunks.length
  });
  for (let i = 0; i < chunks.length; i += 1) {
    await sendRuntimeMessageAsync({
      type: Msg.RENDER_RESULT_CHUNK,
      requestId,
      index: i,
      chunk: chunks[i]
    });
  }
  await sendRuntimeMessageAsync({
    type: Msg.RENDER_RESULT_CHUNK_END,
    requestId
  });
}

async function renderWordFromHtml(requestId, title, html) {
  const blob = await buildDocxBlob(html, stripInvisibleText(title || "").trim());
  const dataUrl = await blobToDataUrl(blob);
  await sendChunkedWordResult(requestId, { ok: true, dataUrl, mime: DOCX_MIME });
}

// 分片 HTML 的接收/拼装由共享工厂处理，此处只提供 Word 特有的生成与错误上报
const handleChunkedRenderMessage = createChunkedRenderHandler({
  renderType: "word",
  onComplete: ({ requestId, title, html }) => renderWordFromHtml(requestId, title, html),
  onError: ({ requestId, error }) =>
    sendRuntimeMessageAsync({
      type: Msg.RENDER_RESULT_ERROR,
      requestId,
      error: error?.message || "Word render failed"
    }).catch(() => {})
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return;
  }

  if (
    message.type === Msg.RENDER_HTML_CHUNK_START ||
    message.type === Msg.RENDER_HTML_CHUNK ||
    message.type === Msg.RENDER_HTML_CHUNK_END
  ) {
    handleChunkedRenderMessage(message);
    if (typeof sendResponse === "function") {
      sendResponse({ ok: true });
    }
    return;
  }
});
