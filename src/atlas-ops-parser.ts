/**
 * atlas-ops-parser.ts — C01 / C02 / §8.3 / §8.5：文本 → Operation 数组的唯一解析器。
 *
 * 规范形态：一行一个完整 JSON 对象，没有根封套、没有收尾标记。
 * 有限兼容：完整单个 JSON 对象、完整 JSON 对象数组、Markdown 代码围栏、旧 `<atlasEdit>` 外壳、
 * 思考段外壳。它们全部归一为同一 `ParsedOperation[]`，不是第二条执行链，也不做
 * `schemaVersion` / `v2` 之类的关键词扫描来选择解析路径。
 *
 * 边界（§8.3）：
 * - 未闭合的 think/analysis/reasoning 段一律不读取其内容（P09）；
 * - 半截 JSON 行不补全（P03）；一坏行不牵连独立好行；
 * - 损坏的完整数组不扫描内部嵌套对象来“救行”，整段作为一次失败输入（P10 反例）；
 * - 超过响应/单条/条数/深度上限时明确报错，绝不截断后假装收到完整回复。
 */

// 跨平台稳定哈希：浏览器产物不能 import node:crypto（见 atlas-hash.ts）。
import { stableHexHash } from './atlas-hash.ts';

/** P0-02:跨平台 UTF-8 字节数。浏览器没有 Node `Buffer`,
 * 用 TextEncoder 统一计算;Node 端也走这条路径,避免依赖全局 Buffer。 */
const UTF8_ENCODER = new TextEncoder();
function utf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).byteLength;
}

import type { Issue, ModelOperation, ParseResult, ParsedOperation, Phase } from './atlas-ops-contract.ts';
import { ATLAS_NOOP, SYSTEM_OWNED_FIELDS } from './atlas-ops-contract.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { ATLAS_ERROR_CODES, toIssue } from './atlas-ops-errors.ts';

export type ExtractResult = {
  payload: string;
  issues: Issue[];
  incomplete: boolean;
  reasoningBlocked: boolean;
};

/** 解析上下文：阶段只用于诊断与调用者信息，裁剪操作集合由 C03/C04 负责。 */
export type ParseContext = {
  phase: Phase;
  allowedOps?: readonly string[];
};

const REASONING_OPEN_RE = /<(think|thinking|analysis|reasoning)(?:\s[^>]*)?>/gi;
const REASONING_ANY_CLOSE_RE = /<\/(?:think|thinking|analysis|reasoning)\s*>/gi;
const FENCE_LINE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const ATLAS_OPEN_RE = /<atlasEdit\b[^>]*>/i;
const ATLAS_CLOSE_RE = /<\/atlasEdit\s*>/i;
const ATLAS_HEAD_RE = /^\s*<atlasEdit\b/i;
const FENCE_ANYWHERE_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})/m;

const SQL_START_RE = /^(SELECT|UPDATE|INSERT|DELETE|CREATE|DROP|ALTER|PRAGMA|ATTACH|WITH|REPLACE)\b/i;

/** §8.3：顶层固定字段；其余顶层键忽略。 */
const OPERATION_TOP_FIELDS: readonly string[] = ['op', 'ref', 'data', 'source', 'why', 'ticket'];

const EXCERPT_CHARS = 80;

function issue(
  code: string,
  path: string,
  message: string,
  extra: {
    severity?: 'warning' | 'error';
    line?: number;
    opId?: string;
    retryable?: boolean;
  } = {},
): Issue {
  // 统一走 toIssue：message 出站前强制脱敏（模型正文可能夹带密钥，§16.8）。
  return toIssue(new Error(message), { code, path, ...extra });
}

/** BOM 与换行归一；只在文本层面处理，不改动字符串内部转义。 */
function normalizeText(text: string): string {
  let out = text;
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  return out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function makeLineIndex(text: string): { lineAt: (offset: number) => number } {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return {
    lineAt(offset: number): number {
      const target = Math.max(0, Math.min(offset, text.length));
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= target) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function excerptOf(text: string, limit = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}

function sha256Hex(text: string): string {
  return stableHexHash(text);
}

/** 返回从 start 起的第一个完整 JSON 值的结束下标（不含），未闭合返回 -1。 */
function findJsonValueEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let opened = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      opened = true;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth <= 0 && opened) return i + 1;
      if (depth < 0) return i + 1;
    }
  }
  return -1;
}

