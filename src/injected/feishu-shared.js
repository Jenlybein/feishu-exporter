// 飞书文档页面侧共享辅助函数命名空间。
// 必须在各提取脚本（extract-*.js）之前加载。所有工具函数挂载到 window.__feishu 命名空间，
// 避免污染或冲突页面全局变量。
//
// 注入脚本是经典脚本，无法使用 import/export，唯一的复用方式就是本文件中的 FX 命名空间。
// 因此 extract-html / extract-attachments 等脚本曾重复实现的取图、Blob 读取、块定位等逻辑
// 统一收敛到这里，由各脚本从 FX 解构使用。
//
// 重要：IIFE 内先声明本地 const 辅助函数，函数体之间用裸名互相调用，最后再统一挂到 FX。
// 若只在 FX 上挂属性而函数体直接写裸名，运行时会抛 ReferenceError。
(function () {
  const FX = (window.__feishu = window.__feishu || {});

  // ---------- 基础工具 ----------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitForCondition = async (checker, timeoutMs = 3000, intervalMs = 200) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (await checker()) {
          return true;
        }
      } catch (error) {
        // 忽略检查异常
      }
      await sleep(intervalMs);
    }
    return false;
  };

  const readValue = (getter) => {
    try {
      return getter();
    } catch (error) {
      return null;
    }
  };

  const safeKeys = (value, limit = 60) => {
    try {
      if (!value || typeof value !== "object") {
        return [];
      }
      return Object.keys(value).slice(0, limit);
    } catch (error) {
      return [];
    }
  };

  // ---------- Blob / 画布 ----------

  const readBlobAsDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(blob);
    });

  const readCanvasDataUrl = (canvas) => {
    try {
      return canvas.toDataURL("image/png");
    } catch (error) {
      return null;
    }
  };

  // 经 toBlob 再转 data URL，用于超大画布等 toDataURL 可能失败的场景。
  const readCanvasAsDataUrl = (canvas) =>
    new Promise((resolve) => {
      try {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              resolve(null);
              return;
            }
            readBlobAsDataUrl(blob).then(resolve).catch(() => resolve(null));
          },
          "image/png",
          1
        );
      } catch (error) {
        resolve(null);
      }
    });

  const normalizePngDataUrl = (value) => {
    if (!value || typeof value !== "string") {
      return null;
    }
    return value.startsWith("data:") ? value : `data:image/png;base64,${value}`;
  };

  const toSvgDataUrl = (svgText) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;

  const guessImageExtension = (dataUrl, fallback = "png") => {
    if (typeof dataUrl !== "string") {
      return fallback;
    }
    const match = /^data:image\/([^;]+);/i.exec(dataUrl);
    if (!match) {
      return fallback;
    }
    const type = String(match[1]).toLowerCase();
    if (type === "jpeg") {
      return "jpg";
    }
    if (type === "svg+xml") {
      return "svg";
    }
    return type.replace(/[^a-z0-9]+/g, "") || fallback;
  };

  // 采样判断图片是否为全透明/全黑（即"空白"），避免导出无意义的占位图。
  const isBlankImageDataUrl = (dataUrl) =>
    new Promise((resolve) => {
      if (!dataUrl || typeof dataUrl !== "string") {
        resolve(true);
        return;
      }
      const image = new Image();
      image.onload = () => {
        try {
          const sampleSize = 32;
          const canvas = document.createElement("canvas");
          canvas.width = sampleSize;
          canvas.height = sampleSize;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) {
            resolve(false);
            return;
          }
          context.drawImage(image, 0, 0, sampleSize, sampleSize);
          const pixels = context.getImageData(0, 0, sampleSize, sampleSize).data;
          let visible = 0;
          let nonBlack = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const alpha = pixels[i + 3];
            if (alpha < 8) {
              continue;
            }
            visible += 1;
            if (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8) {
              nonBlack += 1;
            }
          }
          resolve(visible === 0 || nonBlack === 0);
        } catch (error) {
          resolve(false);
        }
      };
      image.onerror = () => resolve(false);
      image.src = dataUrl;
    });

  // ---------- 文档块信息 ----------

  const getRecordId = (block) => block?.record?.id || block?.snapshot?.id || block?.id || "";

  const getBlockType = (block) => {
    const direct = block?.type || block?.snapshot?.type || "";
    if (direct === "fallback" && block?.snapshot?.type) {
      return block.snapshot.type;
    }
    return direct;
  };

  // 一个块在 DOM 上可能对应多种 id 属性，尽可能收集全部候选。
  const getBlockIdCandidates = (block) => {
    const ids = [];
    const pushId = (value) => {
      if (!value) {
        return;
      }
      const text = String(value);
      if (!ids.includes(text)) {
        ids.push(text);
      }
    };
    pushId(block?.record?.id);
    pushId(block?.snapshot?.id);
    pushId(block?.id);
    const mindnote = block?.snapshot?.mindnote || {};
    pushId(mindnote.record_id);
    pushId(mindnote.recordId);
    pushId(mindnote.id);
    const whiteboard = block?.snapshot?.whiteboard || {};
    pushId(whiteboard.record_id);
    pushId(whiteboard.recordId);
    pushId(whiteboard.id);
    return ids;
  };

  const findBlockElement = (block) => {
    const ids = getBlockIdCandidates(block);
    for (const id of ids) {
      const byRecord = document.querySelector(`[data-record-id="${id}"]`);
      if (byRecord) {
        return byRecord;
      }
      const byBlock = document.querySelector(`[data-block-id="${id}"]`);
      if (byBlock) {
        return byBlock;
      }
    }
    return null;
  };

  // ---------- 取图：通用 ----------

  const fetchImageBySrc = async (src) => {
    if (!src) {
      return null;
    }
    try {
      const options = src.startsWith("blob:") ? {} : { credentials: "include" };
      const response = await fetch(src, options);
      if (!response.ok) {
        return null;
      }
      const blob = await response.blob();
      return await readBlobAsDataUrl(blob);
    } catch (error) {
      return null;
    }
  };

  // 经文档 imageManager 取原图 src，再拉回 data URL。
  const fetchImageDataUrl = async (block) => {
    const token = block?.snapshot?.image?.token;
    const manager = block?.imageManager;
    if (!token || !manager || typeof manager.fetch !== "function") {
      return null;
    }

    const result = await new Promise((resolve) => {
      try {
        manager.fetch({ token, isHD: false }, {}, (data) => resolve(data));
      } catch (error) {
        resolve(null);
      }
    });

    const src = result?.src;
    if (!src) {
      return null;
    }

    try {
      const options = src.startsWith("blob:") ? {} : { credentials: "include" };
      const response = await fetch(src, options);
      if (!response.ok) {
        return null;
      }
      const blob = await response.blob();
      return await readBlobAsDataUrl(blob);
    } catch (error) {
      return null;
    }
  };

  // 多画布合并成一张（飞书图表/公式常由多个 canvas 拼接）。
  const composeCanvasDataUrl = async (element) => {
    const canvases = Array.from(element.querySelectorAll("canvas")).filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return canvas.width > 0 && canvas.height > 0 && rect.width > 0 && rect.height > 0;
    });
    if (canvases.length === 0) {
      return null;
    }
    if (canvases.length === 1) {
      const single = readCanvasDataUrl(canvases[0]);
      return single && !(await isBlankImageDataUrl(single)) ? single : null;
    }
    const rects = canvases.map((canvas) => canvas.getBoundingClientRect());
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.ceil(right - left));
    output.height = Math.max(1, Math.ceil(bottom - top));
    const context = output.getContext("2d");
    if (!context) {
      return null;
    }
    context.fillStyle = "#fff";
    context.fillRect(0, 0, output.width, output.height);
    for (let i = 0; i < canvases.length; i += 1) {
      const rect = rects[i];
      context.drawImage(canvases[i], rect.left - left, rect.top - top, rect.width, rect.height);
    }
    const dataUrl = readCanvasDataUrl(output);
    return dataUrl && !(await isBlankImageDataUrl(dataUrl)) ? dataUrl : null;
  };

  // ---------- 取图：特殊块（图表 / 白板 / 思维笔记 / DOM 兜底）----------

  const fetchDiagramDataUrl = async (block) => {
    const recordId = getRecordId(block);
    if (!recordId) {
      return null;
    }
    const manager = window.PageMain?.blockManager;
    const views = manager?.getBlockViewsByRecordId?.(recordId);
    const view = views && views[0];
    if (!view || typeof view.getSvg !== "function") {
      return null;
    }
    let svg = await Promise.resolve(view.getSvg());
    if (!svg) {
      return null;
    }
    if (svg instanceof SVGElement) {
      svg = svg.outerHTML;
    } else if (typeof svg !== "string") {
      try {
        svg = svg.toString();
      } catch (error) {
        return null;
      }
    }
    if (!svg || !String(svg).includes("<svg")) {
      return null;
    }
    let svgText = String(svg);
    if (!svgText.includes("xmlns=")) {
      svgText = svgText.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    return toSvgDataUrl(svgText);
  };

  const fetchWhiteboardDataUrl = async (block) => {
    const isolateEnv = block?.whiteboardBlock?.isolateEnv;
    if (!isolateEnv || typeof isolateEnv.hasRatioApp !== "function") {
      return null;
    }
    if (!isolateEnv.hasRatioApp()) {
      return null;
    }
    const ratioApp = isolateEnv.getRatioApp?.();
    const proxy = ratioApp?.ratioAppProxy;
    if (!proxy || typeof proxy.getBase64ImgByNodeId !== "function") {
      return null;
    }
    const paramsList = [
      [24, [""], false, 2],
      [24, [], false, 2],
      [24, undefined, false, 2]
    ];
    for (const params of paramsList) {
      try {
        const base64 = await proxy.getBase64ImgByNodeId(...params);
        const dataUrl = normalizePngDataUrl(base64);
        if (dataUrl && !(await isBlankImageDataUrl(dataUrl))) {
          return dataUrl;
        }
      } catch (error) {
        // 换下一组参数重试
      }
    }
    return null;
  };

  // 思维笔记需要先滚动定位到该块，等画布渲染完成后再截图。
  const fetchMindnoteDataUrl = async (block) => {
    const candidates = getBlockIdCandidates(block);
    if (candidates.length === 0) {
      return null;
    }
    const locate = window.PageMain?.locateBlockWithRecordIdImpl;
    if (typeof locate === "function") {
      for (const id of candidates) {
        try {
          await locate(id);
        } catch (error) {
          // 忽略定位失败，继续尝试下一个候选 id
        }
      }
      await sleep(200);
    }
    await waitForCondition(() => {
      const element = findBlockElement(block);
      const canvas = element?.querySelector("canvas");
      return !!(canvas && canvas.width > 0 && canvas.height > 0);
    }, 12000, 300);
    const element = findBlockElement(block);
    const canvas = element?.querySelector("canvas");
    if (!canvas) {
      return null;
    }
    return await readCanvasAsDataUrl(canvas);
  };

  // DOM 兜底取图：优先合并画布，其次抓 <img>，最后抓内联 <svg>。
  const fetchDomPreviewDataUrl = async (block) => {
    const element = findBlockElement(block);
    if (!element) {
      return null;
    }
    const canvasDataUrl = await composeCanvasDataUrl(element);
    if (canvasDataUrl) {
      return canvasDataUrl;
    }
    const img = element.querySelector("img");
    if (img?.src) {
      const dataUrl = await fetchImageBySrc(img.src);
      if (dataUrl && !(await isBlankImageDataUrl(dataUrl))) {
        return dataUrl;
      }
    }
    const svg = element.querySelector("svg");
    if (svg) {
      const svgText = svg.outerHTML;
      if (svgText && svgText.includes("<svg")) {
        return toSvgDataUrl(svgText);
      }
    }
    return null;
  };

  // 特殊块统一入口：按块类型选专用取图方式，失败则回落到 DOM 兜底。
  const fetchSpecialBlockDataUrl = async (block) => {
    const type = getBlockType(block);
    let dataUrl = null;
    if (type === "diagram") {
      dataUrl = await fetchDiagramDataUrl(block);
    } else if (type === "whiteboard") {
      dataUrl = await fetchWhiteboardDataUrl(block);
    } else if (type === "mindnote") {
      dataUrl = await fetchMindnoteDataUrl(block);
    }
    if (dataUrl) {
      return dataUrl;
    }
    return await fetchDomPreviewDataUrl(block);
  };

  // ---------- 统一挂载到 FX 命名空间 ----------

  Object.assign(FX, {
    // 基础工具
    sleep,
    waitForCondition,
    readValue,
    safeKeys,
    // Blob / 画布
    readBlobAsDataUrl,
    readCanvasDataUrl,
    readCanvasAsDataUrl,
    normalizePngDataUrl,
    toSvgDataUrl,
    guessImageExtension,
    isBlankImageDataUrl,
    // 块信息
    getRecordId,
    getBlockType,
    getBlockIdCandidates,
    findBlockElement,
    // 取图
    fetchImageBySrc,
    fetchImageDataUrl,
    composeCanvasDataUrl,
    fetchDiagramDataUrl,
    fetchWhiteboardDataUrl,
    fetchMindnoteDataUrl,
    fetchDomPreviewDataUrl,
    fetchSpecialBlockDataUrl
  });
})();
