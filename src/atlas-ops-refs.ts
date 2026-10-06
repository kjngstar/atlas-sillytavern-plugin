/**
 * atlas-ops-refs.ts — 引用作用域、第一遍 new: 声明与引用解析（C05/C06；§16.5 步骤 2/3、§8.4、§18.2）。
 *
 * 三条不可动摇的规则：
 * 1. §16.5 步骤 2：第一遍登记全部 `ref: "new:<alias>"` 声明，之后才解析引用 →
 *    人物行可以引用本轮后面才建立的地点（§18.2 P02 前向引用）。
 * 2. `data` 里出现的 `new:` 是**引用**而不是声明。`{"data":{"location_ref":"new:missing"}}`
 *    若没有任何操作用 `ref:"new:missing"` 建立它，第二遍必须报 REF_UNKNOWN
 *    （§18.2 P05、§18.4 的 REF_UNKNOWN→C05/C06）。所以数据字段扫描只提供两件事：
 *    「引用字段期望的类型」提示，以及跨字段的同名引用信息；它绝不凭空造实体。
 * 3. 绝不按相似名字自动合并（§8.4）。别名只做精确匹配；显示名只有在
 *    `resolveByDisplayName` 里按规范化后的别名精确匹配才允许，且必须留下诊断。
 *
 * 本模块不引入 sql.js、DOM 或任何模块级副作用；确定性 ID 只用同步 SHA-256。
 */

import type { Issue, ParsedOperation, RefEntry, RefKind, TurnAnchor } from './atlas-ops-contract.ts';

/* ───────────────────────── §16.5 步骤 2：稳定 ID ───────────────────────── */

/** 3 字母类型前缀（§16.5 步骤 2 的固定标签表）。 */
export function refKindPrefix(kind: RefKind): string {
  switch (kind) {
    case 'location':
      return 'loc';
    case 'character':
      return 'chr';
    case 'item':
      return 'itm';
    case 'faction':
      return 'fac';
    case 'map':
      return 'map';
    case 'route':
      return 'rte';
    case 'action':
      return 'act';
    case 'journey':
      return 'jrn';
    case 'event':
      return 'evt';
    case 'information':
      return 'inf';
    case 'knowledge':
      return 'kno';
    case 'channel':
      return 'chn';
    case 'relation':
      return 'rel';
    case 'rumor_front':
      return 'rfr';
    case 'opportunity':
      return 'opp';
    case 'mention':
      return 'mnt';
    default:
      return 'ref';
  }
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * 同步 SHA-256（UTF-8）→ 64 位小写十六进制。
 * 不用 node:crypto（浏览器不可用），也不用异步 WebCrypto（makeId 必须同步）。
 * 同输入恒同输出，不依赖时间、随机数或宿主实现。
 */
function sha256Hex(text: string): string {
  const message = new TextEncoder().encode(text);
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(message);
  buffer[message.length] = 0x80;
  const bitLength = message.length * 8;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr32(x, 7) ^ rotr32(x, 18) ^ (x >>> 3);
      const s1 = rotr32(y, 17) ^ rotr32(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i += 1) hex += state[i].toString(16).padStart(8, '0');
  return hex;
}

const NEW_PREFIX = 'new:';

/** `new:elin` → `elin`；不是 new: 声明时返回 null。 */
function newAliasOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith(NEW_PREFIX)) return null;
  const alias = trimmed.slice(NEW_PREFIX.length).trim();
  return alias.length > 0 ? alias : null;
}

/**
 * §16.5 步骤 2 默认 ID：`sha256(chatUid \0 branchId \0 variantKey \0 alias \0 opId)`
 * 取十六进制前 24 位，加 3 字母类型前缀。同输入恒同 ID —— 修复保持原 opId 就保持同一个 ID。
 */
