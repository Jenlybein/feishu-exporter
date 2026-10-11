import { createReactiveStore } from "../lib/reactive.js";
import { Msg, exportCommand, BATCH_PORT_NAME } from "../lib/protocol.js";
import { buildBatchPlan, FORMAT_EXTENSIONS } from "../lib/batch-plan.js";
import {
  applyCheckedToUids,
  buildTree,
  collectSubtreeUids,
  flattenTree,
  isFolderNode,
  isUnloadedFolder,
  parseNodePos,
  selectionStateOf
} from "../lib/tree-path.js";

const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progress-bar");
const exportModeSelect = document.getElementById("export-mode");
const formatSelect = document.getElementById("export-format");
const formatHint = document.getElementById("format-hint");
const runButton = document.getElementById("run-export");
const scanTreeButton = document.getElementById("scan-tree");
const treePanelEl = document.getElementById("tree-panel");
const treeHintEl = document.getElementById("tree-hint");
const treeToolbarEl = document.getElementById("tree-toolbar");
const treeCheckAllEl = document.getElementById("tree-check-all");
const treeCountEl = document.getElementById("tree-count");
const treeListEl = document.getElementById("tree-list");
const KEEP_RENDER_TAB_TIP = "请勿关闭新打开的页面";

const TREE_HINT =
  "只含页面上已展开的部分，折叠节点的子节点未加载，需要在飞书页面上手动展开这些节点后，再点一次「刷新目录」。";

// 下拉框各选项的说明文案，随选中项显示在操作区下方
const FORMAT_HINTS = {
  markdown: "下载 .zip 压缩包到本地",
  pdf: "自动渲染生成高清 PDF",
  html: "下载完整网页文件",
  attachments: "批量下载图片和文件",
  word: "下载 .docx 文档（保留标题/表格/代码块/图片）"
};

// 格式的中文名，用于状态栏/完成文案（与 FORMAT_EXTENSIONS 的键一致）。
const FORMAT_LABELS = {
  markdown: "Markdown",
  html: "HTML",
  word: "Word",
  pdf: "PDF"
};

// —— UI 状态：唯一数据源 ——
// 以前是「每次状态变化手动逐个赋值 DOM」：几个 setXxxUi 函数互相调用、各自 set
// 十几个元素，共 100+ 行，且容易漏同步。现在只维护状态，DOM 一律由 renderUi()
// 从状态推导；状态一改自动重渲染（createReactiveStore 会把同一轮内的多次赋值
// 合并成一次渲染）。
const ui = createReactiveStore(
  {
    status: "准备就绪，等待操作…",
    statusError: false,
    progress: 0,
    busy: false,
    // 导出方式：single = 只导出当前打开的这篇；batch = 按目录树勾选批量导出。
    // 「批量」才会显示目录树容器；默认单篇。
    mode: "single",
    format: "markdown",
    // —— 目录树（批量导出的「选择源」）——
    treeBusy: false,
    treeNodes: [], // flatten 后的节点数组，带 depth / children / ancestors，已按 pos 排序
    treeSelectedUids: [] // 已勾选的节点 uid（数组，便于比对与序列化）
  },
  renderUi
);

// —— 状态写入口：保持原有调用方式，但内部只改状态，不再直接碰 DOM ——
function setStatus(message, isError = false) {
  ui.status = message;
  ui.statusError = isError;
}

function setProgress(value) {
  ui.progress = value;
}

function setBusy(isBusy) {
  ui.busy = isBusy;
}

// 目录树列表的重建开关：只在「节点清单变了」时重建列表 DOM，
// 否则勾选/进度等状态刷新会把列表滚动位置和 hover 状态一起清掉。
// 必须在下面首次 renderUi() 之前完成初始化，否则 renderTreePanel 会撞上 TDZ。
let renderedNodesRef = null;
// 每个已渲染行 -> { row, checkbox, node }，勾选变化时只更新复选框三态、不重建 DOM。
const rowByUid = new Map();
// 节点 uid -> 子树 uid 列表 的缓存：勾选时每行都要判三态，重复遍历子树很浪费。
const subtreeUidCache = new Map();

