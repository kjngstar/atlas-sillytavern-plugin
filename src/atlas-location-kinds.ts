/**
 * 地点类型（locations.kind）的唯一权威枚举。
 *
 * 规则：schema CHECK、行类型、归一器、编译器与迁移器都必须引用本文件，
 * 不得各自复制一份字符串联合。新增或调整类型只改这里。
 *
 * 本文件只提供类型与常量，不包含世界名称、默认地点或任何业务数据。
 */

/** 全部合法地点类型；顺序即层级从大到小的自然顺序，供 SQL CHECK 与 UI 分组复用。 */
export const ATLAS_LOCATION_KINDS = [
  'region',
  'city',
  'district',
  'building',
  'floor',
  'room',
  'natural',
  'vehicle',
  'other',
] as const;

/** 合法地点类型的联合类型。 */
export type AtlasLocationKind = (typeof ATLAS_LOCATION_KINDS)[number];

/** 供 SQL CHECK 拼装的单引号字面量列表；各模块不得自行复制顺序。 */
export const ATLAS_LOCATION_KINDS_SQL = ATLAS_LOCATION_KINDS.map(kind => `'${kind}'`).join(',');

/** 运行时守卫：未知值（含 undefined/null/对象）一律返回 false，不放开非法 kind。 */
export function isAtlasLocationKind(value: unknown): value is AtlasLocationKind {
  return typeof value === 'string' && (ATLAS_LOCATION_KINDS as readonly string[]).includes(value);
}