function defaultMakeId(anchor: TurnAnchor, alias: string, opId: string, kind: RefKind): string {
  const digest = sha256Hex([anchor.chatUid, anchor.branchId, anchor.variantKey, alias, opId].join('\u0000'));
  return `${refKindPrefix(kind)}_${digest.slice(0, 24)}`;
}

/* ───────────────────────── 引用字段与类型推断表 ───────────────────────── */

/**
 * `data` 中的引用字段 → 期望类型（null = 用操作名推断）。
 * 只扫描这张表里的键名，避免把 name/description 里的 "new:" 当成引用。
 */
const REFERENCE_FIELD_KINDS: Record<string, RefKind | null> = {
  ref: null,
  parent_ref: null,
  location_ref: 'location',
  target_location_ref: 'location',
  anchor_ref: 'location',
  headquarters_ref: 'location',
  destination_ref: 'location',
  spread_at_ref: 'location',
  place_ref: 'location',
  origin_ref: 'location',
  via_refs: 'location',
  from_ref: 'location',
  to_ref: 'location',
  map_ref: 'map',
  item_ref: 'item',
  container_ref: 'item',
  event_ref: 'event',
  target_event_ref: 'event',
  wait_for_event_ref: 'event',
  information_ref: 'information',
  channel_ref: 'channel',
  opportunity_ref: 'opportunity',
  action_ref: 'action',
  requires_action_ref: 'action',
  route_ref: 'route',
  // 下面这些在字段表里是「实体」而不是某一种实体；RefKind 没有 entity，
  // 因此默认按人物（最常见），具体类型由操作名或第二遍的类型检查兜住。
  holder_ref: 'character',
  sender_ref: 'character',
  originator_ref: 'character',
  actor_ref: 'character',
  recipient_ref: 'character',
  subject_ref: 'character',
  object_ref: 'character',
  entity_ref: 'character',
  entity_id: 'character',
  owner_ref: 'character',
  target_ref: 'character',
  other_ref: 'character',
  participants: 'character',
};

const REFERENCE_FIELDS = new Set(Object.keys(REFERENCE_FIELD_KINDS));

const OP_REF_KINDS: Record<string, RefKind> = {
  'location.upsert': 'location',
  'character.upsert': 'character',
  'item.upsert': 'item',
  'item.transfer': 'item',
  'faction.upsert': 'faction',
  'relation.upsert': 'relation',
  'plan.propose': 'action',
  'plan.revise': 'action',
  'event.propose': 'event',
  'information.propose': 'information',
  'attention.propose': 'knowledge',
  'channel.upsert': 'channel',
  'map.estimate': 'map',
  'map.layout.request': 'map',
  'route.propose': 'route',
};

/** 操作名推断类型；未知操作返回 null（此时才用引用字段的类型提示）。 */
function kindFromOp(op: string): RefKind | null {
  const table: Record<string, RefKind | undefined> = OP_REF_KINDS;
  return table[op] ?? null;
}

const MAX_SCAN_DEPTH = 12;

type NewRefHit = { alias: string; field: string; kind: RefKind | null };

/**
 * 扫描 `data` 里的 `new:` 出现位置（引用，不是声明）。
 * 递归覆盖 `to`/`from`/`scope`/`steps[]`/`effects[]`/`participants[]` 等嵌套位置；
 * 只认引用字段名，深度上限防病态输入。
 */
function scanNewRefs(data: unknown, visit: (hit: NewRefHit) => void): void {
  const walk = (node: unknown, field: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    if (typeof node === 'string') {
      const alias = newAliasOf(node);
      if (alias !== null && REFERENCE_FIELDS.has(field)) {
        visit({ alias, field, kind: REFERENCE_FIELD_KINDS[field] ?? null });
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, field, depth + 1);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, key, depth + 1);
    }
  };
  if (data !== null && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) walk(value, key, 1);
  }
}

/* ─── map.layout.request：spec 内的嵌套引用扫描（P03） ─── */

/**
 * spec 集合 → 引用字段及期望的实体类型。
 * `contents` **不在**表里：家具 group 的 id 是局部视觉 ID，
 * 不进 entity_keys、不声明依赖，只作为 near/on 的匹配池。
 */
