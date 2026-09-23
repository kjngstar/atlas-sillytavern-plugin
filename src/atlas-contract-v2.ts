/**
 * atlas-contract-v2.ts — R05 推进协议 v2 契约（解析 + 校验，纯函数零副作用）。
 *
 * 对应《修复计划》第 5 节的精确定义：
 * - 输出顶层字段全部必在（缺数组 = 错误，不是缺省）；
 * - schemaVersion 必须 = 2，baseRevision 必须逐字复用请求值（过期提交拒绝）；
 * - evidence.quote 必须是指定 sourceId 的原文片段（包含校验）；
 * - 临时引用 new:loc:* / new:npc:*：本响应内唯一、类型相符、可解析；
 *   已知实体用原 ID，名称不是 ID；
 * - 位置 keep/clear → locationRef null；set → 必须有有效引用；
 *   presence keep 语义由调用方校验（需与 scene 相符）；
 * - 上限：别名 ≤8（各 ≤64 字）、新地点/人物各 ≤12、变化数组各 ≤64、证据 ≤64、
 *   摘要/记忆 ≤500 字、引文 ≤240 字。
 *
 * 错误返回 JSON 路径 + 原因（不静默裁剪、不伪造成功）。
 * v1 输出（无 schemaVersion 字段）由调用方先分流——本解析器对 v1 报明确版本错误。
 *
 * 引用解析纪律：本模块只做**语法**校验（ref 形状、重复、证据包含）；
 * 「已知实体用原 ID / new: 引用可解析」的**语义**校验由 atlas-turn-v2.ts 在
 * 候选世界构建时完成——那里同时持有已知集合与临时引用分配表。
 */

export interface AtlasV2Draft {
  schemaVersion: 2;
  baseRevision: number;
  duration: number;
  evidence: Array<{ id: string; sourceId: string; quote: string }>;
  discoveries: {
    locations: Array<{ ref: string; name: string; aliases: string[]; regionRef: string | null; parentLocationRef: string | null; evidenceIds: string[] }>;
    characters: Array<{ ref: string; displayName: string; aliases: string[]; description: string; evidenceIds: string[] }>;
  };
  scene: { resolution: "confirmed" | "estimated" | "unknown" | "conflict"; locationRef: string | null; transition: "stay" | "arrive" | "initial" | "unknown"; evidenceIds: string[] };
  identityUpdates: Array<{ entityRef: string; displayName: string; addAliases: string[]; evidenceIds: string[] }>;
  npcUpdates: Array<{ entityRef: string; location: { op: "keep" | "set" | "clear"; locationRef: string | null }; presence: "present" | "left" | "unknown"; status: string | null; evidenceIds: string[] }>;
  relationUpdates: Array<{ fromRef: string; toRef: string; key: string; value: unknown; evidenceIds: string[] }>;
  memories: Array<{ entityRef: string; text: string; evidenceIds: string[] }>;
  worldFlags: Array<{ key: string; value: unknown; evidenceIds: string[] }>;
  events: Array<{ summary: string; entityRefs: string[]; evidenceIds: string[] }>;
  mapScaleHints: Array<{ mapRef: string; frameRevision: number | null; status: "estimated" | "grounded" | "unknown" | "conflict"; extentMeters: { width: number; height: number } | null; basis: string; confidence: "low" | "medium" | "high"; evidenceIds: string[] }>;
  summary: string;
}

export interface AtlasV2ParseContext {
  /** 请求方声明的版本（草稿必须逐字复用） */
  baseRevision: number;
  /** sourceId → 原文（证据引文核验的依据） */
  sources: Record<string, string>;
}

export interface AtlasV2ParseError {
  path: string;
  message: string;
}

export type AtlasV2ParseResult =
  | { ok: true; draft: AtlasV2Draft }
  | { ok: false; errors: AtlasV2ParseError[] };

