// 批量导出计划 —— 把「目录树里勾选的节点」换算成 ZIP 内的相对路径。
//
// 纯函数、零 DOM、零副作用：输入是 flattenTree 出来的有序节点数组 + 勾选的 uid 集合，
// 输出是每篇文档要落到的 md 路径、图片目录，以及被跳过的节点清单。这样批量编排
// （background/modules/batch.js）只管跑流程，路径这层可以在 Node 下单独跑用例。
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
export const NON_DOCUMENT_KINDS = new Set([
  "video",
  "image",
  "sheet",
  "bitable",
  "mindnote",
  "slide"
]);

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

  // 在作用域内取一个不冲突的名字；重名时追加 " (2)"、" (3)"…（与 tree-path 的
  // dedupeSiblings 同一套编号，避免同一棵树里出现两种消歧风格）。
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
// @returns {{ items: Array, skipped: Array, stats: object }}
//   items[]: { uid, wikiToken, title, url, kind, dir, baseName, mdPath, assetsDir,
//              assetsLeaf, depth, pathTitles }
//   skipped[]: { uid, title, kind, reason }
export function buildBatchPlan(nodes, selectedUids, options = {}) {
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
  // 一张表同时服务两种角色：既是某个子节点的目录段，又是它自己的文档名。飞书 wiki
  // 里每个节点本身就是一篇页面（有子节点的节点照样有正文），全选时两种情况会同时
  // 发生——分成两张表的话，同一个节点会被分配出「整理」和「整理 (2)」两个名字，
  // 目录与文件就对不上了。
  const nameByUid = new Map();

  const items = [];
  const skipped = [];

  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || !node.uid || !selected.has(node.uid)) {
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
        reason: `类型 ${node.kind} 不是文档，无法按 Markdown 导出`
      });
      continue;
    }

    // 逐级铺出目录段。scopeKey 用「已确定的段序列」拼成，天然区分不同父目录；
    // 段名按祖先 uid 缓存，同一父目录下的多个子节点不会各自消歧出不同名字。
    const segments = [];
    let scopeKey = "";
    for (const ancestor of node.ancestors || []) {
      let segment = nameByUid.get(ancestor.uid);
      if (!segment) {
        segment = allocate(scopeKey, sanitizePathSegment(ancestor.title));
        nameByUid.set(ancestor.uid, segment);
      }
      segments.push(segment);
      scopeKey = scopeKey ? `${scopeKey}/${segment}` : segment;
    }
    const dir = segments.join("/");

    let baseName = nameByUid.get(node.uid);
    if (!baseName) {
      baseName = allocate(scopeKey, sanitizePathSegment(node.title));
      nameByUid.set(node.uid, baseName);
    }
    const mdPath = dir ? `${dir}/${baseName}.md` : `${baseName}.md`;
    const assetsLeaf = `${baseName}.assets`;
    // 占住「本篇文档」在同层要用的两个名字，避免后续节点恰好命名为 `X.md` / `X.assets`
    // 而互相覆盖。占不到（极罕见）也不影响正确性，只是少了这层额外保护。
    reserve(scopeKey, `${baseName}.md`);
    reserve(scopeKey, assetsLeaf);

    const pathTitles = (node.ancestors || []).map((item) => item.title || "");
    pathTitles.push(node.title || "");

    items.push({
      uid: node.uid,
      wikiToken: node.wikiToken,
      title: node.title || "未命名文档",
      url: node.url || "",
      kind: node.kind || "",
      dir,
      baseName,
      mdPath,
      assetsDir: dir ? `${dir}/${assetsLeaf}` : assetsLeaf,
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