// —— 渲染：所有 DOM 都由状态推导 ——
function renderUi() {
  statusEl.textContent = ui.status;
  statusEl.classList.toggle("error", ui.statusError);

  progressBar.style.width = `${Math.max(0, Math.min(100, Number(ui.progress) || 0))}%`;

  const selectedCount = (ui.treeSelectedUids || []).length;

  exportModeSelect.value = ui.mode;
  exportModeSelect.disabled = ui.busy;

  formatSelect.value = ui.format;
  formatHint.textContent = formatHintText(selectedCount);
  formatSelect.disabled = ui.busy;
  runButton.disabled = ui.busy;
  runButton.textContent = ui.busy ? "导出中…" : ui.mode === "batch" ? "批量导出" : "执行";

  scanTreeButton.disabled = ui.busy || ui.treeBusy;
  scanTreeButton.textContent = ui.treeBusy ? "刷新中…" : "刷新目录";

  // 目录树容器只在「批量导出」下出现；单篇模式下整块隐藏。
  treePanelEl.hidden = ui.mode !== "batch";

  renderTreePanel();
}

// 下拉框说明 + 「勾选有没有生效」的提示。
//
// 批量 = 「批量模式 + 支持批量的格式」：Markdown / HTML / Word / PDF 都能打包成一个
// ZIP，附件仍只支持单篇，因此切到附件时要明确说明，别让用户点下去才发现没反应。
function formatHintText(selectedCount) {
  const base = FORMAT_HINTS[ui.format] || "";
  if (ui.mode !== "batch") {
    return base;
  }
  if (!FORMAT_EXTENSIONS[ui.format]) {
    return `${base}（批量导出暂不支持该格式，请切换到 Markdown / HTML / Word / PDF）`;
  }
  const count = Number(selectedCount) || 0;
  return count > 0
    ? `${base}（已勾选 ${count} 篇，点「批量导出」将打包成一个 ZIP）`
    : `${base}（请先在目录树里勾选要导出的文档）`;
}

renderUi();

// ---------- 目录树面板 ----------

function renderTreePanel(force = false) {
  treeHintEl.textContent = TREE_HINT;

  const nodes = ui.treeNodes || [];
  if (!nodes.length) {
    treeToolbarEl.hidden = true;
    treeListEl.hidden = true;
    treeListEl.textContent = "";
    rowByUid.clear();
    renderedNodesRef = null;
    return;
  }

  treeToolbarEl.hidden = false;

  // 清单没变就只刷新勾选态，保留列表滚动位置。
  if (!force && renderedNodesRef === nodes) {
    updateTreeSelectionUi();
    return;
  }
  renderedNodesRef = nodes;
  rebuildTreeList(nodes);
  updateTreeSelectionUi();
}

function rebuildTreeList(nodes) {
  const fragment = document.createDocumentFragment();
  rowByUid.clear();

  nodes.forEach((node) => {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.setAttribute("data-uid", node.uid || "");
    // 缩进用内联 padding：层级是数据，不是样式语义
    row.style.paddingLeft = `${6 + Math.max(0, Number(node.depth) || 0) * 12}px`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "tree-row-check";
    checkbox.tabIndex = -1;

    // 三种图标：有子节点且子节点已加载 ▾ / 有子节点但未加载 ▸ / 叶子 ·
    const childLoaded = Array.isArray(node.children) && node.children.length > 0;
    const icon = document.createElement("span");
    icon.className = "tree-row-icon";
    icon.textContent = node.hasChildren ? (childLoaded ? "▾" : "▸") : "·";

    const title = document.createElement("span");
    title.className = "tree-row-title";
    title.textContent = node.title || "未命名文档";

    row.appendChild(checkbox);
    row.appendChild(icon);
    row.appendChild(title);

    const notes = [];
    if (node.hasChildren && !childLoaded) {
      row.classList.add("unloaded");
      notes.push("子目录未展开");
    }
    // 非文档节点（视频、表格等）导出时会被跳过，提前标出来避免误选。
    if (node.kind && node.kind !== "doc" && node.kind !== "unknown") {
      const kind = document.createElement("span");
      kind.className = "tree-row-meta";
      kind.textContent = node.kind;
      row.appendChild(kind);
      notes.push(node.kind);
    }
    row.title = notes.length ? `${node.title || ""}（${notes.join("，")}）` : node.title || "";

    rowByUid.set(node.uid, { row, checkbox, node });
    fragment.appendChild(row);
  });

  treeListEl.textContent = "";
  treeListEl.appendChild(fragment);
  treeListEl.hidden = false;
}

