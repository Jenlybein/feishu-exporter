// 飞书 Wiki 左侧目录树的读取器（content script 子模块，构建期由 inlineClassicLibs
// 内联进 content.js）。
//
// 数据来源是每个节点的两个属性：
//   data-node-uid = "firstLevelWikiToken=…&level=2&rootNodeId=…&wikiToken=XXX"
//   data-node-pos = "0,0,3"（从根到本节点的索引序列，父子关系全靠它推导）
//
// 两个实测得到的页面事实决定了这里的实现：
//
// 1) 目录树容器不止一个。飞书会同时渲染一个「目录（暂无内容）」的空壳
//    (.wiki-space-detail-directory-tree) 和一个真正装内容的容器
//    (.wiki-space-detail-single-tree > #SHARE_WITH_ME_ROOT)，两者是兄弟节点。
//    「命中第一个选择器就用」会把空壳当成目录树，读出来必然是 0 条 —— 这正是
//    首版读不到任何东西的原因。现在改为：全文档收集带 uid 的节点，按 rootNodeId
//    分组，取节点最多的那一组，空壳自然被排除。
//
// 2) 没有虚拟滚动，但**折叠节点的子节点不在 DOM 里**。折叠项只留一个 --collapsed
//    的箭头，子节点要点开箭头才会挂上 DOM。所以「一次性读全」只对当前已展开的
//    部分成立。
//
//    本版**不做自动展开**（曾经点过箭头：React 的展开时机不受控，点完还得等渲染
//    重扫，容易点错、点乱用户的页面）。策略改为：只读当前 DOM 里已有的节点，把
//    「有子节点但子节点没加载」的节点照实标出来（侧边栏显示 ▸），并在 warnings 里
//    说明有 N 个折叠子树没读到 —— 用户想导出那些内容时，自己在页面上展开后重读。
//
//   注意判定的坑：--has-icon / --collapsed / --expanded 这几个类挂在**箭头元素**
//    (.workspace-tree-view-node-expand-arrow) 上，不在节点元素自身。首版拿节点自身
//    的 class 去匹配，hasChildren 恒为 false，于是「哪些节点还有未加载的子树」根本
//    判不出来。

import {
  comparePos,
  documentUrlFromToken,
  parseNodePos,
  parseNodeUid
} from "../lib/tree-path.js";

const NODE_UID_ATTR = "data-node-uid";
const NODE_POS_ATTR = "data-node-pos";
const NODE_LEVEL_ATTR = "data-node-level";
const NODE_CONTENT_SELECTOR = ".workspace-tree-view-node-content";
const NODE_ARROW_SELECTOR = ".workspace-tree-view-node-expand-arrow";
const NODE_ICON_SELECTOR = ".workspace-tree-view-node-icon svg[data-icon]";

// 图标 -> 文档类型。飞书用 svg 的 data-icon 区分文档 / 视频 / 表格等，
// 批量导出时要靠它跳过无法导出为文档的节点。
const KIND_BY_ICON = {
  FileLinkWordOutlined: "doc",
  FileLinkVideoOutlined: "video",
  FileLinkImageOutlined: "image",
  FileLinkSheetOutlined: "sheet",
  FileLinkBitableOutlined: "bitable",
  FileLinkMindnoteOutlined: "mindnote",
  FileLinkSlideOutlined: "slide"
};

