// 批量导出计划 —— 把「目录树里勾选的节点」换算成 ZIP 内的相对路径。
//
// 纯函数、零 DOM、零副作用：输入是 flattenTree 出来的有序节点数组 + 勾选的 uid 集合，
// 输出是每篇文档要落到 ZIP 里的文件路径（Markdown 还多一个同级图片目录），以及被跳过的
// 节点清单。这样批量编排（background/modules/batch.js）只管跑流程，路径这层可以在
// Node 下单独跑用例。
//
// 为什么路径要单独算：目录树是「标题」而非「文件名」，直接拼进 ZIP 会撞三件事——
//   1) 同层重名（飞书里两个「整理」很常见）；
//   2) 标题含 \ / : * ? " < > | 等文件系统非法字符；
//   3) Windows 大小写不敏感 + 末尾点/空格会被吞。
// 这里统一走 sanitizePathSegment + 同层大小写不敏感消歧，解压时不会互相覆盖。

import { sanitizePathSegment } from "./tree-path.js";

export { sanitizePathSegment };

// 已知不是「文档」的节点类型：飞书目录树里的这些节点没有可分页的文档模型，
// 按 Markdown 导出必然失败。默认跳过并在报告里说明，避免白跑一遍才发现。
// 注意：kind 为 "unknown"（没读到图标）与 "other"（图标没在映射表里）不在此列——
// 它们很可能就是普通文档，宁可试一次也不要漏导。
const NON_DOCUMENT_KINDS = new Set([
  "video",
  "image",
  "sheet",
  "bitable",
  "mindnote",
  "slide"
]);

// 导出格式 -> 产物扩展名。批量导出按格式选渲染链路，扩展名决定 ZIP 里的文件名，
// 放在这里作为唯一来源，侧边栏与编排层都从这里取，避免两处各写一份映射。
export const FORMAT_EXTENSIONS = {
  markdown: "md",
  html: "html",
  word: "docx",
  pdf: "pdf"
};

// 把外部传入的扩展名收敛到白名单内：未知值一律退回 md。
// 扩展名会拼进 ZIP 路径，不能放任任意字符串（含 / 或 .. 会写出目录穿越式的条目）。
function normalizeExtension(value) {
  const ext = String(value || "")
    .replace(/^\./, "")
    .toLowerCase();
  return Object.values(FORMAT_EXTENSIONS).includes(ext) ? ext : "md";
}

