/**
 * atlas-ops-repair.ts — 修复票据、定向修复批次与合并（C08/C09；§16.5 步骤 6/7、§8.5、§19.6、§18.4）。
 *
 * 硬边界：
 * - C08：修复输入里只有**失败操作** + 票据 + 必要依赖。成功组冻结，绝不重发整个世界
 *   （`buildRepairBatch` 的入参类型就没有「成功操作」这个位置）。
 * - C09：修复结果按 `ticket` 映射回**原 opId / 原行号**，成功操作永不重新编号。
 * - 超出票据范围（非法 op、原依赖集合之外的新 `new:` 别名）报 REPAIR_SCOPE_VIOLATION，
 *   只拒绝该条，其它合法条目继续生效。
 * - 每批最多 `ATLAS_RUNTIME_LIMITS.repairAttemptsPerBatch` 次修复；用完只报
 *   REPAIR_ATTEMPTS_EXHAUSTED 并保留原操作。
 *
 * 本文件里的 SHA-256 与 atlas-ops-refs.ts 中的实现逐字一致（同步、无宿主依赖）；
 * 之所以不共享，是为了让 refs 的导出面严格保持规格给定的签名集合，也不新增第五个文件。
 */

import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { collectNewAliases } from './atlas-ops-refs.ts';
import type { Issue, ParsedOperation, Phase } from './atlas-ops-contract.ts';

export type RepairTicket = {
  ticket: string;
  originalOpId: string;
  allowedOps: readonly string[];
  originalReadSet: Array<{ table: string; rowId: string; rowRev: number }>;
  issues: Issue[];
};

/* ───────────────────────── 本地同步 SHA-256（与 refs 同实现） ───────────────────────── */

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

/* ───────────────────────── Issue 构造 ───────────────────────── */

function makeIssue(
  code: string,
  path: string,
  message: string,
  severity: 'warning' | 'error',
  retryable: boolean,
  where?: { line?: number; opId?: string },
): Issue {
  const issue: Issue = { code, path, message, severity, retryable };
  if (where?.line !== undefined) issue.line = where.line;
  if (where?.opId !== undefined) issue.opId = where.opId;
  return issue;
}

function oneLine(text: string): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function cloneIssue(issue: Issue): Issue {
  return { ...issue };
}

/* ───────────────────────── C08：buildRepairBatch ───────────────────────── */

function renderTicketLine(ticket: RepairTicket, op: ParsedOperation | undefined): string {
  const value: Record<string, unknown> = { ticket: ticket.ticket };
  const model = op?.value;
  if (model && typeof model === 'object') {
    value.op = model.op;
    if (model.ref !== undefined) value.ref = model.ref;
    if (model.data !== undefined) value.data = model.data;
    if (model.source !== undefined) value.source = model.source;
    if (model.why !== undefined) value.why = model.why;
  }
  const errors = ticket.issues.map((issue) => ({
    code: issue.code,
    path: issue.path,
    message: oneLine(issue.message),
    line: issue.line ?? op?.line ?? null,
  }));
  return (
    `${JSON.stringify(value)} ｜ ticket=${ticket.ticket} originalOpId=${ticket.originalOpId}` +
    ` ｜ 允许操作：${ticket.allowedOps.length > 0 ? ticket.allowedOps.join(', ') : '（无）'}` +
    ` ｜ 错误：${JSON.stringify(errors)}`
  );
}

