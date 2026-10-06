/** Original UI world-book controls, connected to the host's real book API. */
export function createReferenceLorePort(getContext,loadWorldInfo){
 const capture=()=>{const c=getContext();return {c,id:c?.chatId??c?.chat_id,metadata:c?.chatMetadata};};
 const valid=s=>{const n=capture();return n.id===s.id&&n.metadata===s.metadata;};
 function books(c){return [...new Set([c?.chatMetadata?.world_info,c?.characters?.[c.characterId]?.data?.extensions?.world].filter(x=>typeof x==='string'&&x.trim()))];}
 return {
  async read(){const s=capture(),names=books(s.c);if(!names.length)return [];const port=await loadWorldInfo();if(!valid(s))return [];
   const rows=[];for(const name of names){const data=await port.loadWorldInfo(name);if(!valid(s))return [];for(const [uid,e]of Object.entries(data?.entries??{}))rows.push({id:JSON.stringify([name,uid]),book:name,uid,title:e.comment||e.key?.join(' · ')||`条目 ${uid}`,kind:name,content:String(e.content??''),enabled:e.disable!==true,keys:e.key??[],target:null});}return rows;},
  async toggle(id){const [name,uid]=JSON.parse(id),s=capture();if(!books(s.c).includes(name))throw Error('该世界书不属于当前聊天或角色卡');const port=await loadWorldInfo(),data=await port.loadWorldInfo(name);if(!valid(s))throw Error('聊天已切换，请重新操作');const e=data?.entries?.[String(uid)];if(!e)throw Error('世界书条目已不存在');e.disable=e.disable!==true;await port.saveWorldInfo(name,data,true);}
 };
}
