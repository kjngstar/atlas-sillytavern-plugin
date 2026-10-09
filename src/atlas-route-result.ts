import { ATLAS_ERROR_CODES, toSerializedError, type SerializedAtlasError } from './atlas-contract.ts';

function httpStatusFor(code: string): number {
  switch (code) {
    case ATLAS_ERROR_CODES.INVALID_PAYLOAD:
    case ATLAS_ERROR_CODES.PROTOCOL_INCOMPATIBLE:
    case ATLAS_ERROR_CODES.NOT_BOUND:
    // M5-08A：事件流的参数类错误。形状坏掉的游标是「请求写错了」，重试无用。
    case 'VIEW_CURSOR_INVALID':
    case 'FEED_POV_ID_REQUIRED':
      return 400;
    case ATLAS_ERROR_CODES.FORBIDDEN:
      return 403;
    case ATLAS_ERROR_CODES.WORLD_NOT_FOUND:
      return 404;
    case ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED:
      return 413;
    case ATLAS_ERROR_CODES.API_NOT_CONFIGURED:
    case ATLAS_ERROR_CODES.DUPLICATE_COMMIT:
    case ATLAS_ERROR_CODES.SESSION_STALE:
    case ATLAS_ERROR_CODES.PREVIEW_STALE:
    // C04：协议不符 = 「设置与响应形态冲突」，不是格式错（400）也不是服务故障（502）——
    // 作者要做的动作是回推进页切协议，409 与既有前端错误呈现一致。
    case ATLAS_ERROR_CODES.PROTOCOL_MISMATCH:
    // M5-08A：事件流的冲突类错误。客户端拿着旧身份或过期游标，重读第一页即可 —— 不是服务坏了。
    case 'VIEW_CURSOR_STALE':
    case 'SQL_PREVIEW_EXPIRED':
      return 409;
    case ATLAS_ERROR_CODES.API_RATE_LIMITED:
      return 429;
    case ATLAS_ERROR_CODES.API_TIMEOUT:
      return 504;
    case ATLAS_ERROR_CODES.RESPONSE_MALFORMED:
    case ATLAS_ERROR_CODES.API_AUTH_FAILED:
    case ATLAS_ERROR_CODES.API_NOT_FOUND:
    case ATLAS_ERROR_CODES.API_REQUEST_FAILED:
      return 502;
    case ATLAS_ERROR_CODES.SERVICE_OFFLINE:
      return 503;
    case ATLAS_ERROR_CODES.WRITE_FAILED:
      return 500;
    default:
      return 500;
  }
}

export interface AtlasRouteResult {
  status: number;
  body: unknown;
}

export function okResult(data: unknown): AtlasRouteResult {
  return { status: 200, body: { ok: true, data } };
}

export function errorResult(thrown: unknown): AtlasRouteResult {
  const error: SerializedAtlasError = toSerializedError(thrown);
  return { status: httpStatusFor(error.code), body: { ok: false, error } };
}
