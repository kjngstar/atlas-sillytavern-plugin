// Run from the repository root: node docs/pr5-reacceptance-20261022/reproduce-branching.mjs
// Pure generator audit; no model request, browser, or user save mutation.
import assert from 'node:assert/strict';
import * as Kit from '../../vendor/atlas-spatial/index.mjs';
const scope={chatId:'audit-topology',branchId:'b',revision:1,viewMode:'author'};
const map={id:'floor-map',branch_id:'b',status:'active',container_location_id:'floor',name:'楼层',row_rev:1,frame_json:{cols:40,rows:24},meters_per_cell:1,scale_quality:'estimated'};
const locations=[{id:'floor',kind:'floor',parent_location_id:null},...['A_hall','B_kitchen','C_store','D_guest'].map(id=>({id,kind:'room',parent_location_id:'floor',map_id:map.id}))].map(l=>({...l,branch_id:'b',status:'active',name:l.id}));
const routes=['B_kitchen','C_store','D_guest'].map((id,i)=>({id:'r'+i,branch_id:'b',status:'open',kind:'door',from_location_id:'A_hall',to_location_id:id,bidirectional:1}));
const built=Kit.buildLayoutContext({scope,mapRow:map,maps:[map],locations,routes});
assert.equal(built.ok,true);
const rooms=locations.filter(l=>l.kind==='room').map(l=>({id:l.id,name:l.id,side:'north',w:l.id==='A_hall'?8:4,h:l.id==='A_hall'?8:4}));
const feasible=[{id:'A_hall',x:10,y:6,w:8,h:8},{id:'B_kitchen',x:18,y:6,w:4,h:4},{id:'C_store',x:10,y:2,w:4,h:4},{id:'D_guest',x:10,y:14,w:4,h:4}];
for(const r of feasible)assert.ok(r.x>=0&&r.y>=0&&r.x+r.w<=40&&r.y+r.h<=24);
for(let i=0;i<feasible.length;i++)for(let j=i+1;j<feasible.length;j++){
 const a=feasible[i],b=feasible[j];
 assert.ok(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y,'counterexample rooms must not overlap');
}
const a=feasible[0];
for(const b of feasible.slice(1)){
 const vertical=(a.x+a.w===b.x||b.x+b.w===a.x)&&Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>=.8;
 const horizontal=(a.y+a.h===b.y||b.y+b.h===a.y)&&Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>=.8;
 assert.ok(vertical||horizontal,'every requested door has a feasible shared wall');
}
const result=Kit.generateFloor({rooms,contents:[]},{...built.context,currentScope:scope});
console.log(JSON.stringify({ok:result.ok,issues:result.issues,feasibleCounterexample:feasible},null,2));
// Promoted to a passing regression on 2026-10-23; the original report is historical.
assert.equal(result.ok,true,JSON.stringify(result.issues));
assert.deepEqual(result.issues,[]);
assert.equal(result.scene.layout.doors.length,6);
