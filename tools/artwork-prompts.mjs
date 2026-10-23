/** Produce an auditable per-asset image-generation plan; never send API requests. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function artworkPrompts(manifest){
 const roles=manifest.theme.assets||{},palette=manifest.theme.tokens||{};
 return {schemaVersion:1,skin:manifest.id,tasks:manifest.assets.map(asset=>{
  const assigned=Object.entries(roles).filter(([,id])=>id===asset.id).map(([role])=>role);
  const avatar=assigned.includes('avatarFrame'),marker=assigned.some(role=>role.endsWith('Marker'));
  const frame=assigned.some(role=>role.endsWith('Frame')),divider=assigned.includes('divider');
  const transparent=frame||marker||divider;
  if(avatar&&assigned.includes('windowFrame'))throw Error('ARTWORK_AVATAR_NEEDS_OWN_FRAME');
  const instructions=[
   `为 Atlas 制作一张可直接用于界面的独立素材。主题：${manifest.name}。用途：${assigned.join('、')||asset.id}。`,
   `统一配色：底色 ${palette['ui.window.bg']||'沿用主题'}，主色 ${palette['ui.accent']||'沿用主题'}，文字墨色 ${palette['ui.text.primary']||'沿用主题'}。`,
   '只画这一张素材；不画界面截图、按钮文字、标签、水印、样机、拼图或多套备选。细节克制，轮廓清楚。',
   transparent?'背景为真正透明的 alpha，不画白色底、棋盘格或矩形底板。':'使用低对比、低密度背景，中央保留大片安静区域，确保地图和文字易读。',
  ];
  if(avatar)instructions.push('专用圆环头像框，正方形画幅，中心至少 65% 直径完全透明；装饰沿圆周，四角透明，不画方形窗框。实际显示 38–48 CSS 像素，细节必须在此尺寸可辨。');
  else if(frame)instructions.push('可九宫格拉伸的边框：四角完整，四边连续，中心透明；不把主要图案放在中心或依赖固定长宽比。边框实际显示约 4–18 CSS 像素宽。');
  if(marker)instructions.push('单个居中的地图符号，正方形画幅，四周至少 12% 透明留白；按最终 24×24 CSS 像素设计，单一主体、清晰剪影、少量色块，不加微小文字或细线背景。');
  if(divider)instructions.push('横向轻量分隔纹样，细节只沿横向分布，四边透明，无文字。');
  return {id:asset.id,path:asset.path,roles:assigned,transparent_background:transparent,prompt:instructions.join('\n'),review:avatar?['圆环与透明中心','38/48px 预览']:marker?['24px 预览','六类符号能区分','透明边缘']:frame?['九宫格拉伸','透明中心','切换后几何不变']:['文字及地图对比','中央留白']};
 })};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const directory=process.argv[2];if(!directory)throw Error('Usage: node tools/artwork-prompts.mjs <skin-directory>');
 console.log(JSON.stringify(artworkPrompts(JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'))),null,2));
}
