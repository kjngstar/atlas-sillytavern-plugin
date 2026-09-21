/**
 * atlas-session-helper.mjs — 0.9.42 会话承载测试载体。
 *
 * 模拟浏览器侧行为：会话文档随请求往返，200 ok 响应带回的新会话（rev+1）自动覆盖本地。
 * 同时兼容旧测试写法：GET /state/:chatId、GET /map/image/:chatId 自动改写为 POST + 随体 chatId。
 * 需要多聊天隔离的测试请创建多个载体（一个聊天一个会话，与真实 chatMetadata 语义一致）。
 */

const SESSION_ROUTE_METHODS = (method, path) =>
  method === "POST" &&
  (path === "/state" ||
    path === "/map/image" ||
    path === "/map/travel-preview" ||
    path.startsWith("/turns/") ||
    path === "/bindings" ||
    path === "/worlds/import" ||
    path === "/worlds/ensure-starter" ||
    path === "/worlds/geo/adopt");

export function createSessionCarrier(core, { world = null, binding = null, maps = null, session: initial = null } = {}) {
  let session = initial
    ? JSON.parse(JSON.stringify(initial))
    : {
    schemaVersion: 1,
    rev: 0,
    binding,
    world,
    maps,
    turns: {},
    geoAuto: {},
  };
  return {
    /** 底层核心（测试代理 logs() 等非 handle 方法用）。 */
    core,
    /** 当前会话文档（测试可直接断言世界 / 绑定 / 回合映射内容）。 */
    get session() {
      return session;
    },
    /** 模拟 core.handle，但携带并回收会话；旧 GET 路径自动改写。 */
    async handle(method, path, body = {}, ctx) {
      const stateMatch = method === "GET" ? /^\/state\/([^/]+)$/.exec(path) : null;
      const imageMatch = method === "GET" ? /^\/map\/image\/([^/]+)$/.exec(path) : null;
      if (stateMatch) {
        method = "POST";
        path = "/state";
        body = { chatId: decodeURIComponent(stateMatch[1]), ...body };
      } else if (imageMatch) {
        method = "POST";
        path = "/map/image";
        body = { chatId: decodeURIComponent(imageMatch[1]), ...body };
      }
      let payload = body;
      if (SESSION_ROUTE_METHODS(method, path)) {
        payload = { ...body, session };
      }
      const result = await core.handle(method, path, payload, ctx);
      if (
        result.status === 200 &&
        result.body &&
        typeof result.body === "object" &&
        result.body.ok === true &&
        result.body.session &&
        result.body.session.schemaVersion === 1
      ) {
        session = result.body.session;
      }
      return result;
    },
  };
}

/** 兼容旧调用习惯：把载体包装成 { handle } 对象，测试里的 `core.handle(...)` 无需改写；logs() 等诊断方法透传底层核心。 */
export function carrierAsCore(carrier) {
  return {
    handle: (method, path, body, ctx) => carrier.handle(method, path, body, ctx),
    get session() {
      return carrier.session;
    },
    logs: (...args) => carrier.core.logs(...args),
  };
}
