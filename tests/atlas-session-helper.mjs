/**
 * atlas-session-helper.mjs — 0.9.42 会话承载测试载体。
 *
 * 模拟浏览器侧行为：会话文档随请求往返，200 ok 响应带回的新会话（rev+1）自动覆盖本地。
 * 同时兼容旧测试写法：GET /state/:chatId、GET /map/image/:chatId 自动改写为 POST + 随体 chatId。
 * 需要多聊天隔离的测试请创建多个载体（一个聊天一个会话，与真实 chatMetadata 语义一致）。
 *
 * A05（2026-09-25 追加）：大体积会话构造与实测（buildLargeSession / measureSessionSize /
 * measureSessionRoundTrip / writeSessionGuarded / assertOversizedSessionWriteRejected）。
 * 既有导出 createSessionCarrier / carrierAsCore 的行为契约不变。
 */

import assert from "node:assert/strict";

const SESSION_ROUTE_METHODS = (method, path) =>
  method === "POST" &&
  (path === "/state" ||
    path === "/map/image" ||
    path === "/map/travel-preview" ||
    path.startsWith("/turns/") ||
    path === "/scene/bootstrap" ||
    path === "/scene/repair-start" ||
    path === "/bindings" ||
    path === "/worlds/import" ||
    path === "/worlds/ensure-starter" ||
    path === "/worlds/geo/adopt" ||
    path === "/worlds/move-author" ||
    path === "/worlds/scale/calibrate" ||
    // H07a：作者手动确认地理关系的会话路由
    path === "/maps/topology/confirm" ||
    // H15a：作者手动涂色范围
    path === "/maps/areas/upsert");

