/** Build a browser check page that can be served by the local SillyTavern host. */
import {build} from 'esbuild';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const option=name=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];};
const out=resolve(option('--out')??join(root,'artifacts/map-lab/proximity'));
const baselineFile=option('--baseline-file');
const baseline=baselineFile?readFileSync(baselineFile,'utf8'):execFileSync('git',['show','HEAD:vendor/atlas-spatial/overview-core.mjs'],{cwd:root,encoding:'utf8'});
mkdirSync(out,{recursive:true});
for(const [name,old] of [['before',true],['after',false]]){
  await build({entryPoints:[join(root,'tools/map-lab/proximity-cases.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',charset:'utf8',outfile:join(out,name+'.mjs'),
    plugins:old?[{name:'baseline-overview',setup(build){build.onLoad({filter:/[\\/]overview-core\.mjs$/},()=>({contents:baseline,loader:'js',resolveDir:join(root,'vendor/atlas-spatial')}));}}]:[]});
}
writeFileSync(join(out,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atlas · 邻近排位实测</title>
<style>body{margin:0;background:#f4f6f8;color:#243443;font:14px system-ui}main{max-width:1080px;margin:30px auto;padding:0 24px}h1{font-size:24px;margin:0 0 12px}p{line-height:1.7;color:#526374}.cards{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{background:white;border:1px solid #d9e1e7;border-radius:10px;padding:20px}h2{margin:0;font-size:17px}.metric{font-size:32px;font-weight:650;margin:14px 0}.fail{color:#a33d32}.pass{color:#16754f}svg{width:100%;height:185px;background:#f6f9fb;border-radius:8px}table{width:100%;border-collapse:collapse;background:white;margin-top:22px}td,th{text-align:left;border-bottom:1px solid #e0e6eb;padding:9px 12px}th{background:#eaf0f4}#result{font-weight:650;padding:12px 0}@media(max-width:650px){.cards{grid-template-columns:1fr}}</style>
<main><h1>Atlas · 邻近排位实测</h1><p>本地酒馆提供页面，浏览器执行真实地图生成器。使用合成资料，不读取或修改聊天，不请求模型。<br>示例：同一张 10 km 地图中，两座 12 × 8 m 建筑要求靠近；同时给出方位偏好。下图按各自内容范围放大显示。</p>
<div class="cards"><section class="card"><h2>修复前</h2><div id="before-metric" class="metric"></div><svg id="before-map" aria-label="修复前邻近地点排位"></svg><p id="before-summary"></p></section><section class="card"><h2>修复后</h2><div id="after-metric" class="metric"></div><svg id="after-map" aria-label="修复后邻近地点排位"></svg><p id="after-summary"></p></section></div>
<div id="result" role="status">正在执行浏览器检查…</div><table><thead><tr><th>检查</th><th>修复前</th><th>修复后</th></tr></thead><tbody id="checks"></tbody></table><p>这里只验证局部邻近、尺寸、稳定性与单位换算；不代表完整模型生成质量已经通过验收。中心间距为布局估计，不能当作实测旅行路程。</p></main>
<script type="module">
import * as before from './before.mjs';import * as after from './after.mjs';
const labels=['参照地点排在后面','大地图中按占地留间隙','靠近与方位偏好同时表达','逆序的邻近链','相互靠近关系','增量补图沿用旧参照位置','已确认坐标作为参照','已确认轮廓作为参照','扩大地图不放大邻近间距','输入顺序稳定且不改输入','格与米换算不漂移','不虚构道路或精确定位','排在循环关系前的依赖地点'];
const old=before.runProximityChecks(),current=after.runProximityChecks();
function text(id,value){document.getElementById(id).textContent=value;}
function draw(id,layout){const svg=document.getElementById(id),ns='http://www.w3.org/2000/svg',pins=layout.pins;const xs=pins.map(p=>p.x),ys=pins.map(p=>p.y),minX=Math.min(...xs)-12,minY=Math.min(...ys)-12,maxX=Math.max(...xs)+12,maxY=Math.max(...ys)+12;const scale=Math.min(410/(maxX-minX),140/(maxY-minY));const p=q=>({x:25+(q.x-minX)*scale,y:20+(q.y-minY)*scale});svg.setAttribute('viewBox','0 0 460 185');const element=(name,attrs)=>{const el=document.createElementNS(ns,name);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,String(v));svg.append(el);return el;};const a=p(pins[0]),b=p(pins[1]);element('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#788f9f','stroke-dasharray':'4 4'});for(const s of layout.shapes)element('polygon',{points:s.polygon.map(q=>{const t=p(q);return t.x+','+t.y;}).join(' '),fill:'#d6e8ef',stroke:'#6d9fb4','stroke-width':1});for(const q of pins){const t=p(q);element('circle',{cx:t.x,cy:t.y,r:3,fill:'#206482'});const label=element('text',{x:Math.max(6,Math.min(410,t.x-12)),y:Math.min(178,t.y+22),'font-size':12,fill:'#345467'});label.textContent=q.id==='A-shop'?'商店':'住宅';}return Math.hypot(pins[0].x-pins[1].x,pins[0].y-pins[1].y);}
for(const [prefix,kit,checks]of [['before',before,old],['after',after,current]]){const gap=draw(prefix+'-map',kit.example());text(prefix+'-metric',gap.toFixed(2)+' m');text(prefix+'-summary',checks.filter(c=>c.pass).length+' / '+checks.length+' 项检查通过 · 建筑中心间距如上');}
for(let i=0;i<current.length;i++){const tr=document.createElement('tr');for(const [j,value]of [labels[i],old[i].pass?'通过':'未通过',current[i].pass?'通过':'未通过'].entries()){const td=document.createElement('td');td.textContent=value;if(j>0)td.className=(j===1?old[i]:current[i]).pass?'pass':'fail';tr.append(td);}document.getElementById('checks').append(tr);}
const report={baseline:old,current};document.documentElement.dataset.passed=String(current.every(c=>c.pass));text('result',current.every(c=>c.pass)?'浏览器检查：'+current.length+' / '+current.length+' 项通过':'浏览器检查存在失败项');const details=document.createElement('script');details.type='application/json';details.id='proximity-report';details.textContent=JSON.stringify(report);document.body.append(details);
</script></html>`,'utf8');
console.log('Built '+out);
