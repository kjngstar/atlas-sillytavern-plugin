import {generateFloor,generateCity,generateOverview} from './generation.mjs';
import {placeMarkers,buildOverlays} from './placement.mjs';
import {parseWholeArguments,failure} from './contracts.mjs';
export const TOOL_NAMES=Object.freeze(['atlas_generate_floor','atlas_generate_city','atlas_place_markers','atlas_build_overlays','atlas_generate_overview']);
/** Neutral definitions. Provider message/tool envelopes belong to the existing model adapter. */
export function getSpatialToolDefinitions(){
  const id={type:'string',minLength:1,maxLength:160},num={type:'number'},item=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
  const rooms=item({id,name:{type:'string'},side:{enum:['north','south']},role:{enum:['indoor','outdoor','garden']},w:num,h:num},['id','side','w','h']);
  const groups=item({id,name:{type:'string'},roomId:id,type:{enum:['shelf','desk','bench','reading','stairs','table','chair','bed','cabinet','doorway','light','decor']},w:num,h:num},['id','roomId','type','w','h']);
  const descriptions=['生成当前地图的室内细节；只提供房间、尺寸和归属，程序计算位置','生成有河流约束的城市分区和建筑；保留已保存的几何','在调用者提供的合法区域内摆放视觉标点；不改变实体真实位置','从程序提供的已过滤关系、路线与传播数据生成图层','生成广域概览：分区、已登记路线与局部装饰；不新建 SQL 实体，装饰永远不是道路'];
  const overviewZone=item({id,name:{type:'string'},role:{enum:['city','settlement','forest','water','mountain','ruins','district','campus','land','other']},size:{enum:['small','medium','large']},sector:{enum:['north','northeast','east','southeast','south','southwest','west','northwest','center']},near:id},['id']);
  const overviewLink=item({id,name:{type:'string'}},['id']);
  const overviewFeature=item({id,type:{enum:['forest_texture','ridge','shore','building_cluster','road_texture','ruins_scatter','watercourse']},zoneId:id,density:{enum:['low','medium','high']},fromSector:{enum:['north','northeast','east','southeast','south','southwest','west','northwest']},toSector:{enum:['north','northeast','east','southeast','south','southwest','west','northwest']},widthClass:{enum:['narrow','medium','wide']}},['id','type']);
  return TOOL_NAMES.map((name,i)=>({name,description:descriptions[i],inputSchema:i===0?item({mapId:id,width:num,height:num,corridorWidth:num,rooms:{type:'array',maxItems:24,items:rooms},contents:{type:'array',maxItems:128,items:groups},actors:{type:'array',maxItems:128,items:item({id,name:{type:'string'},roomId:id,near:id},['id','roomId'])},items:{type:'array',maxItems:256,items:item({id,name:{type:'string'},on:id},['id','on'])}},['mapId','rooms']):i===1?item({mapId:id,width:num,height:num,riverWidth:num,enclosure:{enum:['open','wall']},blocksPerDistrict:{type:'integer',minimum:0,maximum:24},districts:{type:'array',maxItems:16,items:item({id,name:{type:'string'},bank:{enum:['west','east']},order:num},['id','bank','order'])},buildings:{type:'array',maxItems:64,items:item({id,name:{type:'string'},districtId:id,w:num,h:num},['id','districtId','w','h'])}},['mapId','riverWidth','districts']):i===2?item({regionId:id,markerIds:{type:'array',maxItems:512,items:id}},['regionId','markerIds']):i===3?item({overlayIds:{type:'array',maxItems:256,items:id},selectedEntityId:id},['overlayIds']):item({mapId:id,surface:{enum:['mixed','urban','forest','mountain','water','indoor','void']},rebuild:{type:'boolean'},zones:{type:'array',maxItems:64,items:overviewZone},links:{type:'array',maxItems:128,items:overviewLink},features:{type:'array',maxItems:128,items:overviewFeature},deletes:item({zones:{type:'array',items:id},links:{type:'array',items:id},features:{type:'array',items:id}},[])},['mapId'])}));
}
export function executeSpatialTool(call,context){
  try{
    if(!TOOL_NAMES.includes(call?.name))return failure('TOOL_UNKNOWN','$.name','不支持的工具');
    const input=parseWholeArguments(call.arguments);
    if(call.name==='atlas_generate_floor')return generateFloor(input,context);
    if(call.name==='atlas_generate_city')return generateCity(input,context);
    if(call.name==='atlas_generate_overview')return generateOverview(input,context);
    if(call.name==='atlas_place_markers'){
      const region=context.regions?.[input.regionId],markers=(input.markerIds??[]).map(id=>context.markers?.[id]);
      if(!region||markers.some(m=>!m))return failure('TOOL_REF_UNKNOWN','$.markerIds','区域或实体不在本次上下文');
      return placeMarkers({region,markers,obstacles:context.obstacles??[],previous:context.previousMarkers??[],step:context.placementStep??.25});
    }
    const rows=(input.overlayIds??[]).map(id=>context.overlays?.[id]);if(rows.some(r=>!r))return failure('TOOL_REF_UNKNOWN','$.overlayIds','图层不在程序提供的可见集合中');
    return buildOverlays({mapId:context.map.id,rows,positions:context.positions??[],selectedEntityId:input.selectedEntityId??null});
  }catch(e){return failure('TOOL_ARGUMENT_INVALID','$.arguments','工具参数不是完整可用对象',{detailCode:String(e.message)});}
}