export const LAYOUT_SPEC_REF_FIELDS: Readonly<Record<string, Readonly<Record<string, RefKind>>>> = {
  rooms: { id: 'location' },
  actors: { id: 'character', roomId: 'location' },
  items: { id: 'item' },
  districts: { id: 'location' },
  buildings: { id: 'location', districtId: 'location' },
};

/** 家具（局部视觉 ID）所在集合。 */
export const LAYOUT_LOCAL_COLLECTION = 'contents';

/** 指向家具组的局部关联字段：只做池内匹配，绝不解析成实体。 */
export const LAYOUT_LOCAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  actors: ['near'],
  items: ['on'],
};

export type LayoutRefHit = {
  /** 不含 `new:` 前缀的别名。 */
  alias: string;
  /** 相对 `$.data.` 的路径，例如 `spec.rooms[0].id`。 */
  path: string;
  /** 期望实体类型；局部关联为 null。 */
  kind: RefKind | null;
  /** true = 局部视觉 ID（家具组），不建 entity_keys。 */
  local: boolean;
};

/**
 * 扫描 layout spec 里的 `new:` 引用。
 * 只认上表列出的字段：`description` / `name` 等自由文本里写 `new:xxx`
 * 一律不算引用（也不会被改写）。
 */
export function scanLayoutSpecRefs(spec: unknown, visit: (hit: LayoutRefHit) => void): void {
  if (spec === null || typeof spec !== 'object') return;
  const root = spec as Record<string, unknown>;
  for (const [collection, fields] of Object.entries(LAYOUT_SPEC_REF_FIELDS)) {
    const rows = root[collection];
    if (!Array.isArray(rows)) continue;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row === null || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      for (const [field, kind] of Object.entries(fields)) {
        const alias = newAliasOf(record[field]);
        if (alias === null) continue;
        visit({ alias, path: `spec.${collection}[${i}].${field}`, kind, local: false });
      }
      for (const field of LAYOUT_LOCAL_FIELDS[collection] ?? []) {
        const alias = newAliasOf(record[field]);
        if (alias === null) continue;
        visit({ alias, path: `spec.${collection}[${i}].${field}`, kind: null, local: true });
      }
    }
  }
}

/** 某个操作声明/引用到的全部 `new:` 别名（不含 new: 前缀）。 */
function newAliasesOf(value: { ref?: unknown; op?: unknown; data?: unknown } | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (alias: string | null): void => {
    if (alias !== null && !seen.has(alias)) {
      seen.add(alias);
      out.push(alias);
    }
  };
  if (value && typeof value === 'object') {
    push(newAliasOf(value.ref));
    scanNewRefs(value.data, (hit) => push(hit.alias));
    if (value.op === 'map.layout.request') {
      scanLayoutSpecRefs((value.data as Record<string, unknown> | undefined)?.['spec'], (hit) =>
        push(hit.alias),
      );
    }
  }
  return out;
}

/* ───────────────────────── Issue 构造 ───────────────────────── */

type IssueWhere = { line?: number; opId?: string; groupId?: string; dependencyId?: string };

function makeIssue(
  code: string,
  path: string,
  message: string,
  severity: 'warning' | 'error',
  retryable: boolean,
  where?: IssueWhere,
): Issue {
  const issue: Issue = { code, path, message, severity, retryable };
  if (where && where.line !== undefined) issue.line = where.line;
  if (where && where.opId !== undefined) issue.opId = where.opId;
  if (where && where.groupId !== undefined) issue.groupId = where.groupId;
  if (where && where.dependencyId !== undefined) issue.dependencyId = where.dependencyId;
  return issue;
}

function refPath(field?: string): string {
  if (!field) return '$.ref';
  return field.startsWith('$.') ? field : `$.data.${field}`;
}

/* ───────────────────────── RefScope（C06 的解析基座） ───────────────────────── */

