/**
 * tests/fixtures/atlas-sql/model-cases.mjs — T01 模型样例夹具（§18.2 P01–P12）。
 *
 * `response` 是**模型原始文本**，不能被预先 normalize 或修好；`expected` 只断言可观察结果。
 * 每个样例：{id, phase, seedPatch, sourceText, response, expected}
 */

import { IDS, makeSeedWith, insertRows } from './seed.mjs';

/** seedPatch：在基础种子上追加的合成数据（可选）。 */
const CASES = [
  {
    id: 'P01',
    phase: 'observe',
    title: '只有心理，没有引文。必须成功。',
    seedPatch: null,
    sourceText: '艾琳看了他一眼，没有多说。',
    response: '{"op":"character.upsert","ref":"C1","data":{"thought":"他似乎在隐瞒什么。"}}',
    expected: {
      appliedOps: 1,
      failedGroups: 0,
      errorCodes: [],
      mustChange: [{ table: 'characters', id: IDS.C1, field: 'thought', equals: '他似乎在隐瞒什么。' }],
      mustNotChange: [{ table: 'characters', id: IDS.C1, field: 'location_id' }],
      forbidsCodes: ['QUOTE_REQUIRED', 'QUOTE_NOT_FOUND'],
      verification: ['source_bound', 'causal'],
    },
  },
  {
    id: 'P02',
    phase: 'observe',
    title: '人物前向引用本轮后面才建立的学校。必须成功。',
    seedPatch: null,
    sourceText: '教师艾琳在圣光学校等候。',
    response:
      '{"op":"character.upsert","ref":"new:elin","data":{"name":"艾琳","identity":"学校教师","location_ref":"new:school"}}\n{"op":"location.upsert","ref":"new:school","data":{"name":"圣光学校","kind":"building"}}',
    expected: {
      appliedOps: 2,
      failedGroups: 0,
      errorCodes: [],
      mustCreate: [
        { table: 'locations', nameField: 'name', nameEquals: '圣光学校' },
        { table: 'characters', nameField: 'name', nameEquals: '艾琳', locationRefOf: '圣光学校' },
      ],
      mustBeNull: [{ table: 'characters', nameField: 'name', nameEquals: '艾琳', field: 'grid_x' }],
    },
  },
  {
    id: 'P03',
    phase: 'observe',
    title: '第二行截断，第一行没有依赖。第一行保留。',
    seedPatch: null,
    sourceText: '她只是看着。',
    response: '{"op":"character.upsert","ref":"C1","data":{"thought":"先观察。"}}\n{"op":"location.upsert","ref":"new:broken","data":{"name":"',
    expected: {
      appliedOps: 1,
      failedGroups: 0,
      errorCodes: ['JSON_SYNTAX'],
      syntaxLine: 2,
      mustChange: [{ table: 'characters', id: IDS.C1, field: 'thought', equals: '先观察。' }],
      mustNotCreate: [{ table: 'locations' }],
      receipt: 'partial',
    },
  },
  {
    id: 'P04',
    phase: 'observe',
    title: '名称中有单引号、分号和中文引号。',
    seedPatch: null,
    sourceText: '港口联络人自报姓名。',
    response: '{"op":"character.upsert","ref":"new:oneil","data":{"name":"O\'Neil；“渡鸦”","identity":"港口联络人"}}',
    expected: {
      appliedOps: 1,
      failedGroups: 0,
      mustCreate: [{ table: 'characters', nameField: 'name', nameEquals: "O'Neil；“渡鸦”" }],
      exactNameMatch: true,
      characterCount: 1,
    },
  },
  {
    id: 'P05',
    phase: 'observe',
    title: '一组引用不存在，另一组更新独立人物。',
    seedPatch: null,
    sourceText: '分别处理两件事。',
    response:
      '{"op":"character.upsert","ref":"C1","data":{"location_ref":"new:missing"}}\n{"op":"character.upsert","ref":"C2","data":{"thought":"按原路继续。"}}',
    expected: {
      appliedOps: 1,
      failedGroups: 1,
      errorCodes: ['REF_UNKNOWN'],
      mustChange: [{ table: 'characters', id: IDS.C2, field: 'thought', equals: '按原路继续。' }],
      mustNotChange: [{ table: 'characters', id: IDS.C1, field: 'location_id' }],
      independentGroupSurvives: true,
    },
  },
  {
    id: 'P06',
    phase: 'observe',
    title: '有无变化的明确回复。',
    seedPatch: null,
    sourceText: '无事发生。',
    response: '{"op":"noop"}',
    expected: {
      appliedOps: 0,
      failedGroups: 0,
      explicitNoop: true,
      forbidsCodes: ['EMPTY_RESPONSE'],
      receipt: 'noop',
    },
  },
  {
    id: 'P07',
    phase: 'observe',
    title: '复杂含引号心理。',
    seedPatch: null,
    sourceText: '她说明天再来。',
    response: '{"op":"character.upsert","ref":"C1","data":{"thought":"她说：\\"明天再来\\"，但我还不确定。\\n先观察。"}}',
    expected: {
      appliedOps: 1,
      failedGroups: 0,
      mustChange: [{ table: 'characters', id: IDS.C1, field: 'thought', equals: '她说："明天再来"，但我还不确定。\n先观察。' }],
    },
  },
  {
    id: 'P08',
    phase: 'observe',
    title: 'SQL 输出给生产模型接口。',
    seedPatch: null,
    sourceText: '（模型误用 SQL）',
    response: "UPDATE characters SET thought='先观察' WHERE id='C1';",
    expected: {
      appliedOps: 0,
      failedGroups: 0,
      errorCodes: ['UNSUPPORTED_RESPONSE_FORMAT'],
      mustNotChange: [{ table: 'characters', id: IDS.C1, field: 'thought' }],
      noFakeNoop: true,
    },
  },
  {
    id: 'P09',
    phase: 'observe',
    title: '未闭合思考段。',
    seedPatch: null,
    sourceText: '（模型思考被打断）',
    response: '<think>\n可能可以这样写：\n{"op":"character.upsert","ref":"C1","data":{"thought":"这是思考里的示例"}}',
    expected: {
      appliedOps: 0,
      failedGroups: 0,
      errorCodes: ['UNTERMINATED_REASONING'],
      mustNotChange: [{ table: 'characters', id: IDS.C1, field: 'thought' }],
    },
  },
  {
    id: 'P10',
    phase: 'observe',
    title: '整个 JSON 数组合法。',
    seedPatch: null,
    sourceText: '两个人都沉默着。',
    response:
      '[{"op":"character.upsert","ref":"C1","data":{"thought":"先观察。"}},{"op":"character.upsert","ref":"C2","data":{"thought":"继续赶路。"}}]',
    expected: {
      appliedOps: 2,
      failedGroups: 0,
      mustChange: [
        { table: 'characters', id: IDS.C1, field: 'thought', equals: '先观察。' },
        { table: 'characters', id: IDS.C2, field: 'thought', equals: '继续赶路。' },
      ],
    },
  },
  {
    id: 'P11',
    phase: 'observe',
    title: '旧外壳漏收尾，但内容完整。',
    seedPatch: null,
    sourceText: '她在等消息。',
    response: '<atlasEdit>\n{"op":"character.upsert","ref":"C1","data":{"thought":"等待消息。"}}',
    expected: {
      appliedOps: 1,
      failedGroups: 0,
      errorCodes: [],
      warnsCodes: ['WRAPPER_INCOMPLETE'],
      mustChange: [{ table: 'characters', id: IDS.C1, field: 'thought', equals: '等待消息。' }],
    },
  },
  {
    id: 'P12',
    phase: 'observe',
    title: '普通新建重要角色。',
    seedPatch: null,
    sourceText: '王宫卫队长伊娜站在门侧。',
    response:
      '{"op":"character.upsert","ref":"new:captain","data":{"name":"伊娜","identity":"世界书明确描述的王宫卫队长","importance":"core"},"source":"W1"}',
    expected: {
      appliedOps: 1,
      failedGroups: 0,
      mustCreate: [{ table: 'characters', nameField: 'name', nameEquals: '伊娜', importance: 'core' }],
      mustBeNull: [{ table: 'characters', nameField: 'name', nameEquals: '伊娜', field: 'location_id' }],
      worldbookDoesNotPlaceAtPov: true,
    },
  },
];

/** 世界书来源快照（P12 的 source=W1）。 */
export const SOURCE_SNAPSHOT = [
  { key: 'W1', text: '王宫卫队长伊娜：忠于王室，常驻王宫。', hash: 'hash_W1', kind: 'lorebook' },
  { key: 'S1', text: '', hash: 'hash_S1', kind: 'story' },
];

export function modelCases() {
  return CASES.map((c) => ({ ...c }));
}

export function caseById(id) {
  return CASES.find((c) => c.id === id) ?? null;
}

/** 为某个样例构造独立世界（附带 seedPatch）。 */
export async function makeCaseWorld(SQL, caseId) {
  const seed = await makeSeedWith(SQL);
  const c = caseById(caseId);
  if (c?.seedPatch) {
    for (const [table, rows] of Object.entries(c.seedPatch)) {
      insertRows(seed.db, table, rows);
    }
  }
  return seed;
}

export const CASE_IDS = CASES.map((c) => c.id);
