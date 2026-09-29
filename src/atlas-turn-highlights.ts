/** 从已提交的三表差异生成读者简报；不把模型的想法字段或技术回执当作事件。
 *
 * P1-02:返回结构化 {text, visibility, sourceRef?};visibility 默认 hidden,
 * 仅当 POV 在当前位置、可观察接触或已送达消息时才标 known。
 * 同一 acceptedRefs 顺序保持稳定;最多 8 条;text 最长 140 字。
 */
import type { AtlasThreeTablesV1 } from "./atlas-tables.ts";

export type HighlightVisibility = "known" | "hidden";

export type AtlasTurnHighlight = {
  text: string;
  visibility: HighlightVisibility;
  sourceRef?: string;
};

export interface TurnHighlightEvidence {
  /** POV 当前所在地点 id(可空) */
  povLocationId: string | null;
  /** POV 已观察到的人物 id 集合 */
  knownCharacterIds: ReadonlySet<string>;
  /** 本轮已送达的消息 ref 集合(物品/信息等) */
  deliveredRefIds: ReadonlySet<string>;
}

const MAX_HIGHLIGHTS = 8;
const MAX_HIGHLIGHT_CHARS = 140;

export function summarizeAtlasTurnChanges(
  before: AtlasThreeTablesV1 | null,
  after: AtlasThreeTablesV1 | null,
  acceptedRefs: readonly string[],
  evidence?: TurnHighlightEvidence,
): AtlasTurnHighlight[] {
  // 向后兼容:不传 evidence 时使用空集(所有条目视为 hidden)
  const ev: TurnHighlightEvidence = evidence ?? {
    povLocationId: null,
    knownCharacterIds: new Set<string>(),
    deliveredRefIds: new Set<string>(),
  };
  if (!before || !after) return [];
  const locations = new Map(after.locations.map((row) => [row.id, row.name]));
  const place = (id: string | null) =>
    id === null ? "未知地点" : locations.get(id) ?? "未知地点";
  const oldLocations = new Map(before.locations.map((row) => [row.id, row]));
  const oldCharacters = new Map(before.characters.map((row) => [row.id, row]));
  const oldItems = new Map(before.items.map((row) => [row.id, row]));
  const newLocations = new Map(after.locations.map((row) => [row.id, row]));
  const newCharacters = new Map(after.characters.map((row) => [row.id, row]));
  const newItems = new Map(after.items.map((row) => [row.id, row]));

  const out: AtlasTurnHighlight[] = [];
  const seenRefs = new Set<string>();
  const povAt = ev.povLocationId;

  function classify(refId: string, refKind: "location" | "character" | "item"): HighlightVisibility {
    if (refKind === "item") {
      return ev.deliveredRefIds.has(refId) ? "known" : "hidden";
    }
    if (refKind === "location") {
      return povAt !== null && refId === povAt ? "known" : "hidden";
    }
    if (ev.knownCharacterIds.has(refId)) return "known";
    return "hidden";
  }

  for (const refId of new Set(acceptedRefs)) {
    if (out.length >= MAX_HIGHLIGHTS) break;
    if (seenRefs.has(refId)) continue;
    seenRefs.add(refId);

    const location = newLocations.get(refId);
    const oldLocation = oldLocations.get(refId);
    const character = newCharacters.get(refId);
    const oldCharacter = oldCharacters.get(refId);
    const item = newItems.get(refId);
    const oldItem = oldItems.get(refId);

    let text = "";
    let kind: "location" | "character" | "item" = "location";
    if (location && !oldLocation) {
      text = `发现地点：${location.name}${location.gridX === null ? "（位置待确认）" : ""}`;
    } else if (
      location && oldLocation &&
      location.parentLocationId !== oldLocation.parentLocationId
    ) {
      text = `${location.name}归属更新：${location.parentLocationId ? place(location.parentLocationId) : "世界地图"}`;
    } else if (character && !oldCharacter && character.locationId) {
      text = `${character.name}出现在${place(character.locationId)}`;
      kind = "character";
    } else if (
      character && oldCharacter &&
      character.locationId !== oldCharacter.locationId && character.locationId
    ) {
      text = `${character.name}来到${place(character.locationId)}`;
      kind = "character";
    } else if (
      character && oldCharacter &&
      character.presence === "left" && oldCharacter.presence !== "left"
    ) {
      text = `${character.name}离开了原来的场景`;
      kind = "character";
    } else if (
      character && oldCharacter &&
      character.currentAction && character.currentAction !== oldCharacter.currentAction
    ) {
      text = `${character.name}：${character.currentAction}`;
      kind = "character";
    } else if (item && !oldItem) {
      text = `出现物品：${item.name}${item.locationId ? `（${place(item.locationId)}）` : ""}`;
      kind = "item";
    } else if (item && oldItem && item.locationId && item.locationId !== oldItem.locationId) {
      text = `${item.name}出现在${place(item.locationId)}`;
      kind = "item";
    }
    if (!text) continue;
    out.push({
      text: text.slice(0, MAX_HIGHLIGHT_CHARS),
      visibility: classify(refId, kind),
      sourceRef: refId,
    });
  }
  return out;
}