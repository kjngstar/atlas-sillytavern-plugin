/** Shared request planning. These estimates group work; they never override API parameters. */
import { ATLAS_RUNTIME_LIMITS, decisionActorBudget } from './atlas-runtime-limits.ts';

export type ModelBatchingSettings = { charactersPerBatch: number; mapsPerBatch: number };
export type ModelGenerationOptions = { maxTokens: number; batching: ModelBatchingSettings };
export const DEFAULT_MODEL_BATCHING: ModelBatchingSettings = { charactersPerBatch: 0, mapsPerBatch: 0 };
export const MODEL_BATCHING_LIMITS: ModelBatchingSettings = {
  charactersPerBatch: ATLAS_RUNTIME_LIMITS.actorsPerDecisionBatch,
  mapsPerBatch: ATLAS_RUNTIME_LIMITS.layoutMapsPerBatch,
};
export function normalizeModelBatching(value: unknown): ModelBatchingSettings {
  const raw=value&&typeof value==='object'?value as Record<string,unknown>:{};
  const count=(key:keyof ModelBatchingSettings):number=>typeof raw[key]==='number'&&Number.isSafeInteger(raw[key])&&raw[key]>=0&&raw[key]<=MODEL_BATCHING_LIMITS[key]?raw[key]:0;
  return {charactersPerBatch:count('charactersPerBatch'),mapsPerBatch:count('mapsPerBatch')};
}
export function validModelBatching(value: unknown): value is ModelBatchingSettings {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const raw=value as Record<string,unknown>;
  return Object.keys(DEFAULT_MODEL_BATCHING).every(key=>Number.isSafeInteger(raw[key])&&(raw[key] as number)>=0&&(raw[key] as number)<=MODEL_BATCHING_LIMITS[key as keyof ModelBatchingSettings]);
}
export function normalizeGenerationOptions(value?: Partial<ModelGenerationOptions>): ModelGenerationOptions {
  return {maxTokens:typeof value?.maxTokens==='number'&&Number.isSafeInteger(value.maxTokens)&&value.maxTokens>=0?value.maxTokens:0,batching:normalizeModelBatching(value?.batching)};
}
export function planningOutputTokens(options?: Partial<ModelGenerationOptions>): number {
  return options?.maxTokens&&options.maxTokens>0?options.maxTokens:ATLAS_RUNTIME_LIMITS.normalResponseTokens;
}
export function characterBatchLimit(options?: Partial<ModelGenerationOptions>): number {
  const config=normalizeModelBatching(options?.batching);
  return Math.min(config.charactersPerBatch||MODEL_BATCHING_LIMITS.charactersPerBatch,decisionActorBudget(planningOutputTokens(options)));
}

