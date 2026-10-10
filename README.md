# 飞书批量导出助手（feishu-batch-exporter）

> Chrome MV3 扩展：在飞书文档页**批量导出** PDF / Markdown / HTML / 附件。
> 版本 `0.1.5` · 构建由 Vite 管理（不依赖 `@crxjs` 等 MV3 专属插件）。

---

## 1. 功能简介

在飞书文档页面打开侧边栏，即可把当前文档一键导出为多种格式：

| 导出格式 | 说明 |
|----------|------|
| **PDF** | 借助 Chrome DevTools Protocol（`debugger` 权限）`Page.printToPDF` 生成 |
| **Markdown** | 通过 `turndown` + `turndown-plugin-gfm` 将文档块模型转为 Markdown |
| **HTML** | 还原飞书块模型为带样式的自包含 HTML 文档 |
| **附件** | 批量抓取文档内嵌入的图片、文件等附件，可打包为 ZIP |

支持的飞书域名：`*.feishu.cn`、`*.feishu.net`、`*.feishu.cttq.com`。

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

### 3.2 消息协议（唯一事实来源）

所有跨上下文消息的类型常量与响应契约集中在 **`src/lib/protocol.js`**：

- `Msg`：消息类型枚举（值等于字符串本身，便于 DevTools 对照）。
- 响应契约：`ok(value, okKey?)` / `err(error)` / `isOk(res)`。
- 异步分发：`replyAsync(sendResponse, promise, okKey?)` 固定返回 `true`。
- 构造辅助：`exportCommand(type, payload)`、`progressMessage({...})`。

> **约定**：任何新消息类型都**只**在 `protocol.js` 添加，发送方与接收方一律 `import { Msg }`，禁止硬编码消息字符串。

**新增一种导出格式的步骤**（以「新增 Word 导出」为例）：

1. `protocol.js` 的 `Msg` 增加 `EXPORT_WORD_ADVANCED`。
2. `background/modules/exporters.js` 增加 `exportWordFromModel(...)`，并在 `messaging.js` 的 `EXPORT_HANDLERS` 表加一行 `[Msg.EXPORT_WORD_ADVANCED]: ...`。
3. `sidepanel.js` 的 `EXPORT_ACTIONS` 加一项指向对应 `runExportTask` 配置。

无需改动协议以外的任何文件——这是「魔法字符串」痛点被消除后的直接收益。

### 3.3 目录职责

```
src/
  manifest.json                扩展清单（路径与构建产物对齐，无需改写）
  lib/                         纯函数 / 平台适配（会被模块脚本与经典脚本共享、内联）
    protocol.js                消息协议（见 §3.2）
    message.js / tab.js        chrome.runtime / chrome.tabs 的 Promise 封装
    chunk.js / chunked-render.js  大消息分块与渲染页接收工厂
    filename.js / images.js / text.js / markdown.js   文件名、图片、文本、Markdown 转换
    reactive.js                极简响应式状态容器（侧边栏 UI 用）
  background/
    index.js                   Service Worker 入口：仅注册面板行为 + 消息分发
    modules/
      messaging.js             唯一消息监听入口 + EXPORT_HANDLERS 分发表
      exporters.js             各格式导出编排（html/markdown/attachments/pdf/下载）
      templates.js             HTML 文档模板（纯展示）
      render.js                渲染标签页协调 + 分块收发
      inject.js                MAIN world 注入封装（injectAndRun）
      debugger.js              CDP Page.printToPDF
      download.js              chrome.downloads 封装 + ZIP（fflate）
      progress.js              进度广播
  content.js + content/*       内容脚本：PREPARE_PDF / EXPORT_MARKDOWN 命令 + 预加载
  injected/                   MAIN world 经典脚本（禁止 import/export）
    feishu-shared.js           window.__feishu 共享工具命名空间
    extract-html.js            块模型 → HTML（领域复杂，单文件保持稳定）
    extract-attachments.js / count-images.js
  render/                      md-render / pdf-render 渲染标签页
  sidepanel/                   侧边栏 UI（sidepanel.html / .js / .css）
```

