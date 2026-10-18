/** Optional user limits. Zero never introduces an application quantity cap. */
import { decisionActorBudget } from './atlas-runtime-limits.ts';

export type ModelBatchingSettings = { charactersPerBatch: number; mapsPerBatch: number; requestsPerOperation?: number };
export type ModelGenerationOptions = { maxTokens: number; batching: ModelBatchingSettings };
export const DEFAULT_MODEL_BATCHING = { charactersPerBatch: 0, mapsPerBatch: 0, requestsPerOperation: 0 };
export function normalizeModelBatching(value: unknown): Required<ModelBatchingSettings> {
  const raw=value&&typeof value==='object'?value as Record<string,unknown>:{};
  const count=(key:keyof ModelBatchingSettings):number=>typeof raw[key]==='number'&&Number.isSafeInteger(raw[key])&&raw[key]>=0?raw[key]:0;
  return {charactersPerBatch:count('charactersPerBatch'),mapsPerBatch:count('mapsPerBatch'),requestsPerOperation:count('requestsPerOperation')};
}
export function validModelBatching(value: unknown): value is ModelBatchingSettings {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const raw=value as Record<string,unknown>;
  const valid=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0;
  return valid(raw.charactersPerBatch)&&valid(raw.mapsPerBatch)&&(raw.requestsPerOperation===undefined||valid(raw.requestsPerOperation));
}
export function normalizeGenerationOptions(value?: Partial<ModelGenerationOptions>): ModelGenerationOptions {
  return {maxTokens:typeof value?.maxTokens==='number'&&Number.isSafeInteger(value.maxTokens)&&value.maxTokens>=0?value.maxTokens:0,batching:normalizeModelBatching(value?.batching)};
}
export function planningOutputTokens(options?: Partial<ModelGenerationOptions>): number {
  return options?.maxTokens&&options.maxTokens>0?options.maxTokens:Infinity;
}
export function characterBatchLimit(options?: Partial<ModelGenerationOptions>): number {
  const config=normalizeModelBatching(options?.batching);
  return Math.min(config.charactersPerBatch||Infinity,decisionActorBudget(planningOutputTokens(options)));
}
export function isModelBatchSizeFailure(error:unknown):boolean {
  const value=error as {code?:string;message?:string};
  return ['LAYOUT_BATCH_TRUNCATED','CHARACTER_BATCH_TOO_LARGE'].includes(value?.code??'')||/context[_ -]?length[_ -]?exceeded|(?:maximum|exceed\w*).*context|context.*(?:window|length|limit)|(?:prompt|input).*(?:too long|too large)|payload too large/i.test(value?.message??'');
}

