import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createMapController,markerPopupPosition} from '../ui/atlas-map-controller.mjs';
import {createPanGesture,createPinchTracker} from '../src/atlas-map-interactions.ts';
import {panCameraBy,zoomCameraAtPoint} from '../src/atlas-map-camera.ts';

function fixture(){
 const dom=new JSDOM('<div id="map"><button>control</button></div>'),viewport=dom.window.document.getElementById('map');
 Object.defineProperties(viewport,{clientWidth:{value:400},clientHeight:{value:300}});
 viewport.getBoundingClientRect=()=>({left:0,top:0,width:400,height:300});
 let camera={cx:50,cy:50,k:2,fitK:2},commits=0,closes=0;
 const controller=createMapController({createPanGesture,createPinchTracker,panCameraBy,zoomCameraAtPoint});
 controller.mountViewport({viewport,readCamera:()=>camera,commitCamera:next=>{camera=next;commits++;},areaDraw:{active:false},closeMapPanel:()=>closes++});
 const pointer=(type,id,x,y,target=viewport)=>{const event=new dom.window.Event(type,{bubbles:true});Object.assign(event,{pointerType:'touch',pointerId:id,clientX:x,clientY:y,button:0});target.dispatchEvent(event);};
 return {dom,viewport,controller,pointer,camera:()=>camera,commits:()=>commits,closes:()=>closes};
}
test('S04 real controller pans, suppresses drag clicks, ignores controls and tears down all handlers',()=>{
 const f=fixture();try{
  f.pointer('pointerdown',1,10,10);f.pointer('pointermove',1,50,10);f.pointer('pointerup',1,50,10);
  assert.equal(f.camera().cx,30);f.viewport.click();assert.equal(f.closes(),0);f.viewport.click();assert.equal(f.closes(),1);
  const before=f.commits();f.pointer('pointerdown',2,10,10,f.viewport.querySelector('button'));f.pointer('pointermove',2,90,10);assert.equal(f.commits(),before);
  f.controller.cameras.set('room',f.camera());f.controller.stack.push({pointId:'room'});f.controller.dispose();
  f.pointer('pointerdown',3,10,10);f.pointer('pointermove',3,50,10);f.viewport.click();assert.equal(f.commits(),before);assert.equal(f.closes(),1);assert.equal(f.controller.cameras.size,0);assert.equal(f.controller.stack.length,0);
 }finally{f.controller.dispose();f.dom.window.close();}
});
test('S04 both fingers establish pinch; ending pinch can continue single-finger pan',()=>{
 const f=fixture();try{
  f.pointer('pointerdown',1,100,100);f.pointer('pointerdown',2,200,100);f.pointer('pointermove',2,250,100);
  assert.equal(f.camera().k,3);f.pointer('pointerup',2,250,100);const before=f.camera().cx;
  f.pointer('pointermove',1,130,100);assert.equal(f.camera().cx,before-10);
 }finally{f.controller.dispose();f.dom.window.close();}
});
test('S04 resize observers and pending renders are cancelled when the map closes',async()=>{
 const previous=globalThis.ResizeObserver;let callback,disconnected=0,resizes=0;
 globalThis.ResizeObserver=class{constructor(cb){callback=cb;}observe(){}disconnect(){disconnected++;}};
 const f=fixture();try{
  f.controller.observe(f.viewport,()=>resizes++);callback([{contentRect:{width:400,height:300}}]);f.controller.dispose();
  await new Promise(resolve=>setTimeout(resolve,160));assert.equal(resizes,0);assert.equal(disconnected,1);
  callback([{contentRect:{width:540,height:300}}]);await new Promise(resolve=>setTimeout(resolve,160));assert.equal(resizes,0);
 }finally{globalThis.ResizeObserver=previous;f.controller.dispose();f.dom.window.close();}
});
test('S04 popup placement stays within viewport on either edge',()=>{
 const viewport={left:0,top:0,width:540,height:500};
 const position=markerPopupPosition(viewport,{left:490,right:510,top:490},280,240);
 assert.ok(position.left>=10&&position.left+280<=530);assert.ok(position.top>=8&&position.top+240<=490);
});
