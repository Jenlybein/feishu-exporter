// 飞书 Wiki 目录树的路径工具 —— 纯函数、零 DOM 依赖、零副作用，便于在 Node 下单测。
//
// 数据来源是目录树节点的两个 DOM 属性：
//   data-node-uid = "firstLevelWikiToken=…&level=2&rootNodeId=…&wikiToken=XXX"
//   data-node-pos = "0,0,3,5,2,1"
//
// data-node-pos 是「从根到本节点的索引序列」：父节点的 pos 恒为其去掉末项的前缀。
// 因此即便采集到的是散乱、乱序、跨轮次合并的一堆节点，也能凭 pos 无损重建目录树，
// 不依赖父子节点在 DOM 里同时可见（虚拟滚动下它们经常不同时可见）。
//
// 批量导出时文档要落到 ZIP 的相对路径上，本模块同时提供路径段净化与
// 同层重名消歧，避免解压时被互相覆盖。

import { sanitizeFilename } from "./filename.js";

const UID_FIELD_ALIASES = {
  firstLevelWikiToken: ["firstLevelWikiToken", "first_level_wiki_token"],
  level: ["level"],
  rootNodeId: ["rootNodeId", "root_node_id"],
  wikiToken: ["wikiToken", "wiki_token", "token"]
};

// 解析 data-node-uid。形如 query string（可能带前导 "?"），逐字段取值。
// 解析失败时返回全空字段而不是抛错——调用方靠 wikiToken 是否为空来判断节点可用性。
export function parseNodeUid(uid) {
  const result = {
    firstLevelWikiToken: "",
    level: "",
    rootNodeId: "",
    wikiToken: "",
    raw: uid == null ? "" : String(uid)
  };
  const text = result.raw.trim();
  if (!text) {
    return result;
  }

  const query = text.startsWith("?") ? text.slice(1) : text;
  for (const pair of query.split("&")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    let key = "";
    let value = "";
    try {
      key = decodeURIComponent(pair.slice(0, separator));
      value = decodeURIComponent(pair.slice(separator + 1));
    } catch (error) {
      continue;
    }
    for (const [field, aliases] of Object.entries(UID_FIELD_ALIASES)) {
      if (aliases.includes(key) && !result[field]) {
        result[field] = value;
      }
    }
  }

  // 兜底：uid 未按 query string 编码时，退化成「取最后一段」——飞书个别入口
  // 直接把 wikiToken 当作 uid（无 & 分隔符）。
  if (!result.wikiToken && !query.includes("&") && !query.includes("=")) {
    result.wikiToken = query;
  }
  return result;
}

// 解析 data-node-pos："0,0,3,5,2,1" -> [0,0,3,5,2,1]。支持数组直传。
export function parseNodePos(pos) {
  const toNumbers = (list) =>
    list
      .map((item) => Number(String(item).trim()))
      .filter((value) => Number.isInteger(value) && value >= 0);

  if (Array.isArray(pos)) {
    return toNumbers(pos);
  }
  const text = pos == null ? "" : String(pos).trim();
  if (!text) {
    return [];
  }
  return toNumbers(text.split(/[,;|/\s]+/).filter((part) => part !== ""));
}

// pos 序列拼成 Map 键，用于「按 pos 找节点」。
export function posKey(pos) {
  return Array.isArray(pos) ? pos.join(",") : String(pos || "");
}

// 深度：pos 长度 - 1（根为 0）；pos 缺失时返回 -1，表示「未知层级」。
export function nodeDepth(pos) {
  return Array.isArray(pos) && pos.length > 0 ? pos.length - 1 : -1;
}

// child 的 pos 是否落在 ancestor 子树内（含自身）。
// 空 ancestor 视为「没有限定范围」，返回 false —— 让调用方必须显式给出范围，
// 避免 filter 时因漏传参数而把整棵树都当成某节点的子树。
export function isPosWithin(pos, ancestor) {
  if (!Array.isArray(pos) || !Array.isArray(ancestor) || ancestor.length === 0) {
    return false;
  }
  if (ancestor.length > pos.length) {
    return false;
  }
  for (let index = 0; index < ancestor.length; index += 1) {
    if (pos[index] !== ancestor[index]) {
      return false;
    }
  }
  return true;
}

