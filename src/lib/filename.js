// 文件名净化：NFKC 归一化 + 非法字符替换 + 保留名规避，适配飞书中文标题。
const RESERVED_FILENAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFilename(name, fallbackName) {
  const fallback = String(fallbackName || "feishu-document");
  const source = String(name || "").trim() || fallback;
  const normalized =
    typeof source.normalize === "function" ? source.normalize("NFKC") : source;
  let baseName = Array.from(normalized)
    .join("")
    .replace(/[­؜᠎​-‏⁠-⁯﻿]/g, " ")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/g, "");

  baseName = Array.from(baseName).slice(0, 60).join("").replace(/[. ]+$/g, "");

  if (!baseName || baseName === "." || baseName === "..") {
    baseName = fallback;
  }
  if (RESERVED_FILENAME_PATTERN.test(baseName)) {
    baseName = `${baseName}_`;
  }
  return baseName || "feishu-document";
}
