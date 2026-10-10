# 飞书批量导出助手（feishu-batch-exporter）

> Chrome MV3 扩展：在飞书文档页**批量导出** Word / PDF / Markdown / HTML / 附件。
> 版本 `0.1.5` · 构建由 Vite 管理（不依赖 `@crxjs` 等 MV3 专属插件）。

---

## 1. 功能简介

在飞书文档页面打开侧边栏，即可把当前文档一键导出为多种格式：

| 导出格式 | 说明 |
|----------|------|
| **Word** | 主干 HTML 经 `docx` 直接映射为 `.docx`（不经 Markdown），保留标题/加粗/表格/代码块/图片 |
| **PDF** | 借助 Chrome DevTools Protocol（`debugger` 权限）`Page.printToPDF` 生成 |
| **Markdown** | 通过 `turndown` + `turndown-plugin-gfm` 将文档块模型转为 Markdown |
| **HTML** | 还原飞书块模型为带样式的自包含 HTML 文档 |
| **附件** | 批量抓取文档内嵌入的图片、文件等附件，可打包为 ZIP |

支持的飞书域名：`*.feishu.cn`、`*.feishu.net`、`*.feishu.cttq.com`。

侧边栏顶部的「导出方式」下拉有 **单篇 / 批量** 两档，默认**单篇**（导出当前打开的这篇文档）；
只有切到**批量**时才会显示下方的「目录树」区块。在批量模式下点「刷新目录」读取飞书 Wiki 左侧目录树并
**多选勾选**（只读页面上已展开的部分，折叠节点的子节点未加载），勾选语义见下表。勾选后保持格式为
**Markdown**、点「批量导出」，
即可把这批文档逐篇抓下来、打包成一个 ZIP（每篇一个 `.md`，图片落在同级的
`<文档名>.assets/` 目录里，Markdown 里的图片引用已改写到该目录）；有失败或跳过的节点会额外
写一份 `导出报告.txt` 进压缩包。其余格式（Word / PDF / HTML / 附件）目前仍是单篇导出当前文档，
P2 / P3 再补。

**ZIP 里的文件夹层级只反映「你勾了什么」**，不是飞书目录树本身：没勾的父级不会凭空生成文件夹
（只勾最里层几篇 → 结果是完全扁平的，所有 `.md` 平铺在根目录，同名自动加 ` (2)` 后缀）；勾上了
父级，它才会以文件夹的形式出现在路径里（勾了 `实战项目` 和它下面的 `整理` → 只有
`实战项目/整理.md`）。见 `src/lib/batch-plan.js` 的 `selected.has(ancestor.uid)` 判断。

| 操作 | 行为 |
|---|---|
| 点行内其它位置 | 切换**这一行连同它整棵子树**；已是整支全选态再点就整体取消。叶子节点没有子项，点它就是勾自己 |
| 点某行的复选框 | 只切换**这一行自身**，不级联（想精确增删某一篇时用它） |
| 工具栏「全选」 | 勾上所有文档（叶子节点），不含父级目录 |

**勾上的「文件夹」不会作为一篇文档导出**。飞书 wiki 里每个节点本身就是一篇页面，所以「有子节点的
节点」既是文件夹、又有自己那篇正文；勾父级时两者同时成立，而用户要的只是前者——勾一个文件夹，
导出的是它下面的内容，而不是再多出一个与文件夹同名的 `.md`（纯目录页抓出来往往是空的，会在进度里
一路显示「正在导出：某文件夹」，最后报失败）。因此计划层会先把这类节点挑出来（`foldersOnly`）：
**凡是出现在某个已勾选节点的祖先链上的勾选节点，本次只承担 ZIP 里的目录层级，不再单独生成 `.md`**，
也不计入「已跳过」（不是「想导又没导成」）。反过来，只勾了它、底下什么都没勾（单独点它的复选框），
那它就是这次唯一要导的东西，照常导出——保留「父级也能单独导出」这条路径。

**「没展开的文件夹」（列表里带 ▸ 的行）不参与批量勾选**：它们在 DOM 里显示有子节点，但子节点没在
本次读取的清单里（见下文第 2 个坑），把它们算进来只会得到「看着有目录、其实是空的」的导出项。
所以点行级联时会跳过它们（`isUnloadedFolder`），「全选」也自然排除。它们自己的正文仍可导出——
点它那一行的**复选框**即可（精确操作，不走级联）；想连同里面的内容一起要，得先在飞书页面上展开、
再点一次「刷新目录」。

**为什么「全选」不带上父级目录**：见上一条——勾上的父级只会变成文件夹层级，全选时把目录一并算上
除了多出一堆文件夹、没别的作用，还容易让人误以为那些目录页的正文也被导了。所以「全选」只取叶子
文档。复选框始终只反映「这一行自身」的状态，不借用半选态去聚合整棵子树；子树里有东西被选、而这一行
自己没选时，用行底色 + 左侧竖条表达（`.partial`）。

读取侧有两个实测坑（都已处理，改代码前务必先读 `src/content/wiki-tree.js` 的文件头注释）：