const LOC_REF = /^new:loc:[a-z0-9_-]{1,40}$/;
const NPC_REF = /^new:npc:[a-z0-9_-]{1,40}$/;
const MAX = { aliases: 8, aliasChars: 64, locations: 12, characters: 12, updates: 64, evidence: 64, summary: 500, memory: 500, quote: 240, status: 160 };

class V2Errors {
  list: AtlasV2ParseError[] = [];
  push(path: string, message: string) {
    if (this.list.length < 40) this.list.push({ path, message });
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}
function strArray(v: unknown, path: string, err: V2Errors): string[] {
  if (!Array.isArray(v)) {
    err.push(path, "必须是字符串数组");
    return [];
  }
  return v.filter((item) => {
    if (!isStr(item)) {
      err.push(path, "含非字符串元素");
      return false;
    }
    return true;
  });
}
function evidenceIds(v: unknown, path: string, err: V2Errors, evidenceIds: Set<string>): string[] {
  const ids = strArray(v, path, err);
  for (const id of ids) {
    if (!evidenceIds.has(id)) err.push(`${path}.${id}`, "引用了不存在的 evidence id");
  }
  return ids;
}

/** 解析并校验 v2 草稿；任何失败返回结构化错误路径列表。 */
export function parseAtlasWorldTurnDraftV2(text: string, ctx: AtlasV2ParseContext): AtlasV2ParseResult {
  const err = new V2Errors();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ path: "$", message: "输出不是合法 JSON" }] };
  }
  if (!isObj(raw)) return { ok: false, errors: [{ path: "$", message: "顶层必须是 JSON 对象" }] };

  const version = raw.schemaVersion;
  if (version === undefined) {
    return { ok: false, errors: [{ path: "$.schemaVersion", message: "缺少 schemaVersion（v1 输出应走 v1 解析器）" }] };
  }
  if (version !== 2) {
    return { ok: false, errors: [{ path: "$.schemaVersion", message: `协议版本不匹配：期望 2，收到 ${String(version)}` }] };
  }
  if (typeof raw.baseRevision !== "number" || !Number.isFinite(raw.baseRevision) ||
      raw.baseRevision < 0 || raw.baseRevision !== ctx.baseRevision) {
    err.push("$.baseRevision", `必须逐字复用请求值 ${ctx.baseRevision}（收到 ${JSON.stringify(raw.baseRevision)}；过期提交拒绝）`);
  }

  // duration：有限非负整数 0..10000
  const duration = raw.duration;
  if (!isInt(duration) || duration < 0 || duration > 10000) {
    err.push("$.duration", "必须是 0..10000 的整数");
  }

  // evidence：先收 id 集合，供后续 evidenceIds 引用校验
  const evidenceIdsSet = new Set<string>();
  const evidenceOut: AtlasV2Draft["evidence"] = [];
  if (!Array.isArray(raw.evidence)) {
    err.push("$.evidence", "必须是数组");
  } else if (raw.evidence.length > MAX.evidence) {
    err.push("$.evidence", `超过上限 ${MAX.evidence} 条`);
  } else {
    raw.evidence.forEach((item, i) => {
      const path = `$.evidence[${i}]`;
      if (!isObj(item)) {
        err.push(path, "必须是对象");
        return;
      }
      const id = isStr(item.id) ? item.id : "";
      const sourceId = isStr(item.sourceId) ? item.sourceId : "";
      const quote = isStr(item.quote) ? item.quote : "";
      if (!id) err.push(`${path}.id`, "缺少 id");
      if (!sourceId) {
        err.push(`${path}.sourceId`, "缺少 sourceId");
      } else if (!(sourceId in ctx.sources)) {
        err.push(`${path}.sourceId`, `来源不存在：${sourceId}`);
      }
      if (!quote) {
        err.push(`${path}.quote`, "缺少 quote");
      } else {
        if (quote.length > MAX.quote) err.push(`${path}.quote`, `引文超过 ${MAX.quote} 字`);
        const sourceText = ctx.sources[sourceId] ?? "";
        if (sourceId in ctx.sources && !sourceText.includes(quote)) {
          err.push(`${path}.quote`, "引文不是来源原文片段（包含校验失败）");
        }
      }
      if (id) {
        if (evidenceIdsSet.has(id)) err.push(`${path}.id`, `evidence id 重复：${id}`);
        evidenceIdsSet.add(id);
      }
      evidenceOut.push({ id, sourceId, quote });
    });
  }

  // discoveries
  const locRefs = new Set<string>();
  const npcRefs = new Set<string>();
  const locationsOut: AtlasV2Draft["discoveries"]["locations"] = [];
  const charactersOut: AtlasV2Draft["discoveries"]["characters"] = [];
  if (!isObj(raw.discoveries)) {
    err.push("$.discoveries", "必须是对象 {locations, characters}");
  } else {
    const disc = raw.discoveries;
    if (!Array.isArray(disc.locations)) err.push("$.discoveries.locations", "必须是数组");
    else if (disc.locations.length > MAX.locations) err.push("$.discoveries.locations", `超过上限 ${MAX.locations}`);
    else {
      disc.locations.forEach((item, i) => {
        const path = `$.discoveries.locations[${i}]`;
        if (!isObj(item)) {
          err.push(path, "必须是对象");
          return;
        }
        const ref = isStr(item.ref) ? item.ref : "";
        if (!LOC_REF.test(ref)) {
          err.push(`${path}.ref`, `ref 必须匹配 new:loc:<短名>（收到 ${ref || "空"}）`);
        } else if (locRefs.has(ref)) {
          err.push(`${path}.ref`, `临时引用重复：${ref}`);
        } else {
          locRefs.add(ref);
        }
        const name = isStr(item.name) ? item.name.trim() : "";
        if (!name || name.length > 64) err.push(`${path}.name`, "地点名必填且 ≤64 字");
        const aliases = strArray(item.aliases, `${path}.aliases`, err);
        if (aliases.length > MAX.aliases) err.push(`${path}.aliases`, `超过上限 ${MAX.aliases}`);
        for (const alias of aliases) {
          if (alias.length > MAX.aliasChars) err.push(`${path}.aliases`, `别名超过 ${MAX.aliasChars} 字`);
        }
        const regionRef = item.regionRef === undefined || item.regionRef === null ? null : isStr(item.regionRef) ? item.regionRef : false;
        if (regionRef === false) err.push(`${path}.regionRef`, "必须是已知地区 ID 或 null");
        const parentRef = item.parentLocationRef === undefined || item.parentLocationRef === null ? null : isStr(item.parentLocationRef) ? item.parentLocationRef : false;
        if (parentRef === false) err.push(`${path}.parentLocationRef`, "必须是已知地点 ID、new:loc: 引用或 null");
        locationsOut.push({
          ref,
          name,
          aliases: aliases.slice(0, MAX.aliases),
          regionRef: regionRef === false ? null : regionRef,
          parentLocationRef: parentRef === false ? null : parentRef,
          evidenceIds: evidenceIds(item.evidenceIds, `${path}.evidenceIds`, err, evidenceIdsSet),
        });
      });
    }
    if (!Array.isArray(disc.characters)) err.push("$.discoveries.characters", "必须是数组");
    else if (disc.characters.length > MAX.characters) err.push("$.discoveries.characters", `超过上限 ${MAX.characters}`);
    else {
      disc.characters.forEach((item, i) => {
        const path = `$.discoveries.characters[${i}]`;
        if (!isObj(item)) {
          err.push(path, "必须是对象");
          return;
        }
        const ref = isStr(item.ref) ? item.ref : "";
        if (!NPC_REF.test(ref)) {
          err.push(`${path}.ref`, `ref 必须匹配 new:npc:<短名>（收到 ${ref || "空"}）`);
        } else if (npcRefs.has(ref)) {
          err.push(`${path}.ref`, `临时引用重复：${ref}`);
        } else {
          npcRefs.add(ref);
        }
        const displayName = isStr(item.displayName) ? item.displayName.trim() : "";
        if (!displayName || displayName.length > 64) err.push(`${path}.displayName`, "displayName 必填且 ≤64 字");
        const aliases = strArray(item.aliases, `${path}.aliases`, err);
        if (aliases.length > MAX.aliases) err.push(`${path}.aliases`, `超过上限 ${MAX.aliases}`);
        const description = isStr(item.description) ? item.description : "";
        charactersOut.push({
          ref,
          displayName,
          aliases: aliases.slice(0, MAX.aliases),
          description: description.slice(0, MAX.memory),
          evidenceIds: evidenceIds(item.evidenceIds, `${path}.evidenceIds`, err, evidenceIdsSet),
        });
      });
    }
  }

  const scene = parseScene(raw.scene, err, evidenceIdsSet);
  const identityUpdates = parseIdentityUpdates(raw.identityUpdates, err, evidenceIdsSet);
  const npcUpdates = parseNpcUpdates(raw.npcUpdates, err, evidenceIdsSet);
  const relationUpdates = parseRelationUpdates(raw.relationUpdates, err, evidenceIdsSet);
  const memories = parseMemories(raw.memories, err, evidenceIdsSet);
  const worldFlags = parseWorldFlags(raw.worldFlags, err, evidenceIdsSet);
  const events = parseEvents(raw.events, err, evidenceIdsSet);
  const mapScaleHints = parseMapScaleHints(raw.mapScaleHints, err, evidenceIdsSet);

  const summary = isStr(raw.summary) ? raw.summary.trim() : "";
  if (!summary) err.push("$.summary", "缺少摘要");
  if (summary.length > MAX.summary) err.push("$.summary", `摘要超过 ${MAX.summary} 字`);

  if (err.list.length > 0) return { ok: false, errors: err.list };
  return {
    ok: true,
    draft: {
      schemaVersion: 2,
      baseRevision: raw.baseRevision as number,
      duration: duration as number,
      evidence: evidenceOut,
      discoveries: { locations: locationsOut, characters: charactersOut },
      scene,
      identityUpdates,
      npcUpdates,
      relationUpdates,
      memories,
      worldFlags,
      events,
      mapScaleHints,
      summary,
    },
  };
}

