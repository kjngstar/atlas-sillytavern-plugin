import type { SqlSession, AtlasSqlRuntime } from './atlas-sql-session.ts';
import type { AtlasModelPort } from './atlas-db-contract.ts';
import type { AtlasSqlSessionProvider } from './atlas-sql-routes.ts';

export type BrowserSqlHostRecord = {
  chatUid: string;
  branchId?: string | null;
  chatMetadata: Record<string, unknown>;
  saveMetadata: () => Promise<unknown>;
};

export type BrowserSqlHostOptions = {
  enabled: () => boolean;
  context: () => BrowserSqlHostRecord | null;
  loadRuntime: () => Promise<AtlasSqlRuntime>;
  modelPort?: AtlasModelPort | null;
};

function error(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function envelopeOf(metadata: Record<string, unknown>): unknown {
  const atlas = metadata.atlas as Record<string, unknown> | undefined;
  return atlas?.database ?? null;
}

function snapshot(metadata: Record<string, unknown>) {
  const raw = envelopeOf(metadata);
  if (!raw || typeof raw !== 'object') return { raw, revision: null, hash: null, data: null,assets:null };
  const envelope = raw as Record<string, unknown>;
  return { raw: null, revision: envelope.storage_revision, hash: envelope.sha256, data: envelope.data,assets:JSON.stringify(envelope.assets??[]) };
}
function sameSnapshot(a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) {
  return a.raw === b.raw && a.revision === b.revision && a.hash === b.hash && a.data === b.data && a.assets === b.assets;
}

/** One write repository for the currently captured host identity. SQL code loads lazily. */
export function createBrowserSqlHost(options: BrowserSqlHostOptions): AtlasSqlSessionProvider {
  let current: { session: SqlSession; storedSnapshot: ReturnType<typeof snapshot>; savingSnapshot?: ReturnType<typeof snapshot> } | null = null;
  let pending: { chatUid: string; branchId: string; metadata: unknown; promise: Promise<SqlSession> } | null = null;
  let epoch = 0;

  function capture(chatUid: string, branchId?: string) {
    if (!options.enabled()) throw error('SQL_MODE_DISABLED', '当前宿主未启用 SQL 世界数据');
    const record = options.context();
    if (!record || record.chatUid !== chatUid) throw error('CHAT_CHANGED', 'SQL 请求不属于当前宿主聊天');
    const envelope = envelopeOf(record.chatMetadata) as { active_branch_id?: string } | null;
    return { ...record, branchId: branchId || envelope?.active_branch_id || record.branchId || 'main' };
  }

  function isCurrent(record: BrowserSqlHostRecord, branchId: string): boolean {
    const live = options.context();
    if (!options.enabled() || !live || live.chatUid !== record.chatUid || live.chatMetadata !== record.chatMetadata) return false;
    const envelope = envelopeOf(live.chatMetadata) as { active_branch_id?: string } | null;
    return (envelope?.active_branch_id || live.branchId || 'main') === branchId;
  }

  return {
    enabled: options.enabled,
    runtime: options.loadRuntime,
    async session(chatUid, requestedBranch) {
      const record = capture(chatUid, requestedBranch);
      const branchId = record.branchId;
      if (current && !current.session.closed && current.session.chatUid === chatUid
        && current.session.branchId === branchId && current.session.chatMetadata === record.chatMetadata
        && (sameSnapshot(current.storedSnapshot, snapshot(record.chatMetadata))
          || current.savingSnapshot && sameSnapshot(current.savingSnapshot, snapshot(record.chatMetadata)))) return current.session;
      if (pending && pending.chatUid === chatUid && pending.branchId === branchId && pending.metadata === record.chatMetadata) return pending.promise;
      const openingEpoch = ++epoch;
      const originalSnapshot = snapshot(record.chatMetadata);
      const legacyKeys=['world','tables','maps','simulation','session','binding'];
      const legacySignature=()=>JSON.stringify(Object.fromEntries(legacyKeys.map(key=>[key,(record.chatMetadata.atlas as Record<string,unknown>|undefined)?.[key]])));
      const originalLegacy=legacySignature();
      let openingSnapshot=originalSnapshot;
      let migrating = false;
      const task = (async () => {
        const runtime = await options.loadRuntime();
        if (!isCurrent(record, branchId) || epoch !== openingEpoch) throw error('CHAT_CHANGED', 'SQL 初始化期间宿主身份已变化');
        if (current) { await runtime.closeSqlSession(current.session); current = null; }
        const atlas = record.chatMetadata.atlas as Record<string, unknown> | undefined;
        const openOptions={
          chatUid, branchId, chatMetadata: record.chatMetadata, modelPort: options.modelPort ?? null,
          ...(!envelopeOf(record.chatMetadata)&&atlas?.world&&typeof atlas.world==='object'?{
            worldUid:typeof (atlas.world as Record<string,unknown>).id==='string'?(atlas.world as {id:string}).id:undefined,
            branchName:typeof (atlas.world as Record<string,unknown>).name==='string'?(atlas.world as {name:string}).name:undefined,
          }:{}),
          confirmSave: true,
          isCurrentHost: () => isCurrent(record, branchId)
            && sameSnapshot(current?.session.chatMetadata === record.chatMetadata ? current.savingSnapshot ?? current.storedSnapshot : openingSnapshot,
              snapshot(record.chatMetadata)),
          saveSession: async () => {
            if (!isCurrent(record, branchId)) throw error('CHAT_CHANGED', '保存前聊天或分支已变化');
            if(migrating && legacySignature()!==originalLegacy) throw error('SESSION_STALE','保存前旧档已变化，拒绝发布迁移候选');
            // The host publishes candidate metadata before its async save finishes.
            // Reads of that exact candidate must keep the repository alive until
            // confirmSaved and provider.saved publish it as the official database.
            const saving = current?.session.chatMetadata === record.chatMetadata ? current : null;
            if (saving) saving.savingSnapshot = snapshot(record.chatMetadata);
            let result: unknown;
            try { result = await record.saveMetadata(); }
            catch (cause) { if (saving) delete saving.savingSnapshot; throw cause; }
            if(migrating && legacySignature()!==originalLegacy) throw error('SESSION_STALE','保存期间旧档已变化，拒绝发布迁移候选');
            if (result === false) {
              if (saving) delete saving.savingSnapshot;
              throw error('SESSION_WRITE_FAILED', '宿主拒绝保存 SQL 快照');
            }
            if (!isCurrent(record, branchId)) throw error('CHAT_CHANGED', '保存过程中聊天或分支已变化');
            return result;
          },
        };
        let opened:SqlSession;
        if(envelopeOf(record.chatMetadata)===null&&legacyKeys.slice(0,5).some(key=>atlas?.[key]!=null)){
          if(legacySignature()!==originalLegacy)throw error('SESSION_STALE','初始化期间旧档已变化，拒绝迁移过期内容');
          migrating = true;
          const migration=await runtime.migrateSessionToSql({...openOptions,legacy:{atlas:JSON.parse(JSON.stringify(atlas))},persist:true});
          if(!migration.session||migration.issues.some(issue=>issue.severity==='error')||!migration.saved&&migration.inspection.kind!=='empty'){
            if(migration.session)await runtime.closeSqlSession(migration.session);
            const cause=migration.issues.find(issue=>issue.severity==='error');
            throw error(cause?.code??'SQL_MIGRATION_FAILED',cause?.message??'旧档迁移未获得保存确认；旧数据保持原状');
          }
          migrating = false;
          opened=migration.session;
          openingSnapshot=snapshot(record.chatMetadata);
        }else opened=await runtime.openSqlSession(openOptions);
        if (!isCurrent(record, branchId) || epoch !== openingEpoch || !sameSnapshot(snapshot(record.chatMetadata), openingSnapshot)) {
          await runtime.closeSqlSession(opened);
          throw error('CHAT_CHANGED', 'SQL 初始化期间快照或宿主身份已变化');
        }
        current = { session: opened, storedSnapshot: openingSnapshot };
        return opened;
      })();
      const opening = { chatUid, branchId, metadata: record.chatMetadata, promise: task };
      pending = opening;
      try { return await task; }
      finally { if (pending === opening) pending = null; }
    },
    saved(session) {
      if (current?.session === session) {
        current.storedSnapshot = snapshot(session.chatMetadata);
        delete current.savingSnapshot;
      }
    },
    async close() {
      epoch++; pending = null;
      const previous = current; current = null;
      // Never load SQL merely to close an engine that has not opened a database.
      if (previous) await (await options.loadRuntime()).closeSqlSession(previous.session);
    },
  };
}
