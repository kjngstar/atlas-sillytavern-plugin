/** Extract task-relevant background excerpts, without paraphrasing evidence or classifying safety. */
const SETTING_FACT = /(世界|时代|背景|文明|现代|古代|中世纪|奇幻|玄幻|异世界|科幻|武侠|仙侠|修仙|神话|末世|废土|校园|学校|城市|城镇|村庄|街|小巷|道路|走廊|房间|教室|寝殿|寝宫|书房|庭院|院落|门厅|大厅|客房|塔楼|宫殿|王宫|皇宫|城堡|建筑|楼层|入口|出口|位于|坐落|附近|北侧|南侧|东侧|西侧|内部|地下|迷宫|工会|公会|拍卖|魔法|科技|能力|职业|身份|姓名|名字|性格|目标|阵营|抵达|到达|离开|进入|返回|携带|持有|交给|拾起|丢下|species|setting|world|location|school|city|palace|castle|floor|room|street|name|occupation|personality)/i;

export function selectTaskBackground(text: string, maxChars = 1800, names: readonly string[] = []): string {
  if (!text || maxChars <= 0) return '';
  const plain = text.replace(/<(think|thinking|analysis|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[^>]+>/g, '');
  const excerpts: string[] = [];
  let chars = 0;
  for (const raw of plain.split(/\r?\n|(?<=[。！？.!?])\s*/u)) {
    const line = raw.trim();
    if (!line || !(SETTING_FACT.test(line) || names.some(name => name.length > 1 && line.includes(name)))) continue;
    const excerpt = line.slice(0, 420);
    if (chars + excerpt.length + 1 > maxChars) continue;
    excerpts.push(excerpt);
    chars += excerpt.length + 1;
    if (excerpts.length >= 16) break;
  }
  return excerpts.join('\n');
}
