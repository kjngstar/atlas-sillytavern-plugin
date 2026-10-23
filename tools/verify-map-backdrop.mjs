/** Real Canvas border pixels, including a floor produced by the spatial engine. */
import {generateFloor} from '../vendor/atlas-spatial/index.mjs';
import {referenceGeometry} from '../ui/atlas-reference-data.mjs';

const map={id:'backdrop-floor',mapId:'backdrop-floor',name:'大厅背景回归',kind:'interior',metersPerCell:1,frame:{cols:24,rows:24},points:[]};
const generated=generateFloor({id:map.id,width:24,height:24,rooms:[{id:'hall',name:'大厅',w:12,h:8,side:'north'}],contents:[],actors:[],items:[]},{scope:{chatId:'backdrop-check',branchId:'main',revision:0,viewMode:'author'},map,entities:{locations:['hall'],characters:[],items:[]}});
if(!generated.ok)throw Error('BACKDROP_FLOOR_FIXTURE_FAILED');
const floor={...referenceGeometry(map,generated.scene,{viewMode:'author',visibleLocationIds:['hall']}),id:map.id,name:map.name,renderKind:'floor',host:false,sceneStatus:'ready',children:[]};

export async function verifyMapBackdrop({page,frame,check,dir}){
 const original=await frame.evaluate(()=>({profile:AtlasPreview.state.profileId}));
 const cdp=await page.context().newCDPSession(page);
 await frame.evaluate(()=>{const m=AtlasPreview.map,s=m.state;window.__backdropOriginal={node:s.node,path:s.path,cam:{...s.cam},tgt:{...s.tgt},sel:s.sel,paused:s.paused,grid:s.showGrid,marks:s.showMarks,data:JSON.stringify(AtlasPreview.data)};});
 try{
  for(const dpr of [1,2])for(const width of [360,1440]){
   await page.setViewportSize({width,height:1000});
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:dpr,mobile:false});
   for(const profile of ['full','mapFocus','mapOnly']){
    await frame.evaluate(id=>AtlasPreview.setUIProfile(id),profile);
    for(const kind of ['world','floor']){
     const samples=await frame.evaluate(({kind,floor})=>{
      const m=AtlasPreview.map,s=m.state,old=window.__backdropOriginal;
      m.setPath(kind==='floor'?floor:old.node,kind==='floor'?[floor]:old.path);
      m.setFlag('showGrid',false);m.setFlag('showMarks',false);m.setPaused(true);m.resize();m.fit(false);
      const base={...s.cam},canvas=document.getElementById('map'),ctx=canvas.getContext('2d');
      const pixel=()=>{
       const w=canvas.width,h=canvas.height;
       const edges=[ctx.getImageData(0,0,w,1).data,ctx.getImageData(0,h-1,w,1).data,ctx.getImageData(0,0,1,h).data,ctx.getImageData(w-1,0,1,h).data];
       let transparent=0;for(const strip of edges)for(let i=3;i<strip.length;i+=4)if(strip[i]!==255)transparent++;
       const corners=[[0,0],[w-8,0],[0,h-8],[w-8,h-8]].map(([x,y])=>{const a=ctx.getImageData(x,y,8,8).data;let l=0;for(let i=0;i<a.length;i+=4)l+=a[i]*.2126+a[i+1]*.7152+a[i+2]*.0722;return {luminance:l/(a.length/4),rgba:Array.from(a)};});
       return {transparent,corners,width:w,height:h,dpr:s.dpr};
      };
      const output=[];
      for(const pose of ['fit','zoom-out-three','pan-right','pan-left']){
       s.cam={...base};s.tgt={...base};
       if(pose!=='fit'){for(let i=0;i<3;i++)m.zoomBy(1/1.3);s.cam={...s.tgt};}
       if(pose.startsWith('pan-')){s.cam.x+=(pose==='pan-right'?1:-1)*(s.vw/s.cam.s+Math.abs(m.extent()[1]-m.extent()[0]))*2;s.cam.y+=s.vh/s.cam.s*2;s.tgt={...s.cam};}
       m.setPaused(true);output.push({pose,...pixel()});
      }
      return output;
     },{kind,floor});
     check(`backdrop:${dpr}:${width}:${profile}:${kind}:opaque-light-borders`,samples.every(s=>s.dpr===dpr&&s.transparent===0&&s.corners.every(c=>c.luminance>100)),samples.map(s=>({pose:s.pose,dpr:s.dpr,transparent:s.transparent,luminance:s.corners.map(c=>c.luminance)})));
     check(`backdrop:${dpr}:${width}:${profile}:${kind}:art-stays-on-screen`,JSON.stringify(samples[2].corners)===JSON.stringify(samples[3].corners));
     if(dpr===1&&width===1440&&profile==='mapOnly'&&kind==='floor'){
      await page.screenshot({path:dir+'/floor-zoomed-and-panned.png'});
      await frame.evaluate(()=>{const m=AtlasPreview.map,s=m.state;m.fit(false);for(let i=0;i<3;i++)m.zoomBy(1/1.3);s.cam={...s.tgt};m.setPaused(true);});
      await page.screenshot({path:dir+'/floor-zoom-out-three.png'});
     }
    }
   }
  }
  check('backdrop:world-data-unchanged',await frame.evaluate(()=>JSON.stringify(AtlasPreview.data)===window.__backdropOriginal.data));
 }finally{
  await page.setViewportSize({width:1440,height:1000});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await cdp.detach();
  await frame.evaluate(id=>AtlasPreview.setUIProfile(id),original.profile);
  await frame.evaluate(()=>{const m=AtlasPreview.map,s=m.state,o=window.__backdropOriginal;m.setPath(o.node,o.path);m.resize();Object.assign(s,{cam:o.cam,tgt:o.tgt,sel:o.sel});m.setFlag('showGrid',o.grid);m.setFlag('showMarks',o.marks);m.setPaused(o.paused);delete window.__backdropOriginal;});
 }
}