export type RefScope = {
  get(alias: string): RefEntry | null;
  all(): RefEntry[];
  declare(entry: RefEntry): void;
  byId(id: string): RefEntry | null;
};

function normalizeEntry(entry: RefEntry): RefEntry {
  const alias = typeof entry.alias === 'string' ? entry.alias.trim() : '';
  const bare = alias.startsWith(NEW_PREFIX) ? alias.slice(NEW_PREFIX.length).trim() : alias;
  return {
    alias: bare,
    id: typeof entry.id === 'string' ? entry.id : String(entry.id),
    kind: entry.kind,
    rowRev: typeof entry.rowRev === 'number' ? entry.rowRev : null,
    declaredByOpId: typeof entry.declaredByOpId === 'string' ? entry.declaredByOpId : null,
  };
}

/**
 * 别名表 + ID 表。同一别名出现两个不同 ID 时该别名进入「歧义」集合：
 * `get` 返回 null，`all()` 仍返回两条，解析器据此报 REF_AMBIGUOUS，绝不随机挑一个。
 */
export function createRefScope(seed: RefEntry[] = []): RefScope {
  const byAlias = new Map<string, RefEntry>();
  const byId = new Map<string, RefEntry>();
  const ambiguousAliases = new Set<string>();
  const order: RefEntry[] = [];
  const orderKeys = new Set<string>();

  const remember = (entry: RefEntry): void => {
    // 别名相同的两个不同 ID 必须都留在 all() 里，否则解析器无法发现歧义。
    if (entry.alias.length === 0) return;
    const key = `${entry.alias}\u0000${entry.id}`;
    if (orderKeys.has(key)) return;
    orderKeys.add(key);
    order.push(entry);
  };

  const fillMissing = (target: RefEntry, incoming: RefEntry): void => {
    if (target.rowRev === null && incoming.rowRev !== null) target.rowRev = incoming.rowRev;
    if (target.declaredByOpId === null && incoming.declaredByOpId !== null) {
      target.declaredByOpId = incoming.declaredByOpId;
    }
  };

  const register = (raw: RefEntry): void => {
    const entry = normalizeEntry(raw);
    if (entry.alias.length === 0 && entry.id.length === 0) return;
    let canonical = entry;
    if (entry.alias.length > 0) {
      const existing = byAlias.get(entry.alias);
      if (!existing) {
        byAlias.set(entry.alias, entry);
      } else if (existing.id !== entry.id) {
        ambiguousAliases.add(entry.alias);
      } else {
        fillMissing(existing, entry);
        canonical = existing;
      }
    }
    if (entry.id.length > 0) {
      const existingById = byId.get(entry.id);
      if (!existingById) byId.set(entry.id, entry);
      else fillMissing(existingById, entry);
    }
    remember(canonical);
  };

  for (const entry of seed) register(entry);

  return {
    get(alias: string): RefEntry | null {
      const raw = typeof alias === 'string' ? alias.trim() : '';
      if (raw.length === 0) return null;
      // 精确别名优先
      if (!ambiguousAliases.has(raw)) {
        const direct = byAlias.get(raw);
        if (direct) return direct;
      }
      if (raw.startsWith(NEW_PREFIX)) {
        const bare = raw.slice(NEW_PREFIX.length).trim();
        if (bare.length > 0 && !ambiguousAliases.has(bare)) {
          const declared = byAlias.get(bare);
          if (declared) return declared;
        }
      }
      // 再退到稳定 ID
      return byId.get(raw) ?? null;
    },
    all(): RefEntry[] {
      return [...order];
    },
    declare(entry: RefEntry): void {
      register(entry);
    },
    byId(id: string): RefEntry | null {
      const raw = typeof id === 'string' ? id.trim() : '';
      if (raw.length === 0) return null;
      return byId.get(raw) ?? null;
    },
  };
}

/* ───────────────────────── C05：第一遍登记 new: 声明 ───────────────────────── */

