/**
 * atlas-sql-worker-entry.ts — §16.4 Worker 入口（H14 构建目标）。
 *
 * 打成自包含 IIFE，在 Worker 里只做数据工作：SQL 全部在 Worker 内的 Repository 执行；
 * 需要模型时反向发 `{type:'model.request'}`，由主线程经现有 API 适配器回答——
 * token/key 留在主线程代理，Worker 不读取酒馆全局对象。
 */

import { createSqlRepository } from './atlas-db-repository.ts';
import { handleWorkerMessage } from './atlas-db-worker.ts';
import { resetSqlModuleForTests } from './atlas-db-runtime.ts';
import type { AtlasModelPort } from './atlas-db-contract.ts';
import type { ModelBatchRequest, ModelBatchResponse } from './atlas-ops-contract.ts';

type WorkerScope = {
  postMessage(message: unknown): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  close?(): void;
};

type RepoOptions = Parameters<typeof createSqlRepository>[0];
type RepoInstance = ReturnType<typeof createSqlRepository>;

let repo: RepoInstance | null = null;
let pendingModel = new Map<string, (result: ModelBatchResponse) => void>();
let modelSeq = 0;

/** Worker 内的模型端口：把请求转发给主线程并等待回答。 */
function createWorkerModelPort(scope: WorkerScope): AtlasModelPort {
  return {
    request(input: ModelBatchRequest): Promise<ModelBatchResponse> {
      return new Promise((resolve) => {
        const requestId = `model_${++modelSeq}`;
        pendingModel.set(requestId, resolve);
        scope.postMessage({ type: 'model.request', requestId, input });
      });
    },
  };
}

export function createSqlWorkerHandler(scope: WorkerScope) {
  return async function onMessage(message: unknown): Promise<void> {
    const msg = message as { type?: string; requestId?: string; result?: ModelBatchResponse };
    if (msg?.type === 'model.response' && msg.requestId && pendingModel.has(msg.requestId)) {
      const resolve = pendingModel.get(msg.requestId)!;
      pendingModel.delete(msg.requestId);
      resolve(msg.result as ModelBatchResponse);
      return;
    }
    if (msg?.type === 'init') {
      const payload = message as { options?: RepoOptions };
      if (repo) {
        await repo.close();
        repo = null;
      }
      resetSqlModuleForTests();
      repo = createSqlRepository({ ...(payload.options ?? ({} as RepoOptions)), modelPort: createWorkerModelPort(scope) });
      scope.postMessage({ type: 'response', requestId: 'init', result: { ready: true } });
      return;
    }
    if (!repo) {
      scope.postMessage({
        type: 'response',
        requestId: msg?.requestId ?? '',
        error: { code: 'DB_NOT_OPEN', path: '$', message: 'Worker 尚未 init（没有 Repository 实例）', severity: 'error', retryable: false },
      });
      return;
    }
    const response = await handleWorkerMessage(
      message as never,
      {
        open: (payload) => repo!.open(payload as never),
        queryView: (query) => repo!.queryView(query),
        prepareTurn: (input) => repo!.prepareTurn(input as never),
        prepareRollback: (input) => repo!.prepareRollback(input as never),
        prepareMaintenance: (input) => repo!.prepareMaintenance(input as never),
        confirmSaved: (ack) => repo!.confirmSaved(ack as never),
        discardPrepared: (token) => repo!.discardPrepared(token),
        exportCurrent: () => repo!.exportCurrent(),
        close: () => repo!.close(),
      },
      null,
    );
    if (response) scope.postMessage(response);
  };
}

/** 在真实 Worker 环境里自启动。 */
export function installSqlWorker(scope: WorkerScope): void {
  const handler = createSqlWorkerHandler(scope);
  if (scope.addEventListener) scope.addEventListener('message', (event) => void handler(event.data));
  else scope.onmessage = (event) => void handler(event.data);
}

const globalScope = globalThis as unknown as WorkerScope & { document?: unknown };
if (typeof globalScope.postMessage === 'function' && typeof globalScope.document === 'undefined') {
  installSqlWorker(globalScope);
}