function parseScene(raw: unknown, err: V2Errors, evIds: Set<string>): AtlasV2Draft["scene"] {
  const fallback: AtlasV2Draft["scene"] = { resolution: "unknown", locationRef: null, transition: "unknown", evidenceIds: [] };
  if (!isObj(raw)) {
    err.push("$.scene", "必须是对象");
    return fallback;
  }
  const resolutions = ["confirmed", "estimated", "unknown", "conflict"];
  const transitions = ["stay", "arrive", "initial", "unknown"];
  if (!resolutions.includes(String(raw.resolution))) err.push("$.scene.resolution", `必须是 ${resolutions.join("/")}`);
  if (!transitions.includes(String(raw.transition))) err.push("$.scene.transition", `必须是 ${transitions.join("/")}`);
  const locationRef = raw.locationRef === undefined || raw.locationRef === null ? null : isStr(raw.locationRef) ? raw.locationRef : false;
  if (locationRef === false) err.push("$.scene.locationRef", "必须是地点 ID、new:loc: 引用或 null");
  if (locationRef === null && (raw.resolution === "confirmed" || raw.resolution === "estimated")) {
    err.push("$.scene.locationRef", "resolution 为 confirmed/estimated 时必须提供 locationRef");
  }
  return {
    resolution: (resolutions.includes(String(raw.resolution)) ? String(raw.resolution) : "unknown") as AtlasV2Draft["scene"]["resolution"],
    locationRef: locationRef === false ? null : locationRef,
    transition: (transitions.includes(String(raw.transition)) ? String(raw.transition) : "unknown") as AtlasV2Draft["scene"]["transition"],
    evidenceIds: evidenceIds(raw.evidenceIds, "$.scene.evidenceIds", err, evIds),
  };
}

