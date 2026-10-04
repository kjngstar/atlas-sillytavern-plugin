/**
 * atlas-packed-replay.test.mjs — G03 离线重放验收。
 *
 * 计划 §3-G03：**pack 之后**用**打包产物**重复关键路径，证明「发布包 = 实际跑的代码」，
 * 而不是只有源码树里的测试绿：
 *   ① SQL 导入 → ② SQL 模型提交→ ③ 旧协议具名拒绝且零写入
 *   → ④ 回退 → ⑤ 任务推进（推演模块跟着走）→ ⑥ 地图
 *
 * 与其它端到端测试的区别：这里**不 import src/**，只 import `release/` 里的
 * `atlas-server-plugin/index.mjs`（它自己加载组件内的 `./dist/atlas-server.mjs`）。
 * 所以源码绿而产物坏（例如 dist 没重建、镜像没同步、版本没对齐）会被这一条抓住。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releasePlugin = join(root, "release", "atlas-server-plugin", "index.mjs");
const releaseUi = join(root, "release", "atlas-ui-extension");
const SECRET = "sk-packed-replay-0001";

function jsonResponse(status, payload) {
  const raw = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(raw), text: async () => raw };
}
const textResponse = (status, content) => jsonResponse(status, { choices: [{ message: { content } }] });

function buildWorld() {
  const base = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "atlas-packed-fixture", now: 1000 });
  const regionId = String((base.regions ?? [])[0]?.id ?? "");
  const parsed = parseWorld(JSON.parse(JSON.stringify({
    ...base,
    currentRegionId: regionId,
    currentYear: 812,
    points: [...(base.points ?? []), { id: 9001, name: "钟楼", x: 10, y: 10, regionId }],
  })));
  assert.ok(parsed, "夹具世界必须能过 parseWorld");
  return parsed;
}

const V2_ENVELOPE = JSON.stringify({ schemaVersion: 2, narrativeSummary: "旧协议封套", mapScaleHints: [] });


test("G03 离线重放：打包产物跑通 绑定 → 提交 → 协议不符 → 回退 → 任务推进 → 地图", async () => {
  assert.ok(existsSync(releasePlugin), "先跑 npm run pack（release/atlas-server-plugin/index.mjs 不存在）");

  // 产物自证版本：发布物与根包版本一致
  const pluginMod = await import(`file://${releasePlugin.replace(/\\/g, "/")}`);
  const packedManifest = JSON.parse(readFileSync(join(releaseUi, "manifest.json"), "utf8"));
  const packedServerPkg = JSON.parse(readFileSync(join(root, "release", "atlas-server-plugin", "package.json"), "utf8"));
  assert.equal(packedManifest.version, pluginMod.ATLAS_PLUGIN_VERSION, "UI manifest 与插件常量版本一致");
  assert.equal(packedServerPkg.version, pluginMod.ATLAS_PLUGIN_VERSION, "Server package 与插件常量版本一致");
  assert.equal(pluginMod.ATLAS_PLUGIN_VERSION, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "打包产物版本号与当前发布版本一致");

  const dir = mkdtempSync(join(tmpdir(), "atlas-packed-replay-"));
  let response = '{"op":"location.upsert","ref":"new:square","data":{"name":"广场","kind":"room"}}';
  let call=0,packedCore;
  const fetchFn = async () => {call++;return textResponse(200,response);};

  try {
    // 走**产物自己的** init（它会加载组件内的 ./dist/atlas-server.mjs）
    ({ core: packedCore } = await pluginMod.init(
      { get() {}, post() {}, put() {} },
      { dataDir: dir, fetchFn },
    ));
    const send=(route,body={})=>packedCore.handle("POST",route,{chatUid:"chat-a",chatId:"chat-a",...body},{local:true});
    const world=buildWorld();
    const imported=await send("/sql/chat/map/import",{world});
    assert.equal(imported.status,200,JSON.stringify(imported.body));
    assert.equal(imported.body.data.coreSaved,true);
    await packedCore.handle("PUT","/settings",{worldTurn:{name:"重放推演",endpoint:"https://mock.example.invalid/v1",model:"atlas-mock",apiKey:SECRET,timeoutMs:5000}},{local:true});
    const first=await send("/sql/turn",{hostMessageUid:"floor-1",variantKey:"v1",inputHash:"first",assistantText:"来到广场",sourceSnapshot:[]});
    assert.equal(first.body.data.coreSaved,true,JSON.stringify(first.body));
    assert.equal(first.body.data.receipt.status,"committed");
    const store=pluginMod.createNodeDocumentStore(dir);
    const before=JSON.stringify(await store.read("sql-chat:chat-a"));
    response=V2_ENVELOPE;
    const rejected=await send("/sql/turn",{hostMessageUid:"floor-bad",variantKey:"v1",inputHash:"bad",assistantText:"无效封套"});
    assert.equal(rejected.body.ok,false);
    assert.equal(rejected.body.error.code,"TURN_FAILED");
    assert.equal(rejected.body.error.details.receipt.status,"failed");
    assert.ok(rejected.body.error.details.receipt.issues.some(issue=>issue.code==="MINIMUM_FIELD_MISSING"),"旧协议封套具名拒绝");
    assert.equal(JSON.stringify(await store.read("sql-chat:chat-a")),before,"协议不符不得写入存档");
    const state=await send("/sql/chat/state");
    assert.equal(state.status,200,JSON.stringify(state.body));
    assert.equal(state.body.data.sqlMode,true);
    assert.ok(state.body.data.map.points.length>0,"发布入口投影真实 SQL 地图");
    const sql=await import(new URL("../release/atlas-server-plugin/dist/atlas-sql.mjs",import.meta.url));
    const readDb=async()=>{const metadata=await store.read("sql-chat:chat-a");const bytes=await sql.decodeSnapshot(metadata.atlas.database);return await sql.openDatabase(bytes.bytes ?? bytes);};
    let db=await readDb();
    const rows=(table)=>sql.queryBound(db,`SELECT * FROM ${table}`,[]);
    const actor=rows("characters")[0].id,clockBefore=rows("branches")[0].clock_s;db.close();
    const planned=await send("/sql/turn",{hostMessageUid:"floor-plan",variantKey:"v1",inputHash:"plan",manual:true,phaseBatches:["decision"],operations:[{op:"plan.propose",data:{actor_ref:actor,goal:"整理货物",steps:[{kind:"prepare",title:"整理货物",method:"清点货物"}]}}]});
    assert.equal(planned.body.data.coreSaved,true,JSON.stringify(planned.body));
    db=await readDb();assert.ok(rows("actions").length>=2,"正式 SQL 提交产出行动与步骤");db.close();
    const advanced=await send("/sql/turn",{hostMessageUid:"floor-rest",variantKey:"v1",inputHash:"rest",manual:true,operations:[{op:"event.propose",data:{title:"已休息一分钟",phase:"observed",activity:{kind:"rest",completed:true},time_hint:{elapsed_s:60}}}]});
    assert.equal(advanced.body.data.coreSaved,true,JSON.stringify(advanced.body));
    assert.equal(advanced.body.data.receipt.clockAfterS,clockBefore+60);
    const undone=await send("/sql/rollback",{targetParentTurnId:advanced.body.data.receipt.turnId});
    assert.equal(undone.body.data.coreSaved,true,JSON.stringify(undone.body));
    db=await readDb();assert.equal(rows("branches")[0].clock_s,clockBefore);assert.equal(sql.foreignKeyCheck(db).length,0);db.close();
    assert.ok(call>0,"产物自己的模型端口实际发出模拟请求");
    await packedCore.closeSqlSessions();
    const reopened=await send("/sql/chat/state");assert.equal(reopened.status,200);assert.equal(reopened.body.data.map.points.length,state.body.data.map.points.length);

  } finally {
    await packedCore?.closeSqlSessions();
    try { rmdirSync(dir, { recursive: true }); } catch { /* 临时目录，清不掉不影响验收 */ }
  }
});
