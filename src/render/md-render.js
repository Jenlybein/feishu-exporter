import { createMarkdownConverter } from "../lib/markdown.js";
import { stripInvisibleText } from "../lib/text.js";
import { guessImageExtension, normalizeImageName, createUniqueNamer } from "../lib/images.js";
import { splitStringToChunks } from "../lib/chunk.js";
import { sendRuntimeMessageAsync } from "../lib/message.js";
import { createChunkedRenderHandler } from "../lib/chunked-render.js";
import { Msg } from "../lib/protocol.js";

const rootEl = document.getElementById("root");

// HTML→Markdown 用成熟库 turndown（配合 GFM 插件支持表格/删除线/任务列表），
// 配置与 content.js 共用 lib/markdown.js 的工厂，避免两处行为不一致。
const turndownService = createMarkdownConverter();


// 飞书文档页提取出的内联图片：data:URL 改写成 images/ 相对路径，并收集清单供打包。
function extractImages(container) {
  const images = [];
  const ensureUniqueName = createUniqueNamer();
  let imageIndex = 1;

  const nodes = Array.from(container.querySelectorAll("img"));
  nodes.forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (!src.startsWith("data:image")) {
      return;
    }
    const alt = img.getAttribute("alt") || `image_${imageIndex}`;
    const ext = guessImageExtension(src);
    const baseName = normalizeImageName(alt, `image_${imageIndex}`);
    const hasExt = /\.[a-z0-9]+$/i.test(baseName);
    const filename = ensureUniqueName(hasExt ? baseName : `${baseName}.${ext}`);
    images.push({ filename, dataUrl: src });
    img.setAttribute("src", `images/${filename}`);
    imageIndex += 1;
  });

  return images;
}

async function sendChunkedMarkdownResult(requestId, payload) {
  const serialized = JSON.stringify(payload || {});
  const chunks = splitStringToChunks(serialized);
  await sendRuntimeMessageAsync({
    type: Msg.RENDER_MD_RESULT_CHUNK_START,
    requestId,
    totalChunks: chunks.length
  });
  for (let i = 0; i < chunks.length; i += 1) {
    await sendRuntimeMessageAsync({
      type: Msg.RENDER_MD_RESULT_CHUNK,
      requestId,
      index: i,
      chunk: chunks[i]
    });
  }
  await sendRuntimeMessageAsync({
    type: Msg.RENDER_MD_RESULT_CHUNK_END,
    requestId
  });
}

async function renderMarkdownFromHtml(requestId, title, html) {
  if (!rootEl) {
    throw new Error("Render container missing");
  }
  rootEl.innerHTML = html || "";
  const images = extractImages(rootEl);
  let markdown = turndownService.turndown(rootEl);
  markdown = stripInvisibleText(markdown).replace(/\n{3,}/g, "\n\n").trim();
  if (!markdown) {
    markdown = stripInvisibleText(rootEl.innerText || "").trim();
  }
  const safeTitle = stripInvisibleText(title || "").trim();
  if (safeTitle) {
    markdown = `# ${safeTitle}\n\n${markdown}`.replace(/\n{3,}/g, "\n\n").trim();
  }
  await sendChunkedMarkdownResult(requestId, {
    ok: true,
    markdown,
    images
  });
}

// 分片 HTML 的接收/拼装由共享工厂处理，此处只提供 Markdown 特有的收尾与错误上报
const handleChunkedRenderMessage = createChunkedRenderHandler({
  renderType: "md",
  onComplete: ({ requestId, title, html }) => renderMarkdownFromHtml(requestId, title, html),
  onError: ({ requestId, error }) =>
    sendRuntimeMessageAsync({
      type: Msg.RENDER_MD_RESULT_ERROR,
      requestId,
      error: error?.message || "Markdown render failed"
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