export type DeclareResult = { declared: RefEntry[]; aliasById: Map<string, string>; issues: Issue[] };

export function declareRefs(
  ops: ParsedOperation[],
  ctx: {
    anchor: TurnAnchor;
    baseRevision: number;
    seed?: RefEntry[];
    makeId?: (kind: RefKind, opId: string, alias: string) => string;
  },
): DeclareResult {
  const issues: Issue[] = [];
  const aliasById = new Map<string, string>();
  const declared: RefEntry[] = [];
  const list = Array.isArray(ops) ? ops : [];
  const seedScope = createRefScope(ctx.seed ?? []);

  const makeId =
    ctx.makeId ??
    ((kind: RefKind, opId: string, alias: string): string => defaultMakeId(ctx.anchor, alias, opId, kind));

  // 先收集全部引用字段的类型提示（后面的操作可能把某个别名当 location_ref 用）。
  const hints = new Map<string, RefKind>();
  for (const op of list) {
    scanNewRefs(op?.value?.data, (hit) => {
      if (hit.kind !== null && !hints.has(hit.alias)) hints.set(hit.alias, hit.kind);
    });
    // layout spec 的嵌套引用同样提供类型提示：spec.actors[].id 写 new:elin
    // 时，即使本批没有 character.upsert 声明，也能推断 elin 期望是 character。
    if (op?.value?.op === 'map.layout.request') {
      scanLayoutSpecRefs((op?.value?.data as Record<string, unknown> | undefined)?.['spec'], (hit) => {
        if (hit.kind !== null && !hit.local && !hints.has(hit.alias)) hints.set(hit.alias, hit.kind);
      });
    }
  }

  const firstDeclaration = new Map<string, { opId: string; line: number }>();

  for (const op of list) {
    const value = op?.value;
    const refRaw = typeof value?.ref === 'string' ? value.ref.trim() : '';
    const alias = newAliasOf(refRaw);
    if (alias === null) {
      // 修改既有对象：按原样登记短引用，真实 ID 留给第二遍解析（§16.5 步骤 3）。
      if (refRaw.length > 0) {
        const seeded = seedScope.get(refRaw);
        aliasById.set(refRaw, seeded ? seeded.id : refRaw);
      }
      continue;
    }

    const previous = firstDeclaration.get(alias);
    if (previous) {
      issues.push(
        makeIssue(
          'REF_AMBIGUOUS',
          '$.ref',
          `new:${alias} 在本批被重复声明：op ${previous.opId}（第 ${previous.line} 行）与 op ${op.opId}（第 ${op.line} 行）。` +
            '不静默保留第一个，必须由模型消歧或分别使用新别名。',
          'error',
          true,
          { line: op.line, opId: op.opId },
        ),
      );
      continue;
    }
    firstDeclaration.set(alias, { opId: op.opId, line: op.line });

    const opName = typeof value?.op === 'string' ? value.op : '';
    const kind = kindFromOp(opName) ?? hints.get(alias) ?? 'mention';
    const rawId = makeId(kind, op.opId, alias);
    const id =
      typeof rawId === 'string' && rawId.trim().length > 0
        ? rawId.trim()
        : defaultMakeId(ctx.anchor, alias, op.opId, kind);
    const entry: RefEntry = { alias, id, kind, rowRev: null, declaredByOpId: op.opId };
    declared.push(entry);
    aliasById.set(alias, id);
  }

  return { declared, aliasById, issues };
}

/* ───────────────────────── C06：第二遍引用解析 ───────────────────────── */

export type ResolveResult = { entry: RefEntry | null; issues: Issue[] };

function expectedLabel(expectedKind: RefKind | RefKind[] | null): string {
  if (expectedKind === null) return '任意类型';
  return Array.isArray(expectedKind) ? expectedKind.join('/') : expectedKind;
}

