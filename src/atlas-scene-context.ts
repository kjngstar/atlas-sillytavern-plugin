/** Narrative projection only. Author state, intentions and private thoughts never enter this text. */
import type { AtlasThreeTablesV1 } from './atlas-tables.ts';

export const SCENE_CONTEXT_FORMAT = 'atlas-scene-v2';
const clean = (value: unknown, max = 160): string => String(value ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const sameId = (a: unknown, b: unknown): boolean => Boolean(a && b) && String(a).replace(/^(loc:|npc:)/, '') === String(b).replace(/^(loc:|npc:)/, '');

export interface SceneSimulationInput {
  events?: readonly { simulationId: string; kind: string; status: string; visibility: string; summary: string; period: number }[] | null;
  deliveries?: readonly { signalId: string; recipientType: string; recipientId: string; confidence?: string; receivedPeriod?: number }[] | null;
  signals?: readonly { id: string; topic: string; visibility: string; status: string; publishedPeriod: number }[] | null;
  protagonistCharacterId?: string | null;
}

export function projectSceneLines(tables: AtlasThreeTablesV1 | null | undefined, currentLocationId: string | null): string[] {
  if (!tables || !currentLocationId) return [];
  const current = tables.locations.find(row => sameId(row.id, currentLocationId));
  if (!current) return [];
  const byId = new Map(tables.locations.map(row => [row.id, row]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let row: typeof current | undefined = current;
  while (row && !seen.has(row.id) && chain.length < 8) {
    seen.add(row.id);
    chain.unshift(clean(row.name, 64));
    row = row.parentLocationId ? byId.get(row.parentLocationId) : undefined;
  }
  const lines = [`位置链：${chain.join(' → ')}`];
  const present = tables.characters.filter(person => person.presence === 'present' && sameId(person.locationId, current.id)
    && (person.positionSource === 'narrative' || person.positionSource === 'inferred' || person.positionSource === 'manual'));
  for (const person of present.slice(0, 6)) lines.push(`在场：${clean(person.name, 64)}`);
  if (present.length > 6) lines.push(`在场：另有 ${present.length - 6} 位未列出`);
  // These rows were registered from the scene. Hidden descriptions and held objects are omitted.
  const items = tables.items.filter(item => sameId(item.locationId, current.id) && item.holderCharacterId === null && item.status !== '已销毁');
  if (items.length) lines.push(`地面物品：${items.slice(0, 4).map(item => clean(item.name, 64)).join('、')}`);
  return lines;
}

/** A delivery to another place/person is never proof that the protagonist knows the message. */
export function projectReceivedClues(input: SceneSimulationInput | null | undefined, currentLocationId: string | null, at: number): string[] {
  if (!input) return [];
  const clues: string[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...(input.signals ?? []).filter(signal => signal.visibility === 'known' && signal.status === 'active' && signal.publishedPeriod <= at)
      .map(signal => ({ id: signal.id, text: signal.topic, at: signal.publishedPeriod })),
    ...(input.events ?? []).filter(event => event.kind === 'signal' && event.visibility === 'known' && event.period <= at
      && !(input.signals ?? []).some(signal => signal.id === event.simulationId))
      .map(event => ({ id: event.simulationId, text: event.summary, at: event.period })),
  ];
  for (const candidate of candidates.sort((a, b) => b.at - a.at)) {
    if (seen.has(candidate.id)) continue;
    const receipts = (input.deliveries ?? []).filter(receipt => receipt.signalId === candidate.id
      && (receipt.receivedPeriod === undefined || receipt.receivedPeriod <= at)
      && ((receipt.recipientType === 'character' && sameId(receipt.recipientId, input.protagonistCharacterId))
        || (receipt.recipientType === 'location' && sameId(receipt.recipientId, currentLocationId))));
    const delivery = receipts.find(receipt => receipt.recipientType === 'character') ?? receipts[0];
    if (!delivery) continue;
    seen.add(candidate.id);
    const personallyReceived = delivery.recipientType === 'character';
    const label = !personallyReceived ? '此地可接触的风声（不代表已经注意或核实）'
      : delivery.confidence === 'confirmed' ? '收到的消息' : delivery.confidence === 'disputed' ? '有争议的消息' : '听到的传闻';
    const text = clean(candidate.text);
    if (text) clues.push(`${label}：${text}`);
    if (clues.length === 5) break;
  }
  return clues;
}

export function renderSceneContext(scene: readonly string[], clues: readonly string[], maxChars = 1800): string {
  if (!scene.length && !clues.length) return '';
  const header = '<atlas_scene_context version="2">\n仅用于续写当前视角；传闻不等于事实，不能把人物私下意图写成主角已知。\n';
  const footer = '\n</atlas_scene_context>';
  if (maxChars < header.length + footer.length + 5) return '';
  const lines: string[] = [];
  let length = header.length + footer.length;
  for (const section of [scene.length ? ['【当前场景】', ...scene] : [], clues.length ? ['【场景线索】', ...clues] : []]) {
    for (const line of section) {
      if (length + line.length + 1 > maxChars) break;
      lines.push(line);
      length += line.length + 1;
    }
  }
  return header + lines.join('\n') + footer;
}
