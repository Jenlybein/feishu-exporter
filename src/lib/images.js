// 导出图片命名相关的通用逻辑。
//
// 同一份逻辑此前散落在三处：content.js（页面内取图并直接生成 Markdown）、
// feishu-shared.js（注入脚本的 FX 共享层）、md-render.js（渲染页把 HTML 转
// Markdown 时收集内联图片）。三处实现基本一致，但 ensureUniqueName 的拷贝在
// content.js 里基于「上一次的候选名」继续拼接，会产生 image_1_2.png 这类
// 雪球式命名，而 md-render.js 基于「原始名」拼接，行为才是对的。这里统一为
// 基于原始名的版本。
import { stripInvisibleText } from "./text.js";

// 从 data:URL 推断图片扩展名，推断不出时用 fallback。
export function guessImageExtension(dataUrl, fallback = "png") {
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
}

// 把图片 alt / 原始名净化为可用文件名：剥离不可见字符、替换文件系统非法字符、
// 折叠空白、截去过长的名字，全部清掉时回退到 fallbackName。
export function normalizeImageName(name, fallbackName) {
  const fallback = String(fallbackName || "image");
  const source = String(name || "").trim() || fallback;
  const normalized =
    typeof source.normalize === "function" ? source.normalize("NFKC") : source;
  const cleaned = stripInvisibleText(normalized)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

// 创建「唯一文件名」生成器：同一批图片内重名时追加 _1 / _2 后缀，
// 后缀插在扩展名之前。每个收集批次应新建一个生成器。
export function createUniqueNamer() {
  const usedNames = new Set();
  return function ensureUniqueName(name) {
    let candidate = name;
    let index = 1;
    while (usedNames.has(candidate)) {
      // 始终基于原始 name 拼接，避免基于上一次候选名产生 image_1_2.png
      const dotIndex = name.lastIndexOf(".");
      candidate =
        dotIndex > 0
          ? `${name.slice(0, dotIndex)}_${index}${name.slice(dotIndex)}`
          : `${name}_${index}`;
      index += 1;
    }
    usedNames.add(candidate);
    return candidate;
  };
}