/** 最大容器嵌套深度；计数方式为 `{`/`[` 的峰值层数（根对象记 1）。 */
function jsonNestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > max) max = depth;
    } else if (ch === '}' || ch === ']') depth -= 1;
  }
  return max;
}

/** 剥掉已闭合的思考段；遇到未闭合开口标签就丢弃其后全部内容。 */
function stripReasoningBlocks(
  text: string,
  pushIssue: (blockedLine: number, tag: string) => void,
): { text: string; blocked: boolean } {
  const lineIndex = makeLineIndex(text);
  let out = text;
  let blocked = false;
  let cursor = 0;
  while (cursor < out.length) {
    REASONING_OPEN_RE.lastIndex = cursor;
    const open = REASONING_OPEN_RE.exec(out);
    if (!open) break;
    const tag = open[1].toLowerCase();
    const openStart = open.index;
    const openEnd = open.index + open[0].length;
    const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
    const close = closeRe.exec(out.slice(openEnd));
    if (!close) {
      // 未闭合：从开口标签开始的一切都不抽取（P09）。
      pushIssue(lineIndex.lineAt(openStart), tag);
      out = out.slice(0, openStart);
      blocked = true;
      break;
    }
    const closeEnd = openEnd + close.index + close[0].length;
    out = out.slice(0, openStart) + out.slice(closeEnd);
    cursor = openStart;
  }
  // 无开口的孤立闭合标签：直接剔除，不影响内容。
  out = out.replace(REASONING_ANY_CLOSE_RE, '');
  return { text: out, blocked };
}

/** 单行围栏的语言标签（只在这张表里的词会被剥掉，避免误删正文）。 */
const FENCE_LANG_RE =
  /^\s*(?:json|jsonc|json5|javascript|js|sql|text|plaintext|txt|markdown|md|yaml|yml|xml|html|bash|sh|none)\s+/i;