// 逐项字典序比较 pos：先到先小的在前，短前缀在前。
export function comparePos(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
}

// 用 pos 把扁平节点数组重建成目录树。
//
// 找不到父节点的节点会被提升为根（虚拟滚动漏采父节点时的容错），并在
// `orphans` 里记名，便于上层提示「本次采集不完整」。
//
// @returns {{ roots: Array, byPos: Map, byUid: Map, orphans: Array, total: number }}
export function buildTree(nodes) {
  const byPos = new Map();
  const byUid = new Map();
  const list = [];

  for (const raw of Array.isArray(nodes) ? nodes : []) {
    if (!raw) {
      continue;
    }
    const item = { ...raw };
    item.pos = Array.isArray(item.pos) ? item.pos : parseNodePos(item.pos);
    item.depth = item.pos.length > 0 ? item.pos.length - 1 : Number(item.depth) || 0;
    item.parentPos = item.pos.length > 1 ? item.pos.slice(0, -1) : null;
    item.children = [];
    item.ancestors = [];
    list.push(item);
    if (item.pos.length > 0) {
      byPos.set(posKey(item.pos), item);
    }
    if (item.uid) {
      byUid.set(item.uid, item);
    }
  }

  list.sort((a, b) => comparePos(a.pos, b.pos));

  const roots = [];
  const orphans = [];
  for (const item of list) {
    const ancestors = [];
    let parent = null;
    let cursor = item.parentPos;
    // 逐级向上找「真实存在于本次采集结果里」的最近祖先，跳过被漏采的中间层。
    while (cursor && cursor.length > 0) {
      const candidate = byPos.get(posKey(cursor));
      if (candidate) {
        parent = candidate;
        break;
      }
      cursor = cursor.length > 1 ? cursor.slice(0, -1) : null;
    }
    if (parent) {
      parent.children.push(item);
    } else if (item.pos.length > 1) {
      // 有父路径但父节点没采到：挂到根并记名，属于采集不完整的信号。
      orphans.push(item);
      roots.push(item);
    } else {
      roots.push(item);
    }

    // 祖先链：根 -> … -> 直接父节点，供路径拼接使用。
    let walk = parent;
    while (walk) {
      ancestors.unshift(walk);
      walk = byPos.get(posKey(walk.parentPos)) || null;
    }
    item.ancestors = ancestors;
  }

  return { roots, byPos, byUid, orphans, total: list.length };
}

// 前序展开树，附 depth / path（根到自身的标题数组）。
export function flattenTree(roots) {
  const out = [];
  const visit = (node) => {
    out.push(node);
    for (const child of node.children || []) {
      visit(child);
    }
  };
  for (const root of Array.isArray(roots) ? roots : []) {
    visit(root);
  }
  return out;
}

// 收集「节点自身 + 全部后代」的 uid（前序）。
//
// 两处用途，语义一致（用户 2026-10-11 定稿）：
//   1. 级联勾选——点一行 = 勾上它连同整棵子树（目录自己也在这支里，不排除）；
//   2. 渲染——判断该行「整支被选到什么程度」，用于行高亮。
// uid 为空的节点跳过（无法参与导出）。
export function collectSubtreeUids(node) {
  const out = [];
  const visit = (item) => {
    if (!item) {
      return;
    }
    if (item.uid) {
      out.push(item.uid);
    }
    for (const child of item.children || []) {
      visit(child);
    }
  };
  visit(node);
  return out;
}

// 是不是「目录节点」——即带子节点的节点。
//
// 飞书 wiki 里每个节点本身都有正文，所以「目录」只是使用者的心智模型：对用户来说，
// 有子节点的行就是文件夹。判定同时看两个来源：DOM 里箭头是否有 icon（hasChildren），
// 以及 pos 重建后是否真挂上了子节点——只要有一个成立就按目录处理，避免箭头识别失败
// 时把一整个子树误当成叶子文档。
//
// 注意：这里只用来区分「文件夹行 / 文档行」的观感与「全选」的取数范围，
// **不再**用来把目录排除在勾选之外——用户明确要求目录自己也随级联被选中。
export function isFolderNode(node) {
  if (!node) {
    return false;
  }
  return node.hasChildren === true || (Array.isArray(node.children) && node.children.length > 0);
}

