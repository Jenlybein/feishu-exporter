# 飞书批量导出助手（feishu-batch-exporter）

> Chrome MV3 扩展：在飞书文档页**批量导出** Word / PDF / Markdown / HTML / 附件。
> 版本 `0.1.5` · 构建由 Vite 管理。

---

## 1. 功能简介

在飞书文档页面打开侧边栏，即可把当前文档一键导出为多种格式：

| 导出格式 | 说明 |
|----------|------|
| **Word** | 主干 HTML 经 `docx` 直接映射为 `.docx`（不经 Markdown），保留标题/加粗/表格/代码块/图片 |
| **PDF** | 借助 Chrome DevTools Protocol（`debugger` 权限）`Page.printToPDF` 生成 |
| **Markdown** | 通过 `turndown` + `turndown-plugin-gfm` 将文档块模型转为 Markdown |
| **HTML** | 还原飞书块模型为带样式的自包含 HTML 文档 |
| **附件** | 抓取文档内嵌入的图片与文件，按子目录逐个下载落盘（不打包） |

支持的飞书域名：`*.feishu.cn`、`*.feishu.net`、`*.feishu.cttq.com`。

侧边栏顶部的「导出方式」下拉有 **单篇 / 批量** 两档，默认**单篇**（导出当前打开的这篇文档）；
只有切到**批量**时才会显示下方的「目录树」区块。在批量模式下点「刷新目录」读取飞书 Wiki 左侧目录树并
**多选勾选**（只读页面上已展开的部分，折叠节点的子节点未加载），勾选语义见下表。勾选后选好格式、点
「批量导出」，即可把这批文档逐篇抓下来、打包成**一个 ZIP**；有失败或跳过的节点会额外写一份
`导出报告.txt` 进压缩包。

批量支持 **Markdown / HTML / Word / PDF** 四种格式，产物按格式落不同扩展名：

| 格式 | ZIP 内的产物 | 图片 |
|------|--------------|------|
| **Markdown** | 每篇一个 `.md` | 另存到同级的 `<文档名>.assets/`，引用已改写到该目录 |
| **HTML** | 每篇一个自包含 `.html` | 内联为 `data:URL`，不额外生成文件 |
| **Word** | 每篇一个 `.docx` | 已嵌入文档内 |
| **PDF** | 每篇一个 `.pdf` | 已嵌入文档内 |

「附件」格式**不支持批量**。

---

## 2. 快速开始

### 2.1 构建

```bash
npm install
npm run build      # 产物输出到 dist/
```

开发期可在 `dist/` 上挂载 `--watch` 自动重建：

```bash
npm run dev        # 等价于 vite build --watch
```

### 2.2 加载到 Chrome

1. 打开 `chrome://extensions`，右上角打开「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择仓库下的 **`dist/`** 目录。
3. 在飞书文档页面点击扩展图标，打开侧边栏即可使用。

> `dist/` 内的 `manifest.json` 与源码中的相对路径保持一致，因此**无需**改写清单，Chrome 直接加载 `dist/` 即可。

### 2.3 权限说明

扩展申请了以下权限（`src/manifest.json`）：

`debugger` · `downloads` · `sidePanel` · `scripting` · `storage` · `tabs`

- `debugger`：用于 PDF 导出（CDP `Page.printToPDF`）。
- `downloads`：触发浏览器下载与 ZIP 打包落盘。
- `sidePanel` / `scripting` / `storage` / `tabs`：侧边栏、注入脚本、状态持久化与标签页控制。

---

## 3. 架构概览

项目刻意保持**小型**，核心约束只有三条：分层单向依赖、统一消息协议、构建期内联经典脚本。

### 3.1 分层与依赖方向

依赖只允许**自上而下**单向流动，禁止回环：

