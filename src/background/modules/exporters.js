import { stripInvisibleText } from "../../lib/text.js";
import { sanitizeFilename } from "../../lib/filename.js";
import { zipSync, strToU8 } from "fflate";
import {
  downloadFile,
  downloadContent,
  downloadZip,
  dataUrlToUint8Array,
  normalizeMarkdownImageDestinations,
  ZIP_LEVEL
} from "./download.js";
import { exportPdf } from "./debugger.js";
import { wrapHtmlDocument } from "./templates.js";
import { Msg } from "../../lib/protocol.js";
import { sendExportProgress } from "./progress.js";
import {
  waitForTabReady,
  waitForRenderReady,
  sendChunkedHtmlToRenderTab,
  waitForRenderResult
} from "./render.js";
import { countDocumentImages, extractDocumentHtml, extractAttachments } from "./inject.js";

// wrapHtmlDocument 已移至 ./templates.js，本模块从那里 import。

async function downloadHtml(bodyHtml, title) {
  return downloadContent({
    content: wrapHtmlDocument(title, bodyHtml),
    filename: `${sanitizeFilename(title, "feishu-document")}.html`,
    mime: "text/html"
  });
}

// 直接注入提取正文后落盘为单文件 HTML。图片以链接引用（不内联）。
export async function exportHtml(tabId, title, requestId) {
  sendExportProgress(tabId, requestId, "html", 10, "开始导出 HTML...");
  const imageCount = await countDocumentImages(tabId);
  if (imageCount > 0) {
    sendExportProgress(tabId, requestId, "html", 20, `保存图片中 0/${imageCount}`);
  }
  const result = await extractDocumentHtml(tabId);
  if (!result || !result.ok || !result.html) {
    throw new Error(result?.error || "无法提取文档内容");
  }
  if (imageCount > 0) {
    sendExportProgress(
      tabId,
      requestId,
      "html",
      40,
      `保存图片中 ${imageCount}/${imageCount}`
    );
  }
  sendExportProgress(tabId, requestId, "html", 45, "文档内容解析完成");
  const resolvedTitle = stripInvisibleText(result.title || title || "feishu-document").trim();
  sendExportProgress(tabId, requestId, "html", 70, "正在生成 HTML 文件...");
  const filename = await downloadHtml(result.html, resolvedTitle);
  sendExportProgress(tabId, requestId, "html", 100, "HTML 导出完成");
  return filename;
}

// —— 渲染标签页的复用 ——
//
// 渲染页是「HTML → 产物」的无状态转换器：交给它一份 HTML 的标题与正文，它回传
// Markdown / docx。单篇导出时用完即关；批量导出要连续处理几十篇，如果每篇都
// 建一次、销一次标签页，光标签页生命周期就要几十秒。所以这里把「建页」「推 HTML」
// 「等结果」「关页」拆开，批量时一个渲染页连续服务多篇。

export function createRenderRequestId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 打开渲染页并等它加载完成，返回 tabId。
export async function openRenderTab(htmlPath, timeoutMs = 15000) {
  const url = chrome.runtime.getURL(htmlPath);
  const renderTab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabReady(renderTab.id, timeoutMs);
  } catch (error) {
    closeTab(renderTab.id);
    throw error;
  }
  return renderTab.id;
}

// 关闭标签页。批量收尾时可能在页面已被用户手动关掉之后才调用，忽略失败。
export function closeTab(tabId) {
  if (!tabId) {
    return;
  }
  try {
    chrome.tabs.remove(tabId);
  } catch (error) {
    // 忽略：标签页已不存在
  }
}

