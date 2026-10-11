// 飞书批量导出助手 —— Content Script 入口（经典脚本）。
// 这里是「装配层」：只负责注册消息监听器，全部业务逻辑下沉到 ./content：
//   markdown.js   DOM/图片 → Markdown 提取
//   preload.js    渐进滚动预加载、快照合并、进度广播、遮罩
//   wiki-tree.js  左侧 Wiki 目录树的读取（只读当前 DOM，不自动展开）
// 注意：content script 以经典脚本方式加载，产物不能出现 import/export，
// 因此本文件及其 ./content 子模块由 vite 的 inlineClassicLibs 插件
// 在构建时就地展开为单一经典脚本（与 lib 内联机制一致）。

import { buildMarkdownWithDomImages } from "./content/markdown.js";
import {
  getPreloadedMarkdownSnapshot,
  prepareExport
} from "./content/preload.js";
import { readWikiTree } from "./content/wiki-tree.js";
import { Msg, err } from "./lib/protocol.js";

// 重复注入会叠加监听器。侧边栏在收不到响应时会主动 executeScript 注入本文件
// （sendTabMessageWithAutoInject），此时页面上若还挂着旧版监听器，旧版会抢先
// 同步响应，新版永远轮不到 —— 表现就是「改了代码却还是老行为」。
// 所以在注册前先注销上一份：最后注入的那份说话。
if (typeof globalThis.__feishuExporterUnlisten === "function") {
  try {
    globalThis.__feishuExporterUnlisten();
  } catch {
    // 忽略：注销失败不影响后续注册
  }
}

// 唯一的消息监听器。四个动作：
//   EXPORT_MARKDOWN   带图片的完整 Markdown（含预加载快照择优）
//   PREPARE_EXPORT    导出前渐进滚动预加载，触发懒加载
//   ENUM_WIKI_TREE    读取左侧目录树（会点开折叠子树，异步响应）
const contentMessageListener = (message, _sender, sendResponse) => {
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

  if (message.type === Msg.PREPARE_EXPORT) {
    prepareExport(message.requestId, message.exportType)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // 读取目录树：纯读当前 DOM（不点开折叠节点、无渲染等待），因此是同步响应。
  if (message.type === Msg.ENUM_WIKI_TREE) {
    try {
      sendResponse(readWikiTree());
    } catch (error) {
      sendResponse({ ok: false, error: err(error).error });
    }
    return undefined;
  }

  return undefined;
};

chrome.runtime.onMessage.addListener(contentMessageListener);
globalThis.__feishuExporterUnlisten = () => {
  try {
    chrome.runtime.onMessage.removeListener(contentMessageListener);
  } catch {
    // 忽略
  }
};