// 同层名字分配器。
//
// 作用域（所在目录）内名字必须唯一；键统一小写 —— Windows 解压时 `A` 与 `a`
// 会指向同一个文件，只按大小写敏感判重仍会互相覆盖。
function createNameAllocator() {
  const usedByScope = new Map();

  const setOf = (scopeKey) => {
    const key = String(scopeKey || "");
    let used = usedByScope.get(key);
    if (!used) {
      used = new Set();
      usedByScope.set(key, used);
    }
    return used;
  };

  // 在作用域内取一个不冲突的名字；重名时追加 " (2)"、" (3)"…（与文件名净化同一套编号，
  // 保证目录名与文件名消歧风格一致，Windows 解压不会互相覆盖）。
  const allocate = (scopeKey, wantedName) => {
    const used = setOf(scopeKey);
    const base = wantedName || "未命名文档";
    let candidate = base;
    let index = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base} (${index})`;
      index += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  };

  // 直接占用一个名字（登记用）。已被占用时返回 false，调用方自行决定如何处理。
  const reserve = (scopeKey, name) => {
    if (!name) {
      return true;
    }
    const used = setOf(scopeKey);
    const key = String(name).toLowerCase();
    if (used.has(key)) {
      return false;
    }
    used.add(key);
    return true;
  };

  return { allocate, reserve };
}

// 由勾选集合生成批量导出计划。
//
// @param {Array}  nodes        有序节点数组（flattenTree 的输出，节点带 ancestors / pos / uid / title）
// @param {Set|Array} selectedUids 勾选的 uid
// @param {object} [options]
//   options.skipKinds    额外要跳过的 kind 集合（并入 NON_DOCUMENT_KINDS）
//   options.includeKinds 只导出这些 kind（设置后优先于 skipKinds）
//   options.extension    产物扩展名（默认 md）；决定 items[].filePath
// @returns {{ items: Array, skipped: Array, stats: object }}
//   items[]: { uid, wikiToken, title, url, kind, dir, baseName, filePath, extension,
//              assetsDir, assetsLeaf, depth, pathTitles }
//             assetsDir / assetsLeaf 仅 Markdown 有值（图片另存为同级目录）；
//             HTML / Word / PDF 的图片已内联进产物，不需要旁挂目录。
//   skipped[]: { uid, title, kind, reason }
export function buildBatchPlan(nodes, selectedUids, options = {}) {
  const extension = normalizeExtension(options.extension);
  const usesAssets = extension === "md";
  const selected =
    selectedUids instanceof Set ? selectedUids : new Set(selectedUids || []);
  const skipKinds = new Set([
    ...NON_DOCUMENT_KINDS,
    ...(options.skipKinds ? Array.from(options.skipKinds) : [])
  ]);
  const includeKinds =
    options.includeKinds && options.includeKinds.length
      ? new Set(options.includeKinds)
      : null;

  const { allocate, reserve } = createNameAllocator();
  // 节点 uid -> 它在「所在目录」里占用的名字。
  //
  // 目录段名与文档名共用一张表：两者落在同一个作用域（所在目录）里，必须互不冲突
  // （`整理` 这个目录段与同层的 `整理.md` 不能各算各的）。按 uid 缓存段名还保证同一个
  // 父目录被多个子节点引用时只消歧一次，不会各自算出 `整理 (2)`。
  const nameByUid = new Map();

  // 「只作目录」的勾选节点 —— 本次不作为一篇文档去抓。
  //
  // 飞书 wiki 里每个节点本身就是一篇页面，所以勾父级时它同时扮演两种角色：既是下面
  // 内容的「文件夹」，也是一篇有正文的「文档」。用户要的只有前者：勾一个文件夹，导出
  // 的是它下面的内容，而不是再多出一个与文件夹同名的 .md（更糟的是，纯目录页抓出来
  // 往往是空的，会在进度里一路显示「正在导出：某文件夹」最后报失败）。
  //
  // 判定「它这次是不是只当目录」= 它下面还有勾中的内容，即它出现在某个已勾选节点的
  // 祖先链上。这样的节点只承担 ZIP 里的目录层级。
  // 反过来，只勾了它、底下什么都没有勾（单独点它的复选框），那它就是这次唯一要导的
  // 东西，照常导出——保留「父级也能单独导出」这条路径。
  const foldersOnly = new Set();
  const allNodes = Array.isArray(nodes) ? nodes : [];
  for (const node of allNodes) {
    if (!node || !node.uid || !selected.has(node.uid)) {
      continue;
    }
    for (const ancestor of node.ancestors || []) {
      if (ancestor && ancestor.uid && selected.has(ancestor.uid)) {
        foldersOnly.add(ancestor.uid);
      }
    }
  }

  const items = [];
  const skipped = [];

  for (const node of allNodes) {
    if (!node || !node.uid || !selected.has(node.uid)) {
      continue;
    }
    // 只作目录：ZIP 里它会作为下属文档的路径前缀出现（见下面的祖先循环），但不再
    // 生成自己的 .md。不计入 skipped —— 用户并没有「想导又没导成」，那会让报告里
    // 平白多出一批「已跳过」。
    if (foldersOnly.has(node.uid)) {
      continue;
    }
    if (!node.wikiToken) {
      skipped.push({
        uid: node.uid,
        title: node.title || "",
        kind: node.kind || "",
        reason: "缺少 wikiToken，无法定位文档"
      });
      continue;
    }
    if (includeKinds) {
      if (!includeKinds.has(node.kind)) {
        skipped.push({
          uid: node.uid,
          title: node.title || "",
          kind: node.kind || "",
          reason: `类型 ${node.kind || "未知"} 不在本次导出范围内`
        });
        continue;
      }
    } else if (node.kind && skipKinds.has(node.kind)) {
      skipped.push({
        uid: node.uid,
        title: node.title || "",
        kind: node.kind,
        reason: `类型 ${node.kind} 不是文档，无法导出`
      });
      continue;
    }

    // 逐级铺出目录段：**只有本次也被勾选的祖先**才作为文件夹出现在 ZIP 里。
    //
    // 用户明确要求：没勾上的父级不要把文件夹层级带进来（「还是把全部父级文件夹都
    // 带上了，即使我没选上」）。所以只勾叶子文档时结果是**完全扁平**的；勾上了父级
    // 它才会以文件夹的形式出现在路径里——层级反映的是你的勾选，而不是飞书的目录树
    // 本身。注意「勾上父级」在这里的作用正是「把它变成文件夹」：它自己不再作为一篇
    // 文档导出（见上面的 foldersOnly），只留下这个目录层级。
    //
    // scopeKey 用「已确定的段序列」拼成，天然区分不同父目录；段名按祖先 uid 缓存，
    // 同一父目录下的多个子节点不会各自消歧出不同名字。
    const segments = [];
    const segmentTitles = [];
    let scopeKey = "";
    for (const ancestor of node.ancestors || []) {
      if (!selected.has(ancestor.uid)) {
        continue;
      }
      let segment = nameByUid.get(ancestor.uid);
      if (!segment) {
        segment = allocate(scopeKey, sanitizePathSegment(ancestor.title));
        nameByUid.set(ancestor.uid, segment);
      }
      segments.push(segment);
      segmentTitles.push(ancestor.title || "");
      scopeKey = scopeKey ? `${scopeKey}/${segment}` : segment;
    }
    const dir = segments.join("/");

    let baseName = nameByUid.get(node.uid);
    if (!baseName) {
      baseName = allocate(scopeKey, sanitizePathSegment(node.title));
      nameByUid.set(node.uid, baseName);
    }
    const filePath = dir ? `${dir}/${baseName}.${extension}` : `${baseName}.${extension}`;
    const assetsLeaf = usesAssets ? `${baseName}.assets` : "";
    // 占住「本篇文档」在同层要用的名字，避免后续节点恰好命名为 `X.md` / `X.assets`
    // 而互相覆盖。占不到（极罕见）也不影响正确性，只是少了这层额外保护。
    reserve(scopeKey, `${baseName}.${extension}`);
    if (assetsLeaf) {
      reserve(scopeKey, assetsLeaf);
    }

    // 与 dir 保持一致：只含「被勾选的祖先 + 自身」。ZIP 基名取 pathTitles[0]，
    // 只勾一篇时它就等于这篇的标题。
    const pathTitles = segmentTitles.concat([node.title || "未命名文档"]);

    items.push({
      uid: node.uid,
      wikiToken: node.wikiToken,
      title: node.title || "未命名文档",
      url: node.url || "",
      kind: node.kind || "",
      dir,
      baseName,
      filePath,
      extension,
      assetsDir: assetsLeaf ? (dir ? `${dir}/${assetsLeaf}` : assetsLeaf) : "",
      assetsLeaf,
      depth: Number(node.depth) || 0,
      pathTitles
    });
  }

  return {
    items,
    skipped,
    stats: {
      selected: selected.size,
      planned: items.length,
      skipped: skipped.length,
      // 勾选中「只作目录、未单独导出」的节点数。侧边栏用它解释「勾了 N 篇，为什么
      // 实际导出 M 篇」。
      foldersOnly: foldersOnly.size,
      folders: new Set(items.map((item) => item.dir).filter(Boolean)).size
    }
  };
}

// 把 md-render 产出的 Markdown 里的图片目录改写到「本篇文档自己的 assets 目录」。
//
// md-render 是通用渲染页、不认识批量场景，统一把图片写成 `images/xxx.png`。
// 批量打包时每篇文档各有各的图片目录（同层多篇文档若共用 `images/` 会互相覆盖），
// 而 Markdown 文件与 assets 目录同级，因此引用路径就是 `<assetsLeaf>/xxx.png`。
//
// 只改写「图片语法里的目标」，正文里恰好出现的 `](images/` 不会被误伤。
export function retargetMarkdownImages(markdown, assetsLeaf) {
  if (!markdown || !assetsLeaf) {
    return String(markdown || "");
  }
  return String(markdown).replace(
    /(!\[[^\]\n]*\]\()images\//g,
    (_match, prefix) => `${prefix}${assetsLeaf}/`
  );
}

// 生成「失败/跳过清单」文本（仅在确有失败或跳过时写进 ZIP，供用户核对）。
export function buildFailureReport({ failures, skipped, host, finishedAt }) {
  const lines = [];
  lines.push("飞书批量导出报告");
  lines.push(`导出时间：${finishedAt || new Date().toISOString()}`);
  if (host) {
    lines.push(`来源站点：${host}`);
  }
  lines.push("");

  if (failures && failures.length) {
    lines.push(`● 导出失败 ${failures.length} 篇`);
    failures.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.path || item.title || item.uid}`);
      lines.push(`   原因：${item.reason || "未知错误"}`);
    });
    lines.push("");
  }

  if (skipped && skipped.length) {
    lines.push(`● 已跳过 ${skipped.length} 篇`);
    skipped.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title || item.uid}（${item.kind || "未知类型"}）`);
      lines.push(`   原因：${item.reason || "未说明"}`);
    });
    lines.push("");
  }

  lines.push("以上条目未包含在本次导出的文件中。");
  return lines.join("\n");
}