function parseIdentityUpdates(raw: unknown, err: V2Errors, evIds: Set<string>): AtlasV2Draft["identityUpdates"] {
  const out: AtlasV2Draft["identityUpdates"] = [];
  if (!Array.isArray(raw)) {
    err.push("$.identityUpdates", "必须是数组");
    return out;
  }
  if (raw.length > MAX.updates) err.push("$.identityUpdates", `超过上限 ${MAX.updates}`);
  raw.slice(0, MAX.updates).forEach((item, i) => {
    const path = `$.identityUpdates[${i}]`;
    if (!isObj(item)) {
      err.push(path, "必须是对象");
      return;
    }
    const entityRef = isStr(item.entityRef) ? item.entityRef : "";
    if (!entityRef) err.push(`${path}.entityRef`, "缺少 entityRef");
    const displayName = isStr(item.displayName) ? item.displayName.trim() : "";
    if (!displayName || displayName.length > 64) err.push(`${path}.displayName`, "displayName 必填且 ≤64 字（不得为空名）");
    const addAliases = strArray(item.addAliases, `${path}.addAliases`, err);
    if (addAliases.length > MAX.aliases) err.push(`${path}.addAliases`, `超过上限 ${MAX.aliases}`);
    out.push({
      entityRef,
      displayName,
      addAliases,
      evidenceIds: evidenceIds(item.evidenceIds, `${path}.evidenceIds`, err, evIds),
    });
  });
  return out;
}

