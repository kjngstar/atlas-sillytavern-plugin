/** A model batch owns its alias catalogue. Later writes must never renumber it. */
import type { RefKind, ParsedOperation, Phase, RequiredRef } from './atlas-ops-contract.ts';
import type { TableReadPort } from './atlas-ops-compile-types.ts';
import type { AtlasTableName } from './atlas-db-contract.ts';
import type { Opportunity } from './atlas-sim-opportunities.ts';

export type KnownRef = { alias: string; id: string; kind: RefKind; rowRev: number | null };
const CATALOG: Array<[AtlasTableName, string, RefKind, number]> = [
  ['locations','L','location',200], ['characters','C','character',200], ['items','I','item',100],
  ['factions','F','faction',100], ['maps','M','map',50], ['actions','A','action',200],
  ['information','N','information',200], ['routes','R','route',200], ['events','E','event',200],
  ['journeys','J','journey',200], ['channels','H','channel',100], ['knowledge','K','knowledge',200],
];

export type KnownRefScan = {
  refs: KnownRef[];
  /** 声明为必要、但库里确实不存在（或不在本分支）的引用：调用方据此明确报错，不猜、不静默丢。 */
  missingRequired: RequiredRef[];
  /**
   * 实际进目录的**程序声明必要引用**条数（已去重、已按 kind+id 归一）。
   * 调用方用它对照目录预算判断 REF_REQUIRED_BUDGET_EXCEEDED：
   * 必要项本身都装不下时**不得**删掉必要项继续发送。
   */
  requiredResolved: number;
};

/**
 * 稳定的必要引用排序：先按目录里的 kind 顺序，再按 id。
 * 提交目录与编译目录必须得到同一顺序，否则追加的 alias 编号会跟着漂移。
 */
