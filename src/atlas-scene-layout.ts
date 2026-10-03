/** Display-only scene layout shared by legacy migration views and SQL maps. */
function interiorPositionHint(action: string, id: string): { x: number; y: number; label: string } | null {
  const zones: Array<[RegExp, number, number, string]> = [
    [/(窗边|窗旁|靠窗|window)/i, 80, 30, "窗边"],
    [/(门口|门边|门旁|门前|入口|巷口|路口|door)/i, 18, 80, "入口附近"],
    [/(角落|墙角|corner)/i, 18, 18, "角落"],
    [/(桌边|桌旁|桌子|课桌|讲台|desk|table)/i, 55, 55, "桌旁"],
    [/(中央|中间|中心|center|middle)/i, 50, 45, "中央"],
    [/(左侧|左边|left)/i, 22, 50, "左侧"],
    [/(右侧|右边|right)/i, 78, 50, "右侧"],
  ];
  const zone = zones.map((entry) => {
    const matches = [...action.matchAll(new RegExp(entry[0].source, "gi"))];
    return { entry, index: matches.length ? matches[matches.length - 1]!.index : -1 };
  }).sort((a, b) => b.index - a.index)[0];
  if (!zone || zone.index < 0) return null;
  let hash = 0;
  for (const letter of id) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) | 0;
  return { x: zone.entry[1] + ((hash >>> 0) % 11) - 5,
    y: zone.entry[2] + (((hash >>> 4) % 11) - 5), label: zone.entry[3] };
}


export function scenePositions(rows: Array<{ id: string; currentAction?: string; positionHint?: string }>, frame: {cols:number;rows:number}): Map<string, { x: number; y: number; label: string }> {
  const cols = Math.max(1, frame.cols), height = Math.max(1, frame.rows);
  const width = Math.max(1, Math.ceil(Math.sqrt(rows.length * cols / height)));
  const depth = Math.max(1, Math.ceil(rows.length / width));
  const slots = Array.from({ length: width * depth }, (_, i) => ({
    x: width === 1 ? 50 : 18 + (i % width) * 64 / (width - 1),
    y: depth === 1 ? 50 : 18 + Math.floor(i / width) * 64 / (depth - 1),
  }));
  const result = new Map<string, { x: number; y: number; label: string }>();
  const occupied: Array<{ x: number; y: number }> = [];
  const gap = Math.min(12, 45 / Math.sqrt(Math.max(1, rows.length)));
  const ordered = [...rows].sort((a, b) => Number(Boolean(b.positionHint || b.currentAction)) - Number(Boolean(a.positionHint || a.currentAction)) || a.id.localeCompare(b.id));
  for (const row of ordered) {
    const hint = interiorPositionHint(row.positionHint || row.currentAction || "", row.id);
    let index = 0;
    if (hint) {
      let best = Infinity;
      slots.forEach((slot, i) => { const score = (slot.x - hint.x) ** 2 + (slot.y - hint.y) ** 2;
        if (score < best) { best = score; index = i; } });
    }
    let slot = slots.splice(index, 1)[0]!;
    const desired = hint ?? slot;
    for (let attempt = 0; attempt < 300; attempt++) {
      const radius = attempt === 0 ? 0 : gap * Math.sqrt(attempt);
      const angle = attempt * 2.399963;
      const candidate = { x: Math.max(14, Math.min(86, desired.x + radius * Math.cos(angle))),
        y: Math.max(14, Math.min(86, desired.y + radius * Math.sin(angle))) };
      if (occupied.every((point) => Math.hypot(candidate.x - point.x, candidate.y - point.y) >= gap)) {
        slot = candidate; break;
      }
    }
    occupied.push(slot);
    // 相对方位按本场景实际格数缩放；示意坐标绝不写回三表。
    result.set(row.id, { x: slot.x * cols / 100, y: slot.y * height / 100,
      label: row.positionHint || hint?.label || "场景内，细部位置估计" });
  }
  return result;
}
