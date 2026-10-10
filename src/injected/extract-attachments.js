// 由背景脚本通过 chrome.scripting.executeScript({files:[...]}) 注入到页面 MAIN world。
// 共享辅助函数来自 feishu-shared.js（window.__feishu / FX）。
// 本文件只保留"附件提取"的专属遍历与命名逻辑：
// 取图（fetchImageDataUrl）、推断扩展名（guessImageExtension）等通用能力统一从 FX 获取。
(function () {
  const FX = window.__feishu;
  const fetchImageDataUrl = FX.fetchImageDataUrl;
  const guessImageExtension = FX.guessImageExtension;

  window.__feishuExtractAttachments = async function extractAttachments() {
    const rootBlock = window.PageMain?.blockManager?.rootBlockModel || null;
    if (!rootBlock) {
      return { ok: false, error: "未找到文档数据" };
    }

    const attachments = {
      images: [],
      files: []
    };
    let imageIndex = 1;
    let fileIndex = 1;

    const getImageName = (block, ext) => {
      const rawName = block?.snapshot?.image?.name || `image_${imageIndex}`;
      const name = rawName.includes(".") ? rawName : `${rawName}.${ext}`;
      imageIndex += 1;
      return name;
    };

    const getFileName = (block) => {
      const rawName = block?.snapshot?.file?.name || `file_${fileIndex}`;
      fileIndex += 1;
      return rawName;
    };

    const toFileDownloadUrl = (token) =>
      `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/${token}?mount_point=docx_file&preview_type=16`;

    const walk = async (block) => {
      if (!block) {
        return;
      }

      const type = block.type || block.snapshot?.type || "";
      if (type === "image") {
        const dataUrl = await fetchImageDataUrl(block);
        if (dataUrl) {
          const ext = guessImageExtension(dataUrl);
          const filename = getImageName(block, ext);
          attachments.images.push({ filename, dataUrl });
        }
      } else if (type === "file") {
        const token = block?.snapshot?.file?.token;
        if (token) {
          const filename = getFileName(block);
          attachments.files.push({
            filename,
            url: toFileDownloadUrl(token)
          });
        }
      }

      if (Array.isArray(block.children)) {
        for (const child of block.children) {
          await walk(child);
        }
      }
    };

    await walk(rootBlock);
    return { ok: true, attachments };
  };
})();
