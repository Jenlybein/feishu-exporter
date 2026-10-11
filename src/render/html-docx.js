// HTML → DOCX 映射层（Word 导出分支的核心）。
//
// 只服务「主干 HTML → Word」这一条路：不做 HTML→Markdown→docx 的有损往返，
// 而是直接遍历 DOM，把飞书文档的块结构逐一翻译成 docx 元素
// （Heading / Paragraph / Table / ImageRun …），因此加粗、行内代码、围栏代码块、
// 表格、图片都能保真落进 Word，而不受「Markdown 能表达什么」的限制。
//
// 运行环境：扩展渲染页 word-render.html。那里有完整 DOM、Blob/FileReader，
// 且是 ESM 模块上下文，因此可以直接 import docx（渲染页不是经典脚本，
// 不受 inlineClassicLibs 的单文件约束）。
//
// 输入约定：html 是 extractDocumentHtml 产出的自包含 HTML 片段
// （图片已内联为 data:URL，代码块为 <pre><code class="language-xxx">）。

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";

// —— 版式常量 ——
// size 以半磅计：21 ≈ 10.5pt（Word 中文正文常用的「五号」）。
const BODY_FONT = "微软雅黑";
const MONO_FONT = "Consolas";
const BODY_SIZE = 21;
const CODE_SIZE = 18;
// docx 的 transformation 以像素计（96 DPI）。A4 减去页边距后的可用宽度约 600px，
// 超过这个宽度 Word 会把图片撑出页面，因此按比例缩到可容纳宽度。
const MAX_IMAGE_WIDTH_PX = 600;
const MAX_RASTER_SIZE = 2000; // 光栅化 canvas 的上限，避免超大画布失败
const ORDERED_LIST_REFERENCE = "feishu-ordered-list";
const CODE_SHADING = "F2F3F5";
const TABLE_HEADER_SHADING = "F2F3F5";
const QUOTE_BORDER_COLOR = "D0D3D6";
const CALLOUT_FILL = "F7F8FA";
const GRAY_TEXT = "646A73";

// docx 只接受这几种栅格格式；webp / svg 等先光栅化成 png。
const DOCX_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp"
};

const HEADING_BY_LEVEL = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6
};

// —— 小工具 ——

const isElement = (node) => !!node && node.nodeType === 1;
const isText = (node) => !!node && node.nodeType === 3;

// HTML 空白折叠语义的简化：连续空白压成一个空格。
const normalizeText = (text) => String(text ?? "").replace(/\s+/g, " ");

const getDirectChildren = (el, tagName) =>
  Array.from(el.children).filter((child) => child.tagName === tagName);