function parseNpcUpdates(raw: unknown, err: V2Errors, evIds: Set<string>): AtlasV2Draft["npcUpdates"] {
  const out: AtlasV2Draft["npcUpdates"] = [];
  if (!Array.isArray(raw)) {
    err.push("$.npcUpdates", "必须是数组");
    return out;
  }
  if (raw.length > MAX.updates) err.push("$.npcUpdates", `超过上限 ${MAX.updates}`);
  const ops = ["keep", "set", "clear"];
  const presences = ["present", "left", "unknown"];
  raw.slice(0, MAX.updates).forEach((item, i) => {
    const path = `$.npcUpdates[${i}]`;
    if (!isObj(item)) {
      err.push(path, "必须是对象");
      return;
    }
    const entityRef = isStr(item.entityRef) ? item.entityRef : "";
    if (!entityRef) err.push(`${path}.entityRef`, "缺少 entityRef");
    let op: "keep" | "set" | "clear" = "keep";
    let locationRef: string | null = null;
    if (isObj(item.location)) {
      if (!ops.includes(String(item.location.op))) {
        err.push(`${path}.location.op`, `必须是 ${ops.join("/")}`);
      } else {
        op = String(item.location.op) as "keep" | "set" | "clear";
      }
      const ref = item.location.locationRef === undefined || item.location.locationRef === null ? null : isStr(item.location.locationRef) ? item.location.locationRef : false;
      if (ref === false) {
        err.push(`${path}.location.locationRef`, "必须是地点 ID、new:loc: 引用或 null");
      } else if (op === "set" && (ref === null || ref === "")) {
        err.push(`${path}.location.locationRef`, "op=set 必须提供有效地点引用");
      } else if ((op === "keep" || op === "clear") && ref !== null) {
        err.push(`${path}.location.locationRef`, `op=${op} 时 locationRef 必须为 null`);
      } else {
        locationRef = ref;
      }
    } else {
      err.push(`${path}.location`, "必须是对象 {op, locationRef}");
    }
    if (!presences.includes(String(item.presence))) err.push(`${path}.presence`, `必须是 ${presences.join("/")}`);
    let status: string | null = null;
    if (item.status !== undefined && item.status !== null) {
      if (!isStr(item.status)) err.push(`${path}.status`, "必须是字符串或 null");
      else {
        if (item.status.length > MAX.status) err.push(`${path}.status`, `超过 ${MAX.status} 字`);
        status = item.status;
      }
    }
    out.push({
      entityRef,
      location: { op, locationRef },
      presence: (presences.includes(String(item.presence)) ? String(item.presence) : "unknown") as AtlasV2Draft["npcUpdates"][number]["presence"],
      status,
      evidenceIds: evidenceIds(item.evidenceIds, `${path}.evidenceIds`, err, evIds),
    });
  });
  return out;
}

