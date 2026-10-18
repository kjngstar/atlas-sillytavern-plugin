import {makeSeedWith,IDS,insertRows} from './seed.mjs';
import {createRow} from '../../../src/atlas-db-defaults.ts';

export async function makeContactFlowSeed(SQL){
 const seed=await makeSeedWith(SQL),db=seed.db,branchId=IDS.branchMain;
 const add=(table,id,data)=>insertRows(db,table,[createRow(table,data,{branchId,id,turnId:IDS.seedTurn,clockS:0,nowWallMs:1700000000000,rulesetVersion:'atlas-1'})]);
 db.run('UPDATE branches SET clock_s=40,clock_min_s=40,clock_max_s=40 WHERE id=?',[branchId]);
 db.run("UPDATE characters SET name='联系验收甲',role='protagonist',map_id=?,grid_x=24,grid_y=32,coord_precision='exact' WHERE branch_id=? AND id=?",[IDS.M1,branchId,IDS.C1]);
 db.run("UPDATE characters SET name='联系验收乙',map_id=?,grid_x=78,grid_y=32,coord_precision='exact' WHERE branch_id=? AND id=?",[IDS.M1,branchId,IDS.C2]);
 db.run("UPDATE locations SET name='传播起点',grid_x=20,grid_y=18 WHERE branch_id=? AND id=?",[branchId,IDS.L1]);
 db.run("UPDATE locations SET name='传播终点',grid_x=82,grid_y=52 WHERE branch_id=? AND id=?",[branchId,IDS.L2]);
 db.run('UPDATE routes SET geometry_json=?,geometry_quality=? WHERE branch_id=? AND id=?',[JSON.stringify({kind:'line',coordinates:[[20,18],[40,12],[60,45],[82,52]]}),'confirmed',branchId,IDS.R_AB]);
 add('relations','REL_CONTACT',{subject_entity_id:IDS.C1,object_entity_id:IDS.C2,kind:'knows',label:'验收联系：互相认识',secrecy:'public',basis_quality:'confirmed',status:'active'});
 add('information','INFO_CONTACT',{kind:'announcement',title:'验收消息：正午开门',content:'消息从传播起点沿已登记道路传往传播终点。',origin_location_id:IDS.L1,secrecy:'public',truth_status:'true',status:'active',content_hash:'contact-flow-fixture'});
 add('rumor_fronts','RF_ORIGIN',{information_id:'INFO_CONTACT',location_id:IDS.L1,first_available_at_s:0,status:'active',audience_json:'["public"]'});
 add('actions','ACT_TRANSMIT',{actor_entity_id:IDS.L1,kind:'transmit',title:'验收消息传播',status:'active',payload_json:{program_kind:'rumor_delivery',front_id:'RF_ORIGIN',information_id:'INFO_CONTACT',from_location_id:IDS.L1,to_location_id:IDS.L2,route_id:IDS.R_AB,depart_at_s:0,arrive_at_s:100},secrecy:'public'});
 return {...seed,add,ctx:{db,branchId,revision:0,viewMode:'author',povId:IDS.C1,chatId:IDS.chatA}};
}
