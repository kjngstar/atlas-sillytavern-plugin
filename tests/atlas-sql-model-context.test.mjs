import test from 'node:test';
import assert from 'node:assert/strict';
import initSql from 'sql.js';
import {makeSeedWith,IDS} from './fixtures/atlas-sql/seed.mjs';
import {createTableReadPort} from '../src/atlas-db-readport.ts';
import {collectKnownRefs,collectEntityRefs} from '../src/atlas-sql-refs.ts';
import {buildSqlForegroundRequest} from '../src/atlas-sql-model-context.ts';
const SQL=await initSql();

test('实际前台请求保留地点父链、别名、尺寸和已有路线长度，不只给显示名',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const area={kind:'dimensions',widthM:60000,heightM:40000,quality:'confirmed',source:'story'};
    seed.db.run('UPDATE locations SET name=?, aliases_json=?, kind=?, parent_location_id=?, area_geometry_json=? WHERE branch_id=? AND id=?',[
      '“巡星”前驾驶舱',JSON.stringify(['前驾驶舱','巡星艇前驾驶舱']),'room',IDS.L1,JSON.stringify(area),IDS.branchMain,IDS.L2,
    ]);
    seed.db.run('UPDATE routes SET distance_m=?,distance_min_m=?,distance_max_m=? WHERE branch_id=? AND id=?',[42000,42000,42000,IDS.branchMain,IDS.R_AB]);
    seed.db.run('UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify({cols:100,rows:80,atlasScene:{debugPayload:'LOW_LEVEL_GEOMETRY_SENTINEL'}}),IDS.branchMain,IDS.M1]);
    const tables=createTableReadPort(seed.db),refs=collectKnownRefs(tables,IDS.branchMain),before=structuredClone(refs);
    const line=collectEntityRefs(tables,IDS.branchMain,refs).find(line=>line.startsWith(refs.find(r=>r.id===IDS.L2).alias+'='));
    const identity=JSON.parse(line.slice(line.indexOf('） ')+2));
    assert.equal(identity.parent_ref,refs.find(r=>r.id===IDS.L1).alias);
    assert.deepEqual(identity.aliases,['前驾驶舱','巡星艇前驾驶舱']);
    assert.equal(JSON.parse(typeof identity.area==='string'?identity.area:JSON.stringify(identity.area)).widthM,60000);
    const request=buildSqlForegroundRequest(tables,IDS.branchMain,{userText:'进入前驾驶舱',assistantText:'两人进入巡星艇前驾驶舱。',sourceSnapshot:[],anchor:{baseRevision:0}},'observe','identity-test',refs);
    const sent=request.messages.map(m=>m.content).join('\n');
    assert.ok(sent.includes(line),'真实模型发送和预览使用完整同一目录');
    assert.ok(sent.includes('"distance_m":42000'),'已有航程不能在目录中丢失');
    assert.ok(!sent.includes('LOW_LEVEL_GEOMETRY_SENTINEL'),'前台身份判断不发送所有地图的底层场景，布局锁由单图布局任务提供');
    assert.deepEqual(refs,before,'不能重编号冻结引用或修改原目录');
  }finally{seed.close();}
});
