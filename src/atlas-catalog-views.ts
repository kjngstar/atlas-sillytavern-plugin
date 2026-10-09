/**
 * atlas-catalog-views.ts — M4/Q04 `kind='catalog'` 只读分页目录。
 *
 * 规则：
 * - 只查真实实体表（locations/characters/items/events/rumor_fronts），参数绑定，不拼用户字符串。
 * - 固定排序 (name, id) + keyset 游标；完整导出靠翻页，不允许一次全量（默认 50、上限 200）。
 * - 服务端应用视角过滤后再返回；POV 不返回总数/隐藏条目，避免通过 count 泄漏存在性。
 * - 游标自带 queryScope；分支/修订/视角/查询条件变了就作废，不沿用旧游标。
 */

import { queryBound } from './atlas-db-runtime.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import { sqlVisibility } from './atlas-sql-visibility.ts';
import type { ViewContext } from './atlas-db-views.ts';
import { normalizeViewLimit } from './atlas-ops-contract.ts';
import type { CatalogEntityKind, ViewQuery, ViewResult } from './atlas-ops-contract.ts';
import { CATALOG_ENTITY_KINDS } from './atlas-ops-contract.ts';

export type CatalogItem = {
  entityId: string;
  entityKind: CatalogEntityKind;
  name: string;
  locationId: string | null;
  mapId: string | null;
  summary: string | null;
  status: string;
  locationKind?: string;
  mobility?: string;
  anchorLocationId?: string | null;
};

type Source = {
  kind: CatalogEntityKind;
  table: string;
  /** 完整 SQL 表达式（含表别名）；风声的显示名来自 information 表。 */
  nameExpr: string;
  summaryExpr: string;
  locationExpr: string;
  mapExpr: string;
  /** 参与了排序/游标的名字列，非风声就是 `alias.name`。 */
  aliasCol: string | null;
  extraJoin?: string;
};

const infoTitle = (alias: string) => `(SELECT i.title FROM information i WHERE i.branch_id = ${alias}.branch_id AND i.id = ${alias}.information_id)`;
const infoSummary = (alias: string) => `(SELECT i.content FROM information i WHERE i.branch_id = ${alias}.branch_id AND i.id = ${alias}.information_id)`;

const SOURCES: Record<CatalogEntityKind, Source> = {
  location: { kind: 'location', table: 'locations', nameExpr: 'l.name', summaryExpr: 'l.description', locationExpr: 'NULL', mapExpr: 'l.map_id', aliasCol: 'l.aliases_json' },
  character: { kind: 'character', table: 'characters', nameExpr: 'l.name', summaryExpr: 'l.description', locationExpr: 'l.location_id', mapExpr: 'l.map_id', aliasCol: 'l.aliases_json' },
  item: { kind: 'item', table: 'items', nameExpr: 'l.name', summaryExpr: 'l.description', locationExpr: 'l.location_id', mapExpr: 'l.map_id', aliasCol: 'l.aliases_json' },
  event: { kind: 'event', table: 'events', nameExpr: 'l.title', summaryExpr: 'l.summary', locationExpr: 'l.location_id', mapExpr: 'NULL', aliasCol: null },
  rumor: {
    kind: 'rumor',
    table: 'rumor_fronts',
    nameExpr: infoTitle('l'),
    summaryExpr: infoSummary('l'),
    locationExpr: 'l.location_id',
    mapExpr: 'NULL',
    aliasCol: null,
  },
};

/** 游标只带「作用域 + 种类 + 上一个 (name,id)」，不含 SQL。 */
type Cursor = { v: 1; scope: string; k: string; name: string; id: string };

function scopeKey(ctx: ViewContext, query: ViewQuery, kind: CatalogEntityKind | 'all'): string {
  return JSON.stringify([ctx.branchId, ctx.revision, ctx.viewMode ?? 'author', ctx.povId ?? null, kind, query.q ?? '', query.status ?? 'active']);
}

function encodeCursor(cursor: Cursor): string {
  return JSON.stringify(cursor);
}

