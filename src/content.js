// 飞书批量导出助手 —— Content Script 入口（经典脚本）。
// 这里是「装配层」：只负责注册消息监听器，全部业务逻辑下沉到 ./content/modules：
//   markdown.js   DOM/图片 → Markdown 提取
//   preload.js    渐进滚动预加载、快照合并、进度广播、遮罩
//   messaging.js  消息分发（EXPORT_MARKDOWN / TEXT_ONLY / PREPARE_PDF）
// 注意：content script 以经典脚本方式加载，产物不能出现 import/export，
// 因此本文件及其 ./content/modules 子模块由 vite 的 inlineClassicLibs 插件
// 在构建时就地展开为单一经典脚本（与 lib 内联机制一致）。

import { buildMarkdownWithDomImages } from "./content/markdown.js";
import {
  getBestMarkdownSnapshot,
  getPreloadedMarkdownSnapshot,
  preparePdfExport
} from "./content/preload.js";
import { Msg, err } from "./lib/protocol.js";

// 注册 content script 的唯一消息监听器。三个动作：
//   EXPORT_MARKDOWN          带图片的完整 Markdown（含预加载快照择优）
//   EXPORT_MARKDOWN_TEXT_ONLY 纯文本快照（直接打印 PDF 前的快速路径）
//   PREPARE_PDF              导出前渐进滚动预加载，触发懒加载
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
if (!message) {
    return;
}

if (message.type === Msg.EXPORT_MARKDOWN) {
    buildMarkdownWithDomImages()
    .then((result) => {
        const preloaded = getPreloadedMarkdownSnapshot();
        const markdown =
        preloaded && preloaded.length > result.markdown.length
            ? preloaded
            : result.markdown;
        if (!markdown) {
        sendResponse({ ok: false, error: "未提取到文档内容" });
        return;
        }
        sendResponse({
        ok: true,
        markdown,
        images: Array.isArray(result.images) ? result.images : []
        });
    })
    .catch((error) => {
        sendResponse(err(error));
    });
    return true;
}

if (message.type === Msg.EXPORT_MARKDOWN_TEXT_ONLY) {
    try {
    const markdown = getBestMarkdownSnapshot();
    if (!markdown) {
        sendResponse({ ok: false, error: "未提取到文档内容" });
        return;
    }
    sendResponse({ ok: true, markdown });
    } catch (error) {
    sendResponse(err(error));
    }
    return;
}

if (message.type === Msg.PREPARE_PDF) {
    preparePdfExport(message.requestId, message.exportType)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
}
});
