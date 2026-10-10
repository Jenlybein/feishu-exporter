// 由背景脚本通过 chrome.scripting.executeScript({files:[...]}) 注入到页面 MAIN world。
// 共享辅助函数来自 feishu-shared.js（window.__feishu / FX）。
// 本文件由逐字抽取原始内联注入函数生成，提取专属逻辑与原始行为一致。
//
// ⚠️ 架构说明：此文件是「逆向飞书文档页面模型」的领域复杂性代码，不是架构问题而是
//    业务复杂度——它必须读取 window.PageMain / blockManager 等私有内部结构，且作为
//    MV3 MAIN world 经典脚本运行（不能有 import/export），只能挂到 window.__feishuExtractHtml。
//    因此刻意保持「单文件、零依赖、行为稳定」，可读性靠下面的分区导航保证，不做拆分重构。
//
// 结构导航（均位于下方 window.__feishuExtractHtml 函数体内）：
//   1. 工具         escapeHtml / escapeAttr / getBlockText 等纯字符串与块读取辅助
//   2. 取图          fetchImageDataUrl / fetchSpecialBlockDataUrl（来自 FX 命名空间）
//   3. 块渲染       renderImageBlock / renderCellContent / renderTableHtml / renderGridTable /
//                  renderSheetTable —— 把飞书块模型转成 HTML 片段
//   4. 遍历引擎     walk / walkChildren —— 递归遍历块树并拼接 parts[]
//   5. 预加载       preloadSpecialBlocks —— 滚动定位特殊块（图表/白板/表格）以触发渲染
//   6. 入口         locateRootBlock → walk(rootBlock) → 返回 { ok, title, html }
(function () {
  const FX = window.__feishu;
  const getBlockType = FX.getBlockType;
  const readValue = FX.readValue;
  const safeKeys = FX.safeKeys;
  // 以下取图/等待类能力原在本文件重复实现，现统一由 feishu-shared.js 提供
  const sleep = FX.sleep;
  const waitForCondition = FX.waitForCondition;
  const fetchImageDataUrl = FX.fetchImageDataUrl;
  const fetchSpecialBlockDataUrl = FX.fetchSpecialBlockDataUrl;

  window.__feishuExtractHtml = async function extractDocumentHtml() {
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const isRenderableRootBlock = (value) => {
            if (!value || typeof value !== "object") {
              return false;
            }
            if (Array.isArray(value.children)) {
              return true;
            }
            const type = value.type || value.snapshot?.type || "";
            return value.isRoot === true || type === "page";
          };
const getRootFromManager = (manager) => {
            if (!manager || typeof manager !== "object") {
              return null;
            }
            const direct = readValue(() => manager.rootBlockModel);
            if (isRenderableRootBlock(direct)) {
              return { rootBlock: direct, source: "manager.rootBlockModel" };
            }
            const modelServiceRoot = readValue(() => manager.modelService.rootBlockModel);
            if (isRenderableRootBlock(modelServiceRoot)) {
              return { rootBlock: modelServiceRoot, source: "manager.modelService.rootBlockModel" };
            }
            const rootRecordId = readValue(() => manager.rootRecordId);
            const getBlockModelsByRecordId = readValue(() => manager.getBlockModelsByRecordId);
            if (rootRecordId && typeof getBlockModelsByRecordId === "function") {
              const models = readValue(() => getBlockModelsByRecordId.call(manager, rootRecordId));
              const root = Array.isArray(models)
                ? models.find((item) => item?.isRoot || isRenderableRootBlock(item))
                : null;
              if (isRenderableRootBlock(root)) {
                return { rootBlock: root, source: "manager.getBlockModelsByRecordId(rootRecordId)" };
              }
            }
            return null;
          };
const locateRootBlock = () => {
            const pageMain = readValue(() => window.PageMain);
            // 只留错误提示需要的两个探针。以前这里还会枚举 PageMain / blockManager
            // 的 key 塞进 diagnostics 返回，但没有任何消费方，而 locateRootBlock
            // 每次重试都会跑一遍，白扔掉上百次属性遍历。
            const probe = {
              hasPageMain: !!pageMain,
              hasBlockManager: !!readValue(() => pageMain.blockManager)
            };

            const candidates = [
              {
                source: "PageMain.blockManager.rootBlockModel",
                value: readValue(() => pageMain.blockManager.rootBlockModel)
              },
              {
                source: "PageMain.blockManager.modelService.rootBlockModel",
                value: readValue(() => pageMain.blockManager.modelService.rootBlockModel)
              },
              {
                source: "PageMain.modelService.rootBlockModel",
                value: readValue(() => pageMain.modelService.rootBlockModel)
              },
              {
                source: "PageMain.editor.blockManager.rootBlockModel",
                value: readValue(() => pageMain.editor.blockManager.rootBlockModel)
              }
            ];

            for (const candidate of candidates) {
              if (isRenderableRootBlock(candidate.value)) {
                return { rootBlock: candidate.value };
              }
            }

            const managerResult = getRootFromManager(readValue(() => pageMain.blockManager));
            if (managerResult?.rootBlock) {
              return { rootBlock: managerResult.rootBlock };
            }

            const pageMainKeys = safeKeys(pageMain, 160);
            for (const key of pageMainKeys) {
              const value = readValue(() => pageMain[key]);
              if (!value || typeof value !== "object") {
                continue;
              }
              const nestedRoot = readValue(() => value.rootBlockModel);
              if (isRenderableRootBlock(nestedRoot)) {
                return { rootBlock: nestedRoot };
              }
              const nestedManager = getRootFromManager(readValue(() => value.blockManager));
              if (nestedManager?.rootBlock) {
                return { rootBlock: nestedManager.rootBlock };
              }
              const nestedModelServiceRoot = readValue(() => value.modelService.rootBlockModel);
              if (isRenderableRootBlock(nestedModelServiceRoot)) {
                return { rootBlock: nestedModelServiceRoot };
              }
            }

            return { rootBlock: null, probe };
          };
let located = locateRootBlock();
for (let i = 0; !located.rootBlock && i < 24; i += 1) {
            await pause(250);
            located = locateRootBlock();
          }
const rootBlock = located.rootBlock;
if (!rootBlock) {
            const probe = located.probe || {};
            const pageMainText = probe.hasPageMain ? "PageMain 已存在" : "PageMain 不存在";
            const managerText = probe.hasBlockManager ? "blockManager 已存在" : "blockManager 不存在";
            return {
              ok: false,
              error: `未找到文档数据（${pageMainText}，${managerText}）`
            };
          }
const escapeHtml = (text) =>
            String(text ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
const escapeAttr = (text) => escapeHtml(text).replace(/"/g, "&quot;");
const safeDecode = (value) => {
            if (!value) {
              return "";
            }
            try {
              return decodeURIComponent(value);
            } catch (error) {
              return String(value);
            }
          };
const parseInlineComponent = (attributes) => {
            if (!attributes || !attributes["inline-component"]) {
              return null;
            }
            try {
              const payload = JSON.parse(attributes["inline-component"]);
              if (payload && payload.type === "mention_doc") {
                return {
                  title: payload.data?.title || "",
                  url: payload.data?.raw_url || ""
                };
              }
            } catch (error) {
              return null;
            }
            return null;
          };
const renderInlineHtmlFromOps = (ops = []) =>
            ops
              .map((op) => {
                if (typeof op.insert !== "string") {
                  return "";
                }
                const attributes = op.attributes || {};
                const mention = parseInlineComponent(attributes);
                if (mention) {
                  const title = escapeHtml(mention.title || op.insert);
                  const link = escapeHtml(safeDecode(mention.url));
                  if (link) {
                    return `<a href="${link}" target="_blank" rel="noreferrer">${title}</a>`;
                  }
                  return title;
                }
                let text = escapeHtml(op.insert).replace(/\n/g, "<br/>");
                if (attributes.equation) {
                  const eq = escapeHtml(String(attributes.equation));
                  text = `<span class="equation">${eq}</span>`;
                }
                if (attributes.inlineCode || attributes.code) {
                  text = `<code>${text}</code>`;
                }
                if (attributes.bold) {
                  text = `<strong>${text}</strong>`;
                }
                if (attributes.italic) {
                  text = `<em>${text}</em>`;
                }
                if (attributes.strikethrough) {
                  text = `<del>${text}</del>`;
                }
                const link = safeDecode(attributes.link);
                if (link) {
                  const safeLink = escapeHtml(link);
                  text = `<a href="${safeLink}" target="_blank" rel="noreferrer">${text}</a>`;
                }
                return text;
              })
              .join("")
              .replace(/<br\/?>$/g, "");
const normalizeTextHtml = (text) =>
            escapeHtml(String(text || "")).replace(/\n/g, "<br/>").trim();
const getBlockText = (block) => {
            const zone = block?.zoneState;
            if (zone?.content?.ops) {
              return renderInlineHtmlFromOps(zone.content.ops);
            }
            if (typeof zone?.allText === "string") {
              return normalizeTextHtml(zone.allText);
            }
            const snapshotText =
              block?.snapshot?.text?.initialAttributedTexts?.text?.[0] || "";
            return typeof snapshotText === "string" ? normalizeTextHtml(snapshotText) : "";
          };
// 取块的「原始纯文本」：不做 HTML 转义、不把 \n 换成 <br/>。
// 代码块必须用它——getBlockText 返回的是已转义的 HTML，若再 escapeHtml 会二次转义，
// 导致 <br/> 变成字面文本、> 变成 &gt;。原始文本保留真实换行，交给 <pre> 呈现。
const getBlockRawText = (block) => {
            const zone = block?.zoneState;
            if (zone?.content?.ops) {
              return zone.content.ops
                .map((op) => (typeof op?.insert === "string" ? op.insert : ""))
                .join("");
            }
            if (typeof zone?.allText === "string") {
              return zone.allText;
            }
            const snapshotText =
              block?.snapshot?.text?.initialAttributedTexts?.text?.[0] || "";
            return typeof snapshotText === "string" ? snapshotText : "";
          };
// 代码块语言。飞书块模型的 TextStyle.language 在不同版本/不同快照层级的落点不完全一致
// （snapshot.style / snapshot.code.style / …），取值也可能是数字枚举或语言名字符串，
// 所以这里做「多路径探测 + 数字/字符串双解析」，最后归一化成 Markdown 围栏认识的标识。
// 枚举编号与飞书开放平台 CodeLanguage 对齐（7=Bash、22=Go、28=JSON、29=Java、
// 49=Python、52=Ruby、56=SQL、63=TypeScript、67=YAML 等已交叉核对）。下标 0 占位，语言从 1 起。
const CODE_LANGUAGE_BY_ID = [
            "",
            "PlainText", "ABAP", "Ada", "Apache", "Apex", "Assembly", "Bash",
            "CSharp", "Cpp", "C", "COBOL", "CSS", "CoffeeScript", "D", "Dart",
            "Delphi", "Django", "Dockerfile", "Erlang", "Fortran", "FoxPro", "Go",
            "Groovy", "HTML", "HTMLBars", "HTTP", "Haskell", "JSON", "Java",
            "JavaScript", "Julia", "Kotlin", "LateX", "Lisp", "Logo", "Lua",
            "MATLAB", "Makefile", "Markdown", "Nginx", "ObjectiveC", "OpenEdgeABL",
            "PHP", "Perl", "PostScript", "PowerShell", "Prolog", "ProtoBuf",
            "Python", "R", "RPG", "Ruby", "Rust", "SAS", "SCSS", "SQL", "Scala",
            "Scheme", "Scratch", "Shell", "Swift", "Thrift", "TypeScript",
            "VBScript", "VisualBasic", "XML", "YAML", "CMake", "Diff", "Gherkin",
            "GraphQL", "OpenGLShadingLanguage", "Properties", "Solidity", "TOML"
          ];
// 语言名 → Markdown 标识。空串表示「纯文本」，即不输出围栏语言。
const CODE_LANGUAGE_ALIASES = {
            "plain text": "", plaintext: "", plain: "", text: "", none: "",
            "c#": "csharp", csharp: "csharp", "c sharp": "csharp",
            "c++": "cpp", cpp: "cpp",
            "objective-c": "objectivec", objectivec: "objectivec", objc: "objectivec",
            "open edge abl": "openedgeabl",
            "visual basic": "vb", visualbasic: "vb",
            "assembly language": "asm", assembly: "asm", asm: "asm",
            htmlbars: "handlebars",
            protobuf: "protobuf", proto: "protobuf",
            "opengl shading language": "glsl", glsl: "glsl",
            golang: "go", yml: "yaml"
          };
const toMarkdownLanguage = (name) => {
            const key = String(name ?? "").trim().toLowerCase();
            if (!key) {
              return "";
            }
            if (Object.prototype.hasOwnProperty.call(CODE_LANGUAGE_ALIASES, key)) {
              return CODE_LANGUAGE_ALIASES[key];
            }
            // 兜底：去掉空格与符号（"coffee script" → coffeescript）。
            return key.replace(/[^a-z0-9]/g, "");
          };
// 解析单个候选值：未探到返回 null（继续探下一路径）；能识别则返回标识（可能为空串 = 纯文本）。
const normalizeCodeLanguage = (raw) => {
            if (raw === undefined || raw === null || raw === "") {
              return null;
            }
            if (typeof raw === "object") {
              return normalizeCodeLanguage(raw.id ?? raw.name ?? raw.value ?? raw.language);
            }
            const text = String(raw).trim();
            if (/^\d+$/.test(text)) {
              const name = CODE_LANGUAGE_BY_ID[Number(text)];
              return name ? toMarkdownLanguage(name) : null;
            }
            return text ? toMarkdownLanguage(text) : null;
          };
const getCodeLanguage = (block) => {
            const candidates = [
              () => block?.snapshot?.style?.language,
              () => block?.snapshot?.code?.style?.language,
              () => block?.snapshot?.code?.language,
              () => block?.snapshot?.text?.style?.language,
              () => block?.style?.language,
              () => block?.code?.style?.language,
              () => block?.code?.language,
              () => block?.zoneState?.style?.language,
              () => block?.snapshot?.zoneState?.style?.language,
              () => block?.language
            ];
            for (const read of candidates) {
              const language = normalizeCodeLanguage(readValue(read));
              if (language !== null) {
                return language;
              }
            }
            return "";
          };
const parts = [];
const processedImageIds = new Set();
const pushParagraph = (text) => {
            const content = String(text || "").trim();
            if (!content) {
              return;
            }
            parts.push(`<p>${content}</p>`);
          };
const getImageAlt = (block) => {
            const caption =
              block?.snapshot?.image?.caption?.text?.initialAttributedTexts?.text?.[0];
            const name = block?.snapshot?.image?.name;
            return typeof caption === "string" && caption.trim()
              ? caption.trim()
              : typeof name === "string"
                ? name
                : "image";
          };
const getImageMeta = (block) => ({
            token: block?.snapshot?.image?.token || "",
            name: block?.snapshot?.image?.name || ""
          });
const buildImageTag = ({ src, alt, token, name, style }) => {
            if (!src) {
              return "";
            }
            const attrs = [`src="${src}"`];
            if (alt) {
              attrs.push(`alt="${escapeAttr(alt)}"`);
            }
            if (token) {
              attrs.push(`data-token="${escapeAttr(token)}"`);
            }
            if (name) {
              attrs.push(`data-name="${escapeAttr(name)}"`);
            }
            if (style) {
              attrs.push(`style="${style}"`);
            }
            return `<img ${attrs.join(" ")} />`;
          };
const getBlockId = (block) =>
            block?.id || block?.snapshot?.id || block?.record?.id || "";
const isImageBlock = (block) => getBlockType(block) === "image";
const isGridColumnBlock = (block) => {
            const blockType = getBlockType(block);
            return (
              blockType === "grid_column" ||
              blockType === "grid-column" ||
              blockType === "gridColumn"
            );
          };
const isGridContainerBlock = (block) => {
            const blockType = getBlockType(block);
            if (
              blockType === "grid" ||
              blockType === "grid_container" ||
              blockType === "grid-container"
            ) {
              return true;
            }
            const children = Array.isArray(block?.children) ? block.children : [];
            return children.some((child) => isGridColumnBlock(child));
          };
const isTableCellBlock = (block) => getBlockType(block) === "table_cell";
const collectTableCells = (tableBlock) => {
            const cells = [];
            const walkCells = (node) => {
              if (!node) {
                return;
              }
              if (isTableCellBlock(node)) {
                cells.push(node);
                return;
              }
              const children = Array.isArray(node.children) ? node.children : [];
              for (const child of children) {
                walkCells(child);
              }
            };
            walkCells(tableBlock);
            return cells;
          };
const wrapInlineBlock = (html) =>
            `<div style="margin: 10px 0; line-height: 1.6;">${html}</div>`;
const renderCellContent = async (node, segments) => {
            if (!node) {
              return;
            }
            const nodeType = getBlockType(node);
            if (nodeType === "table_cell" || nodeType === "grid_column" || nodeType === "grid") {
              const children = Array.isArray(node.children) ? node.children : [];
              for (const child of children) {
                await renderCellContent(child, segments);
              }
              return;
            }
            if (isImageBlock(node)) {
              const alt = getImageAlt(node);
              const meta = getImageMeta(node);
              const dataUrl = await fetchImageDataUrl(node);
              if (dataUrl) {
                const imgTag = buildImageTag({
                  src: dataUrl,
                  alt,
                  token: meta.token,
                  name: meta.name
                });
                if (imgTag) {
                  segments.push(imgTag);
                  return;
                }
              }
              segments.push(wrapInlineBlock(`[image] ${escapeHtml(alt)}`));
              return;
            }
            if (nodeType === "diagram" || nodeType === "whiteboard" || nodeType === "mindnote") {
              const label =
                node?.snapshot?.diagram?.name ||
                node?.snapshot?.mindnote?.name ||
                node?.snapshot?.whiteboard?.name ||
                "";
              const dataUrl = await fetchSpecialBlockDataUrl(node);
              if (dataUrl) {
                const imgTag = buildImageTag({
                  src: dataUrl,
                  alt: label || nodeType
                });
                if (imgTag) {
                  segments.push(imgTag);
                  return;
                }
              }
              segments.push(wrapInlineBlock(`[${nodeType}] ${escapeHtml(label)}`));
              return;
            }
            if (nodeType === "file") {
              const name = node?.snapshot?.file?.name || "文件";
              const token = node?.snapshot?.file?.token || "";
              const url = getFileDownloadUrl(token);
              if (url) {
                segments.push(
                  wrapInlineBlock(
                    `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">文件：${escapeHtml(
                      name
                    )}</a>`
                  )
                );
              } else {
                segments.push(wrapInlineBlock(`文件：${escapeHtml(name)}`));
              }
              return;
            }
            if (nodeType === "iframe") {
              const src = getIframeUrl(node);
              if (src) {
                segments.push(
                  wrapInlineBlock(
                    `<a href="${escapeHtml(src)}" target="_blank" rel="noreferrer">嵌入链接：${escapeHtml(
                      src
                    )}</a>`
                  )
                );
              }
              return;
            }
            const text = getBlockText(node);
            if (text) {
              segments.push(wrapInlineBlock(text));
              return;
            }
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) {
              await renderCellContent(child, segments);
            }
          };
const renderTableCellHtml = async (cell) => {
            const segments = [];
            await renderCellContent(cell, segments);
            return segments.join("");
          };
const renderTableHtml = async (tableBlock) => {
            const cells = collectTableCells(tableBlock);
            if (cells.length === 0) {
              return "";
            }
            const columnCount = tableBlock?.snapshot?.columns_id?.length || 0;
            const rows = [];
            if (columnCount > 0) {
              for (let i = 0; i < cells.length; i += columnCount) {
                rows.push(cells.slice(i, i + columnCount));
              }
            } else {
              rows.push(cells);
            }
            const tableStyle = "border-collapse: collapse; width: 100%; margin: 16px 0;";
            const cellStyle =
              "border: 1px solid #dfe2e5; padding: 8px 12px; text-align: left; vertical-align: middle;";
            const rowHtml = [];
            for (const row of rows) {
              const cellHtmlList = await Promise.all(
                row.map(async (cell) => {
                  const cellHtml = await renderTableCellHtml(cell);
                  return `<td style="${cellStyle}">${cellHtml || "&nbsp;"}</td>`;
                })
              );
              rowHtml.push(`<tr>${cellHtmlList.join("")}</tr>`);
            }
            return `<table style="${tableStyle}">${rowHtml.join("")}</table>`;
          };
const renderGridTable = async (gridBlock) => {
            const children = Array.isArray(gridBlock.children) ? gridBlock.children : [];
            const columns = children.filter((child) => isGridColumnBlock(child));
            if (columns.length === 0) {
              return "";
            }
            const tableStyle =
              "border-collapse: collapse; width: 100%; margin: 16px 0; border: 1px solid #ddd;";
            const cellStyle =
              "border: 1px solid #ddd; padding: 8px; vertical-align: top; text-align: left;";
            const cellHtmlList = await Promise.all(
              columns.map(async (column) => {
                const segments = [];
                await renderCellContent(column, segments);
                return `<td style="${cellStyle}">${segments.join("") || "&nbsp;"}</td>`;
              })
            );
            return `<table style="${tableStyle}"><tr>${cellHtmlList.join("")}</tr></table>`;
          };
const getSheetIdFromToken = (token) => {
            if (!token) {
              return null;
            }
            const index = token.lastIndexOf("_");
            if (index === -1) {
              return null;
            }
            return token.slice(index + 1);
          };
const getSheetData = (sheetId) => {
            try {
              const spread = window.Spread?.collaSpread?._spread;
              if (!spread || !spread.sheets) {
                return null;
              }
              for (const sheet of Object.values(spread.sheets)) {
                if (sheet && typeof sheet.name === "function" && sheet.name() === sheetId) {
                  return sheet;
                }
              }
            } catch (error) {
              return null;
            }
            return null;
          };
const buildSheetImageMap = (sheet) => {
            const map = new Map();
            const appendImageMap = (source) => {
              if (!source) {
                return;
              }
              if (source instanceof Map) {
                source.forEach((value, key) => map.set(key, value));
                return;
              }
              const rawMap = source._map || source;
              if (rawMap instanceof Map) {
                rawMap.forEach((value, key) => map.set(key, value));
                return;
              }
              if (Array.isArray(rawMap)) {
                rawMap.forEach((entry) => {
                  if (Array.isArray(entry) && entry.length >= 2) {
                    map.set(entry[0], entry[1]);
                  }
                });
                return;
              }
              if (rawMap && typeof rawMap === "object") {
                Object.entries(rawMap).forEach(([key, value]) => {
                  const numericKey = Number(key);
                  map.set(Number.isNaN(numericKey) ? key : numericKey, value);
                });
              }
            };
            try {
              const imageRef = sheet?._dataModel?.contentModel?.image?.idToRef;
              appendImageMap(imageRef);
              if (map.size === 0) {
                const fallback = sheet?._dataModel?.image || sheet?.image;
                appendImageMap(fallback);
              }
            } catch (error) {
            }
            return map;
          };
const buildSheetImageTag = (info) => {
            if (!info) {
              return "";
            }
            const link = info.link || info.url || "";
            const fileToken = info.fileToken || info.token || "";
            const src = link || (fileToken
              ? `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/${fileToken}/`
              : "");
            if (!src) {
              return "";
            }
            const maxWidth = 300;
            let width = Number(info.width) || maxWidth;
            let height = Number(info.height) || 0;
            if (width > maxWidth) {
              const ratio = maxWidth / width;
              width = maxWidth;
              height = height ? Math.round(height * ratio) : height;
            }
            const sizeAttrs = [
              `width="${width}"`,
              height ? `height="${height}"` : ""
            ].filter(Boolean).join(" ");
            const style =
              "max-width: 100%; height: auto; display: block; margin: 4px auto;";
            const alt = escapeAttr(info.text || "图片");
            return `<img src="${src}" alt="${alt}" style="${style}" ${sizeAttrs} />`;
          };
const renderSheetCellValue = (value, imageMap) => {
            const resolveImageInfo = (id) => {
              if (!imageMap || id === null || id === undefined) {
                return null;
              }
              if (imageMap.has(id)) {
                return imageMap.get(id);
              }
              const numericId = Number(id);
              if (!Number.isNaN(numericId) && imageMap.has(numericId)) {
                return imageMap.get(numericId);
              }
              return null;
            };
            if (value === null || value === undefined || value === "") {
              return "&nbsp;";
            }
            if (Array.isArray(value)) {
              const parts = [];
              value.forEach((item) => {
                if (item && typeof item === "object") {
                  if (
                    item.type === "embed-image" ||
                    item.fileToken ||
                    item.token ||
                    item.link ||
                    item.url
                  ) {
                    const info =
                      item.type === "embed-image"
                        ? resolveImageInfo(item.id) || item
                        : item;
                    const imgTag = buildSheetImageTag(info);
                    parts.push(imgTag || `<span style="color: #999;">[图片]</span>`);
                    return;
                  }
                  const textValue = item.text || item.value || item.name || "";
                  if (textValue) {
                    parts.push(escapeHtml(String(textValue)));
                  }
                  return;
                }
                parts.push(escapeHtml(String(item)));
              });
              return parts.length > 0 ? parts.join("<br>") : "&nbsp;";
            }
            if (value && typeof value === "object") {
              if (
                value.type === "embed-image" ||
                value.fileToken ||
                value.token ||
                value.link ||
                value.url
              ) {
                const info =
                  value.type === "embed-image"
                    ? resolveImageInfo(value.id) || value
                    : value;
                const imgTag = buildSheetImageTag(info);
                return imgTag || `<span style="color: #999;">[图片]</span>`;
              }
              const textValue = value.text || value.value || value.name || "";
              return textValue ? escapeHtml(String(textValue)) : "&nbsp;";
            }
            return escapeHtml(String(value));
          };
const renderSheetTable = (sheetBlock) => {
            const token = sheetBlock?.snapshot?.token || "";
            const sheetId = getSheetIdFromToken(token);
            if (!sheetId) {
              return "";
            }
            const sheet = getSheetData(sheetId);
            if (!sheet) {
              return "";
            }
            const model = sheet?._dataModel;
            if (!model) {
              return "";
            }
            const rowCount = model.rowCount || 0;
            const colCount = model.colCount || 0;
            if (rowCount === 0 || colCount === 0) {
              return "";
            }
            const imageMap = buildSheetImageMap(sheet);
            const headerStyle =
              "border: 1px solid #ddd; padding: 8px; background-color: #f5f5f5; font-weight: bold; text-align: center;";
            const cellStyle =
              "border: 1px solid #ddd; padding: 8px; vertical-align: top; text-align: left;";
            const imageCellStyle =
              "border: 1px solid #ddd; padding: 8px; vertical-align: middle; text-align: center;";
            const rows = [];
            for (let row = 0; row < rowCount; row += 1) {
              const cells = [];
              for (let col = 0; col < colCount; col += 1) {
                const value = model.getValue(row, col);
                const cellHtml = renderSheetCellValue(value, imageMap);
                if (row === 0) {
                  cells.push(`<th style="${headerStyle}">${cellHtml}</th>`);
                } else {
                  const style = cellHtml.includes("<img") ? imageCellStyle : cellStyle;
                  cells.push(`<td style="${style}">${cellHtml}</td>`);
                }
              }
              rows.push(`<tr>${cells.join("")}</tr>`);
            }
            return `<table style="border-collapse: collapse; width: 100%; margin: 16px 0;">${rows.join("")}</table>`;
          };
const collectBlocksByType = (root, typeSet) => {
            const blocks = [];
            const stack = [root];
            while (stack.length > 0) {
              const current = stack.pop();
              if (!current) {
                continue;
              }
              const blockType = getBlockType(current);
              if (typeSet.has(blockType)) {
                blocks.push(current);
              }
              const children = Array.isArray(current.children) ? current.children : [];
              for (const child of children) {
                stack.push(child);
              }
            }
            return blocks;
          };
const preloadSpecialBlocks = async (root) => {
            const locate = window.PageMain?.locateBlockWithRecordIdImpl;
            if (typeof locate !== "function") {
              return;
            }
            const specialBlocks = collectBlocksByType(
              root,
              new Set(["sheet", "whiteboard", "mindnote", "diagram"])
            );
            if (specialBlocks.length === 0) {
              return;
            }
            for (const block of specialBlocks) {
              const recordId =
                block?.record?.id || block?.snapshot?.id || block?.id || "";
              if (recordId) {
                try {
                  await locate(recordId);
                } catch (error) {
                }
              }
              const blockType = getBlockType(block);
              if (blockType === "sheet") {
                const token = block?.snapshot?.token || "";
                const sheetId = getSheetIdFromToken(token);
                if (sheetId) {
                  await waitForCondition(() => {
                    const sheet = getSheetData(sheetId);
                    return !!(sheet && sheet._dataModel);
                  }, 8000, 300);
                }
              }
              await sleep(200);
            }
          };
const getFileDownloadUrl = (token) =>
            token
              ? `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/${token}?mount_point=docx_file&preview_type=16`
              : "";
const getIframeUrl = (block) =>
            block?.snapshot?.iframe?.src ||
            block?.snapshot?.iframe?.url ||
            block?.snapshot?.iframe?.origin_url ||
            "";
const renderImageBlock = async (imageBlock) => {
            const blockId = getBlockId(imageBlock);
            if (blockId && processedImageIds.has(blockId)) {
              return "";
            }
            const alt = getImageAlt(imageBlock);
            const meta = getImageMeta(imageBlock);
            const dataUrl = await fetchImageDataUrl(imageBlock);
            if (dataUrl) {
              const imgTag = buildImageTag({
                src: dataUrl,
                alt,
                token: meta.token,
                name: meta.name
              });
              return imgTag ? `<figure>${imgTag}</figure>` : "";
            }
            return `<p>[image] ${escapeHtml(alt)}</p>`;
          };
const renderImageRow = async (imageBlocks) => {
            const imagesHtml = [];
            for (const imageBlock of imageBlocks) {
              const alt = getImageAlt(imageBlock);
              const meta = getImageMeta(imageBlock);
              const dataUrl = await fetchImageDataUrl(imageBlock);
              if (dataUrl) {
                const imgTag = buildImageTag({
                  src: dataUrl,
                  alt,
                  token: meta.token,
                  name: meta.name
                });
                if (imgTag) {
                  imagesHtml.push(imgTag);
                }
              } else {
                imagesHtml.push(`<span>[image] ${escapeHtml(alt)}</span>`);
              }
            }
            if (imagesHtml.length === 0) {
              return "";
            }
            return `<div class="image-row">${imagesHtml.join("")}</div>`;
          };
const getOrderedPrefix = (block, listState) => {
            const state = listState || { orderedIndex: 0 };
            const rawSeq = block?.snapshot?.seq;
            const seqText = rawSeq === undefined || rawSeq === null ? "" : String(rawSeq).trim();
            if (/^\d+$/.test(seqText)) {
              state.orderedIndex = Number(seqText);
              return `${seqText}. `;
            }
            state.orderedIndex += 1;
            return `${state.orderedIndex}. `;
          };
const walkChildren = async (children) => {
            const listState = { orderedIndex: 0 };
            for (let i = 0; i < children.length; i += 1) {
              const child = children[i];
              if (!child) {
                continue;
              }
              const childType = getBlockType(child);
              if (childType !== "ordered") {
                listState.orderedIndex = 0;
              }
              const childId = getBlockId(child);
              if (childId && processedImageIds.has(childId)) {
                continue;
              }
              if (isImageBlock(child)) {
                const group = [child];
                let nextIndex = i + 1;
                while (nextIndex < children.length && isImageBlock(children[nextIndex])) {
                  group.push(children[nextIndex]);
                  nextIndex += 1;
                }
                if (group.length > 1) {
                  const rowHtml = await renderImageRow(group);
                  if (rowHtml) {
                    group.forEach((item) => {
                      const itemId = getBlockId(item);
                      if (itemId) {
                        processedImageIds.add(itemId);
                      }
                    });
                    parts.push(rowHtml);
                  } else {
                    for (const item of group) {
                      const singleHtml = await renderImageBlock(item);
                      if (singleHtml) {
                        parts.push(singleHtml);
                      }
                    }
                  }
                  i = nextIndex - 1;
                  continue;
                }
              }
              await walk(child, listState);
            }
          };
const walk = async (block, listState) => {
            if (!block) {
              return;
            }

            const type = getBlockType(block);
            const text = getBlockText(block);
            const children = Array.isArray(block.children) ? block.children : [];
            let skipChildren = false;

            if (isGridContainerBlock(block)) {
              const gridHtml = await renderGridTable(block);
              if (gridHtml) {
                parts.push(gridHtml);
                skipChildren = true;
              }
            }

            switch (type) {
              case "page":
                break;
              case "divider":
                parts.push("<hr />");
                break;
              case "heading1":
              case "heading2":
              case "heading3":
              case "heading4":
              case "heading5":
              case "heading6": {
                const level = Number(type.replace("heading", "")) || 1;
                const content = text.trim();
                if (content) {
                  // text 已经是转义过的 HTML（含 <strong>/<a>/<br/> 等行内标记），
                  // 不能再 escapeHtml，否则行内格式会变成字面标签。
                  parts.push(`<h${level}>${content}</h${level}>`);
                }
                break;
              }
              case "code": {
                // 代码块用原始文本（保留真实换行），只转义一次，并包成
                // <pre><code class="language-xxx">：turndown 的围栏规则只识别 PRE > CODE，
                // 且语言标识取自 CODE 的 class（裸 <pre> 会被降级成普通段落）。
                const content = getBlockRawText(block).trim();
                if (content) {
                  const language = getCodeLanguage(block);
                  const langClass = language ? ` class="language-${escapeAttr(language)}"` : "";
                  parts.push(`<pre><code${langClass}>${escapeHtml(content)}</code></pre>`);
                }
                break;
              }
              case "quote":
              case "quote_container": {
                const content = text.trim();
                if (content) {
                  parts.push(`<blockquote>${content}</blockquote>`);
                }
                break;
              }
              case "callout": {
                const content = text.trim();
                if (content) {
                  parts.push(`<blockquote class="callout">${content}</blockquote>`);
                }
                break;
              }
              case "image": {
                const imageHtml = await renderImageBlock(block);
                if (imageHtml) {
                  parts.push(imageHtml);
                }
                break;
              }
              case "sheet": {
                const sheetHtml = renderSheetTable(block);
                if (sheetHtml) {
                  parts.push(sheetHtml);
                } else if (text) {
                  pushParagraph(text);
                }
                skipChildren = true;
                break;
              }
              case "table": {
                const tableHtml = await renderTableHtml(block);
                if (tableHtml) {
                  parts.push(tableHtml);
                } else if (text) {
                  pushParagraph(text);
                }
                skipChildren = true;
                break;
              }
              case "table_cell":
                skipChildren = true;
                break;
              case "file": {
                const name = block?.snapshot?.file?.name || "文件";
                const token = block?.snapshot?.file?.token || "";
                const url = getFileDownloadUrl(token);
                if (url) {
                  parts.push(
                    `<p><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">文件：${escapeHtml(
                      name
                    )}</a></p>`
                  );
                } else {
                  pushParagraph(`文件：${escapeHtml(name)}`);
                }
                break;
              }
              case "iframe": {
                const src = getIframeUrl(block);
                if (src) {
                  parts.push(
                    `<p><a href="${escapeHtml(src)}" target="_blank" rel="noreferrer">嵌入链接：${escapeHtml(
                      src
                    )}</a></p>`
                  );
                }
                break;
              }
              case "diagram":
              case "whiteboard":
              case "mindnote": {
                const label =
                  block?.snapshot?.diagram?.name ||
                  block?.snapshot?.mindnote?.name ||
                  block?.snapshot?.whiteboard?.name ||
                  "";
                const dataUrl = await fetchSpecialBlockDataUrl(block);
                if (dataUrl) {
                  const alt = label || type;
                  const imgTag = buildImageTag({ src: dataUrl, alt });
                  if (imgTag) {
                    parts.push(`<figure>${imgTag}</figure>`);
                  }
                } else {
                  pushParagraph(`[${type}] ${escapeHtml(label)}`);
                }
                break;
              }
              case "ordered": {
                const prefix = getOrderedPrefix(block, listState);
                pushParagraph(`${prefix}${text}`);
                break;
              }
              case "bullet":
                pushParagraph(`- ${text}`);
                break;
              case "todo": {
                const checked = block?.snapshot?.done ? "☑" : "☐";
                pushParagraph(`${checked} ${text}`);
                break;
              }
              case "text":
              case "heading7":
              case "heading8":
              case "heading9":
                pushParagraph(text);
                break;
              default:
                pushParagraph(text);
                break;
            }

            if (!skipChildren && children.length > 0) {
              await walkChildren(children);
            }
          };
await preloadSpecialBlocks(rootBlock);
await walk(rootBlock);
return {
            ok: true,
            title: document.title || "feishu-document",
            html: parts.join("")
          };
  };
})();
