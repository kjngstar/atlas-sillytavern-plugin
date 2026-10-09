/**
 * atlas-world-feed-cursor.ts — M5-05：稳定且隔离的分页游标（02 §7.3 / E08/E09）。
 *
 * 三条硬规则：
 * 1. **浏览器安全**：不依赖 `Buffer` / `atob` / `btoa`，base64url 与 UTF-8 都自己实现，
 *    同一份代码在 Node 与 iframe 里得到逐字节相同的结果。
 * 2. **严格形状**：版本、字段类型、长度、身份（branch/viewMode/povId/filterHash）全部校验；
 *    形状不对报 VIEW_CURSOR_INVALID，身份或修订变了报 VIEW_CURSOR_STALE。
 *    **坏游标绝不能悄悄回到第一页**——那会把旧页拼到新聊天上。
 * 3. **排序固定**：occurredAtS DESC → committedRevision DESC → id ASC。
 *    同一故事时刻的多轮短对话靠 committedRevision 稳定区分，不丢不重。
 *    游标只携带数据值，绝不参与拼 SQL 标识符。
 *
 * 只读纯函数：不写库、不发请求。
 */

import { stableHexHash } from './atlas-hash.ts';
import type { FeedCursor, FeedFilter, WorldFeedItem } from './atlas-world-contract.ts';

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_LOOKUP: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (let i = 0; i < B64_ALPHABET.length; i += 1) map.set(B64_ALPHABET[i], i);
  return map;
})();

/** 游标字符串硬上限：超过一律当作非法，避免把远端 JSON 当数据结构用。 */
export const FEED_CURSOR_MAX_CHARS = 4096;
const MAX_ID_CHARS = 200;
const MAX_HASH_CHARS = 64;

