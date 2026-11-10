/** A registered place can be a parent-map marker without owning a child map.
 * Concrete interiors, occupied places and their ancestors still expand eagerly.
 * This policy never deletes an existing map or guesses from a place's name.
 */
type Row = Record<string, unknown>;
const id=(v:unknown)=>typeof v==='string'?v:'';
const active=(r:Row)=>!r.status||r.status==='active';

export function sceneExpansionLocationIds(input:{locations:readonly Row[];characters?:readonly Row[];items?:readonly Row[];plannedLocationIds?:readonly string[]}):Set<string>{
 const locations=input.locations.filter(active),byId=new Map(locations.map(l=>[id(l.id),l]));
 const required=new Set<string>(input.plannedLocationIds??[]);
 for(const l of locations){
  if(l.parent_location_id&&byId.has(id(l.parent_location_id)))required.add(id(l.parent_location_id));
 }
 for(const row of [...(input.characters??[]),...(input.items??[])].filter(active))if(row.location_id)required.add(id(row.location_id));
 for(const start of [...required]){
  let at=byId.get(start);const seen=new Set<string>();
  while(at&&!seen.has(id(at.id))){seen.add(id(at.id));required.add(id(at.id));at=byId.get(id(at.parent_location_id));}
 }
 return new Set([...required].filter(v=>v&&byId.has(v)));
}