export function createSessionCarrier(core, { world = null, binding = null, maps = null, session: initial = null } = {}) {
  let session = initial
    ? JSON.parse(JSON.stringify(initial))
    : {
    schemaVersion: 1,
    rev: 0,
    binding,
    world,
    maps,
    scene: null,
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

/* ================================================================== *
 * A05 —— 大体积会话构造与体积实测（计划 §2.1 上限 / §3 阶段 A05）
 *
 * 目标（T16）：用「5 图 / 50 人 / 200 物 / 120 tasks / 50 signals / 200 deliveries /
 * 128 edges / 16 染色区 / 100 回合」构造一份**确定性**的会话文档，并实测：
 *   - 整份 JSON 字符数 + 分块（tables / simulation / turns / maps / world / scene / geoAuto）；
 *   - 单请求 payload 字符数（载体真实发送的 POST /state 请求体）；
 *   - 一次 `handle` 往返耗时（measureSessionRoundTrip）。
 *
 * 纪律：
 * 1. 本文件**只测量、只如实报告**：不为了让数字好看而降低有效人物，也不静默截断。
 *    超过 §2.1 的 simulation 硬上限（240000 字）时，measureSessionSize 会在
 *    `violations` 里给出具名越界项；调用方按计划的建议处理（压缩有界摘要 / 分页 /
 *    先修 §2.1 与对应测试），**不得**截断后伪称成功。
 * 2. 推演块（simulation）在此**就地构造等价纯数据**：字段名与计划 §2.1 一字不差。
 *    将来 src/atlas-simulation.ts（C01/C02）稳定后，这里应改为
 *    `import { createEmptySimulation, validateSimulationStore, ATLAS_SIMULATION_LIMITS }`
 *    并直接调用真实校验器；届时 SESSION_SIZE_LIMITS 的重复数字应删除。
 * 3. 构造是纯函数、零网络、零随机、零 Date.now：同参数两次构造逐字节相同。
 * ================================================================== */

/** 计划 §2.1 上限的**测试侧副本**（权威仍是 src/atlas-simulation.ts 的常量；落地后改为 import）。 */
export const SESSION_SIZE_LIMITS = {
  /** simulation 整份 JSON 硬上限（字）。 */
  simulationJsonChars: 240000,
  /** 宿主单请求上限：未知时为 null（只测量不判定）。 */
  payloadChars: null,
  /** 会话 turns 条数上限（src/atlas-server.ts 的 SESSION_TURNS_MAX）。 */
  turns: 2000,
  /** 每回合 simulationEvents 上限（§2.1）。 */
  eventsPerTurn: 16,
  collections: {
    locations: 1000, characters: 2000, items: 5000,
    tasks: 128, activeTasks: 64, signals: 64, deliveries: 256,
    edges: 256, areas: 64, vehicles: 64, areaCells: 256,
  },
  textChars: { topic: 160, event: 160, id: 120 },
};

const A05_DEFAULTS = {
  maps: 5, characters: 50, items: 200, tasks: 120, signals: 50, deliveries: 200,
  edges: 128, areas: 16, turns: 100,
  /** 派生规模（不属于 T16 的固定清单，可覆盖）：地点行 / 每张子图孩子数 / 染色区格数 / 载具 / 每回合事件数。 */
  locations: 64, childrenPerSubmap: 4, cellsPerArea: 8, vehicles: 4, eventsPerTurn: 4,
  topicChars: 24, summaryChars: 60,
};

/** 确定性回合键：与 src/atlas-contract.ts 的 atlasCommitIdempotencyKey 同形（chatId::user::assistant::swipe）。 */
export function largeSessionTurnKey(chatId, index) {
  return `${chatId}::msg-u${index}::msg-a${index}::`;
}

/** §2.1 的空推演模块（就地构造；C01 落地后改为 import 真实构造器）。 */
export function createEmptySimulationData(worldId, branchKey = "canon") {
  return {
    schemaVersion: 1,
    worldId,
    branches: {
      [branchKey]: { tasks: [], signals: [], deliveries: [], geoTopology: { edges: [], areas: [], vehicles: [] } },
    },
  };
}

function a05PointId(rowId) {
  return String(rowId).replace(/^loc:/, "");
}

function a05Text(prefix, index, width) {
  const head = `${prefix}${String(index).padStart(4, "0")}`;
  return head.length >= width ? head : head + "·" + "详".repeat(Math.max(0, width - head.length - 1));
}

/**
 * 构造大体积推演块（§2.1 三组有界行 + geoTopology）。
 * 引用一致性：deliveries → signals、reaction task → 已送达该人的 signal、
 * 所有 recipientId / originLocationId / 边两端 / 载具锚点都能在同一分支三表里解析。
 */
export function buildLargeSimulation({
  worldId = "world-large-a05",
  branchKey = "canon",
  chatId = "chat-large-a05",
  locations = [],
  characters = [],
  tasks = A05_DEFAULTS.tasks,
  signals = A05_DEFAULTS.signals,
  deliveries = A05_DEFAULTS.deliveries,
  edges = A05_DEFAULTS.edges,
  areas = A05_DEFAULTS.areas,
  vehicles = A05_DEFAULTS.vehicles,
  cellsPerArea = A05_DEFAULTS.cellsPerArea,
  topicChars = A05_DEFAULTS.topicChars,
  periods = 8,
  turnKeyOf = (index) => largeSessionTurnKey(chatId, index),
  turnsTotal = A05_DEFAULTS.turns,
} = {}) {
  const locationIds = locations.map((row) => row.id);
  const submapLocations = locations.filter((row) => row.parentLocationId !== null);
  const vehicleLocations = locations.filter((row) => row.name.includes("载具"));
  if (locationIds.length === 0) throw new Error("buildLargeSimulation 需要至少一个地点行");
  if (characters.length === 0) throw new Error("buildLargeSimulation 需要至少一个人物行");

  // --- signals：一件消息只创建一次 ---
  const signalRows = Array.from({ length: signals }, (_, index) => ({
    id: `sig-a05-${String(index + 1).padStart(4, "0")}`,
    originLocationId: locationIds[index % locationIds.length],
    topic: a05Text("宣战文书", index, topicChars),
    sourceTurnKey: turnKeyOf(index % Math.max(1, turnsTotal)),
    sourceQuoteId: `msg:msg-a${index % Math.max(1, turnsTotal)}`,
    publishedPeriod: index % periods,
    visibility: index % 7 === 0 ? "hidden" : "known",
    status: "active",
    propagationCursor: index % 5,
  }));

  // --- deliveries：(signal, recipientType, recipientId) 唯一；receivedPeriod ≥ publishedPeriod ---
  const viaCycle = ["witness", "messenger", "travel", "contact", "faction", "explicit-channel"];
  const confidenceCycle = ["confirmed", "rumor", "disputed"];
  const characterIds = characters.map((row) => row.id);
  const deliveryRows = [];
  /** characterId → 已送达该人的 signalId（reaction 任务只能引用这里面的 signal）。 */
  const deliveredSignalsByCharacter = new Map();
  for (let index = 0; index < deliveries; index += 1) {
    const signalIndex = index % signalRows.length;
    const signal = signalRows[signalIndex];
    const slot = Math.floor(index / signalRows.length);   // 同一 signal 的第几条送达
    const recipientType = slot % 2 === 0 ? "location" : "character";
    const pool = recipientType === "location" ? locationIds : characterIds;
    const recipientId = pool[(signalIndex + slot * 7) % pool.length];
    deliveryRows.push({
      id: `dlv-a05-${String(index + 1).padStart(4, "0")}`,
      signalId: signal.id,
      recipientType,
      recipientId,
      via: viaCycle[index % viaCycle.length],
      fromLocationId: signal.originLocationId,
      receivedPeriod: signal.publishedPeriod + 1,
      confidence: confidenceCycle[index % confidenceCycle.length],
    });
    if (recipientType === "character") {
      const list = deliveredSignalsByCharacter.get(recipientId) ?? [];
      list.push(signal.id);
      deliveredSignalsByCharacter.set(recipientId, list);
    }
  }

  // --- tasks：非终态 ≤ 64（§2.1）；reaction 必须指向「已送达该人」的 signal，否则退回 intent ---
  const kinds = ["intent", "travel", "reaction"];
  const taskRows = Array.from({ length: tasks }, (_, index) => {
    const actor = characters[index % characters.length];
    const delivered = deliveredSignalsByCharacter.get(actor.id) ?? [];
    const useReaction = kinds[index % kinds.length] === "reaction" && delivered.length > 0;
    const kind = useReaction ? "reaction" : (kinds[index % kinds.length] === "reaction" ? "intent" : kinds[index % kinds.length]);
    const nonTerminal = index < Math.min(tasks, 60);
    const status = nonTerminal
      ? (index % 9 === 0 ? "blocked" : index % 3 === 0 ? "active" : "queued")
      : (index % 2 === 0 ? "resolved" : "cancelled");
    return {
      id: `task-a05-${String(index + 1).padStart(4, "0")}`,
      kind,
      status,
      actorCharacterId: actor.id,
      originLocationId: actor.locationId,
      targetLocationId: locationIds[(index + 3) % locationIds.length],
      topic: a05Text("行动计划", index, topicChars),
      signalId: useReaction ? delivered[index % delivered.length] : null,
      visibility: index % 11 === 0 ? "hidden" : "known",
      source: ["observed", "character-intent", "schedule", "engine"][index % 4],
      createdTurnKey: turnKeyOf(index % Math.max(1, turnsTotal)),
      lastAppliedTurnKey: nonTerminal ? null : turnKeyOf((index + 1) % Math.max(1, turnsTotal)),
      createdPeriod: index % periods,
      nextEligiblePeriod: nonTerminal ? (index % periods) + 1 : null,
      reasonCode: status === "blocked" ? "NO_PATH" : null,
    };
  });

  // --- edges：无向去重（(A,B) 与 (B,A) 只留一条）---
  const kindCycle = ["adjacent", "route", "communication"];
  const edgeRows = [];
  for (let left = 0; left < locationIds.length && edgeRows.length < edges; left += 1) {
    for (let right = left + 1; right < locationIds.length && edgeRows.length < edges; right += 1) {
      const kind = kindCycle[edgeRows.length % kindCycle.length];
      edgeRows.push({
        id: `edge-a05-${String(edgeRows.length + 1).padStart(4, "0")}`,
        fromLocationId: locationIds[left],
        toLocationId: locationIds[right],
        kind,
        evidence: ["worldbook", "story", "manual"][edgeRows.length % 3],
        channel: kind === "communication" ? "message" : kind === "route" ? "vehicle" : "walk",
      });
    }
  }

  // --- areas：一地点每图一块有效范围；格点必须落在该图 frame（100×100）内且唯一 ---
  const areaRows = [];
  for (let index = 0; index < areas && index < submapLocations.length; index += 1) {
    const location = submapLocations[index];
    const cells = Array.from({ length: cellsPerArea }, (_, cellIndex) => ({
      x: (cellIndex * 3 + index) % 100,
      y: (cellIndex * 5 + index) % 100,
    }));
    areaRows.push({
      id: `area:${branchKey}|${location.mapId}|${location.id}`,
      locationId: location.id,
      mapId: location.mapId,
      cells,
      evidence: ["worldbook", "story", "manual"][index % 3],
    });
  }

  // --- vehicles：地点表里的移动载具本体；停靠 / 在途 / 未知三态 ---
  const vehiclePool = vehicleLocations.length > 0 ? vehicleLocations : locations.slice(0, Math.max(1, vehicles));
  const vehicleRows = Array.from({ length: vehicles }, (_, index) => {
    const location = vehiclePool[index % vehiclePool.length];
    const status = ["stopped", "en-route", "unknown"][index % 3];
    const routeEdge = edgeRows.find((edge) => edge.kind === "route" && index % 2 === 0) ?? null;
    return {
      id: location.id,
      locationId: location.id,
      atLocationId: status === "stopped" ? locationIds[(index + 1) % locationIds.length] : null,
      routeEdgeId: status === "en-route" ? (routeEdge ? routeEdge.id : null) : null,
      status,
      evidence: ["worldbook", "story", "manual"][index % 3],
    };
  });

  return {
    schemaVersion: 1,
    worldId,
    branches: {
      [branchKey]: {
        tasks: taskRows,
        signals: signalRows,
        deliveries: deliveryRows,
        geoTopology: { edges: edgeRows, areas: areaRows, vehicles: vehicleRows },
      },
    },
  };
}

/**
 * 构造 T16 规模的大体积会话文档（确定性；不写盘、不发请求）。
 *
 * 规模：5 图（world + 4 张子图）/ 50 人 / 200 物 / 120 tasks / 50 signals / 200 deliveries /
 * 128 edges / 16 染色区（各 8 格）/ 100 回合（每回合 4 条 simulationEvents）。
 * `locations`、`cellsPerArea`、`eventsPerTurn`、`vehicles` 为派生规模，可覆盖。
 * 参数不可能同时成立时**抛错**（绝不静默降低有效规模）。
 */
export function buildLargeSession(options = {}) {
  const cfg = { ...A05_DEFAULTS, ...options };
  const chatId = options.chatId ?? "chat-large-a05";
  const worldId = options.worldId ?? "world-large-a05";
  const branchKey = options.branchKey ?? "canon";
  const branchId = options.branchId ?? null;
  const now = options.now ?? 1758600000000;
  const cardName = options.cardName ?? "A05 体积基准";

  const hostCount = cfg.maps - 1;              // 子图宿主地点（各占一张子图）
  const childCount = hostCount * cfg.childrenPerSubmap;   // 每张子图的孩子（用于染色区 / 地图点）
  const minLocations = hostCount + childCount + cfg.vehicles + 1;
  if (cfg.maps < 1) throw new Error("buildLargeSession: maps 至少为 1（world 图）");
  if (cfg.locations < minLocations) {
    throw new Error(`buildLargeSession: locations=${cfg.locations} 不足以容纳 ${hostCount} 张子图 + ${childCount} 个孩子 + ${cfg.vehicles} 辆载具（至少 ${minLocations}）`);
  }
  if (cfg.areas > childCount) {
    throw new Error(`buildLargeSession: areas=${cfg.areas} 超过子图地点数 ${childCount}（一地点每图一块有效范围）`);
  }
  if (cfg.edges > (cfg.locations * (cfg.locations - 1)) / 2) {
    throw new Error("buildLargeSession: edges 超过地点两两组合上限");
  }

  // ---- 地点行：宿主（world）→ 子图孩子（mapId = 宿主）→ 世界图其余地点 → 移动载具 ----
  const locations = [];
  const hosts = [];
  for (let index = 1; index <= hostCount; index += 1) {
    const id = `loc:${index}`;
    hosts.push(id);
    locations.push({
      id, name: `区域${index}`, parentLocationId: null, description: `第 ${index} 张子图的宿主`,
      rumors: [], factions: [], mapId: "world",
      gridX: (index * 9) % 100, gridY: (index * 17) % 100,
    });
  }
  const children = [];
  for (let index = 0; index < childCount; index += 1) {
    const id = `loc:${hostCount + 1 + index}`;
    const host = hosts[index % hosts.length];
    children.push(id);
    locations.push({
      id, name: `房间${index + 1}`, parentLocationId: host, description: `区域${(index % hosts.length) + 1} 内的房间`,
      rumors: [], factions: [], mapId: host,
      // 房间确认在场但没有室内细坐标：gridX/Y = null，不得落到 (0,0)
      gridX: null, gridY: null,
    });
  }
  const vehicleBase = hostCount + childCount;
  const vehiclesPlanned = [];
  for (let index = 0; index < cfg.vehicles; index += 1) {
    const id = `loc:${vehicleBase + 1 + index}`;
    vehiclesPlanned.push(id);
    locations.push({
      id, name: `载具${index + 1}`, parentLocationId: null, description: "移动载具本体（停靠 / 在途 / 未知）",
      rumors: [], factions: [], mapId: "world", gridX: null, gridY: null,
    });
  }
  const remaining = cfg.locations - locations.length;
  for (let index = 0; index < remaining; index += 1) {
    locations.push({
      id: `loc:${vehicleBase + cfg.vehicles + 1 + index}`,
      name: `野外地点${index + 1}`, parentLocationId: null, description: "世界图上的确认地点",
      rumors: [], factions: [], mapId: "world",
      gridX: (index * 7 + 5) % 100, gridY: (index * 11 + 3) % 100,
    });
  }

  // ---- 人物 / 物品：引用同一分支的地点行 ----
  const characters = Array.from({ length: cfg.characters }, (_, index) => ({
    id: `npc:c${String(index + 1).padStart(3, "0")}`,
    name: `人物${index + 1}`,
    locationId: locations[index % locations.length].id,
    thought: `想法${index + 1}`,
    actionTendency: `倾向${index + 1}`,
    currentAction: index % 3 === 0 ? `正在行动${index + 1}` : "",
    targetLocationId: index % 4 === 0 ? locations[(index + 2) % locations.length].id : null,
    presence: "present",
    positionSource: index % 5 === 0 ? "routine" : "narrative",
    mapId: locations[index % locations.length].mapId,
    gridX: null, gridY: null,
  }));
  const items = Array.from({ length: cfg.items }, (_, index) => {
    const held = index % 5 === 0;
    const location = locations[index % locations.length];
    return {
      id: `item:i${String(index + 1).padStart(4, "0")}`,
      name: `物品${index + 1}`,
      description: `第 ${index + 1} 件物品`,
      locationId: held ? null : location.id,
      holderCharacterId: held ? characters[index % characters.length].id : null,
      status: index % 7 === 0 ? "破损" : "完好",
      mapId: held ? null : location.mapId,
      gridX: null, gridY: null,
    };
  });

  const tables = {
    schemaVersion: 1, worldId,
    branches: { [branchKey]: { locations, characters, items } },
  };

  // ---- 地图 sidecar：world + 每张子图各一个 frame / 标定（100 米/格 与 5 米/格）----
  const maps = { schemaVersion: 2, pointMeta: {}, submaps: {}, calibrations: {
    world: { revision: 1, metersPerCell: 100, source: "user", locked: true, basis: "世界书：约 10km × 10km", coverage: "约 10km × 10km", confidence: "high", at: now },
  } };
  for (const host of hosts) {
    const key = a05PointId(host);
    const kids = locations.filter((row) => row.parentLocationId === host);
    maps.pointMeta[key] = { description: `区域${key} 的子图入口` };
    maps.submaps[key] = {
      parentMapId: "world",
      ownerLocationId: key,
      frame: { cols: 100, rows: 100, frameRevision: 1 },
      points: kids.map((row, index) => ({
        id: a05PointId(row.id), name: row.name,
        x: (index * 13) % 100, y: (index * 19) % 100,
      })),
    };
    maps.calibrations[host] = { revision: 1, metersPerCell: 5, source: "user", locked: true, basis: "室内图：人工标定 5 米/格", coverage: "约 500m × 500m", confidence: "high", at: now };
  }

  // ---- world 兼容镜像（示意排版坐标；真实距离只读三表确认坐标）----
  const world = {
    schemaVersion: 1, id: worldId, name: `${cardName} 的世界`, description: "",
    currentRegionId: null, currentYear: 1, createdAt: now, updatedAt: now,
    regions: [],
    points: locations.map((row, index) => ({
      id: Number(a05PointId(row.id)), name: row.name,
      x: row.gridX ?? (index * 7) % 100, y: row.gridY ?? (index * 13) % 100,
      regionId: null,
      ...(row.parentLocationId !== null ? { parentPointId: Number(a05PointId(row.parentLocationId)) } : {}),
    })),
    characters: characters.map((row) => ({
      id: row.id.replace(/^npc:/, ""), worldId, name: row.name, role: "配角",
      description: "", currentRegionId: null,
    })),
    characterStates: characters.map((row) => ({
      characterId: row.id.replace(/^npc:/, ""), currentRegionId: null,
      currentPointId: a05PointId(row.locationId), status: "", updatedAt: now, branchId,
    })),
  };

  // ---- simulation（§2.1）：可就地构造，也可用 simulation:false 只测三表/回合 ----
  const simulation = cfg.simulation === false
    ? null
    : buildLargeSimulation({
      worldId, branchKey, chatId, locations, characters,
      tasks: cfg.tasks, signals: cfg.signals, deliveries: cfg.deliveries,
      edges: cfg.edges, areas: cfg.areas, vehicles: cfg.vehicles,
      cellsPerArea: cfg.cellsPerArea, topicChars: cfg.topicChars, turnsTotal: cfg.turns,
    });

  // ---- turns：100 个已提交回合（每回合带 simulationEvents + simulationUndo）----
  const turns = {};
  for (let index = 1; index <= cfg.turns; index += 1) {
    const turnKey = largeSessionTurnKey(chatId, index);
    const events = Array.from({ length: cfg.eventsPerTurn }, (_, eventIndex) => ({
      id: `evt-a05-${String(index).padStart(3, "0")}-${eventIndex + 1}`,
      simulationId: `task-a05-${String((index + eventIndex) % Math.max(1, cfg.tasks) + 1).padStart(4, "0")}`,
      kind: ["travel", "delivery", "signal", "intent"][(index + eventIndex) % 4],
      actorCharacterId: characters[(index + eventIndex) % characters.length].id,
      fromLocationId: locations[(index + eventIndex) % locations.length].id,
      toLocationId: locations[(index + eventIndex + 1) % locations.length].id,
      status: ["progressed", "delivered", "published", "intent-recorded"][(index + eventIndex) % 4],
      reasonCode: null,
      summary: a05Text("第 " + index + " 回合动向", eventIndex, cfg.summaryChars),
      visibility: (index + eventIndex) % 6 === 0 ? "hidden" : "known",
      period: index,
    }));
    turns[turnKey] = {
      schemaVersion: 1, branchId, chatId, effectiveAt: index,
      idempotencyKey: turnKey,
      userMessageId: `msg-u${index}`, assistantMessageId: `msg-a${index}`, swipeId: null,
      checkpointId: null, committedAt: now + index,
      createdPointIds: [], createdRegionIds: [], createdEntityIds: [],
      tablesBefore: null,
      receipt: {
        receiptId: `rcpt-a05-${index}`, status: "committed", branchId,
        previousTime: index - 1, currentTime: index,
        previousLocationId: locations[index % locations.length].id,
        currentLocationId: locations[(index + 1) % locations.length].id,
        triggeredNpcIds: [characters[index % characters.length].id],
        adoptedEventIds: [], retryable: false,
        summary: `表格增量：应用 ${index % 5} 行；时间推进 1 段`,
      },
      simulationEvents: events,
      simulationUndo: [
        { collection: "tasks", id: `task-a05-${String(index).padStart(4, "0")}`, before: null },
        { collection: "vehicles", id: vehiclesPlanned[index % vehiclesPlanned.length], before: null },
      ],
    };
  }

  const binding = {
    schemaVersion: 1, enabled: true, chatId, characterId: `card-${worldId}`,
    worldId, branchId, currentLocationId: locations[0].id, worldTimeCursor: cfg.turns,
    lastCommittedMessageId: `msg-a${cfg.turns}`, lastCheckpointId: null,
  };

  return {
    schemaVersion: 1,
    rev: options.rev ?? 7,
    binding,
    world,
    maps,
    scene: null,
    turns,
    geoAuto: {},
    tables,
    simulation,
  };
}

/** 分块字符数（JSON.stringify 口径；null / undefined 记 0）。 */
function a05Chars(value) {
  if (value === null || value === undefined) return 0;
  return JSON.stringify(value).length;
}

/** 汇总会话里的关键集合条数（供断言与越界判定）。 */
export function countSessionCollections(session) {
  const simulationBranches = Object.values(session?.simulation?.branches ?? {});
  const tableBranches = Object.values(session?.tables?.branches ?? {});
  const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row)?.length ?? 0), 0);
  const areaCells = simulationBranches.flatMap((branch) => branch.geoTopology?.areas ?? []).map((area) => area.cells?.length ?? 0);
  return {
    maps: 1 + Object.keys(session?.maps?.submaps ?? {}).length,
    submaps: Object.keys(session?.maps?.submaps ?? {}).length,
    calibrations: Object.keys(session?.maps?.calibrations ?? {}).length,
    turns: Object.keys(session?.turns ?? {}).length,
    tableBranches: tableBranches.length,
    locations: sum(tableBranches, (branch) => branch.locations),
    characters: sum(tableBranches, (branch) => branch.characters),
    items: sum(tableBranches, (branch) => branch.items),
    simulationBranches: simulationBranches.length,
    tasks: sum(simulationBranches, (branch) => branch.tasks),
    activeTasks: simulationBranches.flatMap((branch) => branch.tasks ?? [])
      .filter((task) => task.status !== "resolved" && task.status !== "cancelled").length,
    signals: sum(simulationBranches, (branch) => branch.signals),
    deliveries: sum(simulationBranches, (branch) => branch.deliveries),
    edges: sum(simulationBranches, (branch) => branch.geoTopology?.edges),
    areas: sum(simulationBranches, (branch) => branch.geoTopology?.areas),
    areaCells: areaCells.reduce((total, count) => total + count, 0),
    maxAreaCells: areaCells.length > 0 ? Math.max(...areaCells) : 0,
    vehicles: sum(simulationBranches, (branch) => branch.geoTopology?.vehicles),
  };
}