function kindAllowed(kind: RefKind, expectedKind: RefKind | RefKind[] | null): boolean {
  if (expectedKind === null) return true;
  return Array.isArray(expectedKind) ? expectedKind.includes(kind) : expectedKind === kind;
}

function checkKind(
  entry: RefEntry,
  raw: string,
  expectedKind: RefKind | RefKind[] | null,
  where?: { opId?: string; line?: number; field?: string },
): ResolveResult {
  if (kindAllowed(entry.kind, expectedKind)) return { entry, issues: [] };
  const opNote = where?.opId ? `（来源 op ${where.opId}）` : '';
  return {
    entry: null,
    issues: [
      makeIssue(
        'REF_TYPE_MISMATCH',
        refPath(where?.field),
        `引用「${raw}」指向 ${entry.kind}（ID ${entry.id}），此处需要 ${expectedLabel(expectedKind)}${opNote}。`,
        'error',
        true,
        { line: where?.line, opId: where?.opId },
      ),
    ],
  };
}

/**
 * 接受三种写法：`new:<alias>`（必须已在本批第一遍登记）、程序上下文提供的精确别名（C1/L2）、
 * 以及原始稳定 ID。类型不符报 REF_TYPE_MISMATCH，找不到报 REF_UNKNOWN（可修复），
 * 一个别名对应多个 ID 报 REF_AMBIGUOUS 且绝不随机挑选。
 */
export function resolveRef(
  ref: string | undefined | null,
  expectedKind: RefKind | RefKind[] | null,
  scope: RefScope,
  where?: { opId?: string; line?: number; field?: string },
): ResolveResult {
  const raw = typeof ref === 'string' ? ref.trim() : '';
  if (raw.length === 0) {
    return {
      entry: null,
      issues: [
        makeIssue(
          'REF_UNKNOWN',
          refPath(where?.field),
          `引用为空（来源 op ${where?.opId ?? '未知'}），需要短引用、稳定 ID 或 new: 别名。`,
          'error',
          true,
          { line: where?.line, opId: where?.opId },
        ),
      ],
    };
  }

  const isNew = raw.startsWith(NEW_PREFIX);
  const alias = isNew ? raw.slice(NEW_PREFIX.length).trim() : raw;
  const entries = scope.all();
  const aliasMatches = entries.filter((entry) => entry.alias === alias);

  let candidates: RefEntry[] = aliasMatches;
  if (isNew) {
    const declaredMatches = aliasMatches.filter((entry) => entry.declaredByOpId !== null);
    candidates = declaredMatches.length > 0 ? declaredMatches : [];
  }

  if (candidates.length > 0) {
    const ids = new Set(candidates.map((entry) => entry.id));
    if (ids.size > 1) {
      const detail = candidates
        .map((entry) => `${entry.id}（${entry.kind}${entry.declaredByOpId ? `，声明自 op ${entry.declaredByOpId}` : ''}）`)
        .join('、');
      return {
        entry: null,
        issues: [
          makeIssue(
            'REF_AMBIGUOUS',
            refPath(where?.field),
            `引用「${raw}」匹配到多个对象：${detail}。不随机挑选，需要模型改用明确 ID 或消歧${
              where?.opId ? `（来源 op ${where.opId}）` : ''
            }。`,
            'error',
            true,
            { line: where?.line, opId: where?.opId },
          ),
        ],
      };
    }
    return checkKind(candidates[0], raw, expectedKind, where);
  }

  if (isNew && aliasMatches.length > 0) {
    return {
      entry: null,
      issues: [
        makeIssue(
          'REF_UNKNOWN',
          refPath(where?.field),
          `引用「${raw}」在本批没有被任何操作以 ref:"${raw}" 声明；存在的同别名对象不是本批新建，禁止按相似名字自动合并（来源 op ${
            where?.opId ?? '未知'
          }）。`,
          'error',
          true,
          { line: where?.line, opId: where?.opId },
        ),
      ],
    };
  }

  if (!isNew) {
    const byId = scope.byId(raw);
    if (byId) return checkKind(byId, raw, expectedKind, where);
  }

  return {
    entry: null,
    issues: [
      makeIssue(
        'REF_UNKNOWN',
        refPath(where?.field),
        `引用「${raw}」无法解析：既不是本批 new: 声明，也不在程序提供的短引用/稳定 ID 中（来源 op ${
          where?.opId ?? '未知'
        }）。`,
        'error',
        true,
        { line: where?.line, opId: where?.opId },
      ),
    ],
  };
}

