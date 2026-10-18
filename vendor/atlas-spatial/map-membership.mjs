/** Logical display ownership never changes the physical SQL coordinate frame. */
export function collectMapLocations({mapRow,maps=[],locations=[]}={}){
  if(!mapRow?.id)return [];
  const branchId=mapRow.branch_id;
  const active=row=>row?.branch_id===branchId&&(row.status??'active')==='active';
  const rows=locations.filter(active),byId=new Map(rows.map(row=>[String(row.id),row]));
  const holders=new Map();
  for(const map of [...maps,mapRow]){
    if(!active(map)||!map.container_location_id)continue;
    const id=String(map.container_location_id),set=holders.get(id)??new Set();
    set.add(String(map.id));holders.set(id,set);
  }
  const ownerOf=row=>{
    let id=row.parent_location_id?String(row.parent_location_id):null;
    const seen=new Set([String(row.id)]);
    while(id&&!seen.has(id)){
      seen.add(id);
      const candidates=holders.get(id);
      if(candidates?.size===1)return [...candidates][0];
      if(candidates?.size>1)return null; // Ambiguous maps need topology diagnostics, not a random owner.
      const parent=byId.get(id);
      id=parent?.parent_location_id?String(parent.parent_location_id):null;
    }
    return null;
  };
  const container=mapRow.container_location_id?String(mapRow.container_location_id):null;
  return rows.filter(row=>{
    if(String(row.id)===container)return false;
    const owner=ownerOf(row);
    if(owner)return owner===String(mapRow.id);
    // Unclassified old locations retain their existing display responsibility.
    return String(row.map_id??'')===String(mapRow.id);
  });
}