/** 越界项：具名 code + 字段路径 + 实测值 + 上限（永不静默截断，只如实报告）。 */
export function findSessionSizeViolations({ session, blocks, counts, payloadChars = null, limits = SESSION_SIZE_LIMITS } = {}) {
  const violations = [];
  const measured = blocks ?? measureSessionSize(session, { limits }).blocks;
  const counted = counts ?? countSessionCollections(session);

  if (session?.simulation != null && measured.simulation > limits.simulationJsonChars) {
    violations.push({
      code: "SIMULATION_TOO_LARGE", path: "$.simulation",
      actual: measured.simulation, limit: limits.simulationJsonChars,
    });
  }
  const collectionCaps = [
    ["locations", counted.locations, limits.collections.locations],
    ["characters", counted.characters, limits.collections.characters],
    ["items", counted.items, limits.collections.items],
    ["tasks", counted.tasks, limits.collections.tasks],
    ["signals", counted.signals, limits.collections.signals],
    ["deliveries", counted.deliveries, limits.collections.deliveries],
    ["edges", counted.edges, limits.collections.edges],
    ["areas", counted.areas, limits.collections.areas],
    ["vehicles", counted.vehicles, limits.collections.vehicles],
  ];
  for (const [name, actual, limit] of collectionCaps) {
    if (actual > limit) {
      violations.push({ code: "COLLECTION_LIMIT_REACHED", path: name, actual, limit });
    }
  }
  if (counted.activeTasks > limits.collections.activeTasks) {
    violations.push({ code: "ACTIVE_TASKS_EXCEEDED", path: "tasks", actual: counted.activeTasks, limit: limits.collections.activeTasks });
  }
  if (counted.maxAreaCells > limits.collections.areaCells) {
    violations.push({ code: "AREA_CELLS_EXCEEDED", path: "geoTopology.areas", actual: counted.maxAreaCells, limit: limits.collections.areaCells });
  }
  if (counted.turns > limits.turns) {
    violations.push({ code: "TURNS_EXCEEDED", path: "$.turns", actual: counted.turns, limit: limits.turns });
  }
  for (const branch of Object.values(session?.simulation?.branches ?? {})) {
    for (const [name, rows] of [["tasks", branch.tasks ?? []], ["signals", branch.signals ?? []]]) {
      for (const row of rows) {
        if (typeof row.id === "string" && row.id.length > limits.textChars.id) {
          violations.push({ code: "ID_TOO_LONG", path: `${name}.id`, actual: row.id.length, limit: limits.textChars.id });
        }
        if (typeof row.topic === "string" && row.topic.length > limits.textChars.topic) {
          violations.push({ code: "TOPIC_TOO_LONG", path: `${name}.topic`, actual: row.topic.length, limit: limits.textChars.topic });
        }
      }
    }
  }
  for (const turn of Object.values(session?.turns ?? {})) {
    const events = turn.simulationEvents ?? [];
    if (events.length > limits.eventsPerTurn) {
      violations.push({ code: "EVENTS_PER_TURN_EXCEEDED", path: "turns.simulationEvents", actual: events.length, limit: limits.eventsPerTurn });
    }
    for (const event of events) {
      if (typeof event.summary === "string" && event.summary.length > limits.textChars.event) {
        violations.push({ code: "EVENT_SUMMARY_TOO_LONG", path: "simulationEvents.summary", actual: event.summary.length, limit: limits.textChars.event });
        break;
      }
    }
  }
  if (typeof limits.payloadChars === "number" && limits.payloadChars > 0 && payloadChars !== null && payloadChars > limits.payloadChars) {
    violations.push({ code: "PAYLOAD_TOO_LARGE", path: "$.payload", actual: payloadChars, limit: limits.payloadChars });
  }
  return violations;
}