// 只根据选择集刷新每行的复选框状态与行高亮，不重建 DOM（保留滚动位置）。
//
// 复选框显示的是「这一行自身」的勾选态，不借用半选态去聚合整棵子树——父级没被勾上
// 却显示半选会让人以为它自己也会被导出。子树里有没有东西被选，用行底色体现（partial）。
function updateTreeSelectionUi() {
  const selected = new Set(ui.treeSelectedUids);
  for (const entry of rowByUid.values()) {
    const selfChecked = Boolean(entry.node.uid) && selected.has(entry.node.uid);
    const subtreeState = selectionStateOf(entry.node, selected, subtreeUidsOf(entry.node));
    entry.checkbox.checked = selfChecked;
    entry.checkbox.indeterminate = false;
    entry.row.classList.toggle("selected", selfChecked);
    entry.row.classList.toggle("partial", !selfChecked && subtreeState !== "unchecked");
  }
  updateTreeCountHeader(selected);
}

function updateTreeCountHeader(selected) {
  const all = ui.treeNodes || [];
  const count = selected ? selected.size : ui.treeSelectedUids.length;
  const folderCount = all.filter(
    (node) => isFolderNode(node) && selected && selected.has(node.uid)
  ).length;
  treeCountEl.textContent = folderCount
    ? `已选 ${count} 篇（含 ${folderCount} 个父级目录）`
    : `已选 ${count} 篇`;

  // 工具栏复选框以「所有文档（叶子节点）都已勾上」为准——父级目录不参与，
  // 否则勾满全部文档后它仍然显示未选满，看起来像坏了。
  const docUids = all.filter((node) => !isFolderNode(node)).map((node) => node.uid);
  const docSelected = docUids.filter((uid) => selected && selected.has(uid)).length;
  treeCheckAllEl.checked = docUids.length > 0 && docSelected === docUids.length;
  treeCheckAllEl.indeterminate = docSelected > 0 && docSelected < docUids.length;
}

function subtreeUidsOf(node) {
  const key = node.uid || node.pos.join(",");
  if (!subtreeUidCache.has(key)) {
    subtreeUidCache.set(key, collectSubtreeUids(node));
  }
  return subtreeUidCache.get(key);
}

function findNodeByUid(uid) {
  return (ui.treeNodes || []).find((node) => node.uid === uid) || null;
}

// 点复选框：只切这一行自身，不级联。
//
// 和「点行」的差别只在于粒度：点行是整支一起动，点复选框是精确增删某一篇
// （比如整批里只想去掉父级目录那一篇）。
function setNodeChecked(uid, checked) {
  ui.treeSelectedUids = Array.from(
    applyCheckedToUids(new Set(ui.treeSelectedUids), [uid], checked)
  );
}

// 级联勾选的目标：整支里**剔除「没展开的文件夹」**。
//
// 那些行的子树本次没读到（列表里带 ▸），把它们算进来只会得到内容不完整的导出项。
// 已展开的目录、以及叶子文档照常参与。想单独要某一篇 ▸ 节点自己的正文，点它的
// 复选框即可——那是精确操作，不走级联。
function cascadeTargetsOf(node) {
  return subtreeUidsOf(node).filter((uid) => {
    const entry = rowByUid.get(uid);
    return !entry || !isUnloadedFolder(entry.node);
  });
}