function loadImageElement(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function dataUrlToBytes(dataUrl) {
  const commaIndex = String(dataUrl || "").indexOf(",");
  if (commaIndex === -1) {
    return null;
  }
  try {
    const binary = atob(dataUrl.slice(commaIndex + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

const dataUrlMime = (src) => {
  const match = /^data:([^;,]+)[;,]/.exec(String(src || ""));
  return match ? match[1].toLowerCase() : "";
};

// 按可用宽度等比缩放，避免长图撑出页面。
function fitImageBox(width, height) {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  if (safeWidth <= MAX_IMAGE_WIDTH_PX) {
    return { width: safeWidth, height: safeHeight };
  }
  const ratio = MAX_IMAGE_WIDTH_PX / safeWidth;
  return { width: MAX_IMAGE_WIDTH_PX, height: Math.max(1, Math.round(safeHeight * ratio)) };
}

// —— 图片：docx 的 ImageRun 需要 类型 + 字节 + 像素宽高 ——
async function imageRunFromElement(imgEl) {
  const src = imgEl.getAttribute("src") || "";
  if (!src.startsWith("data:image")) {
    return null;
  }
  const image = await loadImageElement(src);
  if (!image || !image.naturalWidth || !image.naturalHeight) {
    return null;
  }
  const natural = { width: image.naturalWidth, height: image.naturalHeight };
  const box = fitImageBox(natural.width, natural.height);

  let type = DOCX_IMAGE_TYPES[dataUrlMime(src)];
  let bytes = null;

  if (type) {
    bytes = dataUrlToBytes(src);
  } else {
    // webp / svg 等：画到 canvas 再转 png（顺带完成缩放上限保护）。
    const scale = Math.min(1, MAX_RASTER_SIZE / Math.max(natural.width, natural.height));
    const canvasWidth = Math.max(1, Math.round(natural.width * scale));
    const canvasHeight = Math.max(1, Math.round(natural.height * scale));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        return null;
      }
      context.drawImage(image, 0, 0, canvasWidth, canvasHeight);
      type = "png";
      bytes = dataUrlToBytes(canvas.toDataURL("image/png"));
    } catch {
      return null;
    }
  }

  if (!type || !bytes || !bytes.length) {
    return null;
  }
  return new ImageRun({ type, data: bytes, transformation: box });
}

// —— 行内：把一段 DOM 翻译成 TextRun / ImageRun / ExternalHyperlink 序列 ——
async function inlineRuns(parent, style) {
  const runs = [];
  for (const child of Array.from(parent.childNodes)) {
    if (isText(child)) {
      const text = normalizeText(child.textContent);
      if (text) {
        runs.push(new TextRun({ text, ...style }));
      }
      continue;
    }
    if (!isElement(child)) {
      continue;
    }
    const tag = child.tagName;

    if (tag === "BR") {
      runs.push(new TextRun({ text: "", break: 1 }));
      continue;
    }
    if (tag === "STRONG" || tag === "B") {
      runs.push(...(await inlineRuns(child, { ...style, bold: true })));
      continue;
    }
    if (tag === "EM" || tag === "I") {
      runs.push(...(await inlineRuns(child, { ...style, italics: true })));
      continue;
    }
    if (tag === "DEL" || tag === "S" || tag === "STRIKE") {
      runs.push(...(await inlineRuns(child, { ...style, strike: true })));
      continue;
    }
    if (tag === "U") {
      runs.push(...(await inlineRuns(child, { ...style, underline: {} })));
      continue;
    }
    if (tag === "CODE") {
      runs.push(
        new TextRun({
          text: child.textContent || "",
          font: MONO_FONT,
          size: CODE_SIZE,
          shading: { type: ShadingType.CLEAR, fill: CODE_SHADING },
          ...style
        })
      );
      continue;
    }
    if (tag === "A") {
      const link = child.getAttribute("href") || "";
      const children = await inlineRuns(child, style);
      if (link && children.length) {
        runs.push(new ExternalHyperlink({ link, children }));
      } else {
        runs.push(...children);
      }
      continue;
    }
    if (tag === "IMG") {
      const run = await imageRunFromElement(child);
      if (run) {
        runs.push(run);
      }
      continue;
    }
    // span / u / 其它行内标签：样式透传，继续向下取文本
    runs.push(...(await inlineRuns(child, style)));
  }
  return runs;
}

// —— 块级 ——
const makeParagraph = (options, ctx) =>
  new Paragraph({ ...ctx?.paragraphStyle, ...options });

function codeBlockParagraph(preEl) {
  const codeEl = preEl.querySelector("code") || preEl;
  const text = String(codeEl.textContent || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "");
  const lines = text.split("\n");
  const runs = lines.map((line, index) =>
    new TextRun({
      text: line,
      font: MONO_FONT,
      size: CODE_SIZE,
      ...(index === 0 ? {} : { break: 1 })
    })
  );
  return new Paragraph({
    children: runs,
    shading: { type: ShadingType.CLEAR, fill: CODE_SHADING },
    spacing: { before: 120, after: 120 },
    indent: { left: 120, right: 120 },
    border: {
      top: { style: BorderStyle.SINGLE, size: 4, color: QUOTE_BORDER_COLOR, space: 4 },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: QUOTE_BORDER_COLOR, space: 4 },
      left: { style: BorderStyle.SINGLE, size: 4, color: QUOTE_BORDER_COLOR, space: 4 },
      right: { style: BorderStyle.SINGLE, size: 4, color: QUOTE_BORDER_COLOR, space: 4 }
    }
  });
}

function horizontalRuleParagraph() {
  return new Paragraph({
    text: "",
    spacing: { before: 120, after: 120 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: QUOTE_BORDER_COLOR, space: 1 }
    }
  });
}

// 列表：无序用 docx 内置的项目符号，有序用自定义 numbering（9 级十进制）。
async function listParagraphs(listEl, level, ordered, ctx) {
  const out = [];
  const listLevel = Math.max(0, Math.min(8, level));
  for (const li of getDirectChildren(listEl, "LI")) {
    const inlineChildren = [];
    const nestedLists = [];

    for (const child of Array.from(li.childNodes)) {
      if (isElement(child) && (child.tagName === "UL" || child.tagName === "OL")) {
        nestedLists.push(child);
        continue;
      }
      if (isElement(child) && /^P$/.test(child.tagName)) {
        inlineChildren.push(...(await inlineRuns(child, {})));
        continue;
      }
      if (isText(child)) {
        const text = normalizeText(child.textContent).trim();
        if (text) {
          inlineChildren.push(new TextRun({ text }));
        }
        continue;
      }
      if (isElement(child)) {
        inlineChildren.push(...(await inlineRuns(child, {})));
      }
    }

    out.push(
      makeParagraph(
        ordered
          ? { numbering: { reference: ORDERED_LIST_REFERENCE, level: listLevel }, children: inlineChildren }
          : { bullet: { level: listLevel }, children: inlineChildren },
        ctx
      )
    );

    for (const nested of nestedLists) {
      out.push(...(await listParagraphs(nested, level + 1, nested.tagName === "OL", ctx)));
    }
  }
  return out;
}

async function tableFromElement(tableEl, ctx) {
  const rows = [];
  const trs = Array.from(tableEl.querySelectorAll("tr"));
  for (let rowIndex = 0; rowIndex < trs.length; rowIndex += 1) {
    const tr = trs[rowIndex];
    const tds = Array.from(tr.children).filter(
      (cell) => cell.tagName === "TD" || cell.tagName === "TH"
    );
    if (tds.length === 0) {
      continue;
    }
    const isHeaderRow = tds.every((cell) => cell.tagName === "TH") || rowIndex === 0;
    const cells = [];
    for (const td of tds) {
      const cellBlocks = await blocksFromContainer(td, ctx);
      const children = cellBlocks.length
        ? cellBlocks
        : [makeParagraph({ children: await inlineRuns(td, {}) }, ctx)];
      cells.push(
        new TableCell({
          children,
          shading:
            td.tagName === "TH"
              ? { type: ShadingType.CLEAR, fill: TABLE_HEADER_SHADING }
              : undefined
        })
      );
    }
    rows.push(new TableRow({ children: cells, tableHeader: isHeaderRow }));
  }

  if (rows.length === 0) {
    return null;
  }
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE }
  });
}