function orderRequired(refs: readonly RequiredRef[] | undefined): RequiredRef[] {
  if (!refs || refs.length === 0) return [];
  const order = new Map<RefKind, number>(CATALOG.map(([, , kind], index) => [kind, index]));
  const unique = new Map<string, RequiredRef>();
  for (const ref of refs) {
    const kind = ref?.kind;
    const id = typeof ref?.id === 'string' ? ref.id.trim() : '';
    if (!kind || !id || !order.has(kind)) continue;
    unique.set(`${kind}\u0000${id}`, { kind, id });
  }
  return [...unique.values()].sort((left, right) => {
    const leftOrder = order.get(left.kind) ?? 0;
    const rightOrder = order.get(right.kind) ?? 0;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * P08/R05：带必要引用的目录扫描。
 *
 * 扫描沿用每表固定条数（maps 50 / characters 200 …）——**不抬高全表 cap**；
 * 程序用真实 ID 声明的必要引用在此之上无条件追加，编号接在各自前缀末尾，
 * 因此既有 alias 一个都不动（同批重解析绝不重编号）。
 */
export function scanKnownRefs(
  tables: TableReadPort,
  branchId: string,
  options?: { requiredRefs?: readonly RequiredRef[] },
): KnownRefScan {
  const refs: KnownRef[] = [];
  const present = new Map<string, KnownRef>();
  const counters = new Map<RefKind, number>();
  const tableByKind = new Map<RefKind, { table: AtlasTableName; prefix: string }>();

  for (const [table, prefix, kind, limit] of CATALOG) {
    tableByKind.set(kind, { table, prefix });
    const rows = tables.selectWhere(table, { branch_id: branchId }, limit);
    let ordinal = 0;
    for (const row of rows) {
      ordinal += 1;
      const id = String(row.id);
      const key = `${kind}\u0000${id}`;
      if (present.has(key)) continue;
      const entry: KnownRef = { alias: `${prefix}${ordinal}`, id, kind, rowRev: typeof row.row_rev === 'number' ? row.row_rev : null };
      present.set(key, entry);
      refs.push(entry);
    }
    counters.set(kind, ordinal);
  }

  const missingRequired: RequiredRef[] = [];
  let requiredResolved = 0;
  for (const required of orderRequired(options?.requiredRefs)) {
    const key = `${required.kind}\u0000${required.id}`;
    if (present.has(key)) {
      requiredResolved += 1;
      continue;
    }
    const bucket = tableByKind.get(required.kind);
    if (!bucket) continue;
    const row = tables.selectOne(bucket.table, branchId, required.id);
    if (!row) {
      missingRequired.push(required);
      continue;
    }
    const ordinal = (counters.get(required.kind) ?? 0) + 1;
    counters.set(required.kind, ordinal);
    const entry: KnownRef = {
      alias: `${bucket.prefix}${ordinal}`,
      id: required.id,
      kind: required.kind,
      rowRev: typeof row.row_rev === 'number' ? row.row_rev : null,
    };
    present.set(key, entry);
    refs.push(entry);
    requiredResolved += 1;
  }

  return { refs, missingRequired, requiredResolved };
}

/** 同 `scanKnownRefs`，只取 alias 表（既有调用点的兼容入口）。 */
export function collectKnownRefs(
  tables: TableReadPort,
  branchId: string,
  options?: { requiredRefs?: readonly RequiredRef[] },
): KnownRef[] {
  return scanKnownRefs(tables, branchId, options).refs;
}

export function collectEntityRefs(tables: TableReadPort, branchId: string, refs: readonly KnownRef[] = collectKnownRefs(tables,branchId)): string[] {
  const aliasOf=(id:unknown)=>id===null||id===undefined?null:refs.find(ref=>ref.id===id)?.alias??null;
  return refs.map(ref => {
    const table=CATALOG.find(entry=>entry[2]===ref.kind)?.[0];
    const row=table?tables.selectOne(table,branchId,ref.id):null;
    let identity:Record<string,unknown>|null=null;
    if(ref.kind==='location'&&row){
      let aliases:unknown=row.aliases_json??[];
      if(typeof aliases==='string'){try{aliases=JSON.parse(aliases);}catch{aliases=[];}}
      let area:unknown=row.area_geometry_json;
      if(typeof area==='string'){try{area=JSON.parse(area);}catch{area=null;}}
      const dimensions=area&&typeof area==='object'&&!Array.isArray(area)&&(area as Record<string,unknown>).kind==='dimensions'?area:undefined;
      identity={kind:row.kind,parent_ref:aliasOf(row.parent_location_id),aliases,
        map_ref:aliasOf(row.map_id),mobility:row.mobility,anchor_ref:aliasOf(row.anchor_location_id),area:dimensions};
    }else if(ref.kind==='route'&&row){
      identity={from_ref:aliasOf(row.from_location_id),to_ref:aliasOf(row.to_location_id),distance_m:row.distance_m,map_ref:aliasOf(row.map_id)};
    }
    return `${ref.alias}=${String(row?.name ?? row?.title ?? ref.kind)}（${ref.kind}）${identity?' '+JSON.stringify(identity):''}`;
  });
}
export type OperationContext = {
  opIds: string[]; phase: Phase; clockS: number; knownRefs: KnownRef[];
  opportunities: Opportunity[]; dueEventIds: string[]; actorIds: string[];
};
/** Decision repair has the same actor limits as its original request. */
export function inDecisionScope(op: ParsedOperation, ctx: Pick<OperationContext,'knownRefs'|'actorIds'>, tables: TableReadPort, branchId: string): boolean {
  const d=op.value.data ?? {}, ids=new Map(ctx.knownRefs.map(ref=>[ref.alias,ref.id]));
  const target=ids.get(String(op.value.ref ?? d.actor_ref ?? d.owner_ref ?? ''));
  if (op.value.op==='noop'||op.value.op==='attention.propose') return true;
  if (op.value.op==='character.upsert') return !!target && ctx.actorIds.includes(target) && Object.keys(d).every(k=>['thought','action_tendency'].includes(k));
  if (op.value.op==='plan.propose') return !!target && ctx.actorIds.includes(target);
  if (op.value.op==='plan.revise') {
    const action=target?tables.selectOne('actions',branchId,target):null;
    return !!action && ctx.actorIds.includes(String(action.actor_entity_id));
  }
  return false;
}
