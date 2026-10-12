import test from 'node:test';
import assert from 'node:assert/strict';
import {IDS, makeSeedWith} from './fixtures/atlas-sql/seed.mjs';
import {loadSqlModule} from '../src/atlas-db-runtime.ts';
import {createTableReadPort} from '../src/atlas-db-readport.ts';
import {discoverTargets, scopeKeyFor, targetSignature} from '../src/atlas-construction-progress.ts';

test('已停用目标恢复 active 后重新进入持久建设队列',async()=>{
 const SQL=await loadSqlModule(),seed=await makeSeedWith(SQL);
 try{
  const tables=createTableReadPort(seed.db),scopeKey=scopeKeyFor({mode:'bootstrap',focusLocationIds:[]});
  const location=tables.selectOne('locations',IDS.branchMain,IDS.L3);
  const retired={...location,status:'archived'};
  const rows=[{id:'reactivate-progress',kind:'target',scopeKey,subjectKey:IDS.L3,
   inputSignature:targetSignature(retired),status:'suspended',lastServedSeq:1,payload:{},payloadOk:true,raw:{}}];
  const discovery=discoverTargets({tables,branchId:IDS.branchMain,scopeKey,focusIds:[],rows});
  assert.ok(discovery.enqueueIds.includes(IDS.L3),'恢复的真实 SQL 地点必须再次被发现');
 }finally{seed.close();}
});