// 让渲染页把一份 HTML 转成 Markdown，返回 { markdown, images }。
// renderTabId 由调用方持有，本函数不负责建/销标签页。
export async function renderMarkdownViaTab(
  renderTabId,
  { title, html, timeoutMs = 120000 }
) {
  const renderRequestId = createRenderRequestId("md-render");
  const responsePromise = waitForRenderResult(renderRequestId, timeoutMs);
  try {
    await sendChunkedHtmlToRenderTab({
      targetTabId: renderTabId,
      renderType: "md",
      title,
      html,
      requestId: renderRequestId
    });
  } catch (error) {
    // 推送失败时等待者仍在计时，超时后会 reject；先吞掉以免产生未处理的 rejection。
    responsePromise.catch(() => {});
    throw error;
  }

  const chunkedResponse = await responsePromise;
  if (!chunkedResponse || !chunkedResponse.ok) {
    throw new Error(chunkedResponse?.error || "无法生成 Markdown");
  }
  return {
    markdown: chunkedResponse.markdown || "",
    images: Array.isArray(chunkedResponse.images) ? chunkedResponse.images : []
  };
}

// 把提取到的 HTML 丢给 md-render 标签页，分块回传后由 turndown 转成 Markdown。
// 返回 { title, markdown, images }，供后续打包成 zip。
async function extractMarkdownFromHtml(tabId, title) {
  const result = await extractDocumentHtml(tabId);
  if (!result || !result.ok || !result.html) {
    throw new Error(result?.error || "无法提取文档内容");
  }
  const resolvedTitle = stripInvisibleText(result.title || title || "feishu-document").trim();
  let renderTabId = null;
  try {
    renderTabId = await openRenderTab("src/render/md-render.html");
    const rendered = await renderMarkdownViaTab(renderTabId, {
      title: resolvedTitle,
      html: result.html
    });
    return {
      title: resolvedTitle,
      markdown: rendered.markdown,
      images: rendered.images
    };
  } finally {
    closeTab(renderTabId);
  }
}

// 兜底路径：直接让 content script 把当前 DOM 转成 Markdown（不依赖页面模型）。
function extractMarkdownFromDom(tabId, title) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: Msg.EXPORT_MARKDOWN },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        if (!response || !response.ok || !response.markdown) {
          reject(new Error(response?.error || "无法从页面内容提取 Markdown"));
          return;
        }
        resolve({
          title: stripInvisibleText(title || "feishu-document").trim(),
          markdown: stripInvisibleText(response.markdown),
          images: Array.isArray(response.images) ? response.images : []
        });
      }
    );
  });
}

// 先把 HTML 送渲染标签页转 Markdown（优先），失败则回退到 DOM 直转；
// 再把 Markdown + 图片打包成 zip 下载。
export async function exportMarkdownFromModel(tabId, title, requestId) {
  sendExportProgress(tabId, requestId, "markdown", 10, "开始导出 Markdown...");
  sendExportProgress(tabId, requestId, "markdown", 15, "正在读取文档结构...");
  const imageCount = await countDocumentImages(tabId);
  if (imageCount > 0) {
    sendExportProgress(
      tabId,
      requestId,
      "markdown",
      25,
      `保存图片中 0/${imageCount}`
    );
  } else {
    sendExportProgress(tabId, requestId, "markdown", 25, "正在提取文档内容...");
  }
  let result;
  try {
    result = await extractMarkdownFromHtml(tabId, title);
  } catch (error) {
    sendExportProgress(
      tabId,
      requestId,
      "markdown",
      30,
      "未读取到页面模型，切换为兼容导出..."
    );
    result = await extractMarkdownFromDom(tabId, title);
  }
  if (!result || !result.markdown) {
    throw new Error("无法提取文档内容");
  }
  const images = Array.isArray(result.images) ? result.images : [];
  if (imageCount > 0) {
    sendExportProgress(
      tabId,
      requestId,
      "markdown",
      50,
      `保存图片中 ${imageCount}/${imageCount}`
    );
  }
  sendExportProgress(tabId, requestId, "markdown", 55, "Markdown 转换完成");
  if (images.length > 0) {
    sendExportProgress(
      tabId,
      requestId,
      "markdown",
      56,
      `保存图片中 0/${images.length}`
    );
  }
  const baseName = sanitizeFilename(result.title || title || "feishu-document", "feishu-document");
  const markdownName = `${baseName}.md`;
  const zipName = `${baseName}.zip`;
  const files = {
    [markdownName]: strToU8(
      normalizeMarkdownImageDestinations(stripInvisibleText(result.markdown || ""))
    )
  };

  images.forEach((image, index) => {
    if (!image || !image.dataUrl) {
      return;
    }
    const rawName = image.filename || `image_${index + 1}.png`;
    const safeName =
      String(rawName || "").replace(/\\/g, "/").split("/").pop() ||
      sanitizeFilename(rawName, `image_${index + 1}.png`);
    const bytes = dataUrlToUint8Array(image.dataUrl);
    files[`images/${safeName}`] = bytes;
    if (images.length > 0 && ((index + 1) % 5 === 0 || index + 1 === images.length)) {
      const ratio = (index + 1) / images.length;
      const progress = 55 + Math.round(ratio * 20);
      sendExportProgress(
        tabId,
        requestId,
        "markdown",
        progress,
        `保存图片中 ${index + 1}/${images.length}`
      );
    }
  });

  if (images.length === 0) {
    sendExportProgress(tabId, requestId, "markdown", 65, "未发现图片，开始打包");
  }

  sendExportProgress(tabId, requestId, "markdown", 80, "正在打包为 ZIP...");
  const zipData = zipSync(files, { level: ZIP_LEVEL });
  sendExportProgress(tabId, requestId, "markdown", 95, "准备下载文件...");
  const filename = await downloadZip(zipData, zipName);
  sendExportProgress(tabId, requestId, "markdown", 100, "Markdown 导出完成");
  return filename;
}

