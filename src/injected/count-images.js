// 由背景脚本通过 chrome.scripting.executeScript({files:[...]}) 注入到页面 MAIN world。
// 共享辅助函数来自 feishu-shared.js（window.__feishu / FX）。
// 本文件由逐字抽取原始内联注入函数生成，提取专属逻辑与原始行为一致。
(function () {
  const FX = window.__feishu;
  const getBlockType = FX.getBlockType;

  window.__feishuCountImages = async function countDocumentImages() {
const pageMain = window.PageMain;
const candidates = [
            pageMain?.blockManager?.rootBlockModel,
            pageMain?.blockManager?.modelService?.rootBlockModel,
            pageMain?.modelService?.rootBlockModel
          ];
const rootBlock = candidates.find((item) => item && Array.isArray(item.children)) || null;
if (!rootBlock) {
            return 0;
          }
let count = 0;
const stack = [rootBlock];
while (stack.length > 0) {
            const block = stack.pop();
            if (!block) {
              continue;
            }
            const type = getBlockType(block);
            if (type === "image") {
              count += 1;
            }
            const children = Array.isArray(block.children) ? block.children : [];
            for (const child of children) {
              stack.push(child);
            }
          }
return count;
  };
})();
