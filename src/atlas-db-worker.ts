/**
 * atlas-db-worker.ts / atlas-db-worker-client.ts — §16.4 Worker RPC（B12 / B13）。
 *
 * 固定形状：{type:'request',requestId,method,payload} / {type:'response',requestId,result?,error?}；
 * 需要模型时反向发 {type:'model.request',requestId,input}，主线程经现有 API 适配器回
 * {type:'model.response',requestId,result}。token/key 留在主线程代理，Worker 不读取酒馆全局对象。
 */

import type { AtlasModelPort } from './atlas-db-contract.ts';
import type { Issue, ModelBatchRequest, ModelBatchResponse, ViewQuery } from './atlas-ops-contract.ts';

export const WORKER_METHODS = [
  'open',
  'query',
  'prepareTurn',
  'prepareRollback',
  'prepareMaintenance',
  'confirmSaved',
  'discardPrepared',
  'export',
  'close',
] as const;

export type WorkerMethod = (typeof WORKER_METHODS)[number];

export type WorkerRequestMessage = { type: 'request'; requestId: string; method: WorkerMethod; payload: unknown };
export type WorkerResponseMessage = { type: 'response'; requestId: string; result?: unknown; error?: Issue };
export type WorkerModelRequestMessage = { type: 'model.request'; requestId: string; input: ModelBatchRequest };
export type WorkerModelResponseMessage = { type: 'model.response'; requestId: string; result: ModelBatchResponse };
export type WorkerMessage =
  | WorkerRequestMessage
  | WorkerResponseMessage
  | WorkerModelRequestMessage
  | WorkerModelResponseMessage;

export type WorkerRepositoryLike = {
  open(payload: unknown): Promise<void>;
  queryView(query: ViewQuery): Promise<unknown>;
  prepareTurn(input: unknown): Promise<unknown>;
  prepareRollback(input: unknown): Promise<unknown>;
  prepareMaintenance(input: unknown): Promise<unknown>;
  confirmSaved(ack: unknown): Promise<void>;
  discardPrepared(token: string): Promise<void>;
  exportCurrent(): Promise<Uint8Array>;
  close(): Promise<void>;
};

function toIssue(err: unknown): Issue {
  const anyErr = err as { code?: string; message?: string };
  return {
    code: typeof anyErr?.code === 'string' ? anyErr.code : 'INTERNAL_ERROR',
    path: '$',
    message: String(anyErr?.message ?? err),
    severity: 'error',
    retryable: false,
  };
}

/**
 * B12 handleWorkerMessage：只允许白名单 method；requestId 对应响应；异常序列化 Issue，不吞掉。
 * 返回待发送的消息（不直接 postMessage，便于测试与 Node 适配）。
 */
export async function handleWorkerMessage(
  message: WorkerMessage,
  repo: WorkerRepositoryLike,
  modelPort?: AtlasModelPort | null,
): Promise<WorkerMessage | null> {
  if (!message || typeof message !== 'object') return null;
  if (message.type !== 'request') return null;
  const { requestId, method, payload } = message;
  try {
    if (!(WORKER_METHODS as readonly string[]).includes(method)) {
      return {
        type: 'response',
        requestId,
        error: { code: 'WORKER_METHOD_NOT_ALLOWED', path: '$.method', message: `Worker 不接受的方法：${String(method)}`, severity: 'error', retryable: false },
      };
    }
    switch (method) {
      case 'open':
        await repo.open(payload);
        return { type: 'response', requestId, result: { opened: true } };
      case 'query':
        return { type: 'response', requestId, result: await repo.queryView(payload as ViewQuery) };
      case 'prepareTurn': {
        const input = payload as { phaseBatches?: unknown };
        void input;
        return { type: 'response', requestId, result: await repo.prepareTurn(payload) };
      }
      case 'prepareRollback':
        return { type: 'response', requestId, result: await repo.prepareRollback(payload) };
      case 'prepareMaintenance':
        return { type: 'response', requestId, result: await repo.prepareMaintenance(payload) };
      case 'confirmSaved':
        await repo.confirmSaved(payload);
        return { type: 'response', requestId, result: { confirmed: true } };
      case 'discardPrepared':
        await repo.discardPrepared(String((payload as { token?: string })?.token ?? ''));
        return { type: 'response', requestId, result: { discarded: true } };
      case 'export': {
        const bytes = await repo.exportCurrent();
        // 不把 Uint8Array 直接 JSON.stringify 成数字对象：转 base64 传输。
        return { type: 'response', requestId, result: { base64: bytesToBase64Portable(bytes), byteLength: bytes.length } };
      }
      case 'close':
        await repo.close();
        return { type: 'response', requestId, result: { closed: true } };
      default:
        return { type: 'response', requestId, error: toIssue(new Error(`未处理的方法：${method}`)) };
    }
  } catch (err) {
    return { type: 'response', requestId, error: toIssue(err) };
  } finally {
    void modelPort;
  }
}

