/** UI author mode never expands the POV's current-position or field-level knowledge. */
import { projectForPov } from './atlas-db-knowledge-view.ts';
import { buildPositionCache, resolveEffectivePosition } from './atlas-sim-position.ts';
import { queryBound } from './atlas-db-runtime.ts';
import type { ViewContext } from './atlas-db-views.ts';

export function sqlVisibility(ctx: ViewContext) {
  const cache=buildPositionCache(ctx), branch=queryBound(ctx.db,'SELECT * FROM branches WHERE id=?',[ctx.branchId])[0];
  const protagonists=[...(cache.characters?.values()??[])].filter(ch=>ch.status==='active'&&ch.role==='protagonist');
  const povId=ctx.povId ?? (branch?.pov_character_id?String(branch.pov_character_id):protagonists.length===1?String(protagonists[0].id):null);
  const projection=projectForPov(ctx,{characterId:povId});
  const clock=Number(branch?.clock_s??0);
  const knownLocations=new Set(projection.knownLocations.filter(loc=>loc.firstReceivedAtS<=clock).map(loc=>loc.locationId));
  const knownCharacters=new Set(projection.knownCharacters.map(ch=>ch.entityId));
  const player=povId?cache.characters?.get(povId):null;
  const p=povId?resolveEffectivePosition(ctx,povId,undefined,cache):null;
  const here=p?.kind==='at_location'?p.locationId:p?.kind==='at_grid'&&player?.location_id?String(player.location_id):null;
  const visibleCharacters=new Set<string>(povId?[povId]:[]), visibleItems=new Set<string>();
  if(here){
    const seen=new Set<string>();let id:string|null=here;
    while(id&&!seen.has(id)){seen.add(id);knownLocations.add(id);const loc:Record<string,unknown>|undefined=cache.locations?.get(id);id=loc?.parent_location_id?String(loc.parent_location_id):null;}
    for(const ch of cache.characters?.values()??[]){
      if(ch.status!=='active')continue;
      const position=resolveEffectivePosition(ctx,String(ch.id),undefined,cache);
      if(position.kind==='at_location'&&position.locationId===here || position.kind==='at_grid'&&ch.location_id===here)visibleCharacters.add(String(ch.id));
    }
    for(const item of cache.items?.values()??[]){
      if(item.status!=='active')continue;
      if(item.holder_character_id===povId||!item.holder_character_id&&!item.container_item_id&&item.location_id===here)visibleItems.add(String(item.id));
    }
  }
  return {povId,here,projection,knownLocations,knownCharacters,visibleCharacters,visibleItems,
    visible:(kind:string,id:string)=>kind==='location'?knownLocations.has(id):kind==='character'?visibleCharacters.has(id):visibleItems.has(id)};
}
