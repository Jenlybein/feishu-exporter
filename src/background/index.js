// 飞书批量导出助手 —— Service Worker 入口。
// 这里是「装配层」：只负责侧边栏/工具栏的打开行为与消息分发注册，
// 全部业务逻辑下沉到 ./modules 下的内聚模块：
//   download.js   下载与落盘（文件名净化、Blob/data-url、ZIP）
//   debugger.js   CDP 打印 PDF
//   progress.js   导出进度广播
//   render.js     渲染标签页协调与分块传输
//   inject.js     MAIN world 页面内容提取
//   exporters.js  各格式导出流程编排
//   messaging.js  消息分发（含 EXPORT_HANDLERS 分发表）
import { registerMessageHandler } from "./modules/messaging.js";

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

registerMessageHandler();