/** base64url（无 padding）编码；纯 JS，不依赖 Buffer。 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (has1) out += B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (has2) out += B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** base64url（无 padding）解码；非法字符 / 非法长度返回 null。 */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (typeof text !== 'string') return null;
  if (text.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const value = B64_LOOKUP.get(ch);
    if (value === undefined) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(bytes);
}

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 过滤条件的稳定指纹：同一组筛选永远得到同一个值，顺序不同不影响。 */
export function feedFilterHash(filter?: FeedFilter | null): string {
  const keys = ['category', 'mapId', 'entityId', 'currentTurnOnly'] as const;
  const parts: string[] = [];
  for (const key of keys) {
    const value = filter?.[key];
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${String(value)}`);
  }
  return stableHexHash(parts.join('&')).slice(0, 32);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const shortString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

const CURSOR_KEYS = new Set(['version', 'branchId', 'revision', 'viewMode', 'povId', 'filterHash', 'after', 'scanAfterTurnId']);

/** 严格解析：任何越界、未知字段、类型不符都返回 null（由调用方报 VIEW_CURSOR_INVALID）。 */
export function parseFeedCursor(text: unknown): FeedCursor | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > FEED_CURSOR_MAX_CHARS) return null;
  const bytes = decodeBase64Url(text);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(bytes));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  for (const key of Object.keys(parsed)) if (!CURSOR_KEYS.has(key)) return null;
  if (parsed.version !== 1) return null;
  if (!shortString(parsed.branchId, 128)) return null;
  if (!Number.isInteger(parsed.revision) || (parsed.revision as number) < 0) return null;
  if (parsed.viewMode !== 'pov' && parsed.viewMode !== 'author') return null;
  if (!(parsed.povId === null || shortString(parsed.povId, 128))) return null;
  if (!shortString(parsed.filterHash, MAX_HASH_CHARS)) return null;
  if (!(parsed.scanAfterTurnId === null || parsed.scanAfterTurnId === undefined || shortString(parsed.scanAfterTurnId, MAX_ID_CHARS))) return null;
  let after: FeedCursor['after'] = null;
  if (parsed.after !== null && parsed.after !== undefined) {
    const raw = parsed.after;
    if (!isPlainObject(raw)) return null;
    const keys = Object.keys(raw);
    if (!keys.every((k) => k === 'occurredAtS' || k === 'committedRevision' || k === 'id')) return null;
    if (typeof raw.occurredAtS !== 'number' || !Number.isFinite(raw.occurredAtS)) return null;
    if (!Number.isInteger(raw.committedRevision) || (raw.committedRevision as number) < 0) return null;
    if (!shortString(raw.id, MAX_ID_CHARS)) return null;
    after = { occurredAtS: raw.occurredAtS, committedRevision: raw.committedRevision as number, id: raw.id };
  }
  return {
    version: 1,
    branchId: parsed.branchId,
    revision: parsed.revision as number,
    viewMode: parsed.viewMode,
    povId: (parsed.povId ?? null) as string | null,
    filterHash: parsed.filterHash,
    after,
    scanAfterTurnId: (parsed.scanAfterTurnId ?? null) as string | null,
  };
}

/** 编码：字段顺序固定，保证同一游标得到同一字符串（便于断言与去重）。 */
export function encodeFeedCursor(cursor: FeedCursor): string {
  const payload = {
    version: 1,
    branchId: cursor.branchId,
    revision: cursor.revision,
    viewMode: cursor.viewMode,
    povId: cursor.povId ?? null,
    filterHash: cursor.filterHash,
    after: cursor.after
      ? { occurredAtS: cursor.after.occurredAtS, committedRevision: cursor.after.committedRevision, id: cursor.after.id }
      : null,
    scanAfterTurnId: cursor.scanAfterTurnId ?? null,
  };
  return encodeBase64Url(utf8Encode(JSON.stringify(payload)));
}

export type FeedCursorExpectation = {
  branchId: string;
  revision: number;
  viewMode: FeedCursor['viewMode'];
  povId: string | null;
  filterHash: string;
};

export type FeedCursorValidation =
  | { ok: true; cursor: FeedCursor }
  | { ok: false; code: 'VIEW_CURSOR_INVALID' | 'VIEW_CURSOR_STALE'; message: string };

/**
 * E09：形状 → 身份 → 修订，逐层校验。
 * 形状坏了是 VIEW_CURSOR_INVALID；身份/修订变了是 VIEW_CURSOR_STALE。两者都不能悄悄回第一页。
 */
export function validateFeedCursor(raw: unknown, expected: FeedCursorExpectation): FeedCursorValidation {
  const cursor = parseFeedCursor(raw);
  if (!cursor) {
    return { ok: false, code: 'VIEW_CURSOR_INVALID', message: '游标不可解析或形状非法；请从第一页重新读取' };
  }
  if (cursor.branchId !== expected.branchId
    || cursor.viewMode !== expected.viewMode
    || (cursor.povId ?? null) !== (expected.povId ?? null)
    || cursor.filterHash !== expected.filterHash) {
    return { ok: false, code: 'VIEW_CURSOR_STALE', message: '分支、视角或筛选条件已改变，旧页不能拼到新结果上' };
  }
  if (cursor.revision !== expected.revision) {
    return { ok: false, code: 'VIEW_CURSOR_STALE', message: '修订已变化，请重新读取第一页' };
  }
  return { ok: true, cursor };
}

/** 固定排序：时间倒序 → 提交修订倒序 → id 正序。 */
export function compareFeedItems(a: WorldFeedItem, b: WorldFeedItem): number {
  if (a.occurredAtS !== b.occurredAtS) return b.occurredAtS - a.occurredAtS;
  if (a.committedRevision !== b.committedRevision) return b.committedRevision - a.committedRevision;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** E08：同一故事时刻的多轮靠 committedRevision 稳定区分；数组长度绝不参与「最新」判定。 */
export function sortFeedItems(items: readonly WorldFeedItem[]): WorldFeedItem[] {
  return [...items].sort(compareFeedItems);
}

/** 严格「在此项之后」：三元组完全匹配才跳过，避免同 id 不同轮被误当已读。 */
export function isAfterCursor(item: WorldFeedItem, after: FeedCursor['after']): boolean {
  if (!after) return true;
  if (item.occurredAtS < after.occurredAtS) return true;
  if (item.occurredAtS > after.occurredAtS) return false;
  if (item.committedRevision < after.committedRevision) return true;
  if (item.committedRevision > after.committedRevision) return false;
  return item.id > after.id;
}

/** 把一项折成游标锚点（三元组就是排序键，翻页时按它继续）。 */
export function cursorAnchorOf(item: WorldFeedItem): FeedCursor['after'] {
  return { occurredAtS: item.occurredAtS, committedRevision: item.committedRevision, id: item.id };
}

/** 该回合序号之后的回合（用于 currentTurnOnly / 左栏「本轮故事」）。 */
export function itemsForTurn(items: readonly WorldFeedItem[], turnId: string | null): WorldFeedItem[] {
  if (!turnId) return [];
  return items.filter((item) => item.turnId === turnId);
}
