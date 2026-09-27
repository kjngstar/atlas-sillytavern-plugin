/**
 * atlas-db-assets.ts — sql.js 本地资源定位（H14 / B01）。
 *
 * §16.1：sql.js 固定 1.14.1，wasm 随组件打包，**不得从 CDN 临时载入另一版**。
 * 这里集中给出 vendor 文件名与本地产物路径的解析规则，供 Worker / 主线程 / 打包校验共用。
 */

export type SqlVendorAsset = {
  /** 产物内的相对文件名（相对 dist/）。 */
  relative: string;
  /** 来源包内路径（相对 node_modules/sql.js）。 */
  source: string;
  /** 用途说明。 */
  purpose: string;
};

export const ATLAS_SQL_VENDOR_FILES: readonly SqlVendorAsset[] = [
  {
    relative: 'vendor/sql-wasm.js',
    source: 'dist/sql-wasm.js',
    purpose: 'sql.js 1.14.1 的 JS 侧（Node/浏览器通用），随组件打包',
  },
  {
    relative: 'vendor/sql-wasm.wasm',
    source: 'dist/sql-wasm.wasm',
    purpose: '同版本 wasm 二进制；与 JS 侧必须同版本',
  },
];

export const ATLAS_SQL_WORKER_FILE = 'atlas-sql-worker.js';

/**
 * 资源根目录：默认「与当前模块同目录的 dist/」。
 * 传入了 assetBase 就用它（宿主可用扩展目录 URL）；否则回退到 import.meta.url。
 */
export function resolveSqlAssetBase(assetBase?: string | null): string {
  if (assetBase && assetBase.length > 0) {
    return assetBase.endsWith('/') ? assetBase : `${assetBase}/`;
  }
  try {
    const metaUrl = (import.meta as { url?: string }).url;
    if (metaUrl) {
      const url = new URL('.', metaUrl);
      return url.href.endsWith('/') ? url.href : `${url.href}/`;
    }
  } catch {
    /* 非 URL 环境（部分宿主打包器）：交给调用方显式传 assetBase */
  }
  return './';
}

/**
 * locateFile：把 sql.js 请求的文件名映射为**本地**路径。
 * 只允许 vendor 白名单里的两个文件；其它文件名一律拒绝（避免静默从别处加载）。
 */
export function sqlVendorLocator(assetBase?: string | null): (file: string) => string {
  const base = resolveSqlAssetBase(assetBase);
  const allowed = new Map(ATLAS_SQL_VENDOR_FILES.map((asset) => [asset.relative.replace('vendor/', ''), asset.relative]));
  return (file: string): string => {
    const normalized = String(file).replace(/^.*[\\/]/, '');
    const relative = allowed.get(normalized);
    if (!relative) {
      throw new Error(
        `DB_WASM_LOAD_FAILED: sql.js 请求了白名单外的文件「${file}」；只允许 ${[...allowed.keys()].join(' / ')}（不从 CDN 加载）`,
      );
    }
    return `${base}${relative}`;
  };
}

/** 打包/启动自检：列出应有资源与缺失项（不读文件系统，只看清单）。 */
export function verifySqlVendorAssets(available: readonly string[]): { ok: boolean; missing: string[]; extra: string[] } {
  const present = new Set(available);
  const missing = ATLAS_SQL_VENDOR_FILES.map((a) => a.relative).filter((r) => !present.has(r));
  const known = new Set(ATLAS_SQL_VENDOR_FILES.map((a) => a.relative));
  const extra = [...present].filter((p) => !known.has(p) && p.startsWith('vendor/'));
  return { ok: missing.length === 0, missing, extra };
}
