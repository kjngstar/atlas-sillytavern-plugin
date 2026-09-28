/**
 * atlas-db-knowledge-view.test.mjs — T22 主角认知与塑造区（§10.4）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { projectForPov, projectPortrayal, projectPromptView, renderSqlSceneContext } from '../src/atlas-db-knowledge-view.ts';

const SQL = await (await import('sql.js')).default();

async function worldWithKnowledge() {
  const seed = await makeSeedWith(SQL);
  insertRows(seed.db, 'information', [
    {
      branch_id: IDS.branchMain,
      id: 'INFO1',
      row_rev: 1,
      created_turn_id: IDS.seedTurn,
      updated_turn_id: IDS.seedTurn,
      kind: 'rumor',
      title: '学校的事',
      content: '学校今天有外人来访',
      source_event_id: null,
      subject_entity_id: IDS.L2,
      payload_json: JSON.stringify({ predicate: 'exists', value: true }),
      origin_location_id: IDS.L1,
      originator_entity_id: null,
      parent_information_id: null,
      truth_status: 'unknown',
      secrecy: 'public',
      topic_key: 't1',
      content_hash: 'h1',
      created_at_s: 0,
      expires_at_s: null,
      supersedes_information_id: null,
      status: 'active',
    },
    {
      branch_id: IDS.branchMain,
      id: 'INFO2',
      row_rev: 1,
      created_turn_id: IDS.seedTurn,
      updated_turn_id: IDS.seedTurn,
      kind: 'observation',
      title: '刺客的密谋',
      content: '有人打算在王宫动手',
      source_event_id: null,
      subject_entity_id: IDS.C3,
      payload_json: JSON.stringify({ predicate: 'located_at', value: { entity_ref: IDS.L1 }, as_of_s: 0 }),
      origin_location_id: IDS.L1,
      originator_entity_id: null,
      parent_information_id: null,
      truth_status: 'true',
      secrecy: 'secret',
      topic_key: 't2',
      content_hash: 'h2',
      created_at_s: 0,
      expires_at_s: null,
      supersedes_information_id: null,
      status: 'active',
    },
  ]);
  insertRows(seed.db, 'knowledge', [
    {
      branch_id: IDS.branchMain,
      id: 'K1',
      row_rev: 1,
      created_turn_id: IDS.seedTurn,
      updated_turn_id: IDS.seedTurn,
      knower_character_id: null,
      knower_faction_id: null,
      is_pov: 1,
      information_id: 'INFO1',
      source_entity_id: null,
      source_front_id: null,
      source_channel_id: null,
      first_received_at_s: 0,
      last_confirmed_at_s: null,
      belief: 'believed',
      attention: 'normal',
      reaction_note: '',
      status: 'active',
    },
    {
      branch_id: IDS.branchMain,
      id: 'K2',
      row_rev: 1,
      created_turn_id: IDS.seedTurn,
      updated_turn_id: IDS.seedTurn,
      knower_character_id: IDS.C2,
      knower_faction_id: null,
      is_pov: 0,
      information_id: 'INFO2',
      source_entity_id: null,
      source_front_id: null,
      source_channel_id: null,
      first_received_at_s: 0,
      last_confirmed_at_s: null,
      belief: 'heard',
      attention: 'high',
      reaction_note: '',
      status: 'active',
    },
  ]);
  return seed;
}

test('正文 SQL 投影：只提供主角已知内容，排除作者真值、载荷及他人知识', async () => {
  const seed = await worldWithKnowledge();
  const world = { db: seed.db, branchId: IDS.branchMain };
  try {
    let text = renderSqlSceneContext(world);
    assert.doesNotMatch(text, /刺客|王宫动手|学校今天有外人/);
    seed.db.run("UPDATE knowledge SET knower_character_id = ?, is_pov = 0, belief = 'verified' WHERE branch_id = ? AND id = 'K1'", [IDS.C1, IDS.branchMain]);
    seed.db.run("UPDATE information SET payload_json = ? WHERE branch_id = ? AND id = 'INFO1'", [JSON.stringify({ author_secret: '隐秘幕后细节' }), IDS.branchMain]);
    text = renderSqlSceneContext(world);
    assert.match(text, /已核实的消息：学校今天有外人来访/);
    assert.doesNotMatch(text, /隐秘幕后细节|truthForAuthor|payload|王宫动手/);
    seed.db.run("UPDATE knowledge SET first_received_at_s = 10 WHERE branch_id = ? AND id = 'K1'", [IDS.branchMain]);
    assert.doesNotMatch(renderSqlSceneContext(world), /学校今天有外人/);
    seed.db.run("UPDATE knowledge SET first_received_at_s = 0 WHERE branch_id = ? AND id = 'K1'", [IDS.branchMain]);
    seed.db.run("UPDATE information SET status = 'retracted' WHERE branch_id = ? AND id = 'INFO1'", [IDS.branchMain]);
    assert.doesNotMatch(renderSqlSceneContext(world), /学校今天有外人/);
    assert.doesNotMatch(renderSqlSceneContext({ db: seed.db, branchId: IDS.branchB }), /学校今天有外人/);
  } finally { seed.close(); }
});

test('正文 SQL 投影：当地公开风声只在实际接触机会存在时提供，不自动写认知', async () => {
  const seed = await worldWithKnowledge();
  const world = { db: seed.db, branchId: IDS.branchMain };
  try {
    seed.db.run("UPDATE knowledge SET knower_character_id = ?, is_pov = 0 WHERE branch_id = ? AND id = 'K1'", [IDS.C2, IDS.branchMain]);
    seed.db.run('UPDATE branches SET clock_s = 120, clock_max_s = 120 WHERE id = ?', [IDS.branchMain]);
    seed.db.run(`INSERT INTO rumor_fronts (branch_id,id,row_rev,created_turn_id,updated_turn_id,information_id,location_id,first_available_at_s,last_reinforced_at_s)
      VALUES (?,?,1,?,?,?, ?,0,0)`, [IDS.branchMain, 'FRONT1', IDS.seedTurn, IDS.seedTurn, 'INFO1', IDS.L2]);
    assert.doesNotMatch(renderSqlSceneContext(world), /学校今天有外人/);
    seed.db.run(`INSERT INTO actions (branch_id,id,row_rev,created_turn_id,updated_turn_id,actor_entity_id,kind,target_location_id,started_at_s,status)
      VALUES (?,?,1,?,?,?,'wait',?,0,'active')`, [IDS.branchMain, 'WAIT1', IDS.seedTurn, IDS.seedTurn, IDS.C1, IDS.L2]);
    assert.match(renderSqlSceneContext(world), /不代表已经注意或核实.*学校今天有外人/);
    const count = seed.db.exec("SELECT COUNT(*) FROM knowledge WHERE knower_character_id = 'C1'")[0].values[0][0];
    assert.equal(count, 0, '投影只读，候选不变成主角认知');
    seed.db.run("UPDATE information SET secrecy = 'secret' WHERE branch_id = ? AND id = 'INFO1'", [IDS.branchMain]);
    assert.doesNotMatch(renderSqlSceneContext(world), /学校今天有外人/);
    seed.db.run("UPDATE information SET secrecy = 'public' WHERE branch_id = ? AND id = 'INFO1'", [IDS.branchMain]);
    seed.db.run('UPDATE rumor_fronts SET audience_json = ? WHERE branch_id = ?', [JSON.stringify({ access: 'members' }), IDS.branchMain]);
    assert.doesNotMatch(renderSqlSceneContext(world), /学校今天有外人/);
    seed.db.run('UPDATE rumor_fronts SET audience_json = ? WHERE branch_id = ?', [JSON.stringify({ access: 'public' }), IDS.branchMain]);
    seed.db.run('UPDATE characters SET location_id = ? WHERE branch_id = ? AND id = ?', [IDS.L3, IDS.branchMain, IDS.C1]);
    assert.doesNotMatch(renderSqlSceneContext(world), /学校今天有外人/);
  } finally { seed.close(); }
});

test('T22-01 主角视图只包含 is_pov 认知；他人认知不进主角投影', async () => {
  const seed = await worldWithKnowledge();
  try {
    const projection = projectForPov({ db: seed.db, branchId: IDS.branchMain }, { characterId: null, isPovRow: true });
    const ids = projection.knownFacts.map((f) => f.informationId);
    assert.deepEqual(ids, ['INFO1']);
    assert.equal(ids.includes('INFO2'), false, '刺客的密谋不在主角认知里');
    assert.equal(projection.knownLocations.length, 1);
    assert.equal(projection.knownLocations[0].locationId, IDS.L2);
  } finally {
    seed.close();
  }
});

test('T22-02 绑定 pov_character_id 后直接用该人物行（不再读 is_pov）', async () => {
  const seed = await worldWithKnowledge();
  try {
    const projection = projectForPov({ db: seed.db, branchId: IDS.branchMain }, { characterId: IDS.C2 });
    assert.deepEqual(projection.knownFacts.map((f) => f.informationId), ['INFO2']);
    assert.equal(projection.knownCharacters[0].entityId, IDS.C3);
    assert.equal(projection.knownCharacters[0].identityKnown, false, '知道名字不等于知道身份');
    assert.equal(projection.lastSeen.length, 1);
    assert.equal(projection.lastSeen[0].locationId, IDS.L1);
  } finally {
    seed.close();
  }
});

test('T22-03 字段级投影：不带 description / personality / 关系图', async () => {
  const seed = await worldWithKnowledge();
  try {
    const projection = projectForPov({ db: seed.db, branchId: IDS.branchMain }, { characterId: IDS.C2 });
    const text = JSON.stringify(projection);
    assert.equal(text.includes('"personality":'), false, '不得带 personality 字段');
    assert.equal(text.includes('"description":'), false, '不得带 description 字段');
    assert.equal(text.includes('"relations"'), false, '不得带关系图');
    assert.equal(text.includes('真名'), false);
    assert.ok(projection.boundaries.some((b) => b.includes('知道名字不等于读到全档案')));
  } finally {
    seed.close();
  }
});

test('T22-04 上次见于明确是历史信息，不冒充当前跟踪', async () => {
  const seed = await worldWithKnowledge();
  try {
    const projection = projectForPov({ db: seed.db, branchId: IDS.branchMain }, { characterId: IDS.C2 });
    assert.equal(projection.lastSeen[0].atS, 0);
    // 刺客当前实际位置仍在 L1；把刺客挪走后，lastSeen 不应自动跟着变。
    seed.db.run(`UPDATE characters SET location_id = 'L3' WHERE branch_id = ? AND id = ?`, [IDS.branchMain, IDS.C3]);
    const after = projectForPov({ db: seed.db, branchId: IDS.branchMain }, { characterId: IDS.C2 });
    assert.equal(after.lastSeen[0].locationId, IDS.L1, 'lastSeen 是当时观察到的位置，不是实时跟踪');
  } finally {
    seed.close();
  }
});

test('T22-05 塑造区只在场的 NPC：远方角色不进注入范围', async () => {
  const seed = await worldWithKnowledge();
  try {
    const portrayal = projectPortrayal({ db: seed.db, branchId: IDS.branchMain }, { locationId: IDS.L2 });
    const ids = portrayal.entries.map((e) => e.entityId);
    assert.deepEqual(ids, [IDS.C1], '只有艾琳在学校');
    assert.equal(ids.includes(IDS.C3), false, '刺客不在场，不注入其隐藏想法');
    assert.ok(portrayal.entries.every((e) => e.disclosure === 'narrator_only'));
    assert.ok(portrayal.boundaries.some((b) => b.includes('不等于主角已知')));
  } finally {
    seed.close();
  }
});

test('T22-06 位置未知的角色不作为在场角色注入，并给出排除原因', async () => {
  const seed = await worldWithKnowledge();
  try {
    // 刺客只知道在城里（粗定位）；把信使清成未知位置后按 actorIds 传入。
    seed.db.run(`UPDATE characters SET location_id = NULL, map_id = NULL, grid_x = NULL, grid_y = NULL WHERE branch_id = ? AND id = ?`, [
      IDS.branchMain,
      IDS.C2,
    ]);
    const portrayal = projectPortrayal({ db: seed.db, branchId: IDS.branchMain }, { locationId: IDS.L1, actorIds: [IDS.C2, IDS.C3] });
    assert.equal(portrayal.entries.some((e) => e.entityId === IDS.C2), false);
    assert.ok(portrayal.exclusions.some((x) => x.startsWith(IDS.C2)));
    assert.ok(portrayal.entries.some((e) => e.entityId === IDS.C3));
  } finally {
    seed.close();
  }
});

test('T22-07 projectPromptView：作者视图开关不扩大主角投影范围', async () => {
  const seed = await worldWithKnowledge();
  try {
    const povView = projectPromptView({ db: seed.db, branchId: IDS.branchMain }, { povId: null, viewMode: 'pov' });
    const authorView = projectPromptView({ db: seed.db, branchId: IDS.branchMain }, { povId: null, viewMode: 'author' });
    assert.deepEqual(
      authorView.pov.knownFacts.map((f) => f.informationId),
      povView.pov.knownFacts.map((f) => f.informationId),
      '作者视图不改变主角字段级投影',
    );
    assert.ok(povView.promptScope.length >= 1);
  } finally {
    seed.close();
  }
});

test('T22-08 秘密渠道不进主角投影；主角拥有的非秘密渠道可见', async () => {
  const seed = await worldWithKnowledge();
  try {
    insertRows(seed.db, 'channels', [
      {
        branch_id: IDS.branchMain,
        id: 'CH1',
        row_rev: 1,
        created_turn_id: IDS.seedTurn,
        updated_turn_id: IDS.seedTurn,
        name: '王宫监视水晶',
        kind: 'surveillance',
        owner_entity_id: IDS.C2,
        source_entity_id: null,
        source_location_id: IDS.L1,
        recipient_entity_id: IDS.C2,
        recipient_location_id: null,
        scope_json: JSON.stringify({ location_refs: [IDS.L1], entity_refs: [], topics: [] }),
        requirements_json: null,
        latency_json: JSON.stringify({ quality: 'explicit', min_s: 0, nominal_s: 0, max_s: 0, basis_refs: [] }),
        transport_mode_key: null,
        reliability: 'high',
        secrecy: 'secret',
        basis_quality: 'confirmed',
        valid_from_s: 0,
        valid_until_s: null,
        status: 'active',
      },
    ]);
    const projection = projectForPov({ db: seed.db, branchId: IDS.branchMain }, { characterId: IDS.C2 });
    assert.equal(projection.knownChannels.length, 0, '秘密渠道不随 owner 一起暴露');
    assert.equal(JSON.stringify(projection).includes('王宫监视水晶'), false);
  } finally {
    seed.close();
  }
});