/* ─── map.layout.request：spec 引用的第二遍解析（P03） ─── */

/**
 * 家具组的局部 ID 池：同时收录原样 id 与去掉 `new:` 后的裸别名，
 * 这样 `contents[].id` 写 `new:table1` 或 `table1` 都能被 `near`/`on` 命中。
 */
function collectLocalIds(spec: Record<string, unknown>): Set<string> {
  const pool = new Set<string>();
  const rows = spec[LAYOUT_LOCAL_COLLECTION];
  if (!Array.isArray(rows)) return pool;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const id = (row as Record<string, unknown>)['id'];
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (trimmed.length === 0) continue;
    pool.add(trimmed);
    const bare = newAliasOf(trimmed);
    if (bare !== null) pool.add(bare);
  }
  return pool;
}

export type LayoutSpecResolveResult = {
  ok: boolean;
  /** 实体 id 已替换为当前分支规范 ID 的 spec 副本；局部关联与自由文本原样保留。 */
  spec: Record<string, unknown> | null;
  issues: Issue[];
  /** 解析出的实体 ID（去重、按出现顺序），供调用方声明依赖，绝不凭名字生成。 */
  dependencies: string[];
};

/**
 * 第二遍：把 layout spec 里的 `new:` 别名换成当前分支的规范 ID。
 *
 * - 只解析 `new:` 前缀；其他值（已保存约束的稳定 ID、局部键）原样保留 —— 省略即保持。
 * - 家具 group 的 `near`/`on` 只在 contents 的局部池里匹配，不建 entity_keys、不入 dependencies。
 * - `description` 等自由文本里的 `new:` 不是引用，不解析也不改写。
 * - 类型不符 REF_TYPE_MISMATCH、找不到 REF_UNKNOWN，路径精确到 `spec.rooms[0].id`。
 */
export function resolveLayoutSpecRefs(
  spec: Record<string, unknown>,
  scope: RefScope,
  where?: { opId?: string; line?: number },
): LayoutSpecResolveResult {
  const issues: Issue[] = [];
  const dependencies: string[] = [];
  const seen = new Set<string>();
  const out: Record<string, unknown> = { ...spec };
  const localPool = collectLocalIds(spec);

  for (const [collection, fields] of Object.entries(LAYOUT_SPEC_REF_FIELDS)) {
    const rows = spec[collection];
    if (!Array.isArray(rows)) continue;
    const nextRows: unknown[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row === null || typeof row !== 'object') {
        nextRows.push(row);
        continue;
      }
      const record: Record<string, unknown> = { ...(row as Record<string, unknown>) };

      for (const [field, kind] of Object.entries(fields)) {
        const raw = record[field];
        if (typeof raw !== 'string') continue;
        const rawText = raw.trim();
        if (rawText.length === 0) continue;
        const resolved = resolveRef(rawText, kind, scope, {
          opId: where?.opId,
          line: where?.line,
          field: `spec.${collection}[${i}].${field}`,
        });
        if (resolved.entry !== null) {
          record[field] = resolved.entry.id;
          if (!seen.has(resolved.entry.id)) {
            seen.add(resolved.entry.id);
            dependencies.push(resolved.entry.id);
          }
          continue;
        }
        // new: 是引用声明，必须可解析；裸 ID 可能只是已保存约束的键或程序未收录的短引用，
        // 「找不到」时原样保留（省略即保持，绝不按名字猜），但类型不符/歧义必须报出来。
        const isNewRef = rawText.startsWith(NEW_PREFIX);
        for (const item of resolved.issues) {
          if (!isNewRef && item.code === 'REF_UNKNOWN') continue;
          issues.push(item);
        }
      }

      for (const field of LAYOUT_LOCAL_FIELDS[collection] ?? []) {
        const raw = record[field];
        const alias = newAliasOf(raw);
        if (alias === null) continue;
        const rawText = typeof raw === 'string' ? raw.trim() : '';
        if (localPool.has(rawText) || localPool.has(alias)) continue;
        issues.push(
          makeIssue(
            'REF_UNKNOWN',
            refPath(`spec.${collection}[${i}].${field}`),
            `局部引用「${alias}」不在本请求 spec.${LAYOUT_LOCAL_COLLECTION} 的家具 ID 中；` +
              `near/on 只认家具组的局部视觉 ID，不建实体、不按名字猜（来源 op ${where?.opId ?? '未知'}）。`,
            'error',
            true,
            { opId: where?.opId, line: where?.line },
          ),
        );
      }

      nextRows.push(record);
    }
    out[collection] = nextRows;
  }

  return {
    ok: !issues.some((item) => item.severity === 'error'),
    spec: out,
    issues,
    dependencies,
  };
}

