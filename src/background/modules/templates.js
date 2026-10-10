// 导出产物的 HTML 模板。
//
// 此前内联在 exporters.js 里，与「各格式导出编排」混在一起。这里把它独立成
// 纯展示层：输入标题 + 正文 HTML，输出带基础排版的完整 HTML 文档，供 HTML 导出
// 与 PDF 渲染标签页复用。不含任何业务逻辑。

// 给正文套一层带基础排版样式的完整 HTML 文档，供 HTML 导出与 PDF 渲染复用。
export function wrapHtmlDocument(title, bodyHtml) {
  const safeTitle = title
    ? title.replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : "feishu-document";
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      body {
        margin: 0;
        padding: 18px;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #1f2328;
        background: #ffffff;
      }
      h1,
      h2,
      h3,
      h4,
      h5,
      h6 {
        margin: 18px 0 10px;
      }
      p {
        margin: 10px 0;
        line-height: 1.6;
      }
      pre {
        background: #f6f8fa;
        border: 1px solid #d0d7de;
        border-radius: 6px;
        padding: 10px;
        overflow-wrap: break-word;
        white-space: pre-wrap;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin: 12px 0;
      }
      table th,
      table td {
        border: 1px solid #d0d7de;
        padding: 6px 8px;
        font-size: 14px;
        vertical-align: top;
      }
      blockquote.callout {
        margin: 12px 0;
        padding: 8px 12px;
        background: #f8fafc;
        border-left: 4px solid #60a5fa;
        border-radius: 6px;
      }
      blockquote {
        margin: 12px 0;
        padding: 8px 12px;
        border-left: 4px solid #d0d7de;
        background: #f6f8fa;
      }
      hr {
        border: none;
        border-top: 1px solid #d0d7de;
        margin: 18px 0;
      }
      img {
        max-width: 100%;
        height: auto;
      }
      figure {
        margin: 12px 0;
      }
      .image-row {
        display: flex;
        gap: 12px;
        margin: 12px 0;
        align-items: flex-start;
      }
      .image-row > * {
        flex: 1 1 0;
        min-width: 0;
      }
      .image-row img {
        width: 100%;
        max-width: 100%;
        height: auto;
        object-fit: contain;
      }
    </style>
  </head>
  <body>
    ${bodyHtml || ""}
  </body>
</html>`;
}
