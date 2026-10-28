import {clone} from './contracts.mjs';

/** Finite physical-space planning. Furniture never shrinks to fit a drawing. */
export function fitEstimatedFloor(generate,value,context){
  const first=generate(value,context);
  if(!context.autoPlan)return first;
  if(!first.ok&&!first.issues?.some(i=>/ROOM_NO_SPACE|NO_VALID_ROOMS/.test(i.code)))return first;
  const fixed=context.map.scaleLocked||context.spaceSize?.quality==='confirmed'||context.spaceSize?.locked||context.spaceCanonical?.size?.locked||context.spaceCanonical?.size?.quality==='confirmed';
  const canGrowCanvas=!fixed&&context.map.scaleQuality!=='confirmed'&&!Object.values(context.locks??{}).some(v=>Object.keys(v??{}).length);
  const base=clone(first.scene?.constraints??value);
  if(!Array.isArray(base.rooms)||!base.rooms.length)return first;
  // Use the dimensions actually chosen by the generator, including child authorities.
  // An old request must never shrink a child that already has a canonical size.
  const widths=base.rooms.map(r=>{const known=context.childSpaces?.[r.id];return {id:r.id,w:known?.widthM??r.w,h:known?.heightM??r.h};});
  let best=first,bestCount=count(first);
  for(const factor of [1,1.25,1.5,2,3,4]){
    if(bestCount===0)break;
    const next=clone(base),children=clone(context.childSpaces??{});
    for(const r of next.rooms){
      const known=children[r.id];
      const original=widths.find(x=>x.id===r.id);
      if(known){r.w=original.w;r.h=original.h;continue;}
      if(context.locks?.rooms?.[r.id]||context.planningProjection)continue;
      r.w=Math.ceil(original.w*factor*4)/4;r.h=Math.ceil(original.h*factor*4)/4;
    }
    const width=Math.max(...['north','south'].map(side=>next.rooms.filter(r=>r.side===side).reduce((n,r)=>n+r.w,1)));
    const heights=['north','south'].map(side=>Math.max(0,...next.rooms.filter(r=>r.side===side).map(r=>r.h)));
    const single=next.rooms.length===1&&next.rooms[0].id===context.map.containerLocationId;
    const required={widthM:single?next.rooms[0].w:width,heightM:single?next.rooms[0].h:2*Math.max(...heights)+(next.corridorWidth??2)+1};
    const current=context.spaceSize??context.spaceCanonical?.size??{widthM:context.map.metersPerCell>0?context.map.frame.cols*context.map.metersPerCell:value.width,heightM:context.map.metersPerCell>0?context.map.frame.rows*context.map.metersPerCell:value.height};
    const size=canGrowCanvas?{...current,widthM:Math.ceil(Math.max(current.widthM,required.widthM)*4)/4,heightM:Math.ceil(Math.max(current.heightM,required.heightM)*4)/4,quality:'estimated'}:current;
    // Re-express the frame together with its physical extent, including the first
    // uncalibrated layout. Otherwise rectangular growth fails aspect validation.
    const map=canGrowCanvas?{...context.map,metersPerCell:.25,frame:{...context.map.frame,cols:size.widthM/.25,rows:size.heightM/.25}}:context.map;
    const result=generate(next,{...context,map,childSpaces:children,spaceSize:size});
    const n=count(result);
    if(n<bestCount){best=result;bestCount=n;if(canGrowCanvas){best.plannedSize=size;best.scene.metersPerCell=.25;best.metricProposal={metersPerCell:.25,scaleQuality:'estimated',basis:{source:'layout-capacity',widthM:size.widthM,heightM:size.heightM}};}}
  }
  return best;
}
function count(result){return result.ok?(result.scene?.layout.issues??[]).filter(i=>/NO_SPACE|TOO_LARGE|NOT_REACHABLE/.test(i.code)).length:10000;}
