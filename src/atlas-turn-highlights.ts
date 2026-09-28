/** 从已提交的三表差异生成读者简报；不把模型的想法字段或技术回执当作事件。 */
import type { AtlasThreeTablesV1 } from "./atlas-tables.ts";

export function summarizeAtlasTurnChanges(
  before: AtlasThreeTablesV1 | null,
  after: AtlasThreeTablesV1 | null,
  acceptedRefs: readonly string[],
): string[] {
  if (!before || !after) return [];
  const locations = new Map(after.locations.map((row) => [row.id, row.name]));
  const place = (id: string | null) => id === null ? "未知地点" : locations.get(id) ?? "未知地点";
  const oldLocations = new Map(before.locations.map((row) => [row.id, row]));
  const oldCharacters = new Map(before.characters.map((row) => [row.id, row]));
  const oldItems = new Map(before.items.map((row) => [row.id, row]));
  const newLocations = new Map(after.locations.map((row) => [row.id, row]));
  const newCharacters = new Map(after.characters.map((row) => [row.id, row]));
  const newItems = new Map(after.items.map((row) => [row.id, row]));
  const highlights: string[] = [];
  for (const id of new Set(acceptedRefs)) {
    if (highlights.length >= 8) break;
    const location = newLocations.get(id);
    const oldLocation = oldLocations.get(id);
    const character = newCharacters.get(id);
    const oldCharacter = oldCharacters.get(id);
    const item = newItems.get(id);
    const oldItem = oldItems.get(id);
    let text = "";
    if (location && !oldLocation) text = `发现地点：${location.name}${location.gridX === null ? "（位置待确认）" : ""}`;
    else if (location && oldLocation && location.parentLocationId !== oldLocation.parentLocationId)
      text = `${location.name}归属更新：${location.parentLocationId ? place(location.parentLocationId) : "世界地图"}`;
    else if (character && !oldCharacter && character.locationId)
      text = `${character.name}出现在${place(character.locationId)}`;
    else if (character && oldCharacter && character.locationId !== oldCharacter.locationId && character.locationId)
      text = `${character.name}来到${place(character.locationId)}`;
    else if (character && oldCharacter && character.presence === "left" && oldCharacter.presence !== "left")
      text = `${character.name}离开了原来的场景`;
    else if (character && oldCharacter && character.currentAction && character.currentAction !== oldCharacter.currentAction)
      text = `${character.name}：${character.currentAction}`;
    else if (item && !oldItem)
      text = `出现物品：${item.name}${item.locationId ? `（${place(item.locationId)}）` : ""}`;
    else if (item && oldItem && item.locationId && item.locationId !== oldItem.locationId)
      text = `${item.name}出现在${place(item.locationId)}`;
    if (text) highlights.push(text.slice(0, 140));
  }
  return highlights;
}
