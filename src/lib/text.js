// 零宽/控制字符清理：飞书文档常夹带不可见字符，导出文件名与正文都需要剥离。
export const INVISIBLE_TEXT_PATTERN = /[­؜᠎​-‏⁠-⁯﻿]/g;

export function stripInvisibleText(text) {
  return String(text || "").replace(INVISIBLE_TEXT_PATTERN, "");
}