export function buildRepairBatch(
  failed: Array<{
    op: ParsedOperation;
    issues: Issue[];
    readSet?: Array<{ table: string; rowId: string; rowRev: number }>;
  }>,
  ctx: { phase: Phase; allowedOps: readonly string[]; failureGroupId?: string },
): { batchId: string; tickets: RepairTicket[]; issues: Issue[]; promptLines: string[] } {
  const list = Array.isArray(failed) ? failed : [];
  const batchId = sha256Hex(list.map((entry) => entry?.op?.opId ?? '').join('\u0000')).slice(0, 16);
  if (list.length === 0) {
    return { batchId, tickets: [], issues: [], promptLines: [] };
  }

  const tickets: RepairTicket[] = [];
  const ticketLines: string[] = [];
  list.forEach((entry, index) => {
    const ticket: RepairTicket = {
      ticket: `R${index + 1}`,
      originalOpId: entry?.op?.opId ?? '',
      allowedOps: ctx.allowedOps,
      originalReadSet: (entry?.readSet ?? []).map((row) => ({
        table: row.table,
        rowId: row.rowId,
        rowRev: row.rowRev,
      })),
      issues: (entry?.issues ?? []).map(cloneIssue),
    };
    tickets.push(ticket);
    ticketLines.push(renderTicketLine(ticket, entry?.op));
  });

  const relatedObjects = tickets
    .map((ticket) => {
      const rows = ticket.originalReadSet.map((row) => `${row.table}:${row.rowId}`);
      return rows.length > 0 ? `${ticket.ticket}=${rows.join(',')}` : '';
    })
    .filter((text) => text.length > 0)
    .join(' | ');

  // §19.6 repair 内容段（user）：不含任何已成功操作，只有失败票据与准确错误。
  const promptLines: string[] = [
    '上一次操作有以下局部问题。其它成功操作已经保留，禁止重复输出或修改它们。',
    '逐条使用给定 ticket 修正原操作，每行一个 JSON 对象。',
    '只使用原本允许的操作。若无足够信息完成，输出同 ticket 的 noop，并用 why 说明。',
    '不要重新输出整个世界，不要改用 SQL，不要编造不存在的引用或证据。',
    `本批允许操作：${ctx.allowedOps.length > 0 ? ctx.allowedOps.join(', ') : '（无）'}`,
    '失败票据、原操作、准确错误：',
    ...ticketLines,
    `相关对象：${relatedObjects.length > 0 ? relatedObjects : '（本批未附读取集）'}`,
    '相关来源/机会：（由调用方在 repairSources 段补入，本批未附）',
    '示例：',
    '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}',
  ];

  return { batchId, tickets, issues: [], promptLines };
}

/* ───────────────────────── C09：mergeRepair ───────────────────────── */

