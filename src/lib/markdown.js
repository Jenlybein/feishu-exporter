// HTML / DOM → Markdown 的统一入口。
//
// 早期项目里有两套转换器：md-render.js 用 turndown，content.js 手写了一套
// convertNode / inlineText / handleList / handleTable / pushBlock（约 120 行）。
// 现在两侧都走这里的工厂，配置唯一，行为一致。
//
// 注意：content.js 是 MV3 经典脚本，不能出现 import/export。构建时由
// vite.config.js 的 inlineClassicLibs 插件把 turndown / turndown-plugin-gfm
// 的 ESM 源码就地内联（IIFE 包裹避免命名冲突），产物仍是自包含单文件。
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// 扩展自己注入到飞书页面里的 UI（进度遮罩等）不能被算进导出内容，
// 打上 data-feishu-exporter 标记的元素一律忽略。
function isExporterUi(node) {
  return (
    node.nodeType === 1 &&
    typeof node.hasAttribute === "function" &&
    node.hasAttribute("data-feishu-exporter")
  );
}

export function createMarkdownConverter() {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**"
  });
  service.use(gfm);

  service.addRule("skipExporterUi", {
    filter: isExporterUi,
    replacement: () => ""
  });

  // 保留飞书"多图并排"区块（.image-row 含多张图）原先的 GFM 表格转换行为。
  service.addRule("imageRow", {
    filter: (node) =>
      node.nodeName === "DIV" &&
      node.classList &&
      node.classList.contains("image-row") &&
      node.querySelectorAll("img").length > 1,
    replacement: (_content, node) => {
      const cells = Array.from(node.querySelectorAll("img")).map((img) => {
        const alt = img.getAttribute("alt") || "";
        const src = img.getAttribute("src") || "";
        return src ? `![${alt}](${src})` : alt;
      });
      return `\n\n| ${cells.join(" | ")} |\n| ${cells.map(() => "---").join(" | ")} |\n\n`;
    }
  });

  return service;
}