/** 载体真实发送的请求体（与 createSessionCarrier 内部一致：body + session）。 */
export function sessionRequestPayload(session, { method = "POST", path = "/state", chatId = null, body = {} } = {}) {
  const resolvedChatId = chatId ?? session?.binding?.chatId ?? null;
  const requestBody = { chatId: resolvedChatId, ...body };
  if (SESSION_ROUTE_METHODS(method, path)) return { ...requestBody, session };
  return requestBody;
}

/**
 * 体积实测（纯测量，不同步发请求）：
 * - total：整份会话 JSON 字符数；
 * - blocks：tables / simulation / turns / maps / world / scene / geoAuto 分块字符数；
 * - payload：载体真实 POST /state 请求体字符数（单请求 payload 大小）；
 * - counts：各集合条数；limits / violations：§2.1 越界判定（**只报告，不截断**）。
 */
export function measureSessionSize(session, { limits = SESSION_SIZE_LIMITS, chatId = null, method = "POST", path = "/state", body = {} } = {}) {
  const blocks = {
    tables: a05Chars(session?.tables),
    simulation: a05Chars(session?.simulation),
    turns: a05Chars(session?.turns),
    maps: a05Chars(session?.maps),
    world: a05Chars(session?.world),
    scene: a05Chars(session?.scene),
    geoAuto: a05Chars(session?.geoAuto),
  };
  const total = a05Chars(session);
  const payloadChars = a05Chars(sessionRequestPayload(session, { method, path, chatId, body }));
  const counts = countSessionCollections(session);
  const violations = findSessionSizeViolations({ session, blocks, counts, payloadChars, limits });
  return {
    total,
    blocks,
    payload: { route: `${method} ${path}`, chars: payloadChars, chatId: chatId ?? session?.binding?.chatId ?? null },
    counts,
    limits,
    violations,
    ok: violations.length === 0,
  };
}

