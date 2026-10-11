import { strToU8 } from "fflate";
import { sanitizeFilename } from "../../lib/filename.js";

export const ZIP_LEVEL = 6;

// 把 Markdown 里的相对图片路径改写为带尖括号的安全形式，规避部分 Markdown
// 解析器对空格/尖括号的误解析（路径里可能含转义后的换行或 >）。
export function normalizeMarkdownImageDestinations(markdown) {
  return String(markdown || "").replace(
    /!\[([^\]\n]*)\]\((images\/[^)\n<>]+)\)/g,
    (match, alt, destination) => {
      const safeDestination = destination
        .replace(/\\/g, "/")
        .replace(/\r?\n/g, "%0A")
        .replace(/>/g, "%3E");
      return `![${alt}](<${safeDestination}>)`;
    }
  );
}

// 把可能带子目录的下载名逐段净化，避免非法字符导致 chrome.downloads 报错。
function sanitizeDownloadPath(filename, fallbackName) {
  const fallback = fallbackName || "feishu-document";
  const parts = String(filename || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part, index) =>
      sanitizeFilename(part, index === 0 ? fallback : "file")
    )
    .filter(Boolean);
  return parts.length > 0 ? parts.join("/") : sanitizeFilename(fallback);
}

function getSafeExtension(filename) {
  const leafName =
    String(filename || "").replace(/\\/g, "/").split("/").pop() || "";
  const match = leafName.match(/(\.[A-Za-z0-9]{1,8})$/);
  return match ? match[1].toLowerCase() : "";
}

// 当文件名被系统拒绝时，回退到「净化基名 + 时间戳 + 原扩展名」，保证能下载成功。
function getFallbackDownloadPath(filename, fallbackName) {
  const ext = getSafeExtension(filename);
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const baseName =
    sanitizeFilename(fallbackName || "feishu-document", "feishu-document")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[. _-]+|[. _-]+$/g, "") || "feishu-document";
  return `${baseName}-${stamp}${ext}`;
}

function isInvalidDownloadFilenameError(error) {
  return /invalid filename|filename.*invalid|文件名.*无效|无效.*文件名/i.test(
    error?.message || ""
  );
}

function getDownloadErrorMessage(error) {
  if (isInvalidDownloadFilenameError(error)) {
    return "文件名包含当前系统不接受的字符，已尝试使用安全文件名下载，请重试。";
  }
  return error?.message || "下载失败";
}

// 封装 chrome.downloads.download：统一处理非法文件名（降级到带时间戳的安全名）。
export function downloadFile(url, filename, saveAs = true) {
  return new Promise((resolve, reject) => {
    const startDownload = (downloadFilename, retryOnInvalidFilename) => {
      chrome.downloads.download(
        {
          url,
          filename: downloadFilename,
          saveAs
        },
        (downloadId) => {
          const err = chrome.runtime.lastError;
          if (err) {
            const error = new Error(err.message);
            if (retryOnInvalidFilename && isInvalidDownloadFilenameError(error)) {
              startDownload(getFallbackDownloadPath(filename, "feishu-document"), false);
              return;
            }
            reject(new Error(getDownloadErrorMessage(error)));
            return;
          }
          resolve(downloadId);
        }
      );
    };

    startDownload(sanitizeDownloadPath(filename, "feishu-document"), true);
  });
}

// 把文本类导出内容（HTML / Markdown）落盘。
// 优先用 Blob + createObjectURL，避开 data: URL 的长度限制；环境不支持时回退到
// data: URL。原先 downloadHtml / downloadMarkdown 各自写了一遍这套流程，这里统一。
export async function downloadContent({ content, filename, mime }) {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      await downloadFile(url, filename, true);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    return filename;
  }

  const dataUrl = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  await downloadFile(dataUrl, filename, true);
  return filename;
}

export function dataUrlToUint8Array(dataUrl) {
  if (typeof dataUrl !== "string") {
    return new Uint8Array();
  }
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    return new Uint8Array();
  }
  const meta = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  if (/;base64/i.test(meta)) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  const decoded = decodeURIComponent(payload);
  return strToU8(decoded);
}

function uint8ToBase64(bytes) {
  if (!bytes || bytes.length === 0) {
    return "";
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function downloadZip(zipData, filename) {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const blob = new Blob([zipData], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    try {
      await downloadFile(url, filename, true);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    return filename;
  }

  const base64 = uint8ToBase64(zipData);
  const dataUrl = `data:application/zip;base64,${base64}`;
  await downloadFile(dataUrl, filename, true);
  return filename;
}
