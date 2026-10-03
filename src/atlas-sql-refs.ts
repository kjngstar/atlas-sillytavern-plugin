/** A model batch owns its alias catalogue. Later writes must never renumber it. */
import type { RefKind, ParsedOperation, Phase } from './atlas-ops-contract.ts';
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
export function collectKnownRefs(tables: TableReadPort, branchId: string): KnownRef[] {
  return CATALOG.flatMap(([table,prefix,kind,limit]) => tables.selectWhere(table,{branch_id:branchId},limit)
    .map((row,i) => ({alias:`${prefix}${i+1}`,id:String(row.id),kind,rowRev:typeof row.row_rev==='number'?row.row_rev:null})));
}
export function collectEntityRefs(tables: TableReadPort, branchId: string, refs = collectKnownRefs(tables,branchId)): string[] {
  return refs.map(ref => {
    const table=CATALOG.find(entry=>entry[2]===ref.kind)?.[0];
    const row=table?tables.selectOne(table,branchId,ref.id):null;
    return `${ref.alias}=${String(row?.name ?? row?.title ?? ref.kind)}（${ref.kind}）`;
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
