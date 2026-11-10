import test from 'node:test';
import assert from 'node:assert/strict';
import {surveySurface} from '../ui/atlas-survey-surface.mjs';
const area=(x,y,options={})=>({x,y,parts:[[[-50,-35],[50,-35],[50,35],[-50,35]]],...options});
const inside=(p,poly)=>{let yes=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
test('同一场所的子空间、公共场地和实际出口组成一个轮廓，没有内部拼块接缝',()=>{
 const areas=[area(-100,0),area(100,0),area(-280,90,{external:true})],paths=[{points:[[-280,90],[0,90]]}],before=JSON.stringify({areas,paths});
 const surface=surveySurface(areas,paths,{sharedSite:true,hub:[0,90]});assert.equal(surface.outlines.length,1);
 for(const p of [[-100,0],[100,0],[0,65],[-270,90]])assert.ok(inside(p,surface.outlines[0]),'同场地元素必须落在同一示意地表内');
 assert.equal(surface.quality,'schematic');assert.equal(surface.displayOnly,true);assert.equal(JSON.stringify({areas,paths}),before);
 for(const poly of surface.outlines)for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length];assert.ok(a[0]===b[0]||a[1]===b[1]);}
});
test('地区间未知连接保持分离，不把两块遥远的区域补成通行走廊',()=>{
 const surface=surveySurface([area(-400,0),area(400,0)],[],{sharedSite:false});assert.equal(surface.outlines.length,2);assert.equal(surface.forecourt,null);
});
test('载具和邻图入口不是固定地表；异常大范围不会产生无界栅格',()=>{
 assert.deepEqual(surveySurface([area(0,0,{mobile:true}),area(400,0,{external:true})],[]).outlines,[]);
 const surface=surveySurface([area(-1e12,0),area(1e12,0)],[{points:[[-1e12,0],[1e12,0]]}],{sharedSite:true});assert.ok(surface.outlines.length<=2);assert.equal(surface.forecourt,null);
});