---

## 4. 构建约束（唯一的「魔法」文件）

`vite.config.js` 内含两个自定义插件，这是「用 Vite 管理构建、但不引入 `@crxjs`」这一 deliberate 选型下的必要方案：

- **`copyExtensionAssets`**：把 `manifest.json`、图标、vendor 复制到 `dist`，并对 HTML 剥离 `crossorigin` / 模块预加载，规避个别 Chrome 版本对扩展内模块脚本的同源告警。
- **`inlineClassicLibs`**：把 `src/content.js` 及其 `./content/*` 子模块中的 `import` **就地展开**为源码，并把 `turndown` 等 npm 包用 IIFE 包一层内联，使产物成为**自包含经典脚本**（MV3 内容脚本 / 注入脚本不允许 ESM `import`/`export`）。

> ⚠️ 该插件依赖**正则**做源码变换；若插件失效，会静默地让产物重新出现 `import`，导致经典脚本环境报错。
> **不要在该插件之外再写依赖其内联行为的模块**；新增内容脚本侧共享逻辑时，优先放进 `lib/`（会被自动内联），而非另起一套机制。

构建还做了以下关键设定：

- `base: "./"`：扩展以 `chrome-extension://` 协议加载，所有资源用相对路径引用。
- `entryFileNames: "[name].js"`（无哈希）：确保 manifest 中的 `service_worker` / `content_scripts` / `web_accessible_resources` 与 `getURL` 路径在构建后仍成立。
- `manualChunks`：所有 `src/lib/*` 统一打成 `lib.js` 共享块，避免共享模块在多个入口间被遗漏内联。
- `minify: false`：注入脚本与 SW 必须保持单文件无 `import/export`，关闭压缩以保证产物形态可控。

---

## 5. 已知权衡（刻意保留，非疏漏）

| 现象 | 原因 | 处理 |
|------|------|------|
| `guessImageExtension` / `readBlobAsDataUrl` 在 `lib/images.js` 与 `injected/feishu-shared.js` 各有一份 | 两者分别运行在**隔离世界(ISOLATED)**与**MAIN 世界**，无法共享模块 | 接受；`feishu-shared` 是 MAIN 世界唯一可复用的形态 |
| `extract-html.js` 单文件较大、缩进不统一 | 逆向飞书私有块模型，必须挂在 `window.__feishuExtractHtml` 且零依赖 | 加分区导航注释，暂不做拆分 |
| `injected/*` 与 `content/*` 不能 import | MV3 经典脚本约束 | 共享逻辑走 `lib/`（被内联）或 `window.__feishu` 命名空间 |

---

## 6. 技术栈

- **运行时**：Chrome 扩展 MV3（Service Worker + 侧边栏 + 内容脚本 + 注入脚本）。
- **构建**：[Vite](https://vitejs.dev/) `^5.4.10`（自定义插件，未用 `@crxjs`）。
- **依赖**：
  - `fflate`：ZIP 打包（附件导出）。
  - `turndown` + `turndown-plugin-gfm`：HTML → Markdown 转换（在经典脚本中被 IIFE 内联）。

---

## 7. 后续路线图（按收益排序）

1. **拆分 `extract-html.js`** 为「按块类型」的多个纯渲染器（image / table / sheet / diagram），降低单文件认知负荷；保持零依赖、单入口不变。
2. **媒体工具去重**：把 `content/markdown.js` 里的 `readBlobAsDataUrl` / `imageSrcToDataUrl` / `canvasToDataUrl` 抽到 `lib/`（会被内容脚本内联）。
3. **协议增强**：为 `Msg` 增加运行时校验（开发期 `console.warn` 未登记类型），尽早发现拼写错误。
4. **（评估）引入 `@crxjs`**：若未来经典脚本约束成为主要负担，可迁移到 `@crxjs/vite-plugin` 彻底移除 `inlineClassicLibs` 正则魔法；当前选型为「不引入」以保持依赖最小。
