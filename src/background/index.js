// 飞书批量导出助手 —— Service Worker 入口。
// 这里是「装配层」：只负责侧边栏/工具栏的打开行为与消息分发注册，
// 全部业务逻辑下沉到 ./modules 下的内聚模块：
//   download.js   下载与落盘（文件名净化、Blob/data-url、ZIP）
//   debugger.js   CDP 打印 PDF
//   progress.js   导出进度广播
//   render.js     渲染标签页协调与分块传输
//   inject.js     MAIN world 页面内容提取
//   exporters.js  各格式导出流程编排（含渲染标签页的复用）
//   batch.js      批量导出：逐篇抓取 + 汇总 ZIP
//   messaging.js  消息分发（含 EXPORT_HANDLERS 分发表）
import { registerMessageHandler } from "./modules/messaging.js";
import { BATCH_PORT_NAME } from "../lib/protocol.js";

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (!tab || !tab.id || !chrome.sidePanel || !chrome.sidePanel.open) {
      return;
    }
    chrome.sidePanel.open({ tabId: tab.id });
  });
}

// 批量导出的保活通道。见 lib/protocol.js 里 BATCH_PORT_NAME 的说明：
// 侧边栏在批量期间维持这条长连接并周期心跳，SW 只要还持有它就不会被回收。
// 这里不需要搬运任何业务数据，收到消息即代表「还活着」。
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== BATCH_PORT_NAME) {
    return;
  }
  port.onMessage.addListener((_message, respond) => {
    if (typeof respond === "function") {
      respond({ ok: true });
    }
  });
});

registerMessageHandler();