/**
 * 一次真实 `handle` 往返（payload 大小 + 耗时）。返回 status/ok/elapsedMs，
 * 并把响应带回的新会话字符数一并记录；不吞错误（调用方自行断言 status）。
 */
export async function measureSessionRoundTrip(carrier, { chatId = null, method = "POST", path = "/state", body = {}, ctx = undefined } = {}) {
  if (!carrier || typeof carrier.handle !== "function") {
    throw new Error("measureSessionRoundTrip 需要一个载体（createSessionCarrier(core, ...)）");
  }
  const session = carrier.session;
  const resolvedChatId = chatId ?? session?.binding?.chatId ?? null;
  const payload = sessionRequestPayload(session, { method, path, chatId: resolvedChatId, body });
  const payloadChars = a05Chars(payload);
  const startedAt = performance.now();
  const result = await carrier.handle(method, path, { chatId: resolvedChatId, ...body }, ctx);
  const elapsedMs = performance.now() - startedAt;
  return {
    method, path, chatId: resolvedChatId,
    status: result?.status ?? null,
    ok: result?.body?.ok ?? null,
    error: result?.body?.error?.code ?? null,
    payloadChars,
    responseChars: a05Chars(result?.body),
    sessionChars: a05Chars(carrier.session),
    elapsedMs,
  };
}