// 点行内其它位置：勾选/取消**这一行连同它整棵子树**（目录自己也在这支里，
// 但「没展开的文件夹」被跳过）。已是整支全选态就整体取消。
function toggleRowDocs(uid) {
  const node = findNodeByUid(uid);
  if (!node) {
    return;
  }
  const targets = cascadeTargetsOf(node);
  if (!targets.length) {
    // 整支都是没展开的文件夹（比如点了一行 ▸）：没有可级联的目标，不改状态，
    // 避免留下一个「点了却没内容」的假勾选。
    return;
  }
  const selected = new Set(ui.treeSelectedUids);
  const allOn = targets.every((targetUid) => selected.has(targetUid));
  ui.treeSelectedUids = Array.from(
    applyCheckedToUids(selected, targets, !allOn)
  );
}

// 全选 = 勾上所有**文档**（叶子节点）。父级目录不随全选一起被灌进来——这是用户
// 最初的诉求；「没展开的文件夹」自然也在其中（`isFolderNode` 已覆盖它们）。
// 某支目录想连它自己一起要，点那一行即可；某一篇 ▸ 节点想单独要，点它的复选框。
function setAllChecked(checked) {
  if (!checked) {
    ui.treeSelectedUids = [];
    return;
  }
  ui.treeSelectedUids = (ui.treeNodes || [])
    .filter((node) => !isFolderNode(node) && !isUnloadedFolder(node))
    .map((node) => node.uid);
}

// 刷新目录树：侧边栏 → 内容脚本直连（不走 Service Worker），只读当前 DOM
// 里已经加载出来的节点，不点开折叠节点（改了页面状态容易让用户困惑）。
async function scanWikiTree() {
  const tab = await ensureFeishuTab();
  if (!tab) {
    return;
  }

  ui.treeBusy = true;
  setStatus("正在刷新目录…");

  try {
    const response = await sendTabMessageWithAutoInject(tab.id, {
      type: Msg.ENUM_WIKI_TREE
    });
    if (!response || !response.ok) {
      setStatus(`刷新目录失败：${response?.error || "未知错误"}`, true);
      return;
    }
    applyTreeResult(response);
  } catch (error) {
    setStatus(`刷新目录失败：${getErrorMessage(error)}`, true);
  } finally {
    ui.treeBusy = false;
  }
}

function applyTreeResult(result) {
  const flat = Array.isArray(result.nodes) ? result.nodes : [];
  const built = buildTree(
    flat.map((node) => ({ ...node, pos: parseNodePos(node.pos) }))
  );
  const ordered = flattenTree(built.roots);

  // 目录变了，之前的勾选不再成立：清空选择并刷新子树缓存。
  ui.treeNodes = ordered;
  ui.treeSelectedUids = [];
  subtreeUidCache.clear();
  renderTreePanel(true);

  if (!ordered.length) {
    setStatus(
      "刷新完成，但没有读到任何文档。请确认飞书页面左侧的 Wiki 目录已展开，并刷新页面后重试（控制台有诊断信息）。",
      true
    );
  } else {
    setStatus("目录已刷新，请勾选要导出的文档。");
  }
  printWholeManifest(result, ordered);
}

// 目录树现在直接渲染在侧边栏里，控制台只留一条摘要 + 警告，够排障即可。
function printWholeManifest(result, ordered) {
  console.log(
    `[目录树] ${result.host || ""} 刷新到 ${ordered.length} 篇文档`,
    { stats: result.stats, diagnostics: result.diagnostics }
  );
  if (result.warnings && result.warnings.length) {
    console.warn("[目录树] 警告", result.warnings);
  }
}

function formatExportMessage(message, exportType) {
  if (!message) {
    return message;
  }
  if (exportType === "pdf" || exportType === "markdown" || exportType === "word") {
    if (message.includes(KEEP_RENDER_TAB_TIP)) {
      return message;
    }
    return `${message}\n${KEEP_RENDER_TAB_TIP}`;
  }
  return message;
}

