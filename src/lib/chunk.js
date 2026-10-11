// 大字符串分块：用于跨扩展上下文的消息传递，避免单条消息超长。
const CHUNK_MESSAGE_SIZE = 512 * 1024;

export function splitStringToChunks(text, chunkSize = CHUNK_MESSAGE_SIZE) {
  const value = String(text || "");
  if (!value) {
    return [""];
  }
  const chunks = [];
  for (let i = 0; i < value.length; i += chunkSize) {
    chunks.push(value.slice(i, i + chunkSize));
  }
  return chunks;
}