/** 只删除围栏标记，保留围栏内部内容与其后的正文；同时支持单行围栏 ```json {…} ```。 */
function stripCodeFences(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let fenceChar: string | null = null;
  for (const line of lines) {
    const match = FENCE_LINE_RE.exec(line);
    if (match) {
      const marker = match[1];
      const rest = match[2];
      const restTrimmed = rest.trim();
      if (fenceChar === null) {
        const bareInfo = restTrimmed === '' || /^[A-Za-z0-9_+-]+$/.test(restTrimmed);
        if (bareInfo) {
          // 常规多行围栏的开头行。
          fenceChar = marker.charAt(0);
          continue;
        }
        // 单行围栏：```json {"op":…} ``` 或 ```sql UPDATE … ```。
        let inner = rest;
        const closing = /(`{3,}|~{3,})\s*$/.exec(inner);
        if (closing) inner = inner.slice(0, closing.index);
        const bracket = inner.search(/[{[]/);
        if (bracket >= 0) inner = inner.slice(bracket);
        else inner = inner.replace(FENCE_LANG_RE, '');
        out.push(inner.trim());
        continue;
      }
      if (marker.charAt(0) === fenceChar && restTrimmed === '') {
        fenceChar = null;
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 只剥外层 `<atlasEdit>` 外壳（不报 issue；issue 由 extractPayload 负责）。 */
function stripWrapperShell(text: string): string {
  const open = ATLAS_OPEN_RE.exec(text);
  if (!open) return text;
  const afterOpen = open.index + open[0].length;
  const close = ATLAS_CLOSE_RE.exec(text.slice(afterOpen));
  return close ? text.slice(afterOpen, afterOpen + close.index) : text.slice(afterOpen);
}

/** C01：BOM/换行/思考段/围栏/atlasEdit 外壳 → 待解析 payload。 */
export function extractPayload(text: string): ExtractResult {
  const issues: Issue[] = [];
  const source = normalizeText(typeof text === 'string' ? text : '');

  const reasoning = stripReasoningBlocks(source, (blockedLine, tag) => {
    issues.push(
      issue(
        ATLAS_ERROR_CODES.UNTERMINATED_REASONING,
        '$.reasoning',
        `unterminated <${tag}> block opened on line ${blockedLine}; nothing after it is extracted`,
        { severity: 'error', line: blockedLine, retryable: true },
      ),
    );
  });

  let body = stripCodeFences(reasoning.text);
  let incomplete = reasoning.blocked;

  const open = ATLAS_OPEN_RE.exec(body);
  if (open) {
    const afterOpen = open.index + open[0].length;
    const close = ATLAS_CLOSE_RE.exec(body.slice(afterOpen));
    const openLine = makeLineIndex(body).lineAt(open.index);
    if (close) {
      body = body.slice(afterOpen, afterOpen + close.index);
    } else {
      issues.push(
        issue(
          ATLAS_ERROR_CODES.WRAPPER_INCOMPLETE,
          '$.atlasEdit',
          `missing </atlasEdit> closing tag (opened on line ${openLine}); inner content kept`,
          { severity: 'warning', line: openLine, retryable: false },
        ),
      );
      body = body.slice(afterOpen);
      incomplete = true;
    }
  } else {
    const closeOnly = ATLAS_CLOSE_RE.exec(body);
    if (closeOnly) {
      const closeLine = makeLineIndex(body).lineAt(closeOnly.index);
      issues.push(
        issue(
          ATLAS_ERROR_CODES.WRAPPER_INCOMPLETE,
          '$.atlasEdit',
          `stray </atlasEdit> closing tag without opening tag on line ${closeLine}; tag stripped`,
          { severity: 'warning', line: closeLine, retryable: false },
        ),
      );
      body = body.slice(0, closeOnly.index) + body.slice(closeOnly.index + closeOnly[0].length);
      incomplete = true;
    }
  }

  const payload = body.trim() === '' ? '' : body;
  return { payload, issues, incomplete, reasoningBlocked: reasoning.blocked };
}

type Candidate = { raw: string; line: number };
type BuiltOp = { kind: 'op'; parsed: ParsedOperation } | { kind: 'noop' } | { kind: 'error' };

/** 逐行形态：只把以 `{` 开头的行当候选，其余按前言/正文忽略。 */
function lineCandidates(text: string): Candidate[] {
  const lines = text.split('\n');
  const out: Candidate[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || !trimmed.startsWith('{')) continue;
    out.push({ raw: trimmed, line: i + 1 });
  }
  return out;
}

function buildOperation(
  value: unknown,
  candidate: Candidate,
  index: number,
  issues: Issue[],
): BuiltOp {
  if (!isPlainObject(value)) {
    issues.push(
      issue(
        ATLAS_ERROR_CODES.MINIMUM_FIELD_MISSING,
        '$',
        `line ${candidate.line}: each response line must be a JSON object with a string op; got ${Array.isArray(value) ? 'array' : typeof value}; excerpt: ${excerptOf(candidate.raw)}`,
        { line: candidate.line, retryable: true },
      ),
    );
    return { kind: 'error' };
  }

  const opRaw = typeof value['op'] === 'string' ? value['op'] : '';
  if (opRaw.trim() === '') {
    issues.push(
      issue(
        ATLAS_ERROR_CODES.MINIMUM_FIELD_MISSING,
        '$.op',
        `line ${candidate.line}: operation object is missing required string field op; minimal example: {"op":"character.upsert","ref":"C1","data":{"thought":"先观察。"}}`,
        { line: candidate.line, retryable: true },
      ),
    );
    return { kind: 'error' };
  }
  if (opRaw.trim().toLowerCase() === ATLAS_NOOP) return { kind: 'noop' };

  const modelOp: ModelOperation = { op: opRaw };

  const ref = value['ref'];
  if (typeof ref === 'string') modelOp.ref = ref;
  else if (ref !== undefined && ref !== null) {
    issues.push(
      issue(ATLAS_ERROR_CODES.FIELD_IGNORED, '$.ref', `line ${candidate.line}: ref must be a string; ignored`, {
        severity: 'warning',
        line: candidate.line,
      }),
    );
  }

  const data = value['data'];
  if (isPlainObject(data)) modelOp.data = data;
  else if (data !== undefined && data !== null) {
    issues.push(
      issue(ATLAS_ERROR_CODES.FIELD_IGNORED, '$.data', `line ${candidate.line}: data must be an object; ignored`, {
        severity: 'warning',
        line: candidate.line,
      }),
    );
  }

  const source = value['source'];
  if (typeof source === 'string') modelOp.source = source;
  else if (Array.isArray(source)) {
    const list = source.filter((entry): entry is string => typeof entry === 'string');
    if (list.length > 0) modelOp.source = list;
    else {
      issues.push(
        issue(ATLAS_ERROR_CODES.FIELD_IGNORED, '$.source', `line ${candidate.line}: source array has no string entries; ignored`, {
          severity: 'warning',
          line: candidate.line,
        }),
      );
    }
  } else if (source !== undefined && source !== null) {
    issues.push(
      issue(ATLAS_ERROR_CODES.FIELD_IGNORED, '$.source', `line ${candidate.line}: source must be a string or string array; ignored`, {
        severity: 'warning',
        line: candidate.line,
      }),
    );
  }

  const why = value['why'];
  if (typeof why === 'string') modelOp.why = why;
  else if (why !== undefined && why !== null) {
    issues.push(
      issue(ATLAS_ERROR_CODES.FIELD_IGNORED, '$.why', `line ${candidate.line}: why must be a string; ignored`, {
        severity: 'warning',
        line: candidate.line,
      }),
    );
  }

  const ticket = value['ticket'];
  if (typeof ticket === 'string') modelOp.ticket = ticket;
  else if (ticket !== undefined && ticket !== null) {
    issues.push(
      issue(ATLAS_ERROR_CODES.FIELD_IGNORED, '$.ticket', `line ${candidate.line}: ticket must be a string; ignored`, {
        severity: 'warning',
        line: candidate.line,
      }),
    );
  }

  for (const key of Object.keys(value)) {
    if (OPERATION_TOP_FIELDS.includes(key)) continue;
    const systemOwned = SYSTEM_OWNED_FIELDS.includes(key);
    issues.push(
      issue(
        systemOwned ? ATLAS_ERROR_CODES.SYSTEM_FIELD_IGNORED : ATLAS_ERROR_CODES.FIELD_IGNORED,
        `$.${key}`,
        `line ${candidate.line}: ${
          systemOwned ? 'program-owned field' : 'unknown top-level field'
        } ${key} ignored on ${opRaw.trim()}`,
        { severity: 'warning', line: candidate.line },
      ),
    );
  }

  const rawHash = sha256Hex(candidate.raw);
  const opId = `op_${index}_${rawHash.slice(0, 8)}`;
  return { kind: 'op', parsed: { opId, line: candidate.line, rawHash, value: modelOp } };
}

/** C02：payload → ParseResult。
 *
 * 支持：规范逐行、完整单个对象（含跨行）、完整数组（整段优先）、围栏/外壳（已由 extractPayload 处理）。
 * ctx 只携带阶段信息；操作集合的裁剪发生在 normalizeOperation / validateMinimum。
 */
export function parseOperations(payload: string, ctx: ParseContext): ParseResult {
  void ctx;

  const rawInput = normalizeText(typeof payload === 'string' ? payload : '');
  const issues: Issue[] = [];
  const operations: ParsedOperation[] = [];
  let explicitNoop = false;
  let incomplete = false;

  const byteLength = utf8ByteLength(rawInput);
  if (byteLength > ATLAS_RUNTIME_LIMITS.responseUtf8Bytes) {
    issues.push(
      issue(
        ATLAS_ERROR_CODES.RESPONSE_TOO_LARGE,
        '$',
        `response is ${byteLength} bytes, over the ${ATLAS_RUNTIME_LIMITS.responseUtf8Bytes} byte limit; no operation kept (response not truncated)`,
        { retryable: false },
      ),
    );
    return { operations: [], issues, explicitNoop: false, incomplete: true };
  }

  // 防御：调用者若漏掉 extractPayload，围栏与 `<atlasEdit>` 外壳仍按 §8.3 归一。
  // 围栏标记行不可能出现在合法 JSON 字符串内部，外壳只在整个 payload 以该标签开头时才剥。
  let source = rawInput;
  if (FENCE_ANYWHERE_RE.test(source)) source = stripCodeFences(source);
  if (ATLAS_HEAD_RE.test(source)) source = stripWrapperShell(source);

  const trimmed = source.trim();
  if (trimmed === '') {
    // 空响应不是 noop：不伪造操作、不伪造 explicitNoop，由调用者区分 EMPTY_RESPONSE。
    return { operations: [], issues: [], explicitNoop: false, incomplete: true };
  }

  const lineIndex = makeLineIndex(source);
  // 允许合法前言：从第一条以 `{` 或 `[` 开头的行开始判断整体形态；行号仍按原始文本计算。
  let bodyStart = source.search(/\S/);
  const firstChar = source[bodyStart];
  if (firstChar !== '{' && firstChar !== '[') {
    const head = /^[ \t]*([\[{])/m.exec(source);
    if (head) bodyStart = head.index + head[0].length - 1;
  }
  const head = source.slice(bodyStart);
  const candidates: Candidate[] = [];

  if (head.startsWith('[')) {
    // 完整数组优先整段解析；损坏数组不扫描内部嵌套对象来救行。
    const arrayEnd = findJsonValueEnd(source, bodyStart);
    if (arrayEnd < 0) {
      issues.push(
        issue(
          ATLAS_ERROR_CODES.JSON_SYNTAX,
          '$',
          `JSON array is unterminated (${byteLength} bytes); excerpt: ${excerptOf(head)}`,
          { line: lineIndex.lineAt(bodyStart), retryable: true },
        ),
      );
      return { operations: [], issues, explicitNoop: false, incomplete: true };
    }
    const arrayText = source.slice(bodyStart, arrayEnd);
    let parsedArray: unknown;
    try {
      parsedArray = JSON.parse(arrayText);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const at = /position (\d+)/.exec(detail);
      const offset = at ? bodyStart + Number(at[1]) : bodyStart;
      issues.push(
        issue(
          ATLAS_ERROR_CODES.JSON_SYNTAX,
          '$',
          `JSON array is malformed (${utf8ByteLength(arrayText)} bytes): ${detail}; excerpt: ${excerptOf(arrayText)}`,
          { line: lineIndex.lineAt(offset), retryable: true },
        ),
      );
      return { operations: [], issues, explicitNoop: false, incomplete: true };
    }
    if (!Array.isArray(parsedArray)) {
      issues.push(
        issue(ATLAS_ERROR_CODES.JSON_SYNTAX, '$', `expected a JSON array; excerpt: ${excerptOf(arrayText)}`, {
          line: lineIndex.lineAt(bodyStart),
          retryable: true,
        }),
      );
      return { operations: [], issues, explicitNoop: false, incomplete: true };
    }

    let cursor = bodyStart + 1;
    const innerEnd = arrayEnd - 1;
    while (cursor < innerEnd) {
      while (cursor < innerEnd && (source[cursor] === ',' || /\s/.test(source[cursor]))) cursor += 1;
      if (cursor >= innerEnd) break;
      const valueEnd = findJsonValueEnd(source, cursor);
      if (valueEnd < 0 || valueEnd > arrayEnd) break;
      candidates.push({ raw: source.slice(cursor, valueEnd), line: lineIndex.lineAt(cursor) });
      cursor = valueEnd;
    }
    if (candidates.length !== parsedArray.length) {
      // 元素定位失败时退回整体重新序列化，保持“整段数组”语义。
      candidates.length = 0;
      for (const element of parsedArray) {
        candidates.push({ raw: String(JSON.stringify(element)), line: lineIndex.lineAt(bodyStart) });
      }
    }
  } else if (head.startsWith('{')) {
    // 完整单个 JSON 对象（跨行书写、其后只有前言/正文）才整段解析；
    // 一旦后面还有别的对象行，就退回逐行形态，保证“一坏行不丢独立好行”。
    const valueEnd = findJsonValueEnd(source, bodyStart);
    const valueText = valueEnd > 0 ? source.slice(bodyStart, valueEnd) : '';
    const rest = valueEnd > 0 ? source.slice(valueEnd) : '';
    const restHasObjectLine = rest.split('\n').some((line) => line.trim().startsWith('{'));
    let wholeObject = false;
    if (valueEnd > 0 && valueText.includes('\n') && !restHasObjectLine) {
      try {
        JSON.parse(valueText);
        wholeObject = true;
      } catch {
        wholeObject = false;
      }
    }
    if (wholeObject) candidates.push({ raw: valueText, line: lineIndex.lineAt(bodyStart) });
    else for (const candidate of lineCandidates(source)) candidates.push(candidate);
  } else {
    for (const candidate of lineCandidates(source)) candidates.push(candidate);
  }

  const limit = ATLAS_RUNTIME_LIMITS.operationsPerResponse;
  let validCount = 0;
  let firstDroppedLine: number | undefined;

  for (const candidate of candidates) {
    const bytes = utf8ByteLength(candidate.raw);
    if (bytes > ATLAS_RUNTIME_LIMITS.operationUtf8Bytes) {
      issues.push(
        issue(
          ATLAS_ERROR_CODES.OPERATION_TOO_LARGE,
          '$',
          `operation on line ${candidate.line} is ${bytes} bytes, over the ${ATLAS_RUNTIME_LIMITS.operationUtf8Bytes} byte per-operation limit; line skipped, other lines unaffected`,
          { line: candidate.line, retryable: true },
        ),
      );
      incomplete = true;
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(candidate.raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      issues.push(
        issue(
          ATLAS_ERROR_CODES.JSON_SYNTAX,
          '$',
          `line ${candidate.line}: invalid JSON (${bytes} bytes): ${detail}; excerpt: ${excerptOf(candidate.raw)}`,
          { line: candidate.line, retryable: true },
        ),
      );
      incomplete = true;
      continue;
    }

    const depth = jsonNestingDepth(candidate.raw);
    if (depth > ATLAS_RUNTIME_LIMITS.responseJsonDepth) {
      issues.push(
        issue(
          ATLAS_ERROR_CODES.JSON_TOO_DEEP,
          '$',
          `line ${candidate.line}: JSON nesting depth ${depth} exceeds ${ATLAS_RUNTIME_LIMITS.responseJsonDepth}; line skipped`,
          { line: candidate.line, retryable: true },
        ),
      );
      incomplete = true;
      continue;
    }

    const built = buildOperation(value, candidate, operations.length, issues);
    if (built.kind === 'error') {
      incomplete = true;
      continue;
    }
    if (built.kind === 'noop') {
      explicitNoop = true;
      continue;
    }
    validCount += 1;
    if (operations.length >= limit) {
      if (firstDroppedLine === undefined) firstDroppedLine = candidate.line;
      continue;
    }
    operations.push(built.parsed);
  }

  if (validCount > limit) {
    issues.push(
      issue(
        ATLAS_ERROR_CODES.TOO_MANY_OPERATIONS,
        '$',
        `response contains ${validCount} valid operations, over the ${limit} per-response limit; kept the first ${limit} and reported the remaining ${
          validCount - limit
        } (no silent drop)`,
        { line: firstDroppedLine, retryable: true },
      ),
    );
    incomplete = true;
  }

  return { operations, issues, explicitNoop, incomplete };
}

/**
 * P08：判断模型是否改用 SQL 作答。纯函数，无副作用。
 * 只看 extractPayload 之后的第一条非空有效行：以 SQL 语句关键字开头且不含 `{`。
 */
export function looksLikeSql(text: string): boolean {
  const { payload } = extractPayload(text);
  for (const line of payload.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.includes('{')) return false;
    return SQL_START_RE.test(trimmed);
  }
  return false;
}
