/**
 * atlas-hash.ts — 跨平台稳定哈希（浏览器 + Node 都能同步调用）。
 *
 * 为什么不用 `node:crypto`：解析器要给每个操作分配稳定 opId，而解析器同时进浏览器产物
 * （`atlas-sql.mjs` / `atlas-ui-core.mjs`），esbuild 无法解析 `node:crypto`。
 * 这里优先用宿主已有的 `node:crypto`（Node 测试与服务器路径得到真 sha256），
 * 没有时退回**确定性**的纯 JS 混合哈希——用途只是「同一段文本得到同一个 ID」，
 * 不是签名或密码学证明。真正需要 sha256 的地方（存档信封）走 `atlas-db-envelope.ts` 的
 * WebCrypto/Node 异步实现。
 */

type NodeCrypto = {
  createHash(alg: string): { update(data: unknown): { digest(enc: string): string } };
};

let nodeCrypto: NodeCrypto | null | undefined;

function getNodeCrypto(): NodeCrypto | null {
  if (nodeCrypto !== undefined) return nodeCrypto;
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (name: string) => unknown } }).process;
    if (proc && typeof proc.getBuiltinModule === 'function') {
      const mod = proc.getBuiltinModule('node:crypto') as NodeCrypto | undefined;
      nodeCrypto = mod && typeof mod.createHash === 'function' ? mod : null;
      return nodeCrypto;
    }
  } catch {
    /* 浏览器/受限环境：走纯 JS 实现 */
  }
  nodeCrypto = null;
  return nodeCrypto;
}

function pureHash(text: string): string {
  // FNV-1a 与 djb2 双通道，各出 128 位十六进制（够长、够稳、无随机性）。
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ c, 0x85ebca6b) >>> 0) + c;
    h3 = Math.imul(h3 ^ c, 0xc2b2ae35) >>> 0;
    h4 = (h4 ^ (c + i)) >>> 0;
    h4 = Math.imul(h4, 0x27d4eb2f) >>> 0;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `${hex(h1)}${hex(h2)}${hex(h3)}${hex(h4)}`;
}

/** 稳定十六进制哈希。同一环境内对同一文本永远返回同一值。 */
export function stableHexHash(text: string): string {
  const crypto = getNodeCrypto();
  if (crypto) return crypto.createHash('sha256').update(text).digest('hex');
  return pureHash(text);
}

/** 环境能力：true 表示返回的是真 sha256（Node / 有 node:crypto 的宿主）。 */
export function stableHexHashIsSha256(): boolean {
  return getNodeCrypto() !== null;
}

/** 测试辅助：重置探测结果。 */
export function resetHashProviderForTests(): void {
  nodeCrypto = undefined;
}
