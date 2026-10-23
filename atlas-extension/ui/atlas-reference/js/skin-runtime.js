/* Data-only appearance contract. No host, world, network, or model access. */
(function(host){
'use strict';
const FONT_REGISTRY=Object.freeze({sans:'"Atlas Preview Sans","Segoe UI","Microsoft YaHei",sans-serif',serif:'Georgia,"Noto Serif SC","Songti SC","Atlas Preview Sans",serif',mono:'Consolas,"Atlas Preview Sans",monospace'});
const COMPONENT_REGISTRY=Object.freeze({frame:['starmap','parchment','minimal'],panels:['glass','paper','flat'],buttons:['glow','outlined','flat'],icons:['line','boxed']});
const MAP_STYLE_REGISTRY=Object.freeze({markers:['classic','seal'],road:['original','ink','technical'],water:['original','ink','technical'],buildingOutline:['original','ink','technical'],floorWall:['original','ink','technical'],furniture:['original','ink','technical']});
const ASSET_ROLES=Object.freeze(['windowFrame','windowBackdrop','avatarFrame','panelTexture','panelFrame','controlFrame','controlActiveFrame','inputFrame','selectionFrame','divider','mapTexture','mapBackdrop','characterMarker','placeMarker','itemMarker','messageMarker','eventMarker','exitMarker']);
const CSS_ASSET_ROLES=Object.freeze({windowFrame:'--skin-window-frame',windowBackdrop:'--skin-window-backdrop',avatarFrame:'--skin-avatar-frame',panelTexture:'--skin-panel-texture',panelFrame:'--skin-panel-frame',controlFrame:'--skin-control-frame',controlActiveFrame:'--skin-control-active-frame',inputFrame:'--skin-input-frame',selectionFrame:'--skin-selection-frame',divider:'--skin-divider'});
const TOKEN_REGISTRY=Object.freeze({
 'ui.window.bg':['--win-1','--win-2'],'ui.window.border':['--line-2','--line-3'],'ui.panel.bg':['--panel-1','--panel-2','--glass'],'ui.panel.border':['--line'],
 'ui.text.primary':['--txt'],'ui.text.muted':['--txt-2','--txt-3','--txt-4'],'ui.text.onAccent':['--skin-on-accent'],'ui.accent':['--cyan'],
 'ui.window.radius':['--r-lg'],'ui.panel.radius':['--r-md'],'ui.control.radius':['--r-sm'],'ui.spacing':['--skin-spacing'],
 'ui.window.frameSlice':['--skin-frame-slice'],'ui.window.frameWidth':['--skin-frame-width'],'ui.font.family':['--sans'],
 ...Object.fromEntries(['panel','control','input','selection'].flatMap(role=>[['ui.'+role+'.frameSlice',['--skin-'+role+'-slice']],['ui.'+role+'.frameWidth',['--skin-'+role+'-width']]])),
 'ui.selection.bg':['--skin-selection-bg'],'ui.selection.text':['--skin-selection-text'],
 ...Object.fromEntries(['info','success','warning','error'].map(role=>['ui.status.'+role,['--skin-status-'+role]])),
 'map.canvas.bg':['--skin-map-bg'],'map.grid.minor':[],'map.label.primary':[],'map.label.background':[],
 ...Object.fromEntries(['character','place','item','message','event','exit'].map(k=>['map.marker.'+k,['--skin-marker-'+k]])),
 ...Object.fromEntries(['road.stroke','water.stroke','water.fill','buildingOutline.stroke','buildingOutline.fill','floorWall.stroke','floorWall.fill','corridor.stroke','corridor.fill','furniture.stroke','furniture.fill'].map(k=>['map.'+k,[]])),
 'map.texture.opacity':['--skin-texture-opacity'],'map.backdrop.opacity':[]
});
const numeric={'ui.window.radius':[0,28],'ui.panel.radius':[0,24],'ui.control.radius':[0,20],'ui.spacing':[8,24],'ui.window.frameSlice':[1,256],'ui.window.frameWidth':[1,24],...Object.fromEntries(['panel','control','input','selection'].flatMap(role=>[['ui.'+role+'.frameSlice',[1,256]],['ui.'+role+'.frameWidth',[1,16]]])),'map.texture.opacity':[0,.30],'map.backdrop.opacity':[0,.50]};
const TOKEN_RULES=Object.freeze(Object.fromEntries(Object.keys(TOKEN_REGISTRY).map(k=>[k,numeric[k]?{type:'number',min:numeric[k][0],max:numeric[k][1]}:k==='ui.font.family'?{type:'enum',values:Object.keys(FONT_REGISTRY)}:{type:'color'}])));
const BASE={kind:'atlas-ui-theme',schemaVersion:1,id:'builtin.starmap',baseTheme:'builtin.starmap',tokens:{},components:{frame:'starmap',panels:'glass',buttons:'glow',icons:'line'},mapStyles:{markers:'classic',road:'original',water:'original',buildingOutline:'original',floorWall:'original',furniture:'original'},options:{motion:true,radar:true,coordinates:false},assets:{}};
const PAPER={...BASE,id:'builtin.parchment',baseTheme:'builtin.parchment',tokens:{'ui.window.bg':'#f3e9d3','ui.window.border':'#aa8451','ui.panel.bg':'#f3e9d3','ui.panel.border':'#c4a777','ui.text.primary':'#3f3527','ui.text.muted':'#78674d','ui.text.onAccent':'#fff8eb','ui.accent':'#825128','ui.font.family':'serif','map.canvas.bg':'#e6d8b3','map.grid.minor':'#9f8b62','map.label.primary':'#3f3527','map.label.background':'#f4e9d0','map.marker.character':'#994b34','map.marker.place':'#754a90','map.marker.item':'#99771c','map.marker.message':'#346a54','map.marker.event':'#b3445c','map.marker.exit':'#35657b'},components:{frame:'parchment',panels:'paper',buttons:'outlined',icons:'boxed'},mapStyles:{markers:'seal',road:'ink',water:'ink',buildingOutline:'ink',floorWall:'ink',furniture:'ink'},options:{motion:false,radar:false,coordinates:false}};
const clone=v=>JSON.parse(JSON.stringify(v));
const builtin=id=>clone(id==='builtin.parchment'?PAPER:BASE);
const fail=code=>{const error=Error(code);error.code=code;throw error;};
function record(v){return v&&typeof v==='object'&&!Array.isArray(v);}
function fields(v,allowed){if(!record(v))fail('SKIN_OBJECT_INVALID');if(Object.keys(v).some(k=>!allowed.includes(k)))fail('SKIN_UNKNOWN_FIELD');}
function validate(value){
 try{
  fields(value,['kind','schemaVersion','id','baseTheme','tokens','components','mapStyles','options','assets']);
  if(value.kind!=='atlas-ui-theme'||value.schemaVersion!==1)fail('SKIN_VERSION_UNSUPPORTED');
  if(typeof value.id!=='string'||!/^[-a-zA-Z0-9._]{1,80}$/.test(value.id))fail('SKIN_ID_INVALID');
  if(value.baseTheme!==undefined&&!['builtin.starmap','builtin.parchment'].includes(value.baseTheme))fail('SKIN_BASE_INVALID');
  if(value.tokens!==undefined){fields(value.tokens,Object.keys(TOKEN_REGISTRY));for(const [k,v]of Object.entries(value.tokens)){const rule=TOKEN_RULES[k];if(rule.type==='color'?(typeof v!=='string'||!/^#[\da-f]{6}$/i.test(v)):rule.type==='number'?typeof v!=='number'||!Number.isFinite(v)||v<rule.min||v>rule.max:!rule.values.includes(v))fail('SKIN_TOKEN_INVALID');}}
  for(const [key,registry]of [['components',COMPONENT_REGISTRY],['mapStyles',MAP_STYLE_REGISTRY]])if(value[key]!==undefined){fields(value[key],Object.keys(registry));for(const [k,v]of Object.entries(value[key]))if(!registry[k].includes(v))fail('SKIN_VARIANT_INVALID');}
  if(value.options!==undefined){fields(value.options,['motion','radar','coordinates']);if(Object.values(value.options).some(v=>typeof v!=='boolean'))fail('SKIN_OPTION_INVALID');}
  if(value.assets!==undefined){fields(value.assets,ASSET_ROLES);for(const v of Object.values(value.assets))if(typeof v!=='string'||!/^[-a-zA-Z0-9._]{1,80}$/.test(v))fail('SKIN_ASSET_REFERENCE_INVALID');}
  return {ok:true};
 }catch(error){return {ok:false,errorCode:error.code||'SKIN_INVALID',warnings:[]};}
}
function migrate(value){
 if(value?.kind==='atlas-preview-skin'&&value.version===1){if(typeof value.accent!=='string'||!/^#[\da-f]{6}$/i.test(value.accent))return {ok:false,errorCode:'SKIN_TOKEN_INVALID'};return resolve({kind:'atlas-ui-theme',schemaVersion:1,id:'user.legacy',baseTheme:'builtin.starmap',tokens:{'ui.accent':value.accent},options:{motion:value.motion!==false,radar:value.radar!==false,coordinates:value.coordinates===true}});}
 return resolve(value);
}
function resolve(value){
 if(typeof value==='string'){if(!['builtin.starmap','builtin.parchment'].includes(value))return {ok:false,errorCode:'SKIN_NOT_FOUND'};return {ok:true,skin:builtin(value),warnings:[]};}
 const result=validate(value);if(!result.ok)return result;
 const base=builtin(value.baseTheme||'builtin.starmap');
 return {ok:true,skin:{...base,...clone(value),tokens:{...base.tokens,...value.tokens},components:{...base.components,...value.components},mapStyles:{...base.mapStyles,...value.mapStyles},options:{...base.options,...value.options},assets:{...value.assets}},warnings:[]};
}
function canvasStyle(skin,resources={}){
 const t=skin.tokens,markerColors={},markerImages={},roles={char:'character',poi:'place',item:'item',sig:'message',evt:'event',exit:'exit'};
 for(const [kind,role]of Object.entries(roles)){if(t['map.marker.'+role])markerColors[kind]=t['map.marker.'+role];const resource=resources[role+'Marker'];if(resource?.bitmap)markerImages[kind]=resource.bitmap;}
 return {background:t['map.canvas.bg']||null,gridColor:t['map.grid.minor']||null,labelColor:t['map.label.primary']||null,labelBackground:t['map.label.background']||null,markerShape:skin.mapStyles.markers,markerColors,markerImages,painters:{...skin.mapStyles},palette:Object.fromEntries(Object.entries(t).filter(([k])=>/^map\.(road|water|buildingOutline|floorWall|corridor|furniture)\./.test(k)).map(([k,v])=>[k.slice(4),v])),texture:resources.mapTexture?.bitmap||null,textureOpacity:t['map.texture.opacity']??.12,backdrop:resources.mapBackdrop?.bitmap||null,backdropOpacity:t['map.backdrop.opacity']??.16};
}
let applied=new WeakMap();
function apply(value,{root,map,resources={}}){
 const result=migrate(value);if(!result.ok)return result;
 const previous=applied.get(root),beforeStyle=root.getAttribute('style'),attrs=['skinBase','skinFrame','skinPanels','skinButtons','skinIcons','motion'],before=Object.fromEntries(attrs.map(k=>[k,root.dataset[k]])),beforeCoordinates=root.classList.contains('show-coordinates'),beforeRadar=map.state.showRadar;
 const skin=result.skin;
 try{
  for(const list of Object.values(TOKEN_REGISTRY))for(const key of list)root.style.removeProperty(key);
  for(const k of Object.values(CSS_ASSET_ROLES))root.style.removeProperty(k);
  for(const [k,v]of Object.entries(skin.tokens))for(const name of TOKEN_REGISTRY[k])root.style.setProperty(name,k==='ui.font.family'?FONT_REGISTRY[v]:typeof v==='number'&&!k.endsWith('.frameSlice')&&!k.endsWith('.opacity')?v+'px':String(v));
  // Older packs reused a square window frame for avatars. Keep their themed
  // monograms clean until a dedicated avatar frame is installed.
  for(const [role,key]of Object.entries(CSS_ASSET_ROLES))if(resources[role]?.url&&!(role==='avatarFrame'&&skin.assets.avatarFrame===skin.assets.windowFrame))root.style.setProperty(key,`url("${resources[role].url}")`);
  if(resources.windowFrame?.url){root.style.setProperty('--skin-window-frame',`url("${resources.windowFrame.url}")`);root.style.setProperty('--skin-frame-slice',String(skin.tokens['ui.window.frameSlice']??16));root.style.setProperty('--skin-frame-width',(skin.tokens['ui.window.frameWidth']??8)+'px');}
  root.dataset.skinBase=skin.baseTheme.split('.')[1];for(const key of Object.keys(COMPONENT_REGISTRY))root.dataset['skin'+key[0].toUpperCase()+key.slice(1)]=skin.components[key];
  root.dataset.motion=skin.options.motion?'full':'reduced';root.classList.toggle('show-coordinates',skin.options.coordinates);map.setFlag('showRadar',skin.options.radar);
  const style=canvasStyle(skin,resources);if(map.setSkin(style)===false)fail('SKIN_CANVAS_APPLY_FAILED');
  applied.set(root,{skin:clone(skin),style});return {...result,saved:false};
 }catch(error){
  if(beforeStyle===null)root.removeAttribute('style');else root.setAttribute('style',beforeStyle);
  for(const k of attrs)if(before[k]===undefined)delete root.dataset[k];else root.dataset[k]=before[k];
  root.classList.toggle('show-coordinates',beforeCoordinates);try{map.setFlag('showRadar',beforeRadar);map.setSkin(previous?.style??null);}catch(_){}
  return {ok:false,errorCode:'SKIN_APPLY_FAILED',message:error.message};
 }
}
const api={TOKEN_REGISTRY,TOKEN_RULES,FONT_REGISTRY,COMPONENT_REGISTRY,MAP_STYLE_REGISTRY,ASSET_ROLES,CSS_ASSET_ROLES,validate,resolve,migrate,canvasStyle,apply,builtin};
if(typeof module==='object'&&module.exports)module.exports=api;else host.AtlasSkinRuntime=api;
})(typeof window==='object'?window:globalThis);