function getErrorMessage(error, fallback = "请求失败") {
  if (!error) {
    return fallback;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error && typeof error.message === "string" && error.message !== "[object Object]") {
    return error.message || fallback;
  }
  if (typeof error.message === "string" && error.message !== "[object Object]") {
    return error.message || fallback;
  }
  if (typeof error.detail === "string" && error.detail) {
    return error.detail;
  }
  if (error.detail && typeof error.detail.message === "string") {
    return error.detail.message;
  }
  try {
    const text = JSON.stringify(error);
    if (text && text !== "{}") {
      return text;
    }
  } catch {
  }
  return fallback;
}

let activeExport = null;

function beginExport(type, tabId) {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  activeExport = { type, requestId, tabId };
  setProgress(5);
  setStatus("开始导出...");
  return requestId;
}

function endExport() {
  activeExport = null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== Msg.EXPORT_PROGRESS) {
    return;
  }
  const respondOk = () => {
    if (typeof sendResponse === "function") {
      sendResponse({ ok: true });
    }
  };
  if (!activeExport || message.requestId !== activeExport.requestId) {
    respondOk();
    return;
  }
  if (message.exportType !== activeExport.type) {
    respondOk();
    return;
  }
  if (activeExport.tabId && message.tabId && message.tabId !== activeExport.tabId) {
    respondOk();
    return;
  }
  if (typeof message.progress === "number") {
    setProgress(message.progress);
  }
  if (message.message) {
    setStatus(formatExportMessage(message.message, message.exportType));
  }
  respondOk();
});

const FEISHU_HOST_SUFFIXES = [
  ".feishu.cn",
  ".feishu.net",
  ".feishu.cttq.com"
];

function isFeishuUrl(url) {
  try {
    const parsedUrl = new URL(url || "");
    return parsedUrl.protocol === "https:" &&
      FEISHU_HOST_SUFFIXES.some((suffix) => parsedUrl.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs ? tabs[0] : undefined);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      resolve(response || { ok: false, error: "未收到响应" });
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      resolve(response || { ok: false, error: "未收到响应" });
    });
  });
}

function isReceivingEndMissingError(errorMessage) {
  return /receiving end does not exist|could not establish connection/i.test(String(errorMessage || ""));
}

