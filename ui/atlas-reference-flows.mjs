/** Project only scoped, read-only SQL flow DTOs; missing geometry stays a card. */
export function projectReferenceFlows(dto,node){
  const result={relations:[],flows:[],journeys:[],cards:[]};
  if(!node||dto?.metadata?.stale)return result;
  const tr=node.transform;
  if(!tr?.bounds||!Number.isFinite(tr.scale))return result;
  for(const row of dto?.items??[]){
    const path=row.path;
    // A relationship is conceptual: visible schematic markers can anchor it
    // without turning their display positions into physical world coordinates.
    if(row.kind==='relation'&&!path&&!row.crossMap){
      const a=(node.marks??[]).find(m=>m.type==='char'&&m.id===row.fromEntityId);
      const b=(node.marks??[]).find(m=>m.type==='char'&&m.id===row.toEntityId);
      if(a&&b&&[a.x,a.y,b.x,b.y].every(Number.isFinite)){
        result.relations.push({id:row.flowId,kind:'relation',fromEntityId:row.fromEntityId,toEntityId:row.toEntityId,
          from:[a.x,a.y],to:[b.x,b.y],points:[[a.x,a.y],[b.x,b.y]],name:row.label,known:true,schematic:true,c:'#ffc247'});
        continue;
      }
    }
    if(!path||(path.mapId??row.mapId)!==node.id||!Array.isArray(path.points)||path.points.length<2){
      result.cards.push({id:row.flowId,kind:row.kind,name:row.label,reason:row.reason??'NO_ROUTE_GEOMETRY'});continue;
    }
    const conversion=path.units==='cells'&&tr.units==='meters';
    if(conversion&&!(Number.isFinite(tr.metersPerCell)&&tr.metersPerCell>0)){
      result.cards.push({id:row.flowId,kind:row.kind,name:row.label,reason:'SCALE_UNKNOWN'});continue;
    }
    if(!path.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)))continue;
    const factor=conversion?tr.metersPerCell:1;
    const points=path.points.map(p=>[(p.x*factor-(tr.bounds.x??0)-tr.bounds.w/2)*tr.scale,(p.y*factor-(tr.bounds.y??0)-tr.bounds.h/2)*tr.scale]);
    const mover=(node.marks??[]).find(m=>m.id===row.moverEntityId),entityKind=mover?.type==='vehicle'?'vehicle':mover?.type==='poi'?'location':'character';
    const edge={id:row.flowId,kind:row.kind,messageId:row.messageId||null,entityId:row.moverEntityId,entityKind,
      fromEntityId:row.fromEntityId,toEntityId:row.toEntityId,from:points[0],to:points.at(-1),points,
      via:points.length>2?points[Math.floor(points.length/2)]:null,
      progress:typeof row.progress==='number'?Math.max(0,Math.min(1,row.progress)):null,
      ...(row.kind==='journey'?{pathProgress:typeof row.pathProgress==='number'?Math.max(0,Math.min(1,row.pathProgress)):null}:{}),
      name:row.label,known:true,c:row.kind==='relation'?'#ffc247':'#39e0a0'};
    result[row.kind==='relation'?'relations':row.kind==='journey'?'journeys':'flows'].push(edge);
  }
  return result;
}