// 与注入脚本/其它页面代码保持同一套文本归一化：去零宽字符、折叠空白。
function normalizeText(value) {
  return String(value == null ? "" : value)
    .replace(/[\u200b-\u200f\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function classOf(element) {
  return element ? String(element.className || "") : "";
}

// 全文档收集目录树节点，按 rootNodeId 分组。
//
// 不预设容器选择器：飞书的类名带 hash 后缀（styles__Xxx-abcdef），改版就失效；
// 而 data-node-uid 是数据属性，稳定得多。分组用 rootNodeId —— 页面上若同时存在
// 多棵树（如「与我分享」将来也有内容），各自的 pos 都从 0 起算，混在一起会串。
function collectNodeGroups() {
  const groups = new Map();
  let all = [];
  try {
    all = Array.from(document.querySelectorAll(`[${NODE_UID_ATTR}]`));
  } catch {
    return groups;
  }

  for (const element of all) {
    const uid = element.getAttribute(NODE_UID_ATTR);
    if (!uid) {
      continue;
    }
    // 只收「最外侧带 uid 的元素」：同一节点若内外两层都带 uid，只算一条。
    let nested = null;
    try {
      nested = element.parentElement
        ? element.parentElement.closest(`[${NODE_UID_ATTR}]`)
        : null;
    } catch {
      nested = null;
    }
    if (nested && nested !== element) {
      continue;
    }

    const fields = parseNodeUid(uid);
    const key = fields.rootNodeId || "(no-root)";
    let group = groups.get(key);
    if (!group) {
      group = new Map();
      groups.set(key, group);
    }
    if (!group.has(uid)) {
      group.set(uid, element);
    }
  }
  return groups;
}

// 取节点最多的一组 —— 空的「目录（暂无内容）」容器会自然落选。
function pickLargestGroup(groups) {
  let best = { key: "", nodes: new Map() };
  for (const [key, nodes] of groups) {
    if (nodes.size > best.nodes.size) {
      best = { key, nodes };
    }
  }
  return best;
}

// 读属性：优先取元素自身，自身没有就向下找带该属性的后代。
//
// 实测飞书把 data-node-uid / data-node-pos / data-node-level 都挂在同一个
// .workspace-tree-view-node 上，但不同入口（或后续改版）可能把 uid 留在外层
// 包裹元素上 —— 那样只读自身就会漏 pos，节点会被当成「无法还原层级」丢弃。
function readNodeAttr(element, attr) {
  const own = element.getAttribute(attr);
  if (own != null && own !== "") {
    return own;
  }
  let child = null;
  try {
    child = element.querySelector(`[${attr}]`);
  } catch {
    child = null;
  }
  return child ? child.getAttribute(attr) || "" : "";
}

// 读节点层级位置（属性可能挂在外层或内层，见 readNodeAttr）。
function readNodePos(element) {
  return parseNodePos(readNodeAttr(element, NODE_POS_ATTR));
}

// 读取单个节点元素的全部可得信息。
function readNodeElement(element, host) {
  const uid = readNodeAttr(element, NODE_UID_ATTR);
  const fields = parseNodeUid(uid);
  const pos = readNodePos(element);
  const levelAttr = readNodeAttr(element, NODE_LEVEL_ATTR);
  let level = levelAttr != null && levelAttr !== "" ? Number(levelAttr) : NaN;
  if (!Number.isFinite(level)) {
    level = pos.length > 0 ? pos.length : -1;
  }

  // 展开态/是否有子节点：看箭头元素，不看节点自身（见文件头注释）。
  const arrow = element.querySelector(NODE_ARROW_SELECTOR);
  const arrowClass = classOf(arrow);
  const hasChildren = /--has-icon|--collapsed|--expanded/.test(arrowClass);
  const collapsed = /--collapsed/.test(arrowClass);

  const icon = element.querySelector(NODE_ICON_SELECTOR);
  const iconName = icon ? icon.getAttribute("data-icon") || "" : "";

  const content = element.querySelector(NODE_CONTENT_SELECTOR);
  const title = normalizeText((content || element).textContent);

  return {
    uid,
    wikiToken: fields.wikiToken || "",
    rootNodeId: fields.rootNodeId || "",
    firstLevelWikiToken: fields.firstLevelWikiToken || "",
    pos,
    level,
    title: title || "未命名文档",
    hasChildren,
    collapsed,
    icon: iconName,
    kind: KIND_BY_ICON[iconName] || (iconName ? "other" : "unknown"),
    url: documentUrlFromToken(fields.wikiToken, host)
  };
}

// 读取飞书左侧目录树 —— 只读当前 DOM 里已经存在的节点，不做任何点击/展开。
//
// @returns {{ ok: boolean, error?: string, host?: string, title?: string,
//   nodes?: Array, stats?: object, diagnostics?: object, warnings?: string[] }}
//   nodes 为扁平数组，子节点尚未加载的折叠节点会带 hasChildren + collapsed 标记。
export function readWikiTree() {
  const started = Date.now();
  const warnings = [];
  const host = location.hostname || "";

  const groups = collectNodeGroups();
  if (groups.size === 0) {
    return {
      ok: false,
      error:
        "页面上找不到目录树节点（没有任何带 data-node-uid 的元素）。请确认左侧 Wiki 目录已展开，然后刷新页面重试。"
    };
  }

  const picked = pickLargestGroup(groups);

  const nodes = [];
  let unknownPos = 0;
  let missingToken = 0;

  for (const element of picked.nodes.values()) {
    const node = readNodeElement(element, host);
    if (!node.uid) {
      continue;
    }
    // pos 是重建目录结构的唯一依据，缺失就没法挂到树上，只能丢弃并告警。
    if (node.pos.length === 0) {
      unknownPos += 1;
      continue;
    }
    if (!node.wikiToken) {
      missingToken += 1;
      continue;
    }
    nodes.push(node);
  }

  nodes.sort((a, b) => comparePos(a.pos, b.pos));

  // 回填 hasChildren：「pos+[0] 是否在清单里」比箭头类名更可靠（同一节点在 DOM 里
  // 可能因外层包裹而读不到箭头）。子节点已在清单里的，一定是有子节点的父节点。
  const posSet = new Set(nodes.map((node) => node.pos.join(",")));
  let hiddenSubtrees = 0;
  for (const node of nodes) {
    const childLoaded = posSet.has([...node.pos, 0].join(","));
    if (childLoaded && !node.hasChildren) {
      node.hasChildren = true;
    }
    // 有子节点、但子节点没在 DOM 里 = 折叠着没加载，这次读不到。
    if (node.hasChildren && !childLoaded) {
      hiddenSubtrees += 1;
    }
  }

  if (unknownPos > 0) {
    warnings.push(`有 ${unknownPos} 个节点缺少 data-node-pos，已跳过（无法还原层级）。`);
  }
  if (missingToken > 0) {
    warnings.push(`有 ${missingToken} 个节点解析不出 wikiToken，已跳过（无法导出）。`);
  }
  if (hiddenSubtrees > 0) {
    warnings.push(
      `有 ${hiddenSubtrees} 个折叠节点的子节点未加载（列表中带 ▸ 标记），本次没有读取。` +
        "需要在飞书页面上手动展开这些节点后，再点一次「刷新目录」。"
    );
  }
  if (nodes.length === 0) {
    warnings.push("目录树里没有读到任何可用节点。");
  }

  return {
    ok: true,
    host,
    title: document.title,
    nodes,
    stats: {
      total: nodes.length,
      scanned: picked.nodes.size,
      skippedUnknownPos: unknownPos,
      skippedMissingToken: missingToken,
      collapsedParents: hiddenSubtrees,
      containers: groups.size,
      elapsedMs: Date.now() - started
    },
    diagnostics: {
      rootNodeId: picked.key,
      groups: Array.from(groups.entries()).map(([key, map]) => ({
        rootNodeId: key,
        nodes: map.size
      })),
      url: location.href
    },
    warnings
  };
}
