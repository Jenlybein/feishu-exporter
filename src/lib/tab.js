// 取当前渲染标签页 id（带缓存，避免重复查询）。
let currentTabIdPromise = null;

export function getCurrentTabId() {
  if (currentTabIdPromise) {
    return currentTabIdPromise;
  }
  currentTabIdPromise = new Promise((resolve) => {
    chrome.tabs.getCurrent((tab) => resolve(tab?.id || null));
  });
  return currentTabIdPromise;
}
