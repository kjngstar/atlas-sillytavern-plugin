/** Read-only SVG projection for SQL scene areas. Geometry never becomes travel evidence. */
export type SqlAreaInput={locationId:string;geometry:unknown};
export function projectSqlMapAreas(areas:SqlAreaInput[],frame:{cols:number;rows:number}){
 const projected:Array<{locationId:string;path:string;quality:string;source:string;cells:number}>=[];
 const skipped:Array<{locationId:string;reason:string}>=[];
 const finite=(p:unknown):p is {x:number;y:number}=>!!p&&typeof p==='object'&&Number.isFinite((p as {x:number}).x)&&Number.isFinite((p as {y:number}).y);
 for(const area of areas){
  const g=area.geometry as {kind?:string;cells?:unknown[];points?:unknown[];quality?:string;source?:string}|null;
  let path='',cells=0;
  if(g?.kind==='cells'&&Array.isArray(g.cells)&&g.cells.length<=256){
   const seen=new Set<string>();
   for(const cell of g.cells){
    if(!finite(cell)||!Number.isInteger(cell.x)||!Number.isInteger(cell.y)||cell.x<0||cell.y<0||cell.x>=frame.cols||cell.y>=frame.rows){path='';break;}
    const key=`${cell.x},${cell.y}`;if(seen.has(key))continue;seen.add(key);
    path+=`M${cell.x} ${cell.y}h1v1h-1Z`;cells++;
   }
  }else if(g?.kind==='polygon'&&Array.isArray(g.points)&&g.points.length>=3&&g.points.length<=256){
   if(g.points.every(p=>finite(p)&&p.x>=0&&p.y>=0&&p.x<=frame.cols&&p.y<=frame.rows))
    path=g.points.map((p,i)=>`${i?'L':'M'}${(p as {x:number}).x} ${(p as {y:number}).y}`).join('')+'Z';
  }
  if(!path){skipped.push({locationId:area.locationId,reason:'INVALID_OR_OUT_OF_FRAME_AREA'});continue;}
  projected.push({locationId:area.locationId,path,quality:g?.quality==='confirmed'?'confirmed':'estimated',source:String(g?.source??'estimate'),cells});
 }
 return {areas:projected,skipped};
}