/**
 * 带体积守卫的写入：越界候选**在发请求之前**就被拒绝，旧档保持原样。
 * 返回 { accepted, code, measurement, status?, response?, session, writtenSession }。
 *
 * 候选会话按载体真实路径发请求（`carrier.core.handle` + 请求体携带 session），
 * 因此「被拒绝」与「被服务端接受」两种情况都能实测；载体自身的会话只在成功路径
 * 由调用方决定是否采用（本函数不修改 carrier.session，便于断言旧档逐字节不变）。
 * `writtenSession` 是响应带回的下一版会话——服务端只在会话确有改动时回写，
 * 因此只读往返下它可能为 null（这是既有契约，不是失败）。
 *
 * 说明：守卫是测试侧实现（C02 的 validateSimulationStore + C09 的候选校验落地后，
 * 这里应改为走服务端真实拒绝路径；在此之前它至少保证「越界不写」这一条纪律可执行、可断言）。
 */
export async function writeSessionGuarded(carrier, candidate, { limits = SESSION_SIZE_LIMITS, method = "POST", path = "/state", body = {}, chatId = null, ctx = undefined } = {}) {
  if (!carrier || typeof carrier.core?.handle !== "function") {
    throw new Error("writeSessionGuarded 需要一个载体（createSessionCarrier(core, ...)）");
  }
  const measurement = measureSessionSize(candidate, { limits });
  if (!measurement.ok) {
    return { accepted: false, code: "SESSION_SIZE_REJECTED", measurement, wrote: false, session: carrier.session };
  }
  const resolvedChatId = chatId ?? candidate?.binding?.chatId ?? null;
  const requestBody = sessionRequestPayload(candidate, { method, path, chatId: resolvedChatId, body });
  const result = await carrier.core.handle(method, path, requestBody, ctx);
  const accepted = result?.status === 200;
  return {
    accepted,
    code: accepted ? null : (result?.body?.error?.code ?? "REQUEST_FAILED"),
    measurement,
    wrote: true,
    status: result?.status ?? null,
    response: result,
    session: carrier.session,
    writtenSession: result?.body?.session ?? null,
  };
}

/** 「越界输入被校验拒绝、不损坏旧档」的断言能力（越界候选必须被拒，旧档逐字节不变）。 */
export async function assertOversizedSessionWriteRejected(carrier, candidate, options = {}) {
  const beforeJson = JSON.stringify(carrier.session ?? null);
  const beforeRev = carrier.session?.rev ?? null;
  const outcome = await writeSessionGuarded(carrier, candidate, options);
  assert.equal(outcome.accepted, false, "越界候选必须被拒绝，绝不能写入");
  assert.equal(outcome.code, "SESSION_SIZE_REJECTED");
  assert.equal(outcome.wrote, false, "越界候选不得发出写入请求");
  assert.ok(outcome.measurement.violations.length > 0, "拒绝必须带具名越界项（不得无声拒绝）");
  assert.equal(JSON.stringify(carrier.session ?? null), beforeJson, "被拒绝的写入不得改动旧档");
  assert.equal(carrier.session?.rev ?? null, beforeRev, "被拒绝的写入不得推进会话 rev");
  return outcome;
}
