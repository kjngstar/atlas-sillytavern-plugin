/**
 * atlas-sql-ref-pages.ts — P08/R05：跨页读取与精确名称匹配。
 *
 * 为什么需要它：`TableReadPort.selectWhere` 有 1,001 行硬上限，`collectKnownRefs` 每表还另有
 * 固定条数（maps 50 / characters 200 …）。于是「按名字选主角」只能看到前 200 人、
 * 「第 51 张地图」拿不到 alias。这里提供两条**只用程序白名单**的跨页能力：
 *
 * 1. `findRowByIdPaged`：按真实 ID 跨页查找（缺失、或属于其他分支 → null，绝不猜）；
 * 2. `findByNameExact`：跨页做**精确**名称/别名匹配，全部命中一起返回，
 *    让调用方判歧义，而不是默认取第一个。
 *
 * 两者都走分页接口（`selectPage`），因此不受 1,001 行硬上限影响。
 */

import { pageAllRows } from './atlas-db-readport.ts';
import type { TableReadPort } from './atlas-ops-compile-types.ts';
import type { AtlasTableName } from './atlas-db-contract.ts';

type SqlRow = Record<string, unknown>;

function asId(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** 跨页按真实 ID 查一行；找不到（含不存在 / 属于其他分支）一律 null。 */
export function findRowByIdPaged(
  tables: TableReadPort,
  table: AtlasTableName,
  branchId: string,
  id: string,
): SqlRow | null {
  const target = asId(id);
  if (!target) return null;
  // 单点查询先走 selectOne：命中就不必扫全表（且它是分支内主键查询，天然拒绝跨分支 ID）。
  const direct = tables.selectOne(table, branchId, target);
  if (direct) return direct as SqlRow;
  for (const row of pageAllRows(tables, table, branchId)) {
    if (asId(row.id) === target) return row;
  }
  return null;
}

export type NameMatch = {
  /** 全部精确命中（名称或别名相同）的实体 ID，按 id 升序。 */
  ids: string[];
  /** 实际扫描到的行数，便于诊断「上限外的对象是否真的被看到」。 */
  scanned: number;
};

/**
 * 跨页做精确名称匹配（名称或 aliases 完全相同，不做模糊/前缀匹配）。
 * 返回全部命中，交由调用方判歧义 —— 同名多档案绝不默认挑第一个。
 */
export function findByNameExact(
  tables: TableReadPort,
  table: AtlasTableName,
  branchId: string,
  name: string,
): NameMatch {
  const needle = asId(name);
  if (!needle) return { ids: [], scanned: 0 };
  const rows = pageAllRows(tables, table, branchId);
  const ids: string[] = [];
  for (const row of rows) {
    const rowName = asId(row.name);
    let hit = rowName === needle;
    if (!hit) {
      const aliases = row.aliases_json;
      if (Array.isArray(aliases)) hit = aliases.some((alias) => asId(alias) === needle);
    }
    if (hit) {
      const id = asId(row.id);
      if (id) ids.push(id);
    }
  }
  return { ids: [...new Set(ids)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)), scanned: rows.length };
}
