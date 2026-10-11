import { buildMarkdown } from "./markdown.js";
import { progressMessage } from "../lib/protocol.js";

// 预加载阶段采集到的最佳 Markdown 快照，供导出时优先采用（长内容滚动到底再
// 回顶后，当前 DOM 可能比预加载快照短，需保留更长版本）。
let preloadedMarkdownSnapshot = "";

export function getPreloadedMarkdownSnapshot() {
  return preloadedMarkdownSnapshot;
}

// —— 快照合并：多轮滚动采集的 Markdown 去重拼接 ——
function normalizeMarkdownBlock(block) {
  return String(block || "").replace(/\s+/g, " ").trim();
}

function mergeMarkdownSnapshots(snapshots) {
  const seen = new Set();
  const blocks = [];
  for (const markdown of snapshots) {
    const parts = String(markdown || "")
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const part of parts) {
      const key = normalizeMarkdownBlock(part);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      blocks.push(part);
    }
  }
  return blocks.join("\n\n").trim();
}

function captureMarkdownSnapshot(snapshots) {
  try {
    const markdown = buildMarkdown();
    if (markdown) {
      snapshots.push(markdown);
    }
  } catch {
    // 页面滚动过程中 DOM 可能短暂变化，忽略单次采集失败。
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// —— 飞书页面模型（PageMain）探测，用于判断「待渲染」块数量 ——
function getRootBlockModel() {
  const pageMain = window.PageMain;
  const candidates = [
    pageMain?.blockManager?.rootBlockModel,
    pageMain?.blockManager?.modelService?.rootBlockModel,
    pageMain?.modelService?.rootBlockModel
  ];
  return candidates.find((item) => item && Array.isArray(item.children)) || null;
}

function getPendingBlockCount() {
  const rootBlock = getRootBlockModel();
  if (!rootBlock) {
    return null;
  }
  const stack = Array.isArray(rootBlock.children) ? [...rootBlock.children] : [];
  let count = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    const type = node.type || node.snapshot?.type || "";
    if (type === "pending") {
      count += 1;
      continue;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      stack.push(child);
    }
  }
  return count;
}

// —— 滚动容器定位与滚动控制 ——
function isScrollHost(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  const style = getComputedStyle(element);
  return /(auto|scroll)/.test(style.overflowY);
}

function getScrollableAmount(element) {
  if (!element) {
    return 0;
  }
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function findScrollContainer() {
  const direct =
    document.querySelector("#mainBox .bear-web-x-container") ||
    document.querySelector(".bear-web-x-container");
  if (direct) {
    return direct;
  }
  const root = findContentRoot();
  let node = root;
  while (node && node !== document.body && node !== document.documentElement) {
    if (isScrollHost(node) && getScrollableAmount(node) > 0) {
      return node;
    }
    node = node.parentElement;
  }
  const scrollingElement = document.scrollingElement;
  if (scrollingElement && getScrollableAmount(scrollingElement) > 0) {
    return scrollingElement;
  }
  return null;
}

function getScrollTop(container) {
  if (!container) {
    return 0;
  }
  return container.scrollTop;
}

function setScrollTop(container, value) {
  if (!container) {
    return;
  }
  container.scrollTop = value;
}

function scrollContainerTo(container, top, behavior = "smooth") {
  if (!container) {
    return;
  }
  if (typeof container.scrollTo === "function") {
    container.scrollTo({
      top: Math.min(top, container.scrollHeight),
      behavior
    });
    return;
  }
  setScrollTop(container, top);
}

// 渐进滚动加载长文档：直到高度稳定、到达底部且无待渲染块。仅当 captureMarkdown
// 为真（Markdown 导出）时才边滚动边采集 Markdown 快照并合并写回
// preloadedMarkdownSnapshot；PDF / HTML 只借用滚动本身触发懒加载。返回原始滚动位置。
async function preloadDocumentContent(container, options = {}) {
  if (!container) {
    return 0;
  }
  const captureMarkdown = options.captureMarkdown === true;
  const markdownSnapshots = [];
  const originalTop = getScrollTop(container);
  const stepDelay = Number(options.stepDelay) || 420;
  const settleRounds = Number(options.settleRounds) || 3;
  const stepDistance =
    Number(options.stepDistance) ||
    Math.max(300, Math.floor(container.clientHeight * 0.9));
  const estimatedSteps = Math.ceil(container.scrollHeight / stepDistance) + 4;
  const maxSteps = Number(options.maxSteps) ||
    Math.min(220, Math.max(60, estimatedSteps));
  let scrollTarget = 0;
  let stableRounds = 0;
  let lastHeight = container.scrollHeight;

  scrollContainerTo(container, scrollTarget, "auto");
  await sleep(Math.max(200, Math.min(500, stepDelay)));
  if (captureMarkdown) {
    captureMarkdownSnapshot(markdownSnapshots);
  }

  for (let step = 0; step < maxSteps; step += 1) {
    const pending = getPendingBlockCount();
    scrollTarget = Math.min(scrollTarget + stepDistance, container.scrollHeight);
    scrollContainerTo(container, scrollTarget, "auto");
    await sleep(stepDelay);
    if (captureMarkdown) {
      captureMarkdownSnapshot(markdownSnapshots);
    }

    const height = container.scrollHeight;
    const maxTop = Math.max(0, height - container.clientHeight);
    const atBottom = Math.abs(getScrollTop(container) - maxTop) <= 2;
    const heightStable = Math.abs(height - lastHeight) <= 2;
    const pendingResolved = pending === null || pending === 0;

    if (typeof options.onStep === "function") {
      options.onStep({
        step: step + 1,
        maxSteps,
        pending,
        height,
        atBottom
      });
    }

    if (heightStable && atBottom && pendingResolved) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    if (stableRounds >= settleRounds && step > 2) {
      break;
    }

    lastHeight = height;
  }

  if (captureMarkdown) {
    const mergedMarkdown = mergeMarkdownSnapshots(markdownSnapshots);
    if (mergedMarkdown) {
      preloadedMarkdownSnapshot = mergedMarkdown;
    }
  }

  return originalTop;
}

// —— 预加载遮罩（白屏，避免用户看到滚动跳动）——
let preloadMaskEl = null;

function showPreloadMask(message) {
  if (!preloadMaskEl) {
    const mask = document.createElement("div");
    mask.id = "feishu-exporter-preload-mask";
    mask.setAttribute("data-feishu-exporter", "true");
    mask.style.position = "fixed";
    mask.style.left = "0";
    mask.style.top = "0";
    mask.style.right = "0";
    mask.style.bottom = "0";
    mask.style.background = "rgba(255, 255, 255, 0.92)";
    mask.style.zIndex = "2147483647";
    mask.style.display = "flex";
    mask.style.alignItems = "center";
    mask.style.justifyContent = "center";
    mask.style.fontSize = "14px";
    mask.style.fontWeight = "600";
    mask.style.color = "#1f2328";
    mask.style.textAlign = "center";
    mask.style.padding = "24px";
    mask.style.boxSizing = "border-box";
    mask.innerHTML = `<div id="feishu-exporter-preload-text"></div>`;
    document.body.appendChild(mask);
    preloadMaskEl = mask;
  }
  updatePreloadMask(message);
  return preloadMaskEl;
}

function updatePreloadMask(message) {
  if (!preloadMaskEl) {
    return;
  }
  const textEl = preloadMaskEl.querySelector("#feishu-exporter-preload-text");
  if (textEl) {
    textEl.textContent = message || "正在预加载文档内容...";
  }
}

function removePreloadMask() {
  if (!preloadMaskEl) {
    return;
  }
  preloadMaskEl.remove();
  preloadMaskEl = null;
}

// 向 background 广播导出进度（进度回调无接收者时不刷错误）。
function emitExportProgress(requestId, exportType, progress, message) {
  if (!requestId || !exportType) {
    return;
  }
  try {
    chrome.runtime.sendMessage(
      progressMessage({ requestId, exportType, progress, message }),
      () => {
        // 读取 lastError，避免无接收者或无响应时在页面控制台刷错误。
        void chrome.runtime.lastError;
      }
    );
  } catch {
    // 忽略消息失败
  }
}

// 导出前预加载：定位滚动容器，渐进滚动触发懒加载，回顶后移除遮罩。
// PDF / HTML / Markdown 三条导出共用；仅 Markdown 需要采集内容快照。
export async function prepareExport(requestId, exportType) {
  const captureMarkdown = exportType === "markdown";
  const container = findScrollContainer();
  if (!container) {
    if (captureMarkdown) {
      const markdownSnapshots = [];
      captureMarkdownSnapshot(markdownSnapshots);
      preloadedMarkdownSnapshot = mergeMarkdownSnapshots(markdownSnapshots);
    }
    emitExportProgress(requestId, exportType, 6, "未找到滚动容器，尝试直接导出");
    return;
  }

  showPreloadMask("正在预加载文档内容...");
  const progressBase = 6;
  const progressRange = 3;
  let originalTop = 0;
  try {
    emitExportProgress(requestId, exportType, progressBase, "正在预加载文档内容...");
    originalTop = await preloadDocumentContent(container, {
      captureMarkdown,
      onStep: ({ step, maxSteps, pending }) => {
        const ratio = maxSteps ? step / maxSteps : 0;
        const progress =
          progressBase + Math.min(progressRange, Math.round(ratio * progressRange));
        const pendingText = typeof pending === "number" ? `，待渲染 ${pending}` : "";
        const message = `正在预加载文档内容 ${step}/${maxSteps}${pendingText}`;
        updatePreloadMask(message);
        emitExportProgress(requestId, exportType, progress, message);
      }
    });
    emitExportProgress(requestId, exportType, progressBase + progressRange, "文档预加载完成");
    await sleep(300);
    setScrollTop(container, originalTop ?? 0);
    await sleep(200);
  } catch {
    emitExportProgress(requestId, exportType, progressBase, "预加载异常，继续导出");
  } finally {
    removePreloadMask();
  }
}
