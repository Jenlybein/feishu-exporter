// 批量导出编排 —— 把「目录树里勾选的一批文档」逐篇抓下来，汇总成一个 ZIP。
//
// 与单篇导出的差别只有两处：单篇导出作用于「用户当前打开的那个标签页」，而批量
// 需要一个自己能控制、能来回导航的标签页；单篇导出每篇产物各自下载，而批量要把
// 多篇的 Markdown 与图片汇总到同一个 ZIP 里（ZIP 内的层级只由勾选决定，
// 见 lib/batch-plan.js）。
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
//    HTML → Markdown 的转换器是无状态的，每篇都建/销一次标签页纯属浪费。
//
// 4) 单篇失败不影响整批：记进 failures，最后写一份「导出报告.txt」放进 ZIP。

import { zipSync, strToU8 } from "fflate";
import { stripInvisibleText } from "../../lib/text.js";
import { sanitizeFilename } from "../../lib/filename.js";
import {
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
import {
  closeTab,
  openRenderTab,
  renderMarkdownViaTab
} from "./exporters.js";
import { sendExportProgress } from "./progress.js";

// 单篇文档从导航到「模型就绪」的等待上限。飞书长文档首屏模型偶有 10s+ 才齐。
const DOC_MODEL_TIMEOUT_MS = 25000;
const TAB_LOAD_TIMEOUT_MS = 30000;
const RENDER_TIMEOUT_MS = 120000;
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
    } catch (error) {
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
  } catch (error) {
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
 * @param {string}   params.requestId   进度归属
 * @param {Function} [params.shouldStop] 返回 true 时停止后续文档（P3 的取消入口）
 * @returns {Promise<{ filename: string, stats: object }>}
 */
export async function exportBatchMarkdown({
  sourceTabId,
  host,
  plan,
  requestId,
  shouldStop
}) {
  const items = (plan && Array.isArray(plan.items) ? plan.items : []).filter(Boolean);
  const skipped = (plan && Array.isArray(plan.skipped) ? plan.skipped : []).filter(Boolean);
  if (items.length === 0) {
    throw new Error("没有可导出的文档（勾选的节点都不是文档，或缺少 wikiToken）");
  }

  const startedAt = Date.now();
  const total = items.length;
  const files = {};
  const failures = [];
  let imageTotal = 0;
  let succeeded = 0;

  let sourceWindowId = null;
  let workWindowId = null;
  let workTabId = null;
  let renderTabId = null;

  const report = (message, progress) => {
    sendExportProgress(sourceTabId, requestId, "markdown", progress, message);
  };

  try {
    try {
      const sourceTab = await chrome.tabs.get(sourceTabId);
      sourceWindowId = sourceTab?.windowId ?? null;
    } catch (error) {
      sourceWindowId = null;
    }

    report(`正在准备批量导出（共 ${total} 篇）…`, 1);
    const work = await openWorkWindow();
    workWindowId = work.windowId;
    workTabId = work.tabId;
    renderTabId = await openRenderTab("src/render/md-render.html");

    for (let index = 0; index < total; index += 1) {
      if (typeof shouldStop === "function" && shouldStop()) {
        break;
      }
      const item = items[index];
      const label = `${index + 1}/${total}`;
      const progress = Math.round((index / total) * FETCH_PROGRESS_SPAN);

      report(`${label} 正在导出：${item.title}`, progress);
      try {
        await navigateTab(workTabId, item.url);
        const modelReady = await waitForDocumentModel(workTabId);
        if (!modelReady) {
          // 模型没就绪也再试一次提取——提取脚本内部还有一轮自己的重试。
          report(`${label} ${item.title}：文档模型加载较慢，继续尝试…`, progress);
        }

        const htmlResult = await extractDocumentHtml(workTabId);
        if (!htmlResult || !htmlResult.ok || !htmlResult.html) {
          throw new Error(htmlResult?.error || "无法提取文档内容");
        }

        const rendered = await renderMarkdownViaTab(renderTabId, {
          title: item.title,
          html: htmlResult.html,
          timeoutMs: RENDER_TIMEOUT_MS
        });

        const markdown = retargetMarkdownImages(
          stripInvisibleText(rendered.markdown || ""),
          item.assetsLeaf
        );
        if (!markdown.trim()) {
          throw new Error("文档内容为空");
        }
        files[item.mdPath] = strToU8(normalizeMarkdownImageDestinations(markdown));

        const usedImageNames = new Set();
        rendered.images.forEach((image, imageIndex) => {
          if (!image || !image.dataUrl) {
            return;
          }
          const entryName = imageEntryName(image, imageIndex, usedImageNames);
          files[`${item.assetsDir}/${entryName}`] = dataUrlToUint8Array(image.dataUrl);
          imageTotal += 1;
        });

        succeeded += 1;
      } catch (error) {
        failures.push({ path: item.mdPath, title: item.title, reason: errorText(error) });
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
      } catch (error) {
        // 忽略：窗口已被关闭
      }
    }
    // 把焦点还给用户原来的窗口（独立窗口即便设了 focused:false，个别平台仍会前置）。
    if (sourceWindowId != null) {
      try {
        await chrome.windows.update(sourceWindowId, { focused: true });
      } catch (error) {
        // 忽略
      }
    }
  }
}