// Word 分支：与 PDF/Markdown 一样共用主干 HTML，但**不复用 Markdown 产物**——
// 把 HTML 直接交给 word-render 标签页映射成 docx（HTML → docx 一步到位），
// 避免 HTML → Markdown → docx 的中间有损往返，因此加粗/表格/图片等能保真落进 Word。
// 产物是二进制，渲染页以 data:URL 分块回传（SW 里没有 URL.createObjectURL）。
export async function exportWordFromHtml(tabId, title, requestId) {
  sendExportProgress(tabId, requestId, "word", 10, "开始导出 Word...");
  sendExportProgress(tabId, requestId, "word", 15, "正在读取文档结构...");
  const imageCount = await countDocumentImages(tabId);
  if (imageCount > 0) {
    sendExportProgress(tabId, requestId, "word", 25, `保存图片中 0/${imageCount}`);
  } else {
    sendExportProgress(tabId, requestId, "word", 25, "正在提取文档内容...");
  }

  const result = await extractDocumentHtml(tabId);
  if (!result || !result.ok || !result.html) {
    throw new Error(result?.error || "无法提取文档内容");
  }
  const resolvedTitle = stripInvisibleText(result.title || title || "feishu-document").trim();
  const filename = `${sanitizeFilename(resolvedTitle, "feishu-document")}.docx`;

  if (imageCount > 0) {
    sendExportProgress(tabId, requestId, "word", 45, `保存图片中 ${imageCount}/${imageCount}`);
  }
  sendExportProgress(tabId, requestId, "word", 50, "正在生成 Word 文档...");

  let renderTabId = null;
  let dataUrl = "";
  try {
    renderTabId = await openRenderTab("src/render/word-render.html");

    const renderRequestId = createRenderRequestId("word-render");
    const responsePromise = waitForRenderResult(renderRequestId, 180000);
    await sendChunkedHtmlToRenderTab({
      targetTabId: renderTabId,
      renderType: "word",
      title: resolvedTitle,
      html: result.html,
      requestId: renderRequestId
    });
    const chunkedResponse = await responsePromise;
    if (!chunkedResponse || !chunkedResponse.ok || !chunkedResponse.dataUrl) {
      throw new Error(chunkedResponse?.error || "无法生成 Word 文档");
    }
    dataUrl = chunkedResponse.dataUrl;
  } finally {
    closeTab(renderTabId);
  }

  sendExportProgress(tabId, requestId, "word", 85, "正在保存 Word 文件...");
  await downloadFile(dataUrl, filename, true);
  sendExportProgress(tabId, requestId, "word", 100, "Word 导出完成");
  return filename;
}

