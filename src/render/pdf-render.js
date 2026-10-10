import { getCurrentTabId } from "../lib/tab.js";
import { createChunkedRenderHandler } from "../lib/chunked-render.js";
import { Msg } from "../lib/protocol.js";

const root = document.getElementById("root");

function waitForImages(container, timeoutMs = 8000) {
  const images = Array.from(container.querySelectorAll("img"));
  if (images.length === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = 0;
    const finish = () => {
      done += 1;
      if (done >= images.length) {
        resolve();
      }
    };

    const timer = setTimeout(resolve, timeoutMs);

    images.forEach((img) => {
      if (img.complete) {
        finish();
        return;
      }
      img.addEventListener("load", finish, { once: true });
      img.addEventListener("error", finish, { once: true });
    });

    Promise.resolve().then(() => {
      if (done >= images.length) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function renderPdfHtmlPayload(tabId, title, html, requestId) {
  if (!tabId || !root) {
    return;
  }
  document.title = title || "飞书批量导出";
  root.innerHTML = html || "";

  await waitForImages(root);
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));

  chrome.runtime.sendMessage({
    type: Msg.PDF_RENDER_READY,
    tabId,
    requestId
  });
}

// 分片 HTML 的接收/拼装由共享工厂处理（与 md-render 同一套逻辑）。
// PDF 侧没有结果上报通道，故不传 onError，保持原「异常向上抛出」的行为。
const handleChunkedRenderMessage = createChunkedRenderHandler({
  renderType: "pdf",
  onComplete: ({ tabId, requestId, title, html }) =>
    renderPdfHtmlPayload(tabId, title, html, requestId)
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

  if (message.type !== Msg.RENDER_PDF_HTML) {
    return;
  }

  getCurrentTabId().then(async (tabId) => {
    if (!tabId || message.targetTabId !== tabId) {
      return;
    }
    await renderPdfHtmlPayload(tabId, message.title, message.html, message.requestId);
  });
});
