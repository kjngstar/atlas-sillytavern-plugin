import {clone,parseSpaceLocalId,spaceLocalId,plain} from './contracts.mjs';

/** Project registered child furniture into its parent's coordinate system.
 * Names never establish identity; the space local ID does. No SQL or IO here.
 */
export function projectChildFurnishing(spec,ctx){
  const aliases=new Map(),key=(room,id)=>room+'\0'+id;
  for(const [room,canonical] of Object.entries(ctx.childCanonical??{})){
    for(const entry of canonical?.furnishing??[]){
      const parsed=parseSpaceLocalId(entry.localId);
      if(parsed?.locationId===room)aliases.set(key(room,parsed.contentId),entry.localId);
    }
  }
  if(ctx.autoPlan)for(const row of spec.contents??[]){if(Object.hasOwn(ctx.childCanonical??{},row.roomId)&&!parseSpaceLocalId(row.id))aliases.set(key(row.roomId,row.id),spaceLocalId(row.roomId,row.id));}
  if(ctx.autoPlan&&Array.isArray(spec.deletes?.contents))spec.deletes.contents=spec.deletes.contents.map(id=>{const targets=[...aliases].filter(([k])=>k.endsWith('\0'+id)).map(([,v])=>v);return targets.length===1?targets[0]:id;});
  const content=row=>{const id=aliases.get(key(row.roomId,row.id));return id?{...row,id}:row;};
  spec.contents=(spec.contents??[]).map(content);
  spec.actors=(spec.actors??[]).map(row=>({...row,...(row.near?{near:aliases.get(key(row.roomId,row.near))??row.near}:{})}));
  const remapItem=row=>{
    const room=ctx.itemsById?.[row.id]?.location_id;
    return {...row,on:aliases.get(key(room,row.on))??row.on};
  };
  spec.items=(spec.items??[]).map(remapItem);
  // Saved constraints share the same identity conversion. Old positions can be
  // retained while the canonical local ID is used in both projections.
  if(ctx.previousScene){
    const previous=clone(ctx.previousScene);ctx.previousScene=previous;
    if(previous.constraints){
      previous.constraints.contents=(previous.constraints.contents??[]).map(content);
      previous.constraints.actors=(previous.constraints.actors??[]).map(row=>({...row,...(row.near?{near:aliases.get(key(row.roomId,row.near))??row.near}:{})}));
      previous.constraints.items=(previous.constraints.items??[]).map(remapItem);
    }
    previous.layout.groups=(previous.layout.groups??[]).map(content);
  }
  for(const [room,canonical] of Object.entries(ctx.childCanonical??{})){
    for(const entry of canonical?.furnishing??[]){
      if(!plain(entry)||!parseSpaceLocalId(entry.localId)||spec.deletes?.contents?.includes(entry.localId)||spec.deletes?.contents?.includes(parseSpaceLocalId(entry.localId).contentId))continue;
      const existing=spec.contents.find(row=>row.id===entry.localId&&row.roomId===room);
      if(existing){if(entry.quality==='confirmed'){existing.w=entry.widthM;existing.h=entry.heightM;}}
      else spec.contents.push({id:entry.localId,roomId:room,type:entry.type,name:entry.name,w:entry.widthM,h:entry.heightM});
      if(entry.itemId&&ctx.itemsById?.[entry.itemId]?.location_id===room&&!spec.items.some(row=>row.id===entry.itemId))spec.items.push({id:entry.itemId,on:entry.localId});
    }
  }
  return spec;
}
