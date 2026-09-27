/**
 * atlas-db-envelope.ts — §7.1 chatMetadata.atlas.database 存档信封（B10 / B11）。
 *
 * 首版固定 sqlite-base64；gzip 只保留接口与显式错误（不假装已实现压缩）。
 * 任何解码失败都必须保留原数据并报错，**绝不触发自动建空世界**。
 */

import { stableHexHash } from './atlas-hash.ts';
import { ATLAS_SCHEMA_VERSION } from './atlas-db-schema.ts';
import type { AtlasAssetRef, AtlasEnvelope } from './atlas-db-contract.ts';
import { AtlasDbError } from './atlas-db-runtime.ts';

export type SnapshotIdentity = {
  chatUid: string;
  worldUid: string;
  storageRevision: number;
  activeBranchId: string;
  schemaVersion?: number;
  assets?: AtlasAssetRef[];
};

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function hasBuffer(): boolean {
  return typeof (globalThis as { Buffer?: unknown }).Buffer !== 'undefined';
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (hasBuffer()) {
    const B = (globalThis as { Buffer: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
    return B.from(bytes).toString('base64');
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

/**
 * Base64 解码。
 *
 * **必须先做严格校验再解码**：Node 的 `Buffer.from(text,'base64')` 会**静默丢弃**非法字符
 * （`"不是base64!!"` 会被解成空/短字节），于是损坏存档不会报 `ENVELOPE_BASE64_INVALID`，
 * 而是拖到后面以长度/哈希不符收场——错误码虽然仍不放过数据，但定位信息是错的（§18.4）。
 * 因此这里在两条实现路径之前统一校验字符集、填充与长度。
 */
export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    const bad = clean.split('').find((ch) => !/[A-Za-z0-9+/=]/.test(ch)) ?? '';
    throw new AtlasDbError(
      'ENVELOPE_BASE64_INVALID',
      bad
        ? `Base64 含非法字符：${bad}`
        : `Base64 长度不是 4 的倍数（${clean.length}）或填充位置非法`,
      { length: clean.length },
    );
  }
  if (hasBuffer()) {
    const B = (globalThis as { Buffer: { from(s: string, enc: string): Uint8Array } }).Buffer;
    return new Uint8Array(B.from(clean, 'base64'));
  }
  const lookup = new Map<string, number>();
  for (let i = 0; i < B64_ALPHABET.length; i += 1) lookup.set(B64_ALPHABET[i], i);
  const cleaned = clean.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of cleaned) {
    const v = lookup.get(ch);
    if (v === undefined) throw new AtlasDbError('ENVELOPE_BASE64_INVALID', `Base64 含非法字符：${ch}`, {});
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 0x0f];
  return out;
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * 同步稳定哈希：用于程序内部 ID / 幂等键（不是签名，也不是存档完整性证明）。
 * Node 下是真 sha256；浏览器退回确定性纯 JS 混合哈希（见 atlas-hash.ts）。
 * 需要密码学强度的存档完整性校验请用异步的 `sha256Hex`（WebCrypto / Node）。
 */
export function sha256HexSync(bytes: Uint8Array | string): string {
  if (typeof bytes === 'string') return stableHexHash(bytes);
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return stableHexHash(text);
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? utf8Bytes(bytes) : bytes;
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    const digestInput = new Uint8Array(data.length);
    digestInput.set(data);
    const digest = await subtle.digest('SHA-256', digestInput);
    return toHex(new Uint8Array(digest));
  }
  return sha256HexAsyncNode(data);
}

async function sha256HexAsyncNode(data: Uint8Array): Promise<string> {
  // 浏览器/受限环境没有 WebCrypto 时退回确定性同步哈希；调用方用它是为了稳定 ID，
  // 存档完整性校验走 `sha256Hex` 的 WebCrypto 分支（存在时优先）。
  return sha256HexSync(data);
}

/** B10：生成 §7.1 存档。首版固定 sqlite-base64。 */
export async function encodeSnapshot(bytes: Uint8Array, identity: SnapshotIdentity): Promise<AtlasEnvelope> {
  if (!(bytes instanceof Uint8Array)) {
    throw new AtlasDbError('ENVELOPE_BYTES_REQUIRED', 'encodeSnapshot 需要 Uint8Array（不能把导出结果 JSON.stringify 成数字对象）', {
      received: typeof bytes,
    });
  }
  const schemaVersion = identity.schemaVersion ?? ATLAS_SCHEMA_VERSION;
  if (schemaVersion !== ATLAS_SCHEMA_VERSION) {
    throw new AtlasDbError('ENVELOPE_SCHEMA_UNSUPPORTED', `拒绝生成 schema_version=${schemaVersion} 的存档（本实现为 ${ATLAS_SCHEMA_VERSION}）`, {
      schemaVersion,
      supported: ATLAS_SCHEMA_VERSION,
    });
  }
  const sha = await sha256Hex(bytes);
  return {
    format: 'atlas-sqlite',
    storage_version: 1,
    chat_uid: identity.chatUid,
    world_uid: identity.worldUid,
    storage_revision: identity.storageRevision,
    active_branch_id: identity.activeBranchId,
    schema_version: schemaVersion,
    encoding: 'sqlite-base64',
    byte_length: bytes.length,
    sha256: sha,
    data: bytesToBase64(bytes),
    assets: identity.assets ?? [],
  };
}

export type DecodeSnapshotResult =
  | { ok: true; bytes: Uint8Array; envelope: AtlasEnvelope }
  | { ok: false; code: string; message: string; detail: Record<string, unknown> };

/**
 * B11：验 hash / 长度 / chat / world / schema。
 * 任何失败返回失败结果并**保留原数据**；不自动建空世界。
 */
export async function decodeSnapshot(envelope: unknown): Promise<DecodeSnapshotResult> {
  if (typeof envelope !== 'object' || envelope === null) {
    return { ok: false, code: 'ENVELOPE_MISSING', message: '存档信封不存在或不是对象', detail: { type: typeof envelope } };
  }
  const env = envelope as Partial<AtlasEnvelope>;
  if (env.format !== 'atlas-sqlite') {
    return { ok: false, code: 'ENVELOPE_FORMAT_UNKNOWN', message: `未知存档格式：${String(env.format)}`, detail: { format: env.format } };
  }
  if (env.storage_version !== 1) {
    return { ok: false, code: 'ENVELOPE_VERSION_UNSUPPORTED', message: `不支持的 storage_version：${String(env.storage_version)}`, detail: { storage_version: env.storage_version } };
  }
  if (typeof env.data !== 'string' || env.data.length === 0) {
    return { ok: false, code: 'ENVELOPE_DATA_MISSING', message: '存档缺少 data 字段', detail: { byteLength: env.byte_length ?? null } };
  }
  if (env.encoding !== 'sqlite-base64') {
    return {
      ok: false,
      code: env.encoding === 'gzip-sqlite-base64' ? 'ENVELOPE_ENCODING_UNSUPPORTED' : 'ENVELOPE_ENCODING_UNKNOWN',
      message: `不支持的 encoding：${String(env.encoding)}`,
      detail: { encoding: env.encoding },
    };
  }
  if (typeof (env as { chat_uid?: unknown }).chat_uid !== 'string' || (env as { chat_uid?: string }).chat_uid === '') {
    return { ok: false, code: 'ENVELOPE_CHAT_UID_MISSING', message: '存档缺少 chat_uid', detail: {} };
  }
  if (typeof env.schema_version !== 'number') {
    return { ok: false, code: 'ENVELOPE_SCHEMA_MISSING', message: '存档缺少 schema_version', detail: {} };
  }
  if (env.schema_version > ATLAS_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'DB_SCHEMA_UNSUPPORTED',
      message: `存档 schema_version=${env.schema_version} 高于本实现支持的 ${ATLAS_SCHEMA_VERSION}；保持只读，不清空重建`,
      detail: { schemaVersion: env.schema_version, supported: ATLAS_SCHEMA_VERSION },
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(env.data);
  } catch (err) {
    return { ok: false, code: 'ENVELOPE_BASE64_INVALID', message: (err as Error).message, detail: {} };
  }

  if (typeof env.byte_length === 'number' && env.byte_length !== bytes.length) {
    return {
      ok: false,
      code: 'ENVELOPE_LENGTH_MISMATCH',
      message: `byte_length=${env.byte_length} 与实际 ${bytes.length} 不一致`,
      detail: { declared: env.byte_length, actual: bytes.length },
    };
  }
  const actualSha = await sha256Hex(bytes);
  if (typeof env.sha256 !== 'string' || env.sha256 !== actualSha) {
    return {
      ok: false,
      code: 'ENVELOPE_HASH_MISMATCH',
      message: '存档 sha256 与数据不一致（保留原数据，不重建空世界）',
      detail: { declared: env.sha256 ?? null, actual: actualSha },
    };
  }
  if (!Array.isArray(env.assets)) {
    return { ok: false, code: 'ENVELOPE_ASSETS_INVALID', message: 'assets 必须是数组', detail: {} };
  }
  return { ok: true, bytes, envelope: env as AtlasEnvelope };
}

/** 便于 UI/诊断：信封摘要（不含 data 正文）。 */
export function envelopeSummary(envelope: AtlasEnvelope): Record<string, unknown> {
  return {
    format: envelope.format,
    storage_version: envelope.storage_version,
    chat_uid: envelope.chat_uid,
    world_uid: envelope.world_uid,
    storage_revision: envelope.storage_revision,
    active_branch_id: envelope.active_branch_id,
    schema_version: envelope.schema_version,
    encoding: envelope.encoding,
    byte_length: envelope.byte_length,
    sha256: envelope.sha256,
    assetCount: envelope.assets?.length ?? 0,
  };
}