// 提取文档里的图片与文件附件，按子目录分多个下载落盘（不打包）。
export async function exportAttachments(tabId, title) {
  const result = await extractAttachments(tabId);
  if (!result || !result.ok || !result.attachments) {
    throw new Error(result?.error || "无法提取附件");
  }

  const images = result.attachments.images || [];
  const files = result.attachments.files || [];
  const baseName = sanitizeFilename(title || "feishu-document", "feishu-document");
  const folderName = `${baseName}_attachments`;

  for (const item of images) {
    if (!item || !item.dataUrl) {
      continue;
    }
    const name = sanitizeFilename(item.filename || "image", "image");
    await downloadFile(item.dataUrl, `${folderName}/images/${name}`, false);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  for (const item of files) {
    if (!item || !item.url) {
      continue;
    }
    const name = sanitizeFilename(item.filename || "file", "file");
    await downloadFile(item.url, `${folderName}/files/${name}`, false);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  return {
    folderName,
    imageCount: images.length,
    fileCount: files.length
  };
}

// 优先用 HTML 渲染标签页排版后打印 PDF（图片/样式更准），
// 提取或渲染失败时降级为直接对文档页打印。
export async function exportPdfFromHtml(tabId, title, requestId) {
  let renderTabId = null;
  try {
    sendExportProgress(tabId, requestId, "pdf", 10, "开始导出 PDF...");
    const imageCount = await countDocumentImages(tabId);
    if (imageCount > 0) {
      sendExportProgress(tabId, requestId, "pdf", 25, `保存图片中 0/${imageCount}`);
    } else {
      sendExportProgress(tabId, requestId, "pdf", 25, "正在提取文档内容（含图片）...");
    }
    const result = await extractDocumentHtml(tabId);
    if (!result || !result.ok || !result.html) {
      sendExportProgress(tabId, requestId, "pdf", 35, "提取失败，尝试直接导出");
      const filename = await exportPdf(tabId, title);
      sendExportProgress(tabId, requestId, "pdf", 100, "PDF 导出完成");
      return filename;
    }

    if (imageCount > 0) {
      sendExportProgress(
        tabId,
        requestId,
        "pdf",
        40,
        `保存图片中 ${imageCount}/${imageCount}`
      );
    }
    sendExportProgress(tabId, requestId, "pdf", 45, "内容解析完成，准备渲染...");
    renderTabId = await openRenderTab("src/render/pdf-render.html");

    sendExportProgress(tabId, requestId, "pdf", 65, "正在渲染 PDF 页面...");
    const readyPromise = waitForRenderReady(renderTabId, 60000);
    const renderRequestId = createRenderRequestId("pdf-render");
    await sendChunkedHtmlToRenderTab({
      targetTabId: renderTabId,
      renderType: "pdf",
      title: result.title || title,
      html: result.html,
      requestId: renderRequestId
    });

    try {
      await readyPromise;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    sendExportProgress(tabId, requestId, "pdf", 85, "正在生成 PDF 文件...");
    let filename = "";
    try {
      filename = await exportPdf(renderTabId, result.title || title);
    } catch (error) {
      sendExportProgress(tabId, requestId, "pdf", 88, "生成失败，尝试直接打印文档...");
      filename = await exportPdf(tabId, title);
    }
    sendExportProgress(tabId, requestId, "pdf", 100, "PDF 导出完成");
    return filename;
  } finally {
    closeTab(renderTabId);
  }
}

export async function downloadMarkdown(markdown, title) {
  if (!markdown) {
    throw new Error("未提取到文档内容");
  }

  return downloadContent({
    content: normalizeMarkdownImageDestinations(stripInvisibleText(markdown)),
    filename: `${sanitizeFilename(title, "feishu-document")}.md`,
    mime: "text/markdown"
  });
}
