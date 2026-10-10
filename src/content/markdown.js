import { stripInvisibleText } from "../lib/text.js";
import { guessImageExtension, normalizeImageName, createUniqueNamer } from "../lib/images.js";
import { createMarkdownConverter } from "../lib/markdown.js";

// —— 图片/媒体源 → data URL ——
function readBlobAsDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result || "");
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
}

async function imageSrcToDataUrl(src) {
  if (!src) {
    return "";
  }
  if (src.startsWith("data:image")) {
    return src;
  }
  try {
    const options = src.startsWith("blob:") ? {} : { credentials: "include" };
    const response = await fetch(src, options);
    if (!response.ok) {
      return "";
    }
    const blob = await response.blob();
    return await readBlobAsDataUrl(blob);
  } catch (error) {
    return "";
  }
}

function canvasToDataUrl(canvas) {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
    return "";
  }
  try {
    return canvas.toDataURL("image/png");
  } catch (error) {
    return "";
  }
}

function svgToDataUrl(svg) {
  if (!svg) {
    return "";
  }
  try {
    let svgText = svg.outerHTML || "";
    if (!svgText.includes("<svg")) {
      return "";
    }
    if (!svgText.includes("xmlns=")) {
      svgText = svgText.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  } catch (error) {
    return "";
  }
}

// —— 内容根节点定位 ——
function findContentRoot() {
  return (
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector("[role='document']") ||
    document.querySelector(".doc-content") ||
    document.querySelector(".lark-doc-content") ||
    document.body
  );
}

function findFeishuEditorRoot() {
  return (
    document.querySelector(".page-block.root-block[data-slate-editor='true']") ||
    document.querySelector("[data-content-editable-root='true']") ||
    document.querySelector(".docx-editor-container")
  );
}

function textFromFeishuAceLine(line) {
  const spans = Array.from(line.querySelectorAll('[data-string="true"]'));
  const text = spans
    .filter((span) => !span.hasAttribute("data-enter"))
    .map((span) => stripInvisibleText(span.textContent || ""))
    .join("")
    .trim();
  return text;
}

// 飞书编辑器（.ace-line）结构 turndown 无法识别，走专属提取分支。
function buildFeishuEditorMarkdown(title) {
  const root = findFeishuEditorRoot();
  if (!root) {
    return "";
  }

  const lines = [];
  if (title) {
    lines.push(`# ${title}`, "");
  }

  const seen = new Set();
  const aceLines = Array.from(root.querySelectorAll(".ace-line"));
  aceLines.forEach((line, index) => {
    const text = textFromFeishuAceLine(line);
    if (!text) {
      return;
    }
    const key = `${index}:${text}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    if (index === 0) {
      lines.push(`# ${text}`, "");
      return;
    }
    lines.push(text, "");
  });

  const markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return aceLines.length >= 3 && markdown.length > 80 ? markdown : "";
}

// HTML/DOM → Markdown 交由成熟库 turndown 处理（与 md-render.js 共用
// lib/markdown.js 的工厂配置）。此前这里手写了一份转换器，已全部删除。
// 惰性创建：turndown 实例只在真正导出时才构造。
let markdownConverter = null;

function getMarkdownConverter() {
  if (!markdownConverter) {
    markdownConverter = createMarkdownConverter();
  }
  return markdownConverter;
}

// 纯文本 Markdown 提取（不含图片 data URL）。优先走飞书编辑器专属分支，
// 否则用 turndown 转换内容根，失败兜底到 innerText。
export function buildMarkdown() {
  const title = stripInvisibleText(document.title || "").trim();
  const editorMarkdown = buildFeishuEditorMarkdown(title);
  if (editorMarkdown) {
    return editorMarkdown;
  }

  const root = findContentRoot();
  if (!root) {
    return title ? `# ${title}` : "";
  }

  let body = "";
  try {
    body = getMarkdownConverter().turndown(root);
  } catch (error) {
    body = "";
  }
  body = stripInvisibleText(body).replace(/\n{3,}/g, "\n\n").trim();

  if (!body) {
    body = stripInvisibleText(root.innerText || "").trim();
  }
  if (!body) {
    return title ? `# ${title}` : "";
  }

  return title ? `# ${title}\n\n${body}`.replace(/\n{3,}/g, "\n\n").trim() : body;
}

// 在 buildMarkdown 基础上，把页面里的 <img>/<canvas>/<svg> 收集为 data URL，
// 并把 Markdown 中的图片引用改写为本地 images/ 路径，供打包下载。
export async function buildMarkdownWithDomImages() {
  const root = findFeishuEditorRoot() || findContentRoot();
  let markdown = buildMarkdown();
  const images = [];
  const usedKeys = new Set();
  // 与 md-render 共用同一套唯一命名逻辑（此前本地版基于上一次候选名拼接，
  // 会产生 image_1_2.png 这类雪球命名）
  const ensureUniqueName = createUniqueNamer();

  const appendImage = async ({ source, alt, dataUrl }) => {
    const resolvedDataUrl = dataUrl || await imageSrcToDataUrl(source);
    if (!resolvedDataUrl || !resolvedDataUrl.startsWith("data:image")) {
      return;
    }
    const key = source || resolvedDataUrl.slice(0, 160);
    if (usedKeys.has(key)) {
      return;
    }
    usedKeys.add(key);
    const index = images.length + 1;
    const ext = guessImageExtension(resolvedDataUrl);
    const rawName = normalizeImageName(alt || `image_${index}`, `image_${index}`);
    const withExt = /\.[a-z0-9]+$/i.test(rawName) ? rawName : `${rawName}.${ext}`;
    const filename = ensureUniqueName(withExt);
    const localPath = `images/${filename}`;
    images.push({ filename, dataUrl: resolvedDataUrl });
    if (source && markdown.includes(source)) {
      markdown = markdown.split(source).join(localPath);
      return;
    }
    markdown = `${markdown.trim()}\n\n![${String(alt || `image_${index}`).replace(/[\r\n[\]]/g, " ")}](${localPath})`;
  };

  const imageNodes = root
    ? Array.from(root.querySelectorAll("img")).filter(
        (img) => !img.closest("[data-feishu-exporter]")
      )
    : [];
  for (const img of imageNodes) {
    const src = img.currentSrc || img.getAttribute("src") || "";
    await appendImage({
      source: src,
      alt: stripInvisibleText(img.getAttribute("alt") || img.getAttribute("data-name") || "")
    });
  }

  const canvasNodes = root
    ? Array.from(root.querySelectorAll("canvas")).filter(
        (canvas) => !canvas.closest("[data-feishu-exporter]")
      )
    : [];
  for (const canvas of canvasNodes) {
    const dataUrl = canvasToDataUrl(canvas);
    await appendImage({ source: "", alt: `canvas_${images.length + 1}`, dataUrl });
  }

  const svgNodes = root
    ? Array.from(root.querySelectorAll("svg")).filter(
        (svg) => !svg.closest("[data-feishu-exporter]")
      )
    : [];
  for (const svg of svgNodes) {
    const dataUrl = svgToDataUrl(svg);
    await appendImage({ source: "", alt: `svg_${images.length + 1}`, dataUrl });
  }

  return {
    markdown: markdown.trim(),
    images
  };
}
