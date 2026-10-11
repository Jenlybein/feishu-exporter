// 批量导出编排 —— 把「目录树里勾选的一批文档」逐篇抓下来，汇总成一个 ZIP。
//
// 与单篇导出的差别只有两处：单篇导出作用于「用户当前打开的那个标签页」，而批量
// 需要一个自己能控制、能来回导航的标签页；单篇导出每篇产物各自下载，而批量要把
// 多篇的产物汇总到同一个 ZIP 里（ZIP 内的层级只由勾选决定，见 lib/batch-plan.js）。
//
// 支持四种格式，主干完全一致（导航 → 等模型 → 提取 HTML），差异只在「HTML 之后怎么
// 变成落进 ZIP 的字节」：
//   markdown → md-render 渲染页转 Markdown，图片另存到同级的 `<名>.assets/`
//   html     → 套一层版式模板，图片已内联成 data:URL，产物是自包含单文件
//   word     → word-render 渲染页把 HTML 直接映射成 docx（不回传 Markdown 走有损往返）
//   pdf      → pdf-render 渲染页铺好内容，再用 CDP printToPDF 取回 PDF 字节
// 因此渲染页按格式选，且只有需要渲染页的格式才开（HTML 不需要）。
//
// 几个关键取舍：
//
// 1) 用**独立窗口**承载文档标签页，而不是复用用户当前标签页。
//    复用会把用户的页面导航走、还会污染浏览历史；用隐藏标签页（active:false）则
//    会因后台节流而漏渲染——飞书编辑器是虚拟列表，只有渲染出来的块才能截到图
//    （普通文本与图片走的是文档模型，不受影响，但流程图/白板/表格要走 DOM+canvas）。
//    独立窗口（focused:false）既保证真实渲染、又不打断用户，收尾时整个窗口关掉。
//
// 2) 不调内容脚本，全程走 chrome.scripting 注入。
//    文本与图片来自页面模型（window.PageMain.blockManager.rootBlockModel），
//    不需要内容脚本参与，也就不存在「内容脚本还没就绪」这类时序问题。
//
// 3) 渲染页只开一个，连续服务整批。
//    渲染页是无状态转换器（Markdown / docx / 一份可打印的 DOM），每篇都建/销一次
//    标签页纯属浪费。
//
// 4) 单篇失败不影响整批：记进 failures，最后写一份「导出报告.txt」放进 ZIP。

import { zipSync, strToU8 } from "fflate";
import { stripInvisibleText } from "../../lib/text.js";
import { sanitizeFilename } from "../../lib/filename.js";
import {
  FORMAT_EXTENSIONS,
  buildFailureReport,
  retargetMarkdownImages
} from "../../lib/batch-plan.js";
import {
  ZIP_LEVEL,
  dataUrlToUint8Array,
  downloadZip,
  normalizeMarkdownImageDestinations
} from "./download.js";
import { extractDocumentHtml } from "./inject.js";
import { wrapHtmlDocument } from "./templates.js";
import { printToPdfData } from "./debugger.js";
import {
  closeTab,
  openRenderTab,
  renderMarkdownViaTab,
  renderPdfViaTab,
  renderWordViaTab
} from "./exporters.js";
import { sendExportProgress } from "./progress.js";

// 批量支持的格式，以及各自在 ZIP 里落什么扩展名（映射在 batch-plan.js 里统一定义）。
const BATCH_FORMATS = new Set(Object.keys(FORMAT_EXTENSIONS));
// 各格式渲染页：HTML 不需要渲染页（套模板即可），故不在此表内。
const RENDER_PAGES = {
  markdown: "src/render/md-render.html",
  word: "src/render/word-render.html",
  pdf: "src/render/pdf-render.html"
};
const FORMAT_LABELS = {
  markdown: "Markdown",
  html: "HTML",
  word: "Word",
  pdf: "PDF"
};
// 单篇渲染超时。docx 映射最重、PDF 只需铺 DOM，故三者取值不同。
const RENDER_TIMEOUT_MS = {
  markdown: 120000,
  word: 180000,
  pdf: 60000
};

