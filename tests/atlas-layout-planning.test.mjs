import test from 'node:test';
import assert from 'node:assert/strict';
import {supportedCorridor,normalizePlannedFrame} from '../src/atlas-layout-closure.ts';
import {resolveSpatialProfile} from '../src/atlas-spatial-profile.ts';
import {referenceReceiptReport} from '../ui/atlas-reference-data.mjs';
import {ensureInitialSpatialFrame} from '../src/atlas-spatial-frame.ts';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
const map={id:'m',container_location_id:'building'},building={id:'building',name:'白桦附楼',kind:'building',status:'active'},corridor={id:'c',name:'中央走廊',kind:'room',map_id:'m',parent_location_id:'building',status:'active'};
test('米制概览首次初始化也保持整数格数；独立容器画整个自身空间',()=>{
 const scope={chatId:'init',branchId:'b',revision:0,viewMode:'author'};
 const mapRow={id:'m',branch_id:'b',row_rev:1,container_location_id:'yard',frame_json:{cols:75,rows:80},meters_per_cell:.1,scale_quality:'estimated',scale_locked:0};
 const init=ensureInitialSpatialFrame({mapRow,scope,currentScope:scope,expectedRowRev:1,kind:'overview',widthM:7.5,heightM:8,locations:[],turnId:'t',operationId:'o'});
 assert.equal(init.ok,true);const after=init.mutation?.after??mapRow;
 assert.ok(Number.isInteger(after.frame_json.rows));assert.equal(after.frame_json.cols*after.meters_per_cell,7.5);assert.equal(after.frame_json.rows*after.meters_per_cell,8);
 const built=Kit.buildLayoutContext({scope,mapRow:after,locations:[{id:'yard',branch_id:'b',name:'庭院',kind:'other',status:'active',map_id:'parent'}]});
 const out=Kit.generateOverview({zones:[{id:'yard',name:'庭院',size:'small',role:'other'}]},built.context);
 assert.ok(out.scene.layout.selfArea);assert.deepEqual(out.scene.layout.shapes,[]);assert.deepEqual(Kit.sceneLocationGeometry(out.scene),[]);
});
test('生成时从已知物理尺寸统一旧小数幅面，确认比例尺和确认坐标保持',()=>{
 const legacy={...map,row_rev:1,frame_json:{cols:100,rows:66.6666667,reference_width_cells:12,reference_height_cells:8},meters_per_cell:.12,scale_quality:'estimated'};
 const before=JSON.stringify(legacy),size={widthM:12,heightM:8};
 const mutation=normalizePlannedFrame(legacy,size,[],[],'turn','op');assert.ok(mutation);
 const after=mutation.after;assert.equal(after.frame_json.cols,after.frame_json.reference_width_cells);assert.equal(after.frame_json.rows,after.frame_json.reference_height_cells);
 assert.ok(Number.isInteger(after.frame_json.rows));assert.equal(after.frame_json.cols*after.meters_per_cell,12);assert.equal(after.frame_json.rows*after.meters_per_cell,8);
 assert.equal(JSON.stringify(legacy),before);
 assert.equal(normalizePlannedFrame({...legacy,scale_quality:'confirmed'},size,[],[],'turn','op'),null);
 assert.equal(normalizePlannedFrame(legacy,size,[],[{map_id:'m',coord_precision:'exact'}],'turn','op'),null);
});
test('基础布局保存不能宣称模型细节也完成',()=>{
 const report=referenceReceiptReport({operation:'layout',coreSaved:true,sceneSaved:true,issues:[{code:'LAYOUT_DETAILS_DEFERRED',severity:'warning',message:'细节未完成'}]});
 assert.equal(report.layout.state,'partial');
});
test('生成流程只绑定正文明确支持的唯一同父同图走廊',()=>{
 const source='白桦附楼中的四个房间由中央走廊相连。';
 assert.equal(supportedCorridor(map,[building,corridor],source),'c');
 assert.equal(supportedCorridor(map,[building,corridor],''),null);
 assert.equal(supportedCorridor(map,[building,corridor],'白桦附楼没有中央走廊，各房间通过外门相连。'),null);
 assert.equal(supportedCorridor(map,[building,{...corridor,map_id:'other'}],source),null);
 assert.equal(supportedCorridor(map,[building,corridor,{...corridor,id:'c2'}],source),null);
});
test('生成流程根据登记的建筑与室外成员选择复合模板，名称不触发档案',()=>{
 const mixed=resolveSpatialProfile({map:{...map,frame_json:{}},container:building,members:[{id:'b2',kind:'building'},{id:'yard',kind:'other'}],routes:[]});
 assert.equal(mixed.profile.mode,'compound');assert.equal(mixed.profile.basis,'source-supported');
 const named=resolveSpatialProfile({map:{...map,frame_json:{}},container:{...building,name:'庭院驿站'},members:[{id:'room',kind:'room'}],routes:[]});
 assert.equal(named.profile.mode,'interior');
});