```
┌─ UI 层 ────────────────────────────────────────────┐
│  sidepanel/*   渲染页 render/*   content 脚本         │  薄：只做委托与展示
└─────────────────────┬───────────────────────────────┘
                      │  统一消息协议 src/lib/protocol.js
┌─ 服务层 ─────────────┴──────────────────────────────┐
│  background/modules/*  (exporters / render / inject …)│  业务编排
└─────────────────────┬───────────────────────────────┘
                      │  Chrome 平台适配 (lib/message, tab, download…)
┌─ 隔离世界 ───────────┴──────────────────────────────┐
│  injected/*  (MAIN world, window.__feishu 命名空间)   │  逆向抓取，隔离边界
└──────────────────────────────────────────────────────┘
```

- **UI 层**不写业务逻辑：sidepanel 只拼消息、渲染状态；render 页只接收分块 HTML 并渲染；content 只响应少量命令、做预加载。
- **服务层**（Service Worker，`src/background/index.js`）是真正的编排中心，按职责拆到 `background/modules/*`。
- **隔离世界**（MAIN world 注入脚本）被迫与页面同世界运行，才能读取 `window.PageMain` 等私有结构；它们一律经 `window.__feishu` / `window.__feishuXxx` 命名空间对外暴露，**禁止 import/export**。

### 3.2 目录职责

```
src/
  manifest.json                扩展清单（路径与构建产物对齐，无需改写）
  lib/                         纯函数 / 平台适配（会被模块脚本与经典脚本共享、内联）
    protocol.js                消息协议（见 §3.2）
    message.js / tab.js        chrome.runtime / chrome.tabs 的 Promise 封装
    chunk.js / chunked-render.js  大消息分块与渲染页接收工厂
    filename.js / images.js / text.js / markdown.js   文件名、图片、文本、Markdown 转换
    tree-path.js               目录树路径工具（uid/pos 解析、pos→树、路径净化与重名消歧、目录/未展开判定与级联）
    batch-plan.js              批量导出的路径规划（勾选集合 → ZIP 内文件路径与 Markdown 的 assets 目录、格式→扩展名映射、文件夹退位成目录、重名消歧、失败报告）
    reactive.js                极简响应式状态容器（侧边栏 UI 用）
  background/
    index.js                   Service Worker 入口：面板行为 + 消息分发 + 批量保活长连接
    modules/
      messaging.js             唯一消息监听入口 + EXPORT_HANDLERS 分发表
      exporters.js             各格式导出编排（word/html/markdown/attachments/pdf/下载）+ 渲染标签页复用
      batch.js                 批量导出编排：逐篇抓取 → 按格式落成字节 → 汇总 ZIP → 收尾回收
      templates.js             HTML 文档模板（纯展示）
      render.js                渲染标签页协调 + 分块收发
      inject.js                MAIN world 注入封装（injectAndRun / 各提取入口）
      debugger.js              CDP Page.printToPDF
      download.js              chrome.downloads 封装 + ZIP（fflate）
      progress.js              进度广播
  content.js + content/*       内容脚本：PREPARE_EXPORT / EXPORT_MARKDOWN 命令 + 预加载
    wiki-tree.js               读取左侧 Wiki 目录树（全文档扫描 + 容器分组，只读当前 DOM、不自动展开）
  injected/                   MAIN world 经典脚本（禁止 import/export）
    feishu-shared.js           window.__feishu 共享工具命名空间
    extract-html.js            块模型 → HTML（领域复杂，单文件保持稳定）
    extract-attachments.js / count-images.js
  render/                      tab 渲染页（md-render / pdf-render / word-render）
    html-docx.js               HTML DOM → docx 元素映射层（Word 分支专属，含 docx 依赖）
  sidepanel/                   侧边栏 UI（sidepanel.html / .js / .css）
```

## 4. 技术栈

- **运行时**：Chrome 扩展 MV3（Service Worker + 侧边栏 + 内容脚本 + 注入脚本）。
- **构建**：[Vite](https://vitejs.dev/) `^5.4.10`。
- **依赖**：
  - `fflate`：ZIP 打包（附件导出）与 ZIP 解包（测试校验）。
  - `turndown` + `turndown-plugin-gfm`：HTML → Markdown 转换（在经典脚本中被 IIFE 内联）。
  - `docx`：生成 `.docx`（Word 分支，仅在 `word-render` 渲染页加载，不影响 SW / 侧边栏体积）。
