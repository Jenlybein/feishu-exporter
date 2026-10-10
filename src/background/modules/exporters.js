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
  waitForMarkdownRenderResult
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
    const url = chrome.runtime.getURL("src/render/md-render.html");
    const renderTab = await chrome.tabs.create({ url, active: false });
    renderTabId = renderTab.id;
    await waitForTabReady(renderTabId);

    const renderRequestId = `md-render-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const responsePromise = waitForMarkdownRenderResult(renderRequestId, 120000);
    await sendChunkedHtmlToRenderTab({
      targetTabId: renderTabId,
      renderType: "md",
      title: resolvedTitle,
      html: result.html,
      requestId: renderRequestId
    });
    const chunkedResponse = await responsePromise;

    if (!chunkedResponse || !chunkedResponse.ok) {
      throw new Error(chunkedResponse?.error || "无法生成 Markdown");
    }

    return {
      title: resolvedTitle,
      markdown: chunkedResponse.markdown || "",
      images: Array.isArray(chunkedResponse.images) ? chunkedResponse.images : []
    };
  } finally {
    if (renderTabId) {
      chrome.tabs.remove(renderTabId);
    }
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
    const url = chrome.runtime.getURL("src/render/pdf-render.html");
    const renderTab = await chrome.tabs.create({ url, active: false });
    renderTabId = renderTab.id;
    await waitForTabReady(renderTabId);

    sendExportProgress(tabId, requestId, "pdf", 65, "正在渲染 PDF 页面...");
    const readyPromise = waitForRenderReady(renderTabId, 60000);
    const renderRequestId = `pdf-render-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
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
    if (renderTabId) {
      chrome.tabs.remove(renderTabId);
    }
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