// 单篇文档从导航到「模型就绪」的等待上限。飞书长文档首屏模型偶有 10s+ 才齐。
const DOC_MODEL_TIMEOUT_MS = 25000;
const TAB_LOAD_TIMEOUT_MS = 30000;
// 进度条在「抓取阶段」占到的比例，其余留给打包与下载。
const FETCH_PROGRESS_SPAN = 92;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
  if (!error) {
    return "未知错误";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || String(error);
}

// 等标签页加载到 complete。必须先挂监听再导航，否则可能错过事件。
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("页面加载超时"));
    }, timeoutMs);

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId || info.status !== "complete") {
        return;
      }
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function navigateTab(tabId, url, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  const ready = waitForTabComplete(tabId, timeoutMs);
  await chrome.tabs.update(tabId, { url });
  await ready;
}

// 轮询「文档模型已就绪」。模型是文本与图片导出的唯一依据，等它就是等页面可用。
// 判据取 rootBlockModel 且已有子块——只有空壳模型时会导出空文档。
async function waitForDocumentModel(tabId, timeoutMs = DOC_MODEL_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let ready = false;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const pageMain = window.PageMain;
          const root =
            pageMain?.blockManager?.rootBlockModel ||
            pageMain?.blockManager?.modelService?.rootBlockModel ||
            pageMain?.modelService?.rootBlockModel;
          return !!(root && Array.isArray(root.children) && root.children.length > 0);
        }
      });
      ready = !!(results && results[0] && results[0].result);
    } catch {
      // 页面尚未可注入（导航中）时继续等，不当作失败。
      ready = false;
    }
    if (ready) {
      return true;
    }
    await delay(400);
  }
  return false;
}

// 由计划推导 ZIP 的基名。
//
// 取每篇文档的「最外层有名字的一层」（pathTitles[0]）。计划里的 pathTitles 只由
// 「被勾选的祖先 + 自身」构成（见 batch-plan.js），所以：
//   只勾了一篇文档      -> 就是这篇自己的标题；
//   勾了同一支下的若干篇 -> 是这一支最外层的那个标题；
//   跨了多个顶层        -> 退回通用名。
function resolveZipBaseName(items) {
  const roots = new Set();
  for (const item of items) {
    const top =
      (item.pathTitles && item.pathTitles[0]) || (item.dir || "").split("/")[0] || "";
    roots.add(top);
    if (roots.size > 1) {
      break;
    }
  }
  const only = roots.size === 1 ? Array.from(roots)[0] : "";
  return only || "飞书文档";
}

function formatStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

