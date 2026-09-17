/**
 * atlas-browser-store.ts — ATLAS-09 浏览器侧 AtlasDocumentStore。
 *
 * 纯浏览器模式下，Atlas 的所有文档（settings / world:* / binding:* / pending:* / receipts）
 * 不再落 Server Plugin 文件，而是整包存进酒馆 extensionSettings 宿主 KV。
 *
 * 形状：{ schemaVersion: 1, docs: Record<name, unknown> }。
 * - 严格解析：宿主载荷损坏 / 版本不符 → 按空存储处理（不抛、不写回、不破坏宿主数据）。
 * - 有界：单文档 / 总量 / 文档数三重上限；超限抛 AtlasError(FIELD_LIMIT_EXCEEDED)，失败写入不落盘。
 * - 本文件保持零 DOM、零酒馆依赖；宿主读写由调用方注入（index.js 适配 extensionSettings）。
 */

import {
  ATLAS_ERROR_CODES,
  AtlasError,
} from "./atlas-contract.ts";

export const ATLAS_BROWSER_STORE_SCHEMA_VERSION = 1;

export const ATLAS_BROWSER_DOC_LIMITS = {
  /** 单文档 JSON 序列化后最大字节数（UTF-8 按 2 字符≈1 字符保守估算用字符串长度） */
  DOC_MAX_BYTES: 4_000_000,
  /** 全部文档总字节上限 */
  TOTAL_MAX_BYTES: 16_000_000,
  /** 文档数量上限 */
  DOC_COUNT_MAX: 256,
} as const;

/** 宿主 KV 适配：extensionSettings 下的键读写（每次写后由 index.js 触发 saveSettingsDebounced）。 */
export interface AtlasBrowserStoreHost {
  readAll(): unknown;
  writeAll(value: unknown): void;
}

interface StoredShape {
  schemaVersion: number;
  docs: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 严格解析宿主载荷；任何不合法 → null（按空存储处理）。 */
function parseStored(raw: unknown): StoredShape | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== ATLAS_BROWSER_STORE_SCHEMA_VERSION) return null;
  if (!isRecord(raw.docs)) return null;
  return { schemaVersion: ATLAS_BROWSER_STORE_SCHEMA_VERSION, docs: raw.docs };
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? null)?.length ?? 0;
  } catch {
    // 循环引用等不可序列化载荷直接拒绝
    throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "文档载荷无法 JSON 序列化（循环引用或非可序列化值）");
  }
}

export function createBrowserDocumentStore(host: AtlasBrowserStoreHost) {
  /** 惰性载入：首次访问时从宿主读取并严格解析；失败按空表处理。 */
  function loadDocs(): Record<string, unknown> {
    const parsed = parseStored(host.readAll());
    return parsed ? parsed.docs : {};
  }

  function persistDocs(docs: Record<string, unknown>): void {
    host.writeAll({ schemaVersion: ATLAS_BROWSER_STORE_SCHEMA_VERSION, docs });
  }

  function assertWithinLimits(name: string, value: unknown, docs: Record<string, unknown>): void {
    if (!(name in docs) && Object.keys(docs).length >= ATLAS_BROWSER_DOC_LIMITS.DOC_COUNT_MAX) {
      throw new AtlasError(
        ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED,
        `浏览器存储文档数已达上限 ${ATLAS_BROWSER_DOC_LIMITS.DOC_COUNT_MAX}`,
      );
    }
    const docLength = serializedLength(value);
    if (docLength > ATLAS_BROWSER_DOC_LIMITS.DOC_MAX_BYTES) {
      throw new AtlasError(
        ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED,
        `单文档超过 ${ATLAS_BROWSER_DOC_LIMITS.DOC_MAX_BYTES} 字符上限`,
      );
    }
    const otherDocs = Object.keys(docs)
      .filter((key) => key !== name)
      .reduce((sum, key) => sum + serializedLength(docs[key]), 0);
    if (otherDocs + docLength > ATLAS_BROWSER_DOC_LIMITS.TOTAL_MAX_BYTES) {
      throw new AtlasError(
        ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED,
        `浏览器存储总量超过 ${ATLAS_BROWSER_DOC_LIMITS.TOTAL_MAX_BYTES} 字符上限`,
      );
    }
  }

  return {
    async read(name: string): Promise<unknown | null> {
      const docs = loadDocs();
      return name in docs ? docs[name] : null;
    },

    async write(name: string, value: unknown): Promise<void> {
      const docs = loadDocs();
      assertWithinLimits(name, value, docs);
      docs[name] = value;
      persistDocs(docs);
    },

    async remove(name: string): Promise<void> {
      const docs = loadDocs();
      if (!(name in docs)) return;
      delete docs[name];
      persistDocs(docs);
    },

    async list(prefix: string): Promise<string[]> {
      const docs = loadDocs();
      return Object.keys(docs)
        .filter((key) => key.startsWith(prefix))
        .sort();
    },
  };
}