1. **目录树容器不止一个**。飞书同时渲染「目录（暂无内容）」空壳
   (`.wiki-space-detail-directory-tree`) 与真正装内容的 `#SHARE_WITH_ME_ROOT`，两者是兄弟节点。
   按选择器「命中即用」会选中空壳、读出 0 条。现在改为全文档收集带 `data-node-uid` 的元素，
   按 `rootNodeId` 分组后取节点最多的那组。
2. **没有虚拟滚动，但折叠项的子节点不在 DOM 里**。折叠节点只留一个 `--collapsed` 箭头，
   子节点要点开才挂上 DOM。因此读取结果**天然只覆盖当前已展开的部分**：`readWikiTree()`
   是全文档扫描后**纯读**，不点开任何折叠节点（曾实现过「点箭头 → 重扫」的自动展开循环，
   因 React 展开时机不受控、且会改动用户在页面上的展开状态，已移除）。子节点没加载的折叠
   节点会带 `hasChildren + collapsed` 标记（侧边栏显示 `▸` 并淡化），`stats.collapsedParents`
   给出数量、`warnings` 里提示用户手动展开后重读。

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
- 响应契约：`ok(value, okKey?)` / `err(error)`。
- 异步分发：`replyAsync(sendResponse, promise, okKey?)` 固定返回 `true`。
- 构造辅助：`exportCommand(type, payload)`、`progressMessage({...})`。

> **约定**：任何新消息类型都**只**在 `protocol.js` 添加，发送方与接收方一律 `import { Msg }`，禁止硬编码消息字符串。

**目录树（批量导出）相关消息**：

- `ENUM_WIKI_TREE`：侧边栏 → **内容脚本直连**（不经 SW）。读取左侧 Wiki 目录树**当前已加载**
  的节点，同步响应 `{ ok, nodes, stats, diagnostics, warnings }`。
  `nodes` 是**扁平**数组，靠 `pos`（`data-node-pos` 解析出的索引序列）重建树形，见 `lib/tree-path.js`。
  子节点尚未加载的折叠节点带 `hasChildren + collapsed` 标记（`stats.collapsedParents` 给出数量），
  **不做自动展开**——需要那些内容时在页面上手动展开后重读。
  之所以直连：目录树是同一份 DOM，isolated world 里 `querySelectorAll` 就能读到，不需要 MAIN world 注入与 SW 中转。

- `EXPORT_BATCH_MARKDOWN`：侧边栏 → **SW**。消息体带 `plan`（见 `lib/batch-plan.js`：每篇文档
  在 ZIP 内的 `mdPath` / `assetsDir`），SW 逐篇导航 → 提取 → 转 Markdown → 汇总成一个 ZIP，
  成功响应返回 `{ ok, result: { filename, stats } }`（`stats.failures` 里带前若干条失败明细）。
  计划的路径**在侧边栏算**：目录树与勾选状态都在这边，SW 不必再理解目录树。
- `BATCH_PORT_NAME`（长连接端口名）：侧边栏在批量期间 `chrome.runtime.connect` 保持一条长连接
  并 20s 心跳。MV3 的 SW 空闲约 30s 就被回收，而「等渲染页回传」这类纯等待阶段没有任何事件，
  最容易被回收、整批就此断掉；连接存在即视为 SW 仍在工作。SW 侧只需接住它，不搬运业务数据。

**新增一种导出格式的步骤**（以「新增 Word 导出」为例，已完成，可作参照）：

1. `protocol.js` 的 `Msg` 增加 `EXPORT_WORD_ADVANCED`。
2. `background/modules/exporters.js` 增加 `exportWordFromHtml(...)`，并在 `messaging.js` 的 `EXPORT_HANDLERS` 表加一行 `[Msg.EXPORT_WORD_ADVANCED]: ...`。
3. `sidepanel.js` 的 `EXPORT_ACTIONS` 加一项指向对应 `runExportTask` 配置。

若新格式只需要在 Service Worker 内完成（如 HTML、附件），到此即可。
若需要**独立渲染页**（如 Markdown / Word，依赖 DOM 或重依赖），还需：

4. 在 `vite.config.js` 的 `rollupOptions.input` 注册新的 `render/xxx-render.html` 入口，并实现该页面（接收 `RENDER_HTML_CHUNK_*` 分片，经共享的 `createChunkedRenderHandler` 收尾）。
5. 生成型渲染页把产物序列化后经 `RENDER_RESULT_CHUNK_*` 分块回传，SW 侧用 `waitForRenderResult(requestId)` 等待——这套结果回传与格式无关，Markdown / Word 共用。

> `RENDER_RESULT_*` 与 `waitForRenderResult` 是**格式无关**的通用机制：渲染页只管把最终产物序列化成字符串切块回传，SW 负责拼装与落盘。

### 3.3 目录职责