function injectContentScript(tabId) {
  return new Promise((resolve) => {
    if (!chrome.scripting || !chrome.scripting.executeScript) {
      resolve({ ok: false, error: "当前浏览器不支持主动注入内容脚本，请刷新飞书文档页面后重试" });
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["src/content.js"]
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

async function sendTabMessageWithAutoInject(tabId, message) {
  const firstResponse = await sendTabMessage(tabId, message);
  if (!firstResponse || firstResponse.ok || !isReceivingEndMissingError(firstResponse.error)) {
    return firstResponse;
  }

  const injectResponse = await injectContentScript(tabId);
  if (!injectResponse || !injectResponse.ok) {
    return {
      ok: false,
      error: `飞书页面脚本未就绪，自动注入失败：${injectResponse?.error || "未知错误"}。请刷新飞书文档页面后重试`
    };
  }

  const retryResponse = await sendTabMessage(tabId, message);
  if (!retryResponse || retryResponse.ok || !isReceivingEndMissingError(retryResponse.error)) {
    return retryResponse;
  }

  return {
    ok: false,
    error: "飞书页面脚本未就绪，请刷新飞书文档页面后重试"
  };
}

async function ensureFeishuTab() {
  const tab = await queryActiveTab();
  if (!tab || !tab.id || !isFeishuUrl(tab.url)) {
    setStatus("请在飞书文档页面使用该功能。", true);
    return null;
  }
  return tab;
}

async function prepareDocument(tabId, requestId, exportType) {
  const prepare = await sendTabMessageWithAutoInject(tabId, {
    type: Msg.PREPARE_EXPORT,
    requestId,
    exportType
  });
  if (!prepare || !prepare.ok) {
    throw new Error(prepare?.error || "无法加载文档内容");
  }
}

// 六个导出动作（Markdown / PDF / HTML / 附件 / 诊断 / 缓存）原本各自实现了一份
// 几乎相同的流程：定位飞书标签 -> 上报埋点 -> 预加载 -> 发消息给后台 ->
// 成功/失败/异常收尾。差异只在导出类型、消息类型、进度文案与是否预加载，
// 因此收敛为下面的通用流程 + 配置表。
//
// @param {string}   type            导出类型，用于埋点上报
// @param {string}   messageType     发给后台 Service Worker 的消息类型
// @param {boolean}  [prepare]       是否先预加载文档（长文档导出需要）
// @param {number}   [startProgress] 起始进度
// @param {string}   [startText]     起始阶段文案
// @param {number}   [workProgress]  发消息前的进度
// @param {string}   [workText]      发消息前的文案
// @param {Function} successText     成功文案，接收后台响应
// @param {string}   [failureLabel]  失败文案前缀
async function runExportTask({
  type,
  messageType,
  prepare = false,
  startProgress = 10,
  startText = "正在加载文档内容…",
  workProgress = 0,
  workText = "",
  successText,
  failureLabel = "导出"
}) {
  const tab = await ensureFeishuTab();
  if (!tab) {
    return;
  }

  setProgress(startProgress);
  setStatus(startText);

  let requestId = null;
  try {
    if (prepare) {
      requestId = beginExport(type, tab.id);
      await prepareDocument(tab.id, requestId, type);
    }

    if (workProgress) {
      setProgress(workProgress);
      setStatus(workText);
    }

    const response = await sendRuntimeMessage(
      exportCommand(messageType, {
        tabId: tab.id,
        title: tab.title,
        url: tab.url,
        ...(requestId ? { requestId } : {})
      })
    );

    if (!response || !response.ok) {
      setProgress(0);
    setStatus(`${failureLabel}失败：${response?.error || "未知错误"}`, true);
    return;
    }

    setProgress(100);
    setStatus(successText(response));
  } catch (error) {
    setProgress(0);
    setStatus(`${failureLabel}失败：${getErrorMessage(error)}`, true);
  } finally {
    if (requestId) {
      endExport();
    }
  }
}

const handleExportMarkdown = () =>
  runExportTask({
    type: "markdown",
    messageType: Msg.EXPORT_MARKDOWN_ADVANCED,
    prepare: true,
    startProgress: 6,
    startText: "正在预加载文档内容...",
    successText: (response) => `Markdown 压缩包已生成：${response.filename}`
  });

const handleExportPdf = () =>
  runExportTask({
    type: "pdf",
    messageType: Msg.EXPORT_PDF_ADVANCED,
    prepare: true,
    startProgress: 6,
    startText: "正在预加载文档内容...",
    successText: (response) => `PDF 已生成：${response.filename}`
  });

const handleExportHtml = () =>
  runExportTask({
    type: "html",
    messageType: Msg.EXPORT_HTML,
    prepare: true,
    startProgress: 6,
    startText: "正在预加载文档内容...",
    successText: (response) => `HTML 已生成：${response.filename}`
  });

const handleExportWord = () =>
  runExportTask({
    type: "word",
    messageType: Msg.EXPORT_WORD_ADVANCED,
    prepare: true,
    startProgress: 6,
    startText: "正在预加载文档内容...",
    successText: (response) => `Word 已生成：${response.filename}`
  });

const handleExportAttachments = () =>
  runExportTask({
    type: "attachments",
    messageType: Msg.EXPORT_ATTACHMENTS,
    workProgress: 60,
    workText: "正在导出附件…",
    successText: (response) => {
      const result = response.result || {};
      return `附件导出完成：图片 ${result.imageCount || 0}，文件 ${result.fileCount || 0}`;
    }
  });

// —— 批量导出：勾选的文档 → 一个 ZIP ——
//
// 计划（哪篇文档落到 ZIP 里的哪个路径）在侧边栏算：目录树与勾选状态都在这边，
// 后台拿到的已经是算好的路径，不必再理解目录树。见 lib/batch-plan.js。
// 扩展名由格式决定（markdown→md / html→html / word→docx / pdf→pdf），映射同出
// batch-plan.js，保证「计划里的路径」与「后台实际写出的条目」是同一个扩展名。

// 批量期间维持一条到 Service Worker 的长连接。MV3 的 SW 空闲约 30s 就被回收，
// 而「等渲染页回传」这类纯等待阶段没有任何事件，最容易被回收、整批就此断掉。
let batchPort = null;
let batchKeepAliveTimer = null;

function startBatchKeepAlive() {
  stopBatchKeepAlive();
  try {
    batchPort = chrome.runtime.connect({ name: BATCH_PORT_NAME });
    batchPort.onDisconnect.addListener(() => {
      // 读掉 lastError，避免 SW 重启时在控制台刷未捕获错误
      void chrome.runtime.lastError;
    });
  } catch {
    batchPort = null;
  }
  batchKeepAliveTimer = setInterval(() => {
    try {
      batchPort?.postMessage({ type: "ping", at: Date.now() });
    } catch {
      // 忽略：连接已断，SW 会自行按需唤醒
    }
  }, 20000);
}

function stopBatchKeepAlive() {
  if (batchKeepAliveTimer) {
    clearInterval(batchKeepAliveTimer);
    batchKeepAliveTimer = null;
  }
  try {
    batchPort?.disconnect();
  } catch {
    // 忽略
  }
  batchPort = null;
}

function summarizeBatch(stats, filename) {
  const total = stats.total || 0;
  const succeeded = stats.succeeded || 0;
  const formatLabel = FORMAT_LABELS[stats.format] || "";
  const lines = [`批量导出完成：${succeeded}/${total} 篇${formatLabel ? ` ${formatLabel}` : ""} → ${filename}`];
  if (stats.images) {
    lines.push(`含 ${stats.images} 张图片`);
  }
  if (stats.failed) {
    lines.push(`${stats.failed} 篇失败，明细见压缩包内的「导出报告.txt」`);
    (stats.failures || []).slice(0, 3).forEach((item) => {
      lines.push(`· ${item.title || item.path}：${item.reason || "未知错误"}`);
    });
  }
  if (stats.skipped) {
    lines.push(`跳过 ${stats.skipped} 篇非文档节点`);
  }
  if (stats.elapsedMs) {
    lines.push(`耗时 ${Math.round(stats.elapsedMs / 1000)} 秒`);
  }
  return lines.join("\n");
}

async function handleBatch(format) {
  const tab = await ensureFeishuTab();
  if (!tab) {
    return;
  }

  const plan = buildBatchPlan(ui.treeNodes, ui.treeSelectedUids, {
    extension: FORMAT_EXTENSIONS[format]
  });
  if (!plan.items.length) {
    setProgress(0);
    setStatus("勾选的节点里没有可导出的文档（非文档类型，或缺少 wikiToken）。", true);
    return;
  }

  const requestId = beginExport(format, tab.id);
  startBatchKeepAlive();

  const skippedNote = plan.skipped.length ? `，另跳过 ${plan.skipped.length} 个非文档节点` : "";
  // 勾了父级目录时，「勾选数」会多出那些只作目录的节点。这里点明一下，否则用户会
  // 以为漏导了（勾了 8 篇却只导 5 篇）。
  const folderNote = plan.stats.foldersOnly
    ? `，另有 ${plan.stats.foldersOnly} 个文件夹只作目录层级、不单独导出`
    : "";
  const formatLabel = FORMAT_LABELS[format] || format;
  setProgress(2);
  setStatus(
    `开始批量导出 ${plan.items.length} 篇文档为 ${formatLabel}${folderNote}${skippedNote}…\n` +
      `导出期间会短暂打开一个后台窗口，请不要关闭它。`
  );

  try {
    let host = "";
    try {
      host = new URL(tab.url).hostname;
    } catch {
      host = "";
    }

    const response = await sendRuntimeMessage(
      exportCommand(Msg.EXPORT_BATCH, {
        tabId: tab.id,
        host,
        requestId,
        format,
        plan
      })
    );

    if (!response || !response.ok) {
      setProgress(0);
    setStatus(`批量导出失败：${response?.error || "未知错误"}`, true);
    return;
    }

    const stats = response.result || {};
    setProgress(100);
    setStatus(summarizeBatch(stats, response.filename));
  } catch (error) {
    setProgress(0);
    setStatus(`批量导出失败：${getErrorMessage(error)}`, true);
  } finally {
    endExport();
    stopBatchKeepAlive();
  }
}

// 下拉框选中格式 -> 执行动作
const EXPORT_ACTIONS = {
  markdown: handleExportMarkdown,
  pdf: handleExportPdf,
  html: handleExportHtml,
  word: handleExportWord,
  attachments: handleExportAttachments
};

// 「执行」到底做什么，取决于「导出方式」：
//   批量 → 按目录树勾选打包 ZIP（Markdown / HTML / Word / PDF 均支持，附件除外）
//   单篇 → 维持原来的单篇导出（导出当前打开的这一篇）
function resolveExportAction() {
  if (ui.mode === "batch") {
    if (!FORMAT_EXTENSIONS[ui.format]) {
      return () =>
        setStatus(
          "批量导出暂不支持「附件」，请把导出格式切换为 Markdown / HTML / Word / PDF 后再试。",
          true
        );
    }
    const format = ui.format;
    return () => handleBatch(format);
  }
  return EXPORT_ACTIONS[ui.format];
}

// 「执行」按钮触发下拉框选中格式对应的导出动作，共用同一套收尾：置忙、进度归零、
// 异常兜底、结束复原
async function runAction(action) {
  setBusy(true);
  setProgress(0);
  try {
    if (action) {
      await action();
    } else {
      setStatus("该功能暂未支持。", true);
    }
  } catch (error) {
    setStatus(`操作失败：${getErrorMessage(error)}`, true);
    setProgress(0);
  } finally {
    setBusy(false);
  }
}

exportModeSelect.addEventListener("change", () => {
  ui.mode = exportModeSelect.value;
});

formatSelect.addEventListener("change", () => {
  ui.format = formatSelect.value;
});

runButton.addEventListener("click", () => {
  runAction(resolveExportAction());
});

scanTreeButton.addEventListener("click", () => {
  if (ui.treeBusy) {
    return;
  }
  scanWikiTree();
});

// 列表用事件委托：清单可能有几百行，逐行绑监听不划算。
//
// 点在复选框上的处理是这里最反直觉的一处，改之前务必看清：
//   <input type="checkbox"> 被点击时，浏览器会在**派发 click 之前**先执行
//   「pre-click 激活」把 checkedness 翻转一次（这就是用户想要的意图），点击结束后
//   再执行「激活行为」（派发 input/change）。如果我们在 click 里 preventDefault，
//   浏览器就转而执行「被取消的激活步骤」—— 把 checkedness 拨回点击前的值。
//
//   早前的实现正是 preventDefault + 从 ui 状态推断意图，结果：处理器里改了状态、
//   微任务里渲染出勾选态，紧接着浏览器把**被点的那一个复选框**拨回原值。表现就是
//   「已选计数 +1、父子行该勾的都勾了，唯独刚点的那个框还是空的」。
//
//   正确做法：不 preventDefault，让浏览器自己翻，然后直接读翻转后的 checked
//   作为用户意图（原生语义，无需推断），再级联到整棵子树。
treeListEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!target || typeof target.closest !== "function") {
    return;
  }
  const row = target.closest(".tree-row");
  if (!row) {
    return;
  }
  const check = target.closest(".tree-row-check");
  const uid = row.getAttribute("data-uid");
  if (!uid) {
    // 没有 uid 就没法级联；这种行本来也不该出现，顺手挡掉默认翻转免得留下假状态。
    if (check) {
      event.preventDefault();
    }
    return;
  }
  if (check) {
    // 复选框 = 只切这一行自身（想精确增删某一篇时用它）。
    setNodeChecked(uid, check.checked);
    return;
  }
  // 点行（标题、图标、空白处）：勾选/取消它连同整棵子树，目录自己也在这支里，
  // 但跳过「没展开的文件夹」（子树本次没读到，不入清单）。
  toggleRowDocs(uid);
});

treeCheckAllEl.addEventListener("change", () => {
  setAllChecked(treeCheckAllEl.checked);
});

async function bootstrap() {
}

bootstrap();
