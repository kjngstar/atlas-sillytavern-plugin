/** Public server entry: the retired world/table dispatcher exists only in tests/legacy. */
export {createAtlasServerCore} from './atlas-production-server.ts';
export type {AtlasServerCore} from './atlas-production-server.ts';
export type {AtlasDocumentStore,AtlasRequestContext,AtlasServerCoreDeps,AtlasSessionDoc} from './atlas-server-contract.ts';
export type {AtlasSqlHostBinding,AtlasSqlSessionProvider} from './atlas-sql-routes.ts';
export type {AtlasRouteResult} from './atlas-route-result.ts';
export {createMemoryDocumentStore} from './atlas-memory-store.ts';