function decodeCursor(raw: string | undefined, scope: string): Cursor | null | 'MISMATCH' {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Cursor;
    if (!parsed || parsed.v !== 1 || typeof parsed.name !== 'string' || typeof parsed.id !== 'string' || typeof parsed.k !== 'string') return 'MISMATCH';
    return parsed.scope === scope ? parsed : 'MISMATCH';
  } catch {
    return 'MISMATCH';
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function fetchWindow(
  db: SqlDatabase,
  source: Source,
  ctx: ViewContext,
  options: { status: string; q: string; cursor: Cursor | null; window: number },
): Array<Record<string, unknown>> {
  // 统一把实体表别名为 `l`，风声走 information 子查询取显示名，排序/游标用同一个表达式。
  const cols = [
    'l.id AS id',
    `${source.nameExpr} AS name`,
    `${source.summaryExpr} AS summary`,
    'l.status AS status',
    `${source.locationExpr} AS location_id`,
    `${source.mapExpr} AS map_id`,
    ...(source.kind==='location'?['l.kind AS location_kind','l.mobility AS mobility','l.anchor_location_id AS anchor_location_id']:[]),
    source.kind === 'event' ? 'l.secrecy AS secrecy' : `'public' AS secrecy`,
    source.kind === 'rumor' ? 'l.first_available_at_s AS first_available_at_s' : '0 AS first_available_at_s',
    source.kind === 'rumor' ? 'l.audience_json AS audience_json' : 'NULL AS audience_json',
  ].join(', ');
  const where: string[] = ['l.branch_id = ?', 'l.status = ?'];
  const values: Array<string | number | null> = [ctx.branchId, options.status];
  if (options.q) {
    const like = `%${escapeLike(options.q)}%`;
    if (source.aliasCol) {
      where.push(`(${source.nameExpr} LIKE ? ESCAPE '\\' OR ${source.aliasCol} LIKE ? ESCAPE '\\')`);
      values.push(like, like);
    } else {
      where.push(`${source.nameExpr} LIKE ? ESCAPE '\\'`);
      values.push(like);
    }
  }
  if (options.cursor) {
    where.push(`(${source.nameExpr} > ? OR (${source.nameExpr} = ? AND l.id > ?))`);
    values.push(options.cursor.name, options.cursor.name, options.cursor.id);
  }
  const sql = `SELECT ${cols} FROM ${source.table} AS l WHERE ${where.join(' AND ')} ORDER BY ${source.nameExpr} ASC, l.id ASC LIMIT ${options.window}`;
  return queryBound(db, sql, values) as Array<Record<string, unknown>>;
}

/** M4/Q05 复用：风声受众是否包含主角。坏 JSON 一律拒绝，不猜。 */
export function parseAudienceAllows(audienceJson: unknown, povId: string | null): boolean {
  let doc: unknown = audienceJson;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return false;
    }
  }
  const record = (doc ?? {}) as Record<string, unknown>;
  if (record.access === 'public') return true;
  const listed = [record.characterIds, record.characters, record.audience].find(Array.isArray);
  if (!Array.isArray(listed)) return false;
  return (listed as unknown[]).some((entry) => String(entry) === String(povId ?? ''));
}

