/** Build constants are injected by esbuild; direct source imports remain usable in tests. */
declare const __ATLAS_BUILD_INFO__: { pluginVersion: string; buildId: string; buildCommit?: string; buildDirty?: boolean };
export const ATLAS_BUILD_INFO = typeof __ATLAS_BUILD_INFO__ === 'undefined'
  ? { pluginVersion: 'development' } : __ATLAS_BUILD_INFO__;