```
src/
  manifest.json                扩展清单（路径与构建产物对齐，无需改写）
  lib/                         纯函数 / 平台适配（会被模块脚本与经典脚本共享、内联）
    protocol.js                消息协议（见 §3.2）
    message.js / tab.js        chrome.runtime / chrome.tabs 的 Promise 封装
    chunk.js / chunked-render.js  大消息分块与渲染页接收工厂
    filename.js / images.js / text.js / markdown.js   文件名、图片、文本、Markdown 转换
    tree-path.js               目录树路径工具（uid/pos 解析、pos→树、路径净化与重名消歧、目录/未展开判定与级联）
    batch-plan.js              批量导出的路径规划（勾选集合 → ZIP 内 md / assets 路径、文件夹退位成目录、重名消歧、失败报告）
    reactive.js                极简响应式状态容器（侧边栏 UI 用）
  background/
    index.js                   Service Worker 入口：面板行为 + 消息分发 + 批量保活长连接
    modules/
      messaging.js             唯一消息监听入口 + EXPORT_HANDLERS 分发表
      exporters.js             各格式导出编排（word/html/markdown/attachments/pdf/下载）+ 渲染标签页复用
      batch.js                 批量导出编排：逐篇抓取 → 汇总 ZIP → 收尾回收
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
| `word-render.js` 产物约 810 kB（gzip 167 kB） | `docx` 是完整的 OOXML 生成器，连带 `jszip` / `xml-js` 等依赖一起打包 | 仅落在 Word 渲染页，导出 Word 时才加载；**不**进入 SW / 侧边栏的 `lib.js`（故映射层放在 `render/` 而非 `lib/`，避免被 `manualChunks` 归入共享块） |
| Word 图片中 webp / svg 需光栅化 | `docx` 只接受 png/jpg/gif/bmp | 在渲染页用 canvas 转 png（顺带限制最大边长）；gif 直接透传 |
| 批量导出的文档标签页放在**独立窗口**（`focused:false`）里，收尾整窗关闭 | 复用用户当前标签页会把用户页面导航走、还污染历史；用隐藏标签页（`active:false`）会因后台节流漏渲染——飞书编辑器是虚拟列表，流程图/白板/表格必须靠 DOM+canvas 截图 | 独立窗口两头都避开，代价是导出期间会短暂出现一个不抢焦点的后台窗口 |
| 大 ZIP 经 base64 `data:` URL 下载 | Service Worker 里没有 `URL.createObjectURL`，`downloadZip` 会退化成 `data:application/zip;base64,…` | 接受；单篇导出一直如此。批量越大内存占用越高，超大批量（数百 MB 量级）需要挪到 SW 之外落盘（offscreen document 或侧边栏） |
| 批量默认跳过 `video / sheet / bitable / mindnote / slide / image` 节点 | 这些节点没有可分页的文档模型，按 Markdown 导出必然失败 | 跳过并写进 `导出报告.txt`；`unknown` / `other`（图标没认出来）**不跳过**——很可能就是普通文档，宁可试一次 |

---

## 6. 技术栈

- **运行时**：Chrome 扩展 MV3（Service Worker + 侧边栏 + 内容脚本 + 注入脚本）。
- **构建**：[Vite](https://vitejs.dev/) `^5.4.10`（自定义插件，未用 `@crxjs`）。
- **依赖**：
  - `fflate`：ZIP 打包（附件导出）与 ZIP 解包（测试校验）。
  - `turndown` + `turndown-plugin-gfm`：HTML → Markdown 转换（在经典脚本中被 IIFE 内联）。
  - `docx`：生成 `.docx`（Word 分支，仅在 `word-render` 渲染页加载，不影响 SW / 侧边栏体积）。

---

## 7. 后续路线图（按收益排序）

0. **批量导出（进行中）**：
   - ✅ P0 完整目录读取 + 侧边栏多选勾选（复选框只切自身、点行级联整支含目录自身、全选只选文档，
     ▸ 未展开的文件夹不参与批量勾选）。
   - ✅ P1 Markdown 批量 + ZIP：勾选清单打包成一个 ZIP（含图片与失败报告），
     ZIP 内的文件夹层级只由「勾选」决定（未勾的父级不产生 folder，勾上的父级只作目录、不单独成文），
     SW 侧长连接保活（`BATCH_PORT_NAME`）。
   - P2 批量补 HTML / Word（复用现有渲染页，路径规划与编排层可直接沿用）。
   - P3 批量补 PDF / 附件，以及**取消**与**断点续传**：`exportBatchMarkdown` 已预留
     `shouldStop` 钩子，中断信息（已完成的路径清单）可落 `chrome.storage` 供续传。
1. **拆分 `extract-html.js`** 为「按块类型」的多个纯渲染器（image / table / sheet / diagram），降低单文件认知负荷；保持零依赖、单入口不变。
2. **媒体工具去重**：把 `content/markdown.js` 里的 `readBlobAsDataUrl` / `imageSrcToDataUrl` / `canvasToDataUrl` 抽到 `lib/`（会被内容脚本内联）。
3. **协议增强**：为 `Msg` 增加运行时校验（开发期 `console.warn` 未登记类型），尽早发现拼写错误。
4. **（评估）引入 `@crxjs`**：若未来经典脚本约束成为主要负担，可迁移到 `@crxjs/vite-plugin` 彻底移除 `inlineClassicLibs` 正则魔法；当前选型为「不引入」以保持依赖最小。
