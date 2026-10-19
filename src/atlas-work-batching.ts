/** A batch is one compatible workload, never one entity or one SQL table. */
export type WorkBatchingSettings = {
  mapBatches: number;
  characterBatches: number;
  evidenceBatches: number;
  outcomeBatches: number;
  extraRequests: number;
};
export type ModelWorkClass = 'observe' | 'construction' | 'evidence' | 'maps' | 'characters' | 'outcomes';
export const DEFAULT_WORK_BATCHING: Readonly<WorkBatchingSettings> = {
  mapBatches: 1, characterBatches: 1, evidenceBatches: 1, outcomeBatches: 1, extraRequests: 1,
};
export function normalizeWorkBatching(value: unknown): WorkBatchingSettings {
  const raw=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  return Object.fromEntries(Object.entries(DEFAULT_WORK_BATCHING).map(([key,fallback])=>{
    const n=raw[key];return [key,typeof n==='number'&&Number.isSafeInteger(n)&&n>=(key==='extraRequests'?0:1)?n:fallback];
  })) as WorkBatchingSettings;
}
export function validWorkBatching(value:unknown):value is WorkBatchingSettings {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const raw=value as Record<string,unknown>;
  return Object.keys(DEFAULT_WORK_BATCHING).every(key=>Number.isSafeInteger(raw[key])&&(raw[key] as number)>=(key==='extraRequests'?0:1));
}
/** Balanced nonempty batches; remaining batches never spawn empty requests. */
export function workBatchSize(targets:number,batches:number):number {
  return targets>0&&batches>0?Math.ceil(targets/Math.min(targets,batches)):0;
}
export function workPlanLimits(settings:WorkBatchingSettings):Record<ModelWorkClass,number> {
  return {observe:1,construction:1,evidence:settings.evidenceBatches,maps:settings.mapBatches,characters:settings.characterBatches,outcomes:settings.outcomeBatches};
}