// 「没展开的文件夹」——DOM 里它显示有子节点（箭头带 --has-icon），但子节点没出现在
// 本次读取的清单里（侧边栏里带 ▸ 标记）。
//
// 这类节点自身的正文能读，但它下面的内容本次根本没拿到，批量勾选时把它算进来
// 只会得到一份「看起来有目录、实际是空的」结果。用户 2026-10-11 要求：批量全选时
// 跳过它们，想单独要这一篇就点它自己的复选框（那是精确操作，不在级联范围里）。
export function isUnloadedFolder(node) {
  if (!node || node.hasChildren !== true) {
    return false;
  }
  return !(Array.isArray(node.children) && node.children.length > 0);
}

// 判断某节点相对选择集的勾选状态，用于渲染复选框的三态：
//   "checked"        自身与全部后代都被选中
//   "indeterminate"  只选中了一部分（含「自身没选、但后代有选」）
//   "unchecked"      整棵子树都没选
//
// uids 可显式传入（调用方若已缓存子树 uid 列表，避免重复遍历整棵子树）。
export function selectionStateOf(node, selected, uids) {
  const list = Array.isArray(uids) ? uids : collectSubtreeUids(node);
  if (list.length === 0) {
    return "unchecked";
  }
  let hit = 0;
  for (const uid of list) {
    if (selected.has(uid)) {
      hit += 1;
    }
  }
  if (hit === 0) {
    return "unchecked";
  }
  return hit === list.length ? "checked" : "indeterminate";
}

// 计算「把指定的一批 uid 全部勾上/取消」之后的新选择集。入参 selected 为 Set，
// 不改动它（纯函数），返回新 Set，便于侧边栏把它提升为新的响应式状态。
//
// 侧边栏有两种用法，都靠显式传入 uid 列表复用它：
//   点复选框 -> [该行自己的 uid]（精准切一行，用于单独增删某一篇）
//   点行     -> collectSubtreeUids(node)（级联它连同整棵子树）
export function applyCheckedToUids(selected, uids, checked) {
  const next = new Set(selected);
  for (const uid of Array.isArray(uids) ? uids : []) {
    if (!uid) {
      continue;
    }
    if (checked) {
      next.add(uid);
    } else {
      next.delete(uid);
    }
  }
  return next;
}

// 根到指定节点的标题路径（不含自身时传 includeSelf=false）。
export function pathTitles(node, includeSelf = true) {
  if (!node) {
    return [];
  }
  const titles = (node.ancestors || []).map((item) => item.title || "");
  if (includeSelf) {
    titles.push(node.title || "");
  }
  return titles;
}

// 路径段净化：直接复用导出文件名的净化规则（NFKC、非法字符、保留名、长度上限），
// 保证 ZIP 内目录名与文件名同一套规则，Windows 解压不会炸。
export function sanitizePathSegment(name) {
  return sanitizeFilename(name, "未命名文档");
}

// 同层重名消歧：保留首个原名，后续追加 " (2)"、"(3)"…。入参可为节点数组或字符串数组，
// 返回同形状的重名计数表 key -> 最终名字（不改动原数组）。
export function dedupeSiblings(items, getName = (item) => item?.title) {
  const used = new Map();
  const resolved = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const name = sanitizePathSegment(getName(item));
    const count = (used.get(name) || 0) + 1;
    used.set(name, count);
    resolved.set(item, count === 1 ? name : `${name} (${count})`);
  }
  return resolved;
}

// 由 wikiToken 拼文档 URL；host 缺省时用当前页面的 hostname。
export function documentUrlFromToken(wikiToken, host) {
  const token = String(wikiToken || "").trim();
  if (!token) {
    return "";
  }
  let resolvedHost = String(host || "").trim();
  if (!resolvedHost && typeof location !== "undefined") {
    resolvedHost = location.hostname || "";
  }
  if (!resolvedHost) {
    return `/wiki/${token}`;
  }
  return `https://${resolvedHost}/wiki/${token}`;
}