function parseRelationUpdates(raw: unknown, err: V2Errors, evIds: Set<string>): AtlasV2Draft["relationUpdates"] {
  const out: AtlasV2Draft["relationUpdates"] = [];
  if (!Array.isArray(raw)) {
    err.push("$.relationUpdates", "必须是数组");
    return out;
  }
  if (raw.length > MAX.updates) err.push("$.relationUpdates", `超过上限 ${MAX.updates}`);
  raw.slice(0, MAX.updates).forEach((item, i) => {
    const path = `$.relationUpdates[${i}]`;
    if (!isObj(item)) {
      err.push(path, "必须是对象");
      return;
    }
    const fromRef = isStr(item.fromRef) ? item.fromRef : "";
    const toRef = isStr(item.toRef) ? item.toRef : "";
    if (!fromRef) err.push(`${path}.fromRef`, "缺少 fromRef");
    if (!toRef) err.push(`${path}.toRef`, "缺少 toRef");
    const key = isStr(item.key) ? item.key.trim() : "";
    if (!key) err.push(`${path}.key`, "缺少关系字段 key");
    // 关系值语义（0.9.53 A3）：与账本 validateEffect 同一条判定规则——非空字符串或
    // 有限数字。旧实现只查 `!== undefined`，会把 null / 布尔 / 对象 / 数组直接送进
    // 应用层；空白字符串到账本才被拒。此处不擅自把非法对象 JSON.stringify 成字符串，
    // 仍由 V2Errors 汇总拒绝整份草稿。
    const value = item.value;
    const validValue = typeof value === "number"
      ? Number.isFinite(value)
      : typeof value === "string" && value.trim().length > 0;
    if (value === undefined) err.push(`${path}.value`, "缺少 value");
    else if (!validValue) err.push(`${path}.value`, "必须是非空字符串或有限数字");
    out.push({
      fromRef,
      toRef,
      key,
      value,
      evidenceIds: evidenceIds(item.evidenceIds, `${path}.evidenceIds`, err, evIds),
    });
  });
  return out;
}

function parseMemories(raw: unknown, err: V2Errors, evIds: Set<string>): AtlasV2Draft["memories"] {
  const out: AtlasV2Draft["memories"] = [];
  if (!Array.isArray(raw)) {
    err.push("$.memories", "必须是数组");
    return out;
  }
  if (raw.length > MAX.updates) err.push("$.memories", `超过上限 ${MAX.updates}`);
  raw.slice(0, MAX.updates).forEach((item, i) => {
    const path = `$.memories[${i}]`;
    if (!isObj(item)) {
      err.push(path, "必须是对象");
      return;
    }
    const entityRef = isStr(item.entityRef) ? item.entityRef : "";
    if (!entityRef) err.push(`${path}.entityRef`, "缺少 entityRef");
    const text = isStr(item.text) ? item.text.trim() : "";
    if (!text) err.push(`${path}.text`, "缺少记忆正文");
    if (text.length > MAX.memory) err.push(`${path}.text`, `超过 ${MAX.memory} 字`);
    out.push({ entityRef, text, evidenceIds: evidenceIds(item.evidenceIds, `${path}.evidenceIds`, err, evIds) });
  });
  return out;
}

function parseWorldFlags(raw: unknown, err: V2Errors, evIds: Set<string>): AtlasV2Draft["worldFlags"] {
  const out: AtlasV2Draft["worldFlags"] = [];
  if (!Array.isArray(raw)) {
    err.push("$.worldFlags", "必须是数组");
    return out;
  }
  if (raw.length > MAX.updates) err.push("$.worldFlags", `超过上限 ${MAX.updates}`);
  raw.slice(0, MAX.updates).forEach((item, i) => {
    const path = `$.worldFlags[${i}]`;
    if (!isObj(item)) {
      err.push(path, "必须是对象");
      return;
    }
    const key = isStr(item.key) ? item.key.trim() : "";
    if (!key) err.push(`${path}.key`, "缺少标记 key");
    out.push({ key, value: item.value, evidenceIds: evidenceIds(item.evidenceIds, `${path}.evidenceIds`, err, evIds) });
  });
  return out;
}