export function mergeRepair(
  original: ParsedOperation[],
  repaired: ParsedOperation[],
  tickets: RepairTicket[],
  ctx: { phase: Phase; attemptsUsed?: number },
): { operations: ParsedOperation[]; issues: Issue[]; consumedTickets: string[]; exceededScope: boolean } {
  const originals = Array.isArray(original) ? original : [];
  const entries = Array.isArray(repaired) ? repaired : [];
  const ticketList = Array.isArray(tickets) ? tickets : [];
  const limit = ATLAS_RUNTIME_LIMITS.repairAttemptsPerBatch;
  const attemptsUsed = typeof ctx.attemptsUsed === 'number' && Number.isFinite(ctx.attemptsUsed) ? ctx.attemptsUsed : 0;

  // 一次纠错额度：超了就不再有第二次修复，原操作原样返回（不给逐条范围错误刷屏）。
  if (attemptsUsed >= limit) {
    return {
      operations: originals,
      issues: [
        makeIssue(
          'REPAIR_ATTEMPTS_EXHAUSTED',
          '$.ticket',
          `每批最多 ${limit} 次定向修复，本批已使用 ${attemptsUsed} 次；拒绝再次修复，保留原操作与原始 opId。`,
          'error',
          false,
        ),
      ],
      consumedTickets: [],
      exceededScope: false,
    };
  }

  const ticketById = new Map<string, RepairTicket>();
  for (const ticket of ticketList) {
    if (ticket && typeof ticket.ticket === 'string' && !ticketById.has(ticket.ticket)) {
      ticketById.set(ticket.ticket, ticket);
    }
  }
  const knownTickets = [...ticketById.keys()];
  const originalById = new Map<string, ParsedOperation>();
  for (const op of originals) {
    if (op && typeof op.opId === 'string' && !originalById.has(op.opId)) originalById.set(op.opId, op);
  }

  // 票据的原依赖集合：修复只能使用原操作里已经出现过的 new: 别名（§16.5 步骤 6）。
  const allowedAliases = new Map<string, Set<string>>();
  for (const [ticketId, ticket] of ticketById) {
    const originalOp = originalById.get(ticket.originalOpId);
    allowedAliases.set(ticketId, new Set(originalOp ? collectNewAliases([originalOp]) : []));
  }

  const issues: Issue[] = [];
  const usedTickets = new Set<string>();
  const consumedTickets: string[] = [];
  const replacements = new Map<string, ParsedOperation>();
  let exceededScope = false;

  for (const entry of entries) {
    const line = typeof entry?.line === 'number' ? entry.line : undefined;
    const model = entry?.value;
    const ticketId = typeof model?.ticket === 'string' ? model.ticket.trim() : '';

    if (ticketId.length === 0) {
      issues.push(
        makeIssue(
          'REPAIR_TICKET_UNKNOWN',
          '$.ticket',
          `修复条目缺少 ticket（第 ${line ?? '?'} 行）；本批票据：${knownTickets.join('、') || '（无）'}。` +
            '没有票据无法映射回原 opId，该条被拒绝。',
          'error',
          false,
          { line, opId: entry?.opId },
        ),
      );
      continue;
    }

    const ticket = ticketById.get(ticketId);
    if (!ticket) {
      issues.push(
        makeIssue(
          'REPAIR_TICKET_UNKNOWN',
          '$.ticket',
          `未知票据「${ticketId}」（第 ${line ?? '?'} 行）；本批票据只有：${
            knownTickets.join('、') || '（无）'
          }。该条被拒绝，其它合法修复条目保留。`,
          'error',
          false,
          { line, opId: entry?.opId },
        ),
      );
      continue;
    }

    const originalOp = originalById.get(ticket.originalOpId);
    if (!originalOp) {
      issues.push(
        makeIssue(
          'REPAIR_TICKET_UNKNOWN',
          '$.ticket',
          `票据「${ticketId}」指向的 originalOpId「${ticket.originalOpId}」不在本批原操作中（第 ${
            line ?? '?'
          } 行）；无法映射回原 opId，该条被拒绝。`,
          'error',
          false,
          { line, opId: entry?.opId },
        ),
      );
      continue;
    }

    if (usedTickets.has(ticketId)) {
      issues.push(
        makeIssue(
          'REPAIR_DUPLICATE_TICKET',
          '$.ticket',
          `票据「${ticketId}」在本批被重复修复（第 ${line ?? '?'} 行）；第二份被拒绝，不重复应用、不创建新 ID。`,
          'error',
          false,
          { line, opId: originalOp.opId },
        ),
      );
      continue;
    }

    const opName = typeof model?.op === 'string' ? model.op : '';
    if (opName === 'noop') {
      // §19.6：没信息完成就输出同 ticket 的 noop + why。原失败操作保持未解决。
      usedTickets.add(ticketId);
      consumedTickets.push(ticketId);
      const why = oneLine(typeof model?.why === 'string' ? model.why : '');
      issues.push(
        makeIssue(
          'REPAIR_DECLINED',
          '$.why',
          `票据「${ticketId}」由模型输出 noop 表示无法完成：${why.length > 0 ? why : '（未给出 why）'}。` +
            `原失败操作 ${ticket.originalOpId} 保持未解决。`,
          'warning',
          false,
          { line, opId: originalOp.opId },
        ),
      );
      continue;
    }

    if (!ticket.allowedOps.includes(opName)) {
      exceededScope = true;
      issues.push(
        makeIssue(
          'REPAIR_SCOPE_VIOLATION',
          '$.op',
          `票据「${ticketId}」以操作「${opName}」修复，超出该票据允许的操作集合：${
            ticket.allowedOps.length > 0 ? ticket.allowedOps.join('、') : '（无）'
          }。该条被拒绝，其它合法修复条目保留。`,
          'error',
          false,
          { line, opId: originalOp.opId },
        ),
      );
      continue;
    }

    const allowed = allowedAliases.get(ticketId) ?? new Set<string>();
    const illegalAlias = collectNewAliases([entry]).find((alias) => !allowed.has(alias));
    if (illegalAlias !== undefined) {
      exceededScope = true;
      issues.push(
        makeIssue(
          'REPAIR_SCOPE_VIOLATION',
          '$.ref',
          `票据「${ticketId}」引入了原依赖集合之外的新别名 new:${illegalAlias}；` +
            `该票据只允许 ${[...allowed].map((alias) => `new:${alias}`).join('、') || '（没有任何 new: 别名）'}。` +
            '新增辅助对象只能落在该票据原依赖集合内，该条被拒绝。',
          'error',
          false,
          { line, opId: originalOp.opId },
        ),
      );
      continue;
    }

    // 映射回原 opId / 原行号：成功操作永不重新编号，确定性 ID 也因此保持不变。
    replacements.set(originalOp.opId, {
      opId: originalOp.opId,
      line: originalOp.line,
      rawHash: entry?.rawHash ? entry.rawHash : originalOp.rawHash,
      value: model,
    });
    usedTickets.add(ticketId);
    consumedTickets.push(ticketId);
  }

  const operations = originals.map((op) => replacements.get(op.opId) ?? op);
  return { operations, issues, consumedTickets, exceededScope };
}
