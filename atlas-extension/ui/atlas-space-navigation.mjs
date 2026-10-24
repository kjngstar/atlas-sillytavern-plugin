/** Read-only hierarchy presentation. A floor is a destination, not a neighbouring room. */
const GROUPS=[['floor','楼层'],['room','房间'],['building','建筑'],['vehicle','载具'],['outside','室外与其他场所']];
const kindOf=(node,locations)=>locations.get(node?.containerLocationId)?.entityKind??node?.containerLocationKind??node?.kind;

export function projectSpaceNavigation(nodes,locations,{scenes=new Map()}={}){
 const places=new Map(locations.map(l=>[l.id,l]));
 const floors=new Set(locations.filter(l=>l.entityKind==='floor').map(l=>l.id));
 for(const node of nodes.values()){
  // Preserve the saved document; remove only the misleading planar projection
  // of another floor. Its existing map remains directly reachable below.
  const g=node.geo??{};
  const vertical=id=>id!==node.containerLocationId&&floors.has(id);
  for(const key of ['overviewShapes','districts','rooms'])if(g[key])g[key]=g[key].filter(s=>!vertical(s.id));
  for(const key of ['overviewFeatures','doors','windows','lamps','furn'])if(g[key])g[key]=g[key].filter(s=>!vertical(s.zoneId??s.roomId));
  node.marks=(node.marks??[]).filter(m=>!vertical(m.id));
  const layout=scenes.get(node.id)?.layout;
  const drawn=new Set([...(layout?.shapes??[]),...(layout?.rooms??[]),...(layout?.districts??[]),...(layout?.buildings??[]).filter(b=>!b.decorative)].map(s=>s.id));
  if(layout?.corridor?.entityId)drawn.add(layout.corridor.entityId);
  const children=(node.children??[]).filter(c=>!c.unclassified&&c.known!==false);
  const hasFloors=children.some(c=>kindOf(c,places)==='floor');
  node.spaceGroups=GROUPS.map(([kind,label])=>({kind,label:kind==='room'&&hasFloors?'房间 · 楼层未标明':label,
   entries:children.filter(c=>{const k=kindOf(c,places);return (GROUPS.some(([v])=>v===k)?k:'outside')===kind;}).map(c=>({
    id:c.id,locationId:c.containerLocationId,name:c.name,kind:kindOf(c,places),
    hasLayout:c.hasLayout===true,represented:kind==='floor'||drawn.has(c.containerLocationId),
   }))})).filter(g=>g.entries.length);
  const entries=node.spaceGroups.flatMap(g=>g.entries);
  node.spaceCoverage={total:entries.length,unplaced:entries.filter(e=>!e.represented).length,pending:entries.filter(e=>!e.hasLayout).length};
  const building=kindOf(node,places)==='floor'?nodes.get(node.parentMapId):node;
  const levels=(building?.children??[]).filter(c=>kindOf(c,places)==='floor'&&c.known!==false);
  node.floorChoices=levels.length?[{id:building.id,name:'总览 · '+building.name},...levels.map(c=>({id:c.id,name:c.name}))]:[];
 }
}