function parseEvents(raw: unknown, err: V2Errors, evIds: Set<string>): AtlasV2Draft["events"] {
  const out: AtlasV2Draft["events"] = [];
  if (!Array.isArray(raw)) {
    err.push("$.events", "必须是数组");
    return out;
  }
  if (raw.length > MAX.updates) err.push("$.events", `超过上限 ${MAX.updates}`);
  raw.slice(0, MAX.updates).forEach((item, i) => {
    const path = `$.events[${i}]`;
    if (!isObj(item)) {
      err.push(path, "必须是对象");
      return;
    }
    const summary = isStr(item.summary) ? item.summary.trim() : "";
    if (!summary) err.push(`${path}.summary`, "缺少事件摘要");
    if (summary.length > MAX.summary) err.push(`${path}.summary`, `超过 ${MAX.summary} 字`);
    const entityRefs = strArray(item.entityRefs, `${path}.entityRefs`, err);
    out.push({ summary, entityRefs, evidenceIds: evidenceIds(item.evidenceIds, `${path}.evidenceIds`, err, evIds) });
  });
  return out;
}

function parseMapScaleHints(raw: unknown, err: V2Errors, evIds: Set<string>): AtlasV2Draft["mapScaleHints"] {
  const out: AtlasV2Draft["mapScaleHints"] = [];
  if (!Array.isArray(raw)) {
    err.push("$.mapScaleHints", "必须是数组");
    return out;
  }
  if (raw.length > MAX.updates) err.push("$.mapScaleHints", `超过上限 ${MAX.updates}`);
  const statuses = ["estimated", "grounded", "unknown", "conflict"];
  const confidences = ["low", "medium", "high"];
  raw.slice(0, MAX.updates).forEach((item, i) => {
    const path = `$.mapScaleHints[${i}]`;
    if (!isObj(item)) {
      err.push(path, "必须是对象");
      return;
    }
    const mapRef = isStr(item.mapRef) ? item.mapRef : "";
    if (!mapRef) err.push(`${path}.mapRef`, "缺少 mapRef");
    if (!statuses.includes(String(item.status))) err.push(`${path}.status`, `必须是 ${statuses.join("/")}`);
    let extentMeters: { width: number; height: number } | null = null;
    if (item.extentMeters !== undefined && item.extentMeters !== null) {
      if (isObj(item.extentMeters) && typeof item.extentMeters.width === "number" && item.extentMeters.width > 0 && typeof item.extentMeters.height === "number" && item.extentMeters.height > 0) {
        extentMeters = { width: item.extentMeters.width, height: item.extentMeters.height };
      } else {
        err.push(`${path}.extentMeters`, "必须是 {width>0, height>0} 或 null");
      }
    }
    if (!confidences.includes(String(item.confidence))) err.push(`${path}.confidence`, `必须是 ${confidences.join("/")}`);
    const frameRevision = item.frameRevision === undefined || item.frameRevision === null ? null : isInt(item.frameRevision) ? item.frameRevision : false;
    if (frameRevision === false) err.push(`${path}.frameRevision`, "必须是整数或 null");
    out.push({
      mapRef,
      frameRevision: frameRevision === false ? null : frameRevision,
      status: (statuses.includes(String(item.status)) ? String(item.status) : "unknown") as AtlasV2Draft["mapScaleHints"][number]["status"],
      extentMeters,
      basis: isStr(item.basis) ? item.basis.slice(0, MAX.summary) : "",
      confidence: (confidences.includes(String(item.confidence)) ? String(item.confidence) : "low") as AtlasV2Draft["mapScaleHints"][number]["confidence"],
      evidenceIds: evidenceIds(item.evidenceIds, `${path}.evidenceIds`, err, evIds),
    });
  });
  return out;
}

