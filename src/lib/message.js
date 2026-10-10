// chrome.runtime.sendMessage 的 Promise 封装。
// background（Service Worker）与 md-render 原先各有一份字节级相同的实现，收敛到此处。
export function sendRuntimeMessageAsync(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}