function summaryText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export function queryCatalog(ctx: ViewContext, query: ViewQuery): ViewResult {
  if (typeof query.revision === 'number' && query.revision !== ctx.revision) {
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [],
      metadata: { stale: true, requestedRevision: query.revision, currentRevision: ctx.revision },
    };
  }

  const limit = normalizeViewLimit(query.limit);
  const status = typeof query.status === 'string' && query.status ? query.status : 'active';
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  const requestedKind = typeof query.entityKind === 'string' && (CATALOG_ENTITY_KINDS as readonly string[]).includes(query.entityKind)
    ? (query.entityKind as CatalogEntityKind)
    : null;
  const kinds: CatalogEntityKind[] = requestedKind ? [requestedKind] : [...CATALOG_ENTITY_KINDS];
  const scope = scopeKey(ctx, query, requestedKind ?? 'all');
  const rawCursor = typeof query.cursor === 'string' ? query.cursor : undefined;
  const decoded = decodeCursor(rawCursor, scope);
  if (decoded === 'MISMATCH') {
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [],
      metadata: { cursorRejected: true, reason: 'CURSOR_SCOPE_MISMATCH', viewMode: ctx.viewMode ?? 'author' },
    };
  }

  const visibility = sqlVisibility(ctx);
  const isPov = ctx.viewMode === 'pov';
  const clock = Number((queryBound(ctx.db, 'SELECT clock_s FROM branches WHERE id = ?', [ctx.branchId])[0] as Record<string, unknown> | undefined)?.clock_s ?? 0);

  const visibleRow = (kind: CatalogEntityKind, row: Record<string, unknown>): boolean => {
    if (!isPov) return true;
    const id = String(row.id);
    const locationId = row.location_id === null || row.location_id === undefined ? null : String(row.location_id);
    if (kind === 'location') return visibility.knownLocations.has(id);
    if (kind === 'character') return visibility.knownCharacters.has(id);
    if (kind === 'item') return visibility.visibleItems.has(id);
    if (kind === 'event') {
      if (String(row.secrecy ?? 'restricted') !== 'public') return false;
      return locationId === null || visibility.knownLocations.has(locationId);
    }
    // rumor：只给「已到达 + 在已知地点 + 面向主角公开」的风声。
    if (Number(row.first_available_at_s ?? 0) > clock) return false;
    if (locationId !== null && !visibility.knownLocations.has(locationId)) return false;
    return parseAudienceAllows(row.audience_json, visibility.povId ?? null);
  };

  const items: CatalogItem[] = [];
  let lastRow: Record<string, unknown> | null = null;
  let lastKind: CatalogEntityKind | null = null;
  let scanned = 0;
  let reachedLimit = false;
  let allExhausted = true;

  // 多种类模式：游标带种类进度，续页从当时停下的那一种继续，不重头扫。
  const startIndex = !requestedKind && decoded ? Math.max(0, kinds.indexOf(decoded.k as CatalogEntityKind)) : 0;
  for (let ki = startIndex; ki < kinds.length; ki += 1) {
    if (reachedLimit) break;
    const kind = kinds[ki];
    const source = SOURCES[kind];
    let cursor: Cursor | null = decoded && (requestedKind || ki === startIndex) ? decoded : null;
    let kindExhausted = false;
    while (!reachedLimit && !kindExhausted) {
      const window = Math.min(500, Math.max(limit, 50));
      const batch = fetchWindow(ctx.db, source, ctx, { status, q, cursor, window });
      scanned += batch.length;
      if (batch.length < window) kindExhausted = true;
      for (const row of batch) {
        lastRow = row;
        lastKind = kind;
        cursor = { v: 1, scope, k: kind, name: String(row.name ?? ''), id: String(row.id) };
        if (!visibleRow(kind, row)) continue;
        items.push({
          entityId: String(row.id),
          entityKind: kind,
          name: String(row.name ?? ''),
          locationId: row.location_id === null || row.location_id === undefined ? null : String(row.location_id),
          mapId: row.map_id === null || row.map_id === undefined ? null : String(row.map_id),
          summary: summaryText(row.summary),
          status: String(row.status ?? ''),
          ...(kind==='location'?{locationKind:String(row.location_kind??''),mobility:String(row.mobility??'fixed'),anchorLocationId:row.anchor_location_id==null?null:String(row.anchor_location_id)}:{}),
        });
        if (items.length >= limit) {
          reachedLimit = true;
          break;
        }
      }
      if (batch.length === 0) break;
    }
    if (!kindExhausted || ki < kinds.length - 1) allExhausted = false;
  }

  const hasMore = reachedLimit && !allExhausted;
  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items,
    nextCursor: hasMore && lastRow && lastKind ? encodeCursor({ v: 1, scope, k: lastKind, name: String(lastRow.name ?? ''), id: String(lastRow.id) }) : undefined,
    metadata: {
      viewMode: ctx.viewMode ?? 'author',
      entityKind: requestedKind ?? 'all',
      status,
      q: q || null,
      limit,
      returned: items.length,
      hasMore,
      // POV 不返回任何总数：隐藏实体连「存在多少个」都不能被数出来。
      ...(ctx.viewMode === 'pov' ? {} : { scanned }),
    },
  };
}