// 图片在 ZIP 内的落点：清洗成单段文件名（去掉渲染页可能带上的目录），
// 同名时由调用方保证唯一（渲染页已按篇去重，这里再兜一层）。
function imageEntryName(image, index, usedNames) {
  const raw = String(image?.filename || `image_${index + 1}.png`)
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  const base = sanitizeFilename(raw || `image_${index + 1}.png`, `image_${index + 1}.png`);
  let candidate = base;
  let counter = 1;
  while (usedNames.has(candidate.toLowerCase())) {
    const dot = base.lastIndexOf(".");
    candidate =
      dot > 0
        ? `${base.slice(0, dot)}_${counter}${base.slice(dot)}`
        : `${base}_${counter}`;
    counter += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

// 为批量导出开一个不受打扰的工作窗口。
async function openWorkWindow() {
  const created = await chrome.windows.create({
    url: "about:blank",
    focused: false,
    type: "normal",
    width: 1280,
    height: 900,
    state: "normal"
  });
  const tabId = created?.tabs?.[0]?.id || null;
  if (!created?.id || !tabId) {
    throw new Error("无法打开批量导出所需的后台窗口");
  }
  // 别让 Chrome 在长时间批量中把它判为可丢弃而挂起。
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    // 忽略：不支持该参数时不影响主流程
  }
  return { windowId: created.id, tabId };
}

/**
 * 批量导出勾选的文档为「一个 ZIP」。
 *
 * @param {object}   params
 * @param {number}   params.sourceTabId 用户发起导出的飞书标签页（用于进度归属与收尾聚焦）
 * @param {string}   params.host        来源站点 host，仅用于报告
 * @param {object}   params.plan        buildBatchPlan 的产物
 * @param {string}   params.format      markdown | html | word | pdf
 * @param {string}   params.requestId   进度归属
 * @param {Function} [params.shouldStop] 返回 true 时停止后续文档（P3 的取消入口）
 * @returns {Promise<{ filename: string, stats: object }>}
 */
export async function exportBatch({
  sourceTabId,
  host,
  plan,
  format = "markdown",
  requestId,
  shouldStop
}) {
  if (!BATCH_FORMATS.has(format)) {
    throw new Error(`批量导出不支持「${format}」格式`);
  }

  const items = (plan && Array.isArray(plan.items) ? plan.items : []).filter(Boolean);
  const skipped = (plan && Array.isArray(plan.skipped) ? plan.skipped : []).filter(Boolean);
  if (items.length === 0) {
    throw new Error("没有可导出的文档（勾选的节点都不是文档，或缺少 wikiToken）");
  }

  const startedAt = Date.now();
  const total = items.length;
  const label = FORMAT_LABELS[format] || format;
  const files = {};
  const failures = [];
  let imageTotal = 0;
  let succeeded = 0;

  let sourceWindowId = null;
  let workWindowId = null;
  let workTabId = null;
  let renderTabId = null;

  const report = (message, progress) => {
    sendExportProgress(sourceTabId, requestId, format, progress, message);
  };

  try {
    try {
      const sourceTab = await chrome.tabs.get(sourceTabId);
      sourceWindowId = sourceTab?.windowId ?? null;
    } catch {
      sourceWindowId = null;
    }

    report(`正在准备批量导出（共 ${total} 篇 ${label}）…`, 1);
    const work = await openWorkWindow();
    workWindowId = work.windowId;
    workTabId = work.tabId;
    const renderPage = RENDER_PAGES[format];
    renderTabId = renderPage ? await openRenderTab(renderPage) : null;

    for (let index = 0; index < total; index += 1) {
      if (typeof shouldStop === "function" && shouldStop()) {
        break;
      }
      const item = items[index];
      const progressLabel = `${index + 1}/${total}`;
      const progress = Math.round((index / total) * FETCH_PROGRESS_SPAN);

      report(`${progressLabel} 正在导出：${item.title}`, progress);
      try {
        await navigateTab(workTabId, item.url);
        const modelReady = await waitForDocumentModel(workTabId);
        if (!modelReady) {
          // 模型没就绪也再试一次提取——提取脚本内部还有一轮自己的重试。
          report(`${progressLabel} ${item.title}：文档模型加载较慢，继续尝试…`, progress);
        }

        const htmlResult = await extractDocumentHtml(workTabId);
        if (!htmlResult || !htmlResult.ok || !htmlResult.html) {
          throw new Error(htmlResult?.error || "无法提取文档内容");
        }
        const resolvedTitle =
          stripInvisibleText(htmlResult.title || item.title || "").trim() || item.title || "未命名文档";

        // 到这里主干结束，各格式只是把同一份 HTML 变成不同的字节。
        const bytes = await renderItemToBytes({
          format,
          renderTabId,
          title: resolvedTitle,
          html: htmlResult.html,
          item,
          onImage: () => {
            imageTotal += 1;
          },
          writeFiles: files
        });
        if (!bytes) {
          throw new Error("文档内容为空");
        }
        succeeded += 1;
      } catch (error) {
        failures.push({ path: item.filePath, title: item.title, reason: errorText(error) });
      }
    }

    report("正在打包 ZIP…", FETCH_PROGRESS_SPAN + 2);
    if (failures.length || skipped.length) {
      files["导出报告.txt"] = strToU8(
        buildFailureReport({
          failures,
          skipped,
          host,
          finishedAt: new Date().toISOString()
        })
      );
    }

    if (succeeded === 0) {
      throw new Error(
        `全部 ${total} 篇都没能导出。${
          failures[0] ? `首篇失败原因：${failures[0].reason}` : ""
        }`
      );
    }

    const zipData = zipSync(files, { level: ZIP_LEVEL });
    const zipName = `${sanitizeFilename(resolveZipBaseName(items), "飞书文档")}-${formatStamp()}.zip`;
    report(`共 ${succeeded}/${total} 篇，正在下载 ZIP…`, 97);
    const filename = await downloadZip(zipData, zipName);

    return {
      filename,
      stats: {
        format,
        total,
        succeeded,
        failed: failures.length,
        skipped: skipped.length,
        images: imageTotal,
        files: Object.keys(files).length,
        zipBytes: zipData.length,
        elapsedMs: Date.now() - startedAt,
        failures: failures.slice(0, 20)
      }
    };
  } finally {
    closeTab(renderTabId);
    if (workWindowId != null) {
      try {
        await chrome.windows.remove(workWindowId);
      } catch {
        // 忽略：窗口已被关闭
      }
    }
    // 把焦点还给用户原来的窗口（独立窗口即便设了 focused:false，个别平台仍会前置）。
    if (sourceWindowId != null) {
      try {
        await chrome.windows.update(sourceWindowId, { focused: true });
      } catch {
        // 忽略
      }
    }
  }
}

// 把一篇文档的 HTML 变成「落进 ZIP 的字节」，按格式分派。
//
// 统一返回主产物的字节，并在 writeFiles 里写入 ZIP；Markdown 额外把图片写进
// item.assetsDir 旁挂目录（其它格式的图片已内联进产物，不需要旁挂）。
// 返回空字节数组表示文档内容为空 —— 由调用方按「本篇失败」处理。
async function renderItemToBytes({ format, renderTabId, title, html, item, onImage, writeFiles }) {
  const timeoutMs = RENDER_TIMEOUT_MS[format];

  if (format === "markdown") {
    const rendered = await renderMarkdownViaTab(renderTabId, { title, html, timeoutMs });
    const markdown = retargetMarkdownImages(
      stripInvisibleText(rendered.markdown || ""),
      item.assetsLeaf
    );
    if (!markdown.trim()) {
      return null;
    }
    const usedImageNames = new Set();
    rendered.images.forEach((image, imageIndex) => {
      if (!image || !image.dataUrl) {
        return;
      }
      const entryName = imageEntryName(image, imageIndex, usedImageNames);
      writeFiles[`${item.assetsDir}/${entryName}`] = dataUrlToUint8Array(image.dataUrl);
      onImage();
    });
    const bytes = strToU8(normalizeMarkdownImageDestinations(markdown));
    writeFiles[item.filePath] = bytes;
    return bytes;
  }

  if (format === "html") {
    // 图片已内联为 data:URL，套一层版式模板即可得到自包含单文件。
    const bytes = strToU8(wrapHtmlDocument(title, html));
    writeFiles[item.filePath] = bytes;
    return bytes;
  }

  if (format === "word") {
    const rendered = await renderWordViaTab(renderTabId, { title, html, timeoutMs });
    const bytes = dataUrlToUint8Array(rendered.dataUrl);
    if (!bytes.length) {
      return null;
    }
    writeFiles[item.filePath] = bytes;
    return bytes;
  }

  if (format === "pdf") {
    await renderPdfViaTab(renderTabId, { title, html, timeoutMs });
    const base64 = await printToPdfData(renderTabId);
    const bytes = dataUrlToUint8Array(`data:application/pdf;base64,${base64}`);
    if (!bytes.length) {
      return null;
    }
    writeFiles[item.filePath] = bytes;
    return bytes;
  }

  throw new Error(`批量导出不支持「${format}」格式`);
}