async function blockFromElement(el, ctx) {
  const tag = el.tagName;

  if (/^H[1-6]$/.test(tag)) {
    const children = await inlineRuns(el, {});
    if (!children.length) {
      return [];
    }
    return [makeParagraph({ heading: HEADING_BY_LEVEL[Number(tag[1])], children }, ctx)];
  }

  if (tag === "P") {
    return [makeParagraph({ children: await inlineRuns(el, {}) }, ctx)];
  }

  if (tag === "UL" || tag === "OL") {
    return listParagraphs(el, ctx.listLevel || 0, tag === "OL", ctx);
  }

  if (tag === "BLOCKQUOTE") {
    const isCallout = el.classList.contains("callout");
    const quoteStyle = isCallout
      ? {
          indent: { left: 240, right: 240 },
          shading: { type: ShadingType.CLEAR, fill: CALLOUT_FILL },
          spacing: { before: 120, after: 120 }
        }
      : {
          indent: { left: 360 },
          spacing: { before: 120, after: 120 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: QUOTE_BORDER_COLOR, space: 8 }
          }
        };
    return blocksFromContainer(el, { ...ctx, paragraphStyle: quoteStyle });
  }

  if (tag === "PRE") {
    return [codeBlockParagraph(el)];
  }

  if (tag === "TABLE") {
    const table = await tableFromElement(el, ctx);
    return table ? [table] : [];
  }

  if (tag === "HR") {
    return [horizontalRuleParagraph()];
  }

  if (tag === "IMG") {
    const run = await imageRunFromElement(el);
    return run ? [new Paragraph({ children: [run] })] : [];
  }

  if (tag === "FIGCAPTION") {
    const children = await inlineRuns(el, { italics: true, color: GRAY_TEXT, size: 18 });
    return children.length
      ? [makeParagraph({ children, alignment: AlignmentType.CENTER }, ctx)]
      : [];
  }

  // 容器与未知块：继续向下递归；若既无块级子节点又无文本，则丢弃。
  const nested = await blocksFromContainer(el, ctx);
  if (nested.length) {
    return nested;
  }
  const runs = await inlineRuns(el, {});
  return runs.length ? [makeParagraph({ children: runs }, ctx)] : [];
}

async function blocksFromContainer(parent, ctx) {
  const out = [];
  for (const child of Array.from(parent.childNodes)) {
    if (isText(child)) {
      const text = normalizeText(child.textContent).trim();
      if (text) {
        out.push(makeParagraph({ children: [new TextRun({ text })] }, ctx));
      }
      continue;
    }
    if (!isElement(child)) {
      continue;
    }
    out.push(...(await blockFromElement(child, ctx)));
  }
  return out;
}

// 有序列表的 9 级十进制编号定义（docx 的 numbering 需要在文档级声明）。
function createNumberingConfig() {
  const levels = [];
  for (let level = 0; level < 9; level += 1) {
    levels.push({
      level,
      format: LevelFormat.DECIMAL,
      text: `%${level + 1}.`,
      alignment: AlignmentType.START,
      style: {
        paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } }
      }
    });
  }
  return { config: [{ reference: ORDERED_LIST_REFERENCE, levels }] };
}

// 入口：HTML 片段 → docx Blob。
export async function buildDocxBlob(html, title) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  const ctx = { listLevel: 0, paragraphStyle: null };
  const children = await blocksFromContainer(parsed.body, ctx);

  const safeTitle = String(title || "").trim();
  if (safeTitle) {
    children.unshift(new Paragraph({ text: safeTitle, heading: HeadingLevel.TITLE }));
  }

  const document = new Document({
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: BODY_SIZE } }
      }
    },
    numbering: createNumberingConfig(),
    sections: [{ children }]
  });

  return Packer.toBlob(document);
}
