import * as E from './layout-core.mjs';
export function createPainter(canvas,state,C,width,height){
const ctx=canvas.getContext('2d');
    function p(q){return E.screen(q,state.cam)}
    function line(points,color,width=1,dash=[]){if(!points.length)return;ctx.beginPath();points.forEach((q,i)=>{const a=p(q);if(i)ctx.lineTo(a.x,a.y);else ctx.moveTo(a.x,a.y)});ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.stroke();ctx.setLineDash([])}
    function poly(points,fill,stroke=null,width=1){ctx.beginPath();points.forEach((q,i)=>{const a=p(q);if(i)ctx.lineTo(a.x,a.y);else ctx.moveTo(a.x,a.y)});ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill()}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.stroke()}}
    function rect(r,fill,stroke,width=1){const a=p(r),s=state.cam.s;ctx.fillStyle=fill;ctx.fillRect(a.x,a.y,r.w*s,r.h*s);if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.strokeRect(a.x,a.y,r.w*s,r.h*s)}}
    const alpha=(hex,a)=>'rgba('+[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(',')+','+a+')';
    function rounded(r,fill,stroke,width=1,radius=.18){const a=p(r),s=state.cam.s;ctx.beginPath();ctx.roundRect(a.x,a.y,r.w*s,r.h*s,Math.min(radius*s,6,r.w*s/2,r.h*s/2));if(fill){ctx.fillStyle=fill;ctx.fill()}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.stroke()}}
    function clipRect(r){const a=p(r);ctx.beginPath();ctx.rect(a.x,a.y,r.w*state.cam.s,r.h*state.cam.s);ctx.clip()}
    function gradient(r,start,end){const a=p(r),b=p({x:r.x+r.w,y:r.y+r.h}),g=ctx.createLinearGradient(a.x,a.y,b.x,b.y);g.addColorStop(0,start);g.addColorStop(1,end);return g}
    function text(value,q,color=C.text,size=12,align='center'){const a=p(q);ctx.font=size+'px AtlasSpatialSans,system-ui,sans-serif';ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillText(value,a.x,a.y)}
    let labelBoxes=[];
    function mapLabel(value,q,color,size=12){
      const a=p(q);ctx.font=size+'px AtlasSpatialSans,system-ui,sans-serif';const w=ctx.measureText(value).width+8,h=size+6;
      const collision=(a,b)=>a.x<b.x+b.w+3&&a.x+a.w+3>b.x&&a.y<b.y+b.h+3&&a.y+a.h+3>b.y;
      for(const [dx,dy]of [[0,0],[0,-20],[0,20],[-w/2-12,0],[w/2+12,0],[0,-40],[0,40]]){
        const r={x:a.x+dx-w/2,y:a.y+dy-h/2,w,h};
        if(r.x<4||r.y<4||r.x+r.w>width()-4||r.y+r.h>height()-4||labelBoxes.some(b=>collision(r,b)))continue;
        labelBoxes.push(r);ctx.save();ctx.beginPath();ctx.roundRect(r.x,r.y,r.w,r.h,4);ctx.fillStyle='#07111ee8';ctx.fill();ctx.lineWidth=.7;ctx.strokeStyle=alpha(color,.18);ctx.stroke();ctx.fillStyle=color;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(value,a.x+dx,a.y+dy);ctx.restore();return;
      }
    }
    function glow(q,color,radius){const a=p(q),g=ctx.createRadialGradient(a.x,a.y,0,a.x,a.y,radius);g.addColorStop(0,color);g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(a.x,a.y,radius,0,Math.PI*2);ctx.fill()}
    function dot(q,color,label){const a=p(q);ctx.save();glow(q,alpha(color,.20),22);ctx.fillStyle='#071521';ctx.strokeStyle=alpha(color,.75);ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(a.x,a.y,7,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle=color;ctx.shadowColor=color;ctx.shadowBlur=9;ctx.beginPath();ctx.arc(a.x,a.y,2.7,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;if(state.selected?.id===q.id){ctx.beginPath();ctx.arc(a.x,a.y,12,0,Math.PI*2);ctx.strokeStyle=alpha(color,.35);ctx.stroke()}ctx.restore();if(state.cam.s>12&&label)mapLabel(label,{x:q.x,y:q.y+.75},color,11)}
    function diamond(q,color){const a=p(q);ctx.save();glow(q,alpha(color,.16),16);ctx.fillStyle=color;ctx.shadowColor=color;ctx.shadowBlur=7;ctx.beginPath();ctx.moveTo(a.x,a.y-4.5);ctx.lineTo(a.x+4.5,a.y);ctx.lineTo(a.x,a.y+4.5);ctx.lineTo(a.x-4.5,a.y);ctx.closePath();ctx.fill();ctx.restore()}
    /**
     * M6-09①：网格画在**屏幕空间**，范围取当前可见视口（`E.world(0,0)`→`E.world(w,h)`），
     * 不再按固定逻辑 extent 全铺 —— 缩出去就是空白的老毛病来自后者。
     * 步长只取 1/2/5×10^n，屏幕间距恒定落在 12–40 CSS px；线宽是屏幕常量，
     * 不随缩放变粗（被 CSS 放大的位图网格才会糊）。
     */
    function gridStepFor(s){
      if(!Number.isFinite(s)||s<=0)return null;
      const raw=12/s,exp=Math.floor(Math.log10(raw));
      for(const m of [1,2,5,10]){const step=m*Math.pow(10,exp);if(step*s>=12)return step;}
      return 10*Math.pow(10,exp);
    }
    function grid(){
      const c=state.cam;
      if(!c||!Number.isFinite(c.s)||c.s<=0||!Number.isFinite(c.x)||!Number.isFinite(c.y))return;
      const w=width(),h=height(),step=gridStepFor(c.s);
      if(!step)return;
      const a=E.world({x:0,y:0},c),b=E.world({x:w,y:h},c);
      state.gridStep=step;
      // 单帧线数上限：极缩放时宁可少画一层，也不能把浏览器画死。
      const columns=Math.ceil((b.x-a.x)/step)+2,rows=Math.ceil((b.y-a.y)/step)+2;
      if(columns+rows>2000)return;
      ctx.strokeStyle=C.grid;ctx.lineWidth=1/Math.max(1,Math.min(globalThis.devicePixelRatio||1,3));ctx.beginPath();
      for(let i=0;i<=columns;i++){const x=a.x+i*step,xx=p({x,y:0}).x;if(xx<0||xx>w)continue;ctx.moveTo(xx,0);ctx.lineTo(xx,h)}
      for(let j=0;j<=rows;j++){const y=a.y+j*step,yy=p({x:0,y}).y;if(yy<0||yy>h)continue;ctx.moveTo(0,yy);ctx.lineTo(w,yy)}
      ctx.stroke();state.gridStep=step;
    }
    function floor(){const s=state.scene,k=state.cam.s,palette=[C.cyan,C.violet,C.blue,C.mint,C.blue,C.gold];
      const focus=state.selected?.roomId||(state.selected?.type==='room'?state.selected.id:null)||s.actors[0]?.roomId;
      ctx.save();ctx.shadowColor='#000000';ctx.shadowBlur=18;rounded(s.corridor,gradient(s.corridor,'#28476570','#16243e70'),'#8bc6f44d',1,.23);ctx.restore();
      for(let x=.6;x<s.bounds.w;x+=1.7)line([{x,y:s.corridor.y+.1},{x,y:s.corridor.y+s.corridor.h-.1}],'#8ec9ee0c',.65);
      for(let i=0;i<s.rooms.length;i++){
        const r=s.rooms[i],color=palette[i%palette.length],active=r.id===focus;
        ctx.save();ctx.shadowColor=active?color:'#000000';ctx.shadowBlur=active?12:8;
        rounded(r,gradient(r,alpha(color,active?.17:.10),alpha(color,.025)),alpha(color,active?.78:.32),active?1.65:.85,.22);ctx.restore();
        ctx.save();clipRect(r);
        for(let x=r.x+.5;x<r.x+r.w;x+=.5)line([{x,y:r.y},{x,y:r.y+r.h}],'#8ab9e708',.45);
        for(let y=r.y+.5;y<r.y+r.h;y+=.5)line([{x:r.x,y},{x:r.x+r.w,y}],'#8ab9e708',.45);
        // Window light is purely a material effect clipped to the already-validated room footprint.
        for(const w of s.windows.filter(w=>w.roomId===r.id)){
          const sign=r.side==='north'?1:-1,a=p(w),b=p({x:w.x,y:w.y+sign*3.2}),g=ctx.createLinearGradient(a.x,a.y,b.x,b.y);
          g.addColorStop(0,'#a9e9ff18');g.addColorStop(1,'#a9e9ff00');
          poly([{x:w.x-w.width/2,y:w.y},{x:w.x+w.width/2,y:w.y},{x:w.x+2,y:w.y+sign*3.2},{x:w.x-1.6,y:w.y+sign*3.2}],g);
        }ctx.restore();
        if(s.groups.some(g=>g.roomId===r.id&&g.type==='bench')){
          for(let j=0;j<7;j++)line([{x:r.x+.3+j*r.w/7,y:r.y+r.h-.3},{x:r.x+.3+j*r.w/7,y:r.y+r.h+.02}],alpha(color,.5),.8);
          line([{x:r.x+.3,y:r.y+r.h},{x:r.x+r.w-.3,y:r.y+r.h}],alpha(color,.6),1.1);
        }
      }
      for(const w of s.windows){ctx.save();ctx.shadowColor=C.cyan;ctx.shadowBlur=10;line([{x:w.x-w.width/2,y:w.y},{x:w.x+w.width/2,y:w.y}],'#a4e8ffb3',2);ctx.restore()}
      for(const l of s.lamps){
        const room=s.rooms.find(r=>r.id===l.roomId);ctx.save();if(room)clipRect(room);else clipRect(s.corridor);
        glow(l,'#ffdc9a30',Math.max(22,k*(room?1.7:1.4)));ctx.restore();
        const a=p(l);ctx.save();ctx.fillStyle='#ffdfab';ctx.shadowColor='#ffcd75';ctx.shadowBlur=11;ctx.beginPath();ctx.arc(a.x,a.y,1.6,0,Math.PI*2);ctx.fill();ctx.restore();
      }
      for(const group of s.groups){
        // M6-09②：选中/悬停按**真实 local id** 判定（组 id 或单件家具 id 都算），
        // 这样「点中哪件家具」和「画出哪件家具」用的是同一个身份。
        const selected=state.selected?.id===group.id||state.hover?.id===group.id;
        // Shadows and finish stay inside/under the same body coordinates; no new gameplay obstacles are added.
        for(const b of group.bodies){
          const live=selected||state.selected?.id===b.id||state.hover?.id===b.id;
          ctx.save();
          if(b.type!=='chair'){ctx.shadowColor='#00000088';ctx.shadowBlur=4;ctx.shadowOffsetY=2}
          if(b.type==='stairs'){
            rounded(b,'#0a1529',live?C.cyan:'#8ca7c15c',.8,.07);ctx.shadowBlur=0;
            for(let j=1;j<10;j++)line([{x:b.x+.06,y:b.y+b.h*j/10},{x:b.x+b.w-.06,y:b.y+b.h*j/10}],'#99b5ce55',.7);
            line([{x:b.x+b.w/2,y:b.y+b.h-.3},{x:b.x+b.w/2,y:b.y+.3}],alpha(C.blue,.6),.8);text('↑',E.center(b),C.blue,12);
          }else if(b.type==='shelf'){
            rounded(b,'#182025',live?C.cyan:'#f7c26a6e',.85,.07);ctx.shadowBlur=0;ctx.shadowOffsetY=0;
            for(let j=0;j<13;j++){
              const x=b.x+.10+(b.w-.20)*j/13,h=b.h*(.43+(j*7%9)/30);
              rect({x,y:b.y+b.h-.10-h,w:Math.min(.14,(b.w-.20)/15),h},['#a4a7b269','#80699988','#82a7b285','#c0ab736a','#718c9490'][j%5]);
            }
            line([{x:b.x+.05,y:b.y+b.h-.05},{x:b.x+b.w-.05,y:b.y+b.h-.05}],'#ebc47d4d',.6);
          }else if(b.type==='chair'){
            rounded(b,'#263b506b','#a0c9e25e',.65,.06);line([{x:b.x+.02,y:b.y+.04},{x:b.x+b.w-.02,y:b.y+.04}],'#c0dfed88',.75);
          }else if(b.type==='bed'){
            // 床：实心底 + 枕头 + 被面折线，实线表示这是**可通行的实体障碍**。
            rounded(b,'#2b3350','#b496ff73',.9,.12);ctx.shadowBlur=0;ctx.shadowOffsetY=0;
            const hw=Math.min(b.w,b.h),pillow={x:b.x+b.w*.12,y:b.y+b.h*.10,w:b.w*.76,h:hw*.22};
            rounded(pillow,'#dfe8ff5c',null,1,.06);
            for(let j=1;j<3;j++)line([{x:b.x+b.w*.10,y:b.y+b.h*(.38+j*.20)},{x:b.x+b.w*.90,y:b.y+b.h*(.38+j*.20)}],'#dfe8ff2e',.6);
          }else if(b.type==='cabinet'){
            rounded(b,'#3a3222','#ffcd828c',.9,.08);ctx.shadowBlur=0;ctx.shadowOffsetY=0;
            line([{x:b.x+b.w/2,y:b.y+.08},{x:b.x+b.w/2,y:b.y+b.h-.08}],'#ffcd8252',.7);
            line([{x:b.x+.08,y:b.y+b.h/2},{x:b.x+b.w-.08,y:b.y+b.h/2}],'#ffcd8252',.6);
          }else if(b.type==='doorway'){
            // 门洞：虚线表示**可通行**，不是实体家具。
            rounded(b,alpha(C.gold,.10),alpha(C.gold,.45),.8,.05);ctx.shadowBlur=0;ctx.shadowOffsetY=0;
            ctx.setLineDash([3,3]);rounded(b,null,alpha(C.gold,.55),.7,.05);ctx.setLineDash([]);
          }else if(b.type==='light'){
            // 灯具：只画光晕与灯芯。**不生成实体 id** —— 灯不是可点的业务对象。
            ctx.shadowBlur=0;ctx.shadowOffsetY=0;
            glow({x:b.x+b.w/2,y:b.y+b.h/2},'#ffe8b447',Math.max(20,k*2.2));
            const c0=p({x:b.x+b.w/2,y:b.y+b.h/2});
            ctx.fillStyle='#ffeec2';ctx.beginPath();ctx.arc(c0.x,c0.y,2,0,Math.PI*2);ctx.fill();
          }else if(b.type==='decor'){
            // 装饰块：中性材质，虚线，明确不是实体。
            rounded(b,'#b4cdeb1c','#b4cdeb38',.5,.05);ctx.shadowBlur=0;ctx.shadowOffsetY=0;
            ctx.setLineDash([3,3]);rounded(b,null,'#b4cdeb5c',.6,.05);ctx.setLineDash([]);
          }else{
            const tint=b.type==='bench'?C.gold:C.blue;
            rounded(b,gradient(b,alpha(tint,.16),alpha(tint,.07)),live?C.cyan:alpha(tint,.50),.9,.14);ctx.shadowBlur=0;ctx.shadowOffsetY=0;
            if(b.type==='bench')for(let j=1;j<4;j++)line([{x:b.x+.10,y:b.y+b.h*j/4},{x:b.x+b.w-.10,y:b.y+b.h*j/4}],'#ffe8ad27',.5);
            if(b.type==='table'||b.type==='desk'){
              const py=b.y+.18,px=b.x+.20;
              rounded({x:px,y:py,w:.25,h:Math.min(.30,b.h-.35)},'#dce8db65',null,1,.015);
              rounded({x:px+.35,y:py+.04,w:.21,h:Math.min(.25,b.h-.40)},'#baacc96b',null,1,.015);
              for(let j=1;j<3;j++)line([{x:px+.04,y:py+.06+j*.06},{x:px+.21,y:py+.06+j*.06}],'#23375288',.55);
            }
          }ctx.restore();
        }
      }
      for(const d of s.doors){const r=s.rooms.find(r=>r.id===d.roomId),sign=r.side==='north'?-1:1,a={x:d.x-d.width/2,y:d.y};
        line([a,{x:d.x+d.width/2,y:d.y}],'#0b1422',3.5);
        line([a,{x:a.x,y:d.y+sign*d.width}],'#f6d9a38f',1);
        const q=p(a);ctx.save();ctx.beginPath();ctx.strokeStyle='#f6d9a340';ctx.lineWidth=.65;ctx.setLineDash([2.3,2.6]);ctx.arc(q.x,q.y,d.width*k,sign<0?-Math.PI/2:0,sign<0?0:Math.PI/2);ctx.stroke();ctx.restore();
      }
      for(let i=0;i<s.rooms.length;i++){const r=s.rooms[i];text(r.name,{x:r.x+r.w/2,y:r.y+.52},r.id===focus?'#bcefff':'#a2b7d2',12);}

      for(const item of s.items)diamond(item,C.gold);
      for(const actor of s.actors)dot(actor,state.selected?.id===actor.id?C.cyan:C.mint,actor.name);
      text('中央走廊',{x:s.corridor.x+s.corridor.w/2,y:s.corridor.y+s.corridor.h/2},'#88a7c69e',11);
      // Dimension annotation is a drawing aid, computed from the floor's actual bounds.
      if(width()>480){const y=s.bounds.h-.35;line([{x:.5,y},{x:s.bounds.w-.5,y}],'#86badc30',.65);for(let x=.5;x<s.bounds.w;x+=5)line([{x,y:y-.15},{x,y:y+.15}],'#86badc50',.6);text((s.bounds.w-1).toFixed(0)+' m · 楼层空间示意',{x:s.bounds.w/2,y:y-.35},'#91b8cf9e',11);}
    }
    function city(){const s=state.scene,k=state.cam.s,palette=[C.cyan,C.gold,C.mint,C.blue,C.violet];
      /**
       * M6-09②：`enclosure==='open'`（水城 / 无墙城市）根本不画城墙 ——
       * 契约保证此时 `wall` 是空数组，画家不能再按「旧档必有墙」的假设去取 `wall[0]`，
       * 否则空数组会画出一圈假城门、或者直接读 undefined 崩掉整张图。
       * 旧档（无 enclosure 字段）与 wall 城市原样保留。
       */
      const wall=Array.isArray(s.wall)?s.wall:[],walled=wall.length>=3&&s.enclosure!=='open';
      if(walled){ctx.save();ctx.shadowColor='#183f73';ctx.shadowBlur=28;poly(wall,'#0a1120','#7ea8d029',1.2);ctx.restore();}
      for(let i=0;i<s.districts.length;i++){
        const d=s.districts[i],color=palette[i%palette.length],xs=d.polygon.map(q=>q.x),ys=d.polygon.map(q=>q.y),bounds={x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};
        poly(d.polygon,gradient(bounds,alpha(color,.13),alpha(color,.025)),alpha(color,.35),.85);
        ctx.save();poly(d.polygon);ctx.clip();
        // Cartographic fabric only: these lines do not create roads or editable entities.
        for(let x=bounds.x;x<bounds.x+bounds.w;x+=36)line([{x,y:bounds.y},{x,y:bounds.y+bounds.h}],alpha(color,.075),.45);
        for(let y=bounds.y;y<bounds.y+bounds.h;y+=36)line([{x:bounds.x,y},{x:bounds.x+bounds.w,y}],alpha(color,.065),.45);
        glow(d.site,alpha(color,.055),Math.min(120,bounds.h*k*.6));ctx.restore();
      }
      if(s.river){const riverBounds={x:s.river.cx-s.river.amplitude-s.river.width/2,y:0,w:s.river.width+s.river.amplitude*2,h:s.bounds.h};
      poly(s.riverPolygon,gradient(riverBounds,'#12609f65','#0a315b80'));
      for(const bank of [s.riverPolygon.slice(0,81),s.riverPolygon.slice(81)]){
        ctx.save();ctx.shadowColor=C.cyan;ctx.shadowBlur=9;line(bank,'#57bfe96b',1);ctx.restore();
      }
      const riverLine=s.riverPolygon.slice(0,81).map(q=>({x:q.x+s.river.width/2,y:q.y}));line(riverLine,'#8ae3ff28',.6,[2,13]);
      for(let y=80;y<s.bounds.h;y+=92){const x=E.riverX(s.river,y);line([{x:x-s.river.width*.2,y},{x:x+s.river.width*.13,y:y-5}],'#69d2ea25',.6)}}
      for(const road of s.segments){
        const w=Math.max(1.3,road.width*k);line([road.a,road.b],'#95c1e21a',w+2);line([road.a,road.b],road.kind==='bridge'?'#ffd1848c':'#b2cdeb4b',w);
        if(road.kind==='bridge'){
          const dx=road.b.x-road.a.x,dy=road.b.y-road.a.y,len=Math.hypot(dx,dy),n={x:-dy/len,y:dx/len};
          for(let j=0;j<=8;j++){const q={x:road.a.x+dx*j/8,y:road.a.y+dy*j/8};line([{x:q.x+n.x*14,y:q.y+n.y*14},{x:q.x-n.x*14,y:q.y-n.y*14}],'#ffd89c75',.65)}
          for(const sign of [-1,1])line([{x:road.a.x+n.x*14*sign,y:road.a.y+n.y*14*sign},{x:road.b.x+n.x*14*sign,y:road.b.y+n.y*14*sign}],'#ffe5bb90',.85);
        }
      }
      for(const b of s.buildings){
        const index=s.districts.findIndex(d=>d.id===b.districtId),color=palette[index%palette.length],active=state.selected?.id===b.id||state.hover?.id===b.id;
        if(b.decorative){
          rounded(b,alpha(color,.11),alpha(color,.17),.5,3);
          // Roof details subdivide an existing decorative footprint, staying inside it.
          const cols=b.w>40?2:1,rows=b.h>35?2:1;
          for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
            const r={x:b.x+3+x*b.w/cols,y:b.y+3+y*b.h/rows,w:b.w/cols-6,h:b.h/rows-6};
            rounded(r,alpha(color,.08),alpha(color,.16),.4,1);line([{x:r.x+r.w*.5,y:r.y},{x:r.x+r.w*.5,y:r.y+r.h}],alpha(color,.20),.5);
          }
        }else{
          ctx.save();ctx.shadowColor=active?C.cyan:color;ctx.shadowBlur=active?12:5;
          rounded(b,gradient(b,alpha(color,.25),alpha(color,.07)),active?C.cyan:alpha(color,.55),1,3);ctx.restore();
          line([{x:b.x+b.w/2,y:b.y+5},{x:b.x+b.w/2,y:b.y+b.h-5}],alpha(color,.35),.7);
          const q=E.center(b);glow(q,alpha(color,.10),25);dot({...q,id:b.id},color);
          if(k>.12)mapLabel(b.name,{x:q.x,y:b.y+b.h+43},'#c2d5ec',11);
        }
      }
      if(walled){
        ctx.save();ctx.shadowColor=C.blue;ctx.shadowBlur=5;line([...wall,wall[0]],'#a1c5e86b',1.1,[9,3]);ctx.restore();
        for(let i=0;i<wall.length;i++){const a=wall[i],b=wall[(i+1)%wall.length],n=Math.ceil(E.distance(a,b)/95);for(let j=0;j<n;j++){const q={x:a.x+(b.x-a.x)*j/n,y:a.y+(b.y-a.y)*j/n};rect({x:q.x-6,y:q.y-6,w:12,h:12},'#a4cae557')}}
      }

      for(let i=0;i<s.districts.length;i++){const d=s.districts[i];mapLabel(d.name,{x:d.site.x,y:d.site.y-55},palette[i%palette.length],12);}
      for(const gate of s.gates){diamond(gate,C.gold);mapLabel(gate.name,{x:gate.x,y:gate.y-60},'#e5bd79',11)}
      if(s.dock){ctx.save();ctx.shadowColor=C.gold;ctx.shadowBlur=5;line([{x:s.dock.x-28,y:s.dock.y},{x:s.dock.x+s.dock.width,y:s.dock.y}],'#ffdd968a',3);ctx.restore();mapLabel(s.dock.name,{x:s.dock.x-95,y:s.dock.y-45},'#e5bd79',11);}
    }

return {floor,city,grid,line,poly,rect,dot,diamond,text,mapLabel,resetLabels(){labelBoxes=[];},labels(){return labelBoxes.slice();}};
}
