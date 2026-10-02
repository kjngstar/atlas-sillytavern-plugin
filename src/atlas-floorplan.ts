/** Display-only architectural layout. Never supplies coordinates to travel or writes world facts. */
export interface FloorplanChild { id: string; name: string; x?: number; y?: number }
export interface FloorplanRect { x: number; y: number; width: number; height: number; name: string; childId?: string }
export interface Floorplan {
  bounds: FloorplanRect;
  regions: FloorplanRect[];
  passages: FloorplanRect[];
  markers: Array<{ id: string; x: number; y: number }>;
}

export function isBuildingScene(name: string): boolean {
  if (/(寝殿|寝宫|卧室|客房|房间|教室|办公室|大厅|餐厅|街道|街区|城市|小巷|走廊)/i.test(name)) return false;
  return /(王宫|皇宫|宫殿|城堡|府邸|宅邸|住宅|公寓|教学楼|校舍|楼房|大楼|大厦|办公楼|建筑|医院|旅馆|旅店|酒店|工会|公会|会馆|拍卖行|商场|palace|castle|building|hotel)/i.test(name);
}

export function buildFloorplan(input: { name: string; cols: number; rows: number; children: readonly FloorplanChild[] }): Floorplan | null {
  if (!isBuildingScene(input.name) || !Number.isFinite(input.cols) || !Number.isFinite(input.rows) || input.cols <= 0 || input.rows <= 0) return null;
  const w = input.cols, h = input.rows;
  const rect = (name: string, x: number, y: number, width: number, height: number): FloorplanRect =>
    ({ name, x: x * w, y: y * h, width: width * w, height: height * h });
  const regions: FloorplanRect[] = [];
  const markers: Floorplan['markers'] = [];
  const children = [...input.children].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  // Known rooms get partitioned areas rather than a single isolated pin. Unspecified areas are
  // architectural decoration only: they have no location ID and cannot affect who knows what.
  const count = Math.max(4, children.length);
  const tiers = Math.ceil(count / 2);
  const step = .62 / tiers;
  for (let i = 0; i < count; i++) {
    const child = children[i];
    const left = i % 2 === 0;
    const area = rect(child?.name ?? '', left ? .14 : .55, .18 + Math.floor(i / 2) * step, .31, step * .82);
    if (child) {
      area.childId = child.id;
      const confirmed = Number.isFinite(child.x) && Number.isFinite(child.y);
      if (confirmed) {
        // Preserve supplied coordinates, including points outside a guessed building frame.
        area.x = child.x! - area.width / 2;
        area.y = child.y! - area.height / 2;
      } else markers.push({ id: child.id, x: area.x + area.width / 2, y: area.y + area.height / 2 });
    }
    regions.push(area);
  }
  const x = Math.min(.1 * w, ...regions.map(area => area.x - .025 * w));
  const y = Math.min(.12 * h, ...regions.map(area => area.y - .025 * h));
  const right = Math.max(.9 * w, ...regions.map(area => area.x + area.width + .025 * w));
  const bottom = Math.max(.9 * h, ...regions.map(area => area.y + area.height + .025 * h));
  return {
    bounds: { name: input.name, x, y, width: right - x, height: bottom - y }, regions, markers,
    passages: [rect('通道', .46, .18, .08, .64), rect('入口', .43, .82, .14, .08)],
  };
}
