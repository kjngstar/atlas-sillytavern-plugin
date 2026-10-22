/** Pure markup; business actions stay in the existing controller event delegation. */
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function appearanceSettingsHTML({skin,catalog=[],runtime}){
 const option=(value,label,current)=>`<option value="${esc(value)}" ${value===current?'selected':''}>${esc(label)}</option>`;
 const row=(label,body)=>`<label class="appearance-row"><span>${esc(label)}</span>${body}</label>`;
 const select=(attr,key,values,current)=>`<select ${attr}="${esc(key)}">${values.map(v=>option(v,v,current)).join('')}</select>`;
 let html='<div class="appearance-form"><h3>界面外观</h3><p class="scope-note">框体、控件与地图风格独立调整。纸面主题为预览。</p>';
 html+=row('已安装皮肤',`<select data-skin-select>${option('builtin.starmap','星幕',skin.id)}${option('builtin.parchment','纸面（预览）',skin.id)}${!skin.id.startsWith('builtin.')&&!catalog.some(p=>p.id===skin.id)?option(skin.id,'当前自定义外观',skin.id):''}${catalog.map(p=>option(p.id,p.name+(p.previewOnly?'（本次预览）':''),skin.id)).join('')}</select>`);
 const labels={frame:'窗口框体',panels:'面板',buttons:'按钮',icons:'图标边框'};
 for(const [key,values]of Object.entries(runtime.COMPONENT_REGISTRY))html+=row(labels[key],select('data-skin-component',key,values,skin.components[key]));
 html+=row('界面字体',select('data-skin-token','ui.font.family',Object.keys(runtime.FONT_REGISTRY),skin.tokens['ui.font.family']||'sans'));
 html+=row('窗口圆角',`<input data-skin-token="ui.window.radius" type="range" min="0" max="28" value="${skin.tokens['ui.window.radius']??20}">`);
 for(const [key,label,fallback]of [['ui.accent','强调色','#43e0ff'],['ui.text.primary','文字颜色','#dce9fb'],['map.canvas.bg','地图底色','#03050a'],['map.road.stroke','道路颜色','#806443']])html+=row(label,`<input ${key==='ui.accent'?'id="skinAccent" ':''}data-skin-token="${key}" type="color" value="${esc(skin.tokens[key]||fallback)}">`);
 const mapLabels={markers:'地图标点',road:'道路笔触',water:'水系笔触',buildingOutline:'建筑轮廓',floorWall:'室内墙体',furniture:'陈设笔触'};
 for(const [key,values]of Object.entries(runtime.MAP_STYLE_REGISTRY))html+=row(mapLabels[key],select('data-skin-map-style',key,values,skin.mapStyles[key]));
 for(const [key,label]of [['radar','室外距离参考环'],['motion','界面动画'],['coordinates','显示坐标读数']])html+=row(label,`<input type="checkbox" data-appearance-${key} ${skin.options[key]?'checked':''}>`);
 html+='<div class="detail-actions"><button class="action-btn" data-export="skin">导出当前皮肤</button><button class="action-btn" data-export-skin-pack>导出完整皮肤包</button><label class="action-btn">导入皮肤<input id="skinImport" type="file" accept=".json,.zip,application/json,application/zip" hidden></label><button class="action-btn" data-skin-reset>恢复默认外观</button></div>';
 if(!skin.id.startsWith('builtin.'))html+='<button class="action-btn" data-remove-skin>移除当前皮肤</button>';
 return html+'<p class="scope-note">JSON 保存配置；ZIP 可包含静态 PNG/WebP 图片。存储失败时保留本次预览，可导出备份。</p></div>';
}