function bytesToBase64Portable(bytes: Uint8Array): string {
  const BufferCtor = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (BufferCtor) return BufferCtor.from(bytes).toString('base64');
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/* —— B13 主线程客户端 —— */

export type ModelRequestHandler = (input: ModelBatchRequest) => Promise<ModelBatchResponse>;

export type WorkerLike = {
  postMessage(message: unknown): void;
  addEventListener?: (type: 'message', listener: (event: { data: unknown }) => void) => void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  terminate?: () => void;
};

export type PendingRpc = {
  requestId: string;
  method: WorkerMethod;
  resolve: (value: unknown) => void;
  reject: (error: Issue) => void;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
};

export type WorkerClientState = {
  pending: Map<string, PendingRpc>;
  modelHandlers: Map<string, ModelRequestHandler>;
  nextId: number;
  closed: boolean;
};

export function createWorkerClientState(): WorkerClientState {
  return { pending: new Map(), modelHandlers: new Map(), nextId: 1, closed: false };
}

/**
 * B13 request：超时/终止/失联及 model.request 回调。
 * 完成定义：关闭聊天后迟到 RPC 不能更新 UI；不把 API key 传给 Worker。
 */
export function createWorkerClient(worker: WorkerLike, options: { timeoutMs?: number; modelPort?: ModelRequestHandler | null; onLateResponse?: (method: WorkerMethod) => void } = {}) {
  const state = createWorkerClientState();
  const timeoutMs = options.timeoutMs ?? 120_000;

  const handleModelRequest = async (message: WorkerModelRequestMessage): Promise<void> => {
    const handler = options.modelPort ?? null;
    if (!handler) {
      worker.postMessage({
        type: 'model.response',
        requestId: message.requestId,
        result: {
          batchId: message.input.batchId,
          text: '',
          finishReason: null,
          httpStatus: null,
          durationMs: 0,
          error: { code: 'MODEL_PORT_MISSING', path: '$', message: '主线程没有模型端口：Worker 不能自行读取酒馆 API', severity: 'error', retryable: false },
        } satisfies ModelBatchResponse,
      });
      return;
    }
    try {
      const result = await handler(message.input);
      worker.postMessage({ type: 'model.response', requestId: message.requestId, result });
    } catch (err) {
      worker.postMessage({
        type: 'model.response',
        requestId: message.requestId,
        result: {
          batchId: message.input.batchId,
          text: '',
          finishReason: null,
          httpStatus: null,
          durationMs: 0,
          error: toIssue(err),
        } satisfies ModelBatchResponse,
      });
    }
  };

  const listener = (event: { data: unknown }): void => {
    const message = event.data as WorkerMessage;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'model.request') {
      void handleModelRequest(message);
      return;
    }
    if (message.type !== 'response') return;
    const pending = state.pending.get(message.requestId);
    if (!pending) {
      // 迟到响应：绝不更新 UI，只做诊断回调（方法名由本地请求表或响应自身携带）。
      options.onLateResponse?.('query');
      return;
    }
    clearTimeout(pending.timer);
    state.pending.delete(message.requestId);
    if (pending.cancelled) {
      options.onLateResponse?.(pending.method);
      return;
    }
    if (message.error) pending.reject(message.error);
    else pending.resolve(message.result);
  };

  if (worker.addEventListener) worker.addEventListener('message', listener);
  else worker.onmessage = listener;

  return {
    state,
    request<T = unknown>(method: WorkerMethod, payload: unknown = {}): Promise<T> {
      if (state.closed) {
        return Promise.reject({
          code: 'WORKER_CLOSED',
          path: '$',
          message: 'Worker 客户端已关闭：拒绝新请求',
          severity: 'error',
          retryable: false,
        } satisfies Issue);
      }
      const requestId = `rpc_${state.nextId++}`;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = state.pending.get(requestId);
          if (!pending) return;
          state.pending.delete(requestId);
          reject({
            code: 'WORKER_TIMEOUT',
            path: '$',
            message: `Worker 调用超时（${timeoutMs}ms）：${method}`,
            severity: 'error',
            retryable: true,
          } satisfies Issue);
        }, timeoutMs);
        state.pending.set(requestId, {
          requestId,
          method,
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
          cancelled: false,
        });
        worker.postMessage({ type: 'request', requestId, method, payload } satisfies WorkerRequestMessage);
      });
    },
    /** 取消所有挂起请求（切聊天/关闭时调用）：迟到响应一律丢弃。 */
    cancelAll(): void {
      for (const pending of state.pending.values()) {
        clearTimeout(pending.timer);
        pending.cancelled = true;
        pending.reject({
          code: 'WORKER_CANCELLED',
          path: '$',
          message: `请求已取消：${pending.method}`,
          severity: 'warning',
          retryable: true,
        } satisfies Issue);
      }
      state.pending.clear();
    },
    close(): void {
      state.closed = true;
      worker.terminate?.();
    },
    /** 不把 API key 传给 Worker：只暴露输入结构，密钥留在主线程闭包里。 */
    modelPortConfigured(): boolean {
      return Boolean(options.modelPort);
    },
  };
}