function normalizeDisplayName(name: string): string {
  return typeof name === 'string' ? name.normalize('NFKC').trim().toLowerCase() : '';
}

/**
 * 显示名兜底：只在规范化后**精确等于**某个别名时接受，不做任何相似度/编辑距离匹配。
 * 成功也返回一条 warning，明确记录「按别名精确匹配」而不是模糊相似。
 */
export function resolveByDisplayName(
  name: string,
  expectedKind: RefKind | null,
  scope: RefScope,
): ResolveResult {
  const normalized = normalizeDisplayName(name);
  if (normalized.length === 0) {
    return {
      entry: null,
      issues: [
        makeIssue(
          'REF_UNKNOWN',
          '$.data.name',
          '显示名为空，无法按别名精确匹配（本模块不做模糊相似匹配）。',
          'error',
          true,
        ),
      ],
    };
  }

  const matches = scope.all().filter((entry) => normalizeDisplayName(entry.alias) === normalized);
  if (matches.length === 0) {
    return {
      entry: null,
      issues: [
        makeIssue(
          'REF_UNKNOWN',
          '$.data.name',
          `显示名「${name}」没有任何别名在规范化后精确相等；只做别名精确匹配，不做模糊相似匹配。`,
          'error',
          true,
        ),
      ],
    };
  }

  const ids = new Set(matches.map((entry) => entry.id));
  if (ids.size > 1) {
    const detail = matches.map((entry) => `${entry.id}（别名 ${entry.alias}）`).join('、');
    return {
      entry: null,
      issues: [
        makeIssue(
          'REF_AMBIGUOUS',
          '$.data.name',
          `显示名「${name}」按别名精确匹配到多个对象：${detail}。不随机挑选。`,
          'error',
          true,
        ),
      ],
    };
  }

  const checked = checkKind(matches[0], name, expectedKind);
  if (checked.entry === null) return checked;
  return {
    entry: checked.entry,
    issues: [
      makeIssue(
        'REF_RESOLVED_BY_ALIAS',
        '$.data.name',
        `显示名「${name}」按别名精确匹配解析为 ${checked.entry.alias}（ID ${checked.entry.id}）；` +
          '本模块从不按模糊相似度挑对象。',
        'warning',
        false,
      ),
    ],
  };
}

/** 供 repair 复用：某个操作里出现的全部 new: 别名（声明 + 引用，均不含前缀）。 */
export function collectNewAliases(ops: ParsedOperation[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const op of Array.isArray(ops) ? ops : []) {
    for (const alias of newAliasesOf(op?.value)) {
      if (!seen.has(alias)) {
        seen.add(alias);
        out.push(alias);
      }
    }
  }
  return out;
}
