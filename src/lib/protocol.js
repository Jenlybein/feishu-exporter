// 跨上下文消息协议 —— 整个扩展唯一的事实来源（single source of truth）。
//
// 背景 Service Worker、内容脚本、渲染标签页、侧边栏、MAIN world 注入脚本之间
// 全部通过 chrome.runtime / chrome.tabs 消息通信。此前 19 个消息类型作为魔法
// 字符串散落在 9 个文件里，新增一种导出格式要改多处、极易漏改。这里集中定义
// 类型常量与响应/请求的契约辅助函数，所有模块统一从本文件取用。
//
// 设计约束：本文件保持「自包含、零 import」，原因有二：
//   1) 它会被内容脚本（MV3 经典脚本）在构建期经 inlineClassicLibs 内联，
//      不能依赖其它模块的 export；
//   2) 它也会被普通 ESM 入口（background / render / sidepanel）import，
//      Vite 会将其并入 lib.js 共享块。两条路径都能成立。

// 所有消息类型常量。值等于字符串本身，便于在 DevTools 里直接对照。
export const Msg = {
  // —— 进度广播：SW → 侧边栏/内容脚本（单向，fire-and-forget）——
  EXPORT_PROGRESS: "EXPORT_PROGRESS",

  // —— 渲染标签页 → SW 的就绪/分块回传（Markdown / Word 等生成型渲染页共用）——
  // 分块结果与格式无关：渲染页把最终产物序列化成字符串切块回传，SW 拼装后落盘。
  PDF_RENDER_READY: "PDF_RENDER_READY",
  RENDER_RESULT_CHUNK_START: "RENDER_RESULT_CHUNK_START",
  RENDER_RESULT_CHUNK: "RENDER_RESULT_CHUNK",
  RENDER_RESULT_CHUNK_END: "RENDER_RESULT_CHUNK_END",
  RENDER_RESULT_ERROR: "RENDER_RESULT_ERROR",

  // —— 侧边栏 → SW 的导出命令（需异步响应 { ok, ... }）——
  EXPORT_PDF: "EXPORT_PDF",
  EXPORT_PDF_ADVANCED: "EXPORT_PDF_ADVANCED",
  EXPORT_HTML: "EXPORT_HTML",
  EXPORT_ATTACHMENTS: "EXPORT_ATTACHMENTS",
  EXPORT_MARKDOWN_ADVANCED: "EXPORT_MARKDOWN_ADVANCED",
  EXPORT_WORD_ADVANCED: "EXPORT_WORD_ADVANCED",
  DOWNLOAD_MARKDOWN: "DOWNLOAD_MARKDOWN",

  // 批量：勾选目录树里的一批文档，逐篇抓取后打包成一个 ZIP。
  // 消息体带 plan（见 lib/batch-plan.js），成功响应返回 { ok, result }。
  EXPORT_BATCH_MARKDOWN: "EXPORT_BATCH_MARKDOWN",

  // —— 侧边栏 → 内容脚本 的导出命令（需异步响应 { ok, ... }）——
  EXPORT_MARKDOWN: "EXPORT_MARKDOWN",
  PREPARE_EXPORT: "PREPARE_EXPORT",

  // —— 侧边栏 → 内容脚本 的目录树读取 ——
  // ENUM_WIKI_TREE 侧边栏直连内容脚本：读飞书左侧完整目录树，
  //                响应 { ok, nodes, stats, diagnostics, warnings }（同步返回）。
  // 注：目录树是完整渲染的普通 DOM，content script 一遍 querySelectorAll 即可读全，
  // 不需要滚动、不需要注入 MAIN world，因此这条消息不经过 Service Worker。
  ENUM_WIKI_TREE: "ENUM_WIKI_TREE",

  // —— SW → 渲染标签页 的分块 HTML 推送 ——
  RENDER_HTML_CHUNK_START: "RENDER_HTML_CHUNK_START",
  RENDER_HTML_CHUNK: "RENDER_HTML_CHUNK",
  RENDER_HTML_CHUNK_END: "RENDER_HTML_CHUNK_END",
  RENDER_PDF_HTML: "RENDER_PDF_HTML"
};

// 导出命令中，哪些成功响应返回的是 result 对象（而非 filename）。
// 用于 EXPORT_HANDLERS 分发表决定 ok 字段名。
export const EXPORT_RESULT_KEY = {
  [Msg.EXPORT_ATTACHMENTS]: "result",
  [Msg.EXPORT_BATCH_MARKDOWN]: "result"
};

// 批量导出的长连接端口名。
//
// MV3 的 Service Worker 会在空闲约 30s 后被回收，而批量导出动辄数分钟——尤其在
// 「等渲染页回传」这种纯等待阶段，SW 收不到任何事件，最容易被回收，整条异步链
// 就此断掉、进度卡死。侧边栏在批量期间保持一条长连接并周期心跳，连接存在即视为
// SW 仍在工作，从而撑过整批。
export const BATCH_PORT_NAME = "feishu-exporter-batch";

// —— 响应契约：所有异步消息统一返回 { ok, error | <okKey> } ——

export function ok(value, okKey = "filename") {
  return { ok: true, [okKey]: value };
}

export function err(error) {
  const message =
    error && typeof error.message === "string" && error.message
      ? error.message
      : typeof error === "string"
        ? error
        : "未知错误";
  return { ok: false, error: message };
}

export function isOk(response) {
  return !!(response && response.ok);
}

// 把异步任务的成功/失败映射成 sendResponse({ ok, ... })，并固定返回 true
// （告诉 Chrome 这是异步响应，稍后再调用 sendResponse）。
export function replyAsync(sendResponse, promise, okKey = "filename") {
  Promise.resolve(promise).then(
    (value) => sendResponse(ok(value, okKey)),
    (error) => sendResponse(err(error))
  );
  return true;
}

// 给无需业务数据的内部消息（进度、分块回调等）回标准 ack。
export function ack(sendResponse) {
  if (typeof sendResponse === "function") {
    sendResponse(ok());
  }
}

// 构造一条「导出命令」消息，统一字段形状，避免各调用点手写散落的 type 字面量。
export function exportCommand(type, payload = {}) {
  return { type, ...payload };
}

// 构造一条「进度广播」消息。SW 与内容脚本两处进度上报共用，保证字段一致。
export function progressMessage({ tabId, requestId, exportType, progress, message }) {
  return {
    type: Msg.EXPORT_PROGRESS,
    tabId,
    requestId,
    exportType,
    progress,
    message
  };
}
