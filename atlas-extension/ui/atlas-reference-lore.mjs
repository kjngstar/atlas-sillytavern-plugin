const SETTINGS_KEY = 'atlas_world_sim';
export const atlasLoreEntryId = (book, uid) => JSON.stringify([String(book), String(uid)]);
export function atlasLoreReadPolicy(context) {
  const value = context?.extensionSettings?.[SETTINGS_KEY]?.excludedLoreEntries;
  return new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string') : []);
}
export function isAtlasLoreEntryReadable(context, book, uid) {
  return !atlasLoreReadPolicy(context).has(atlasLoreEntryId(book, uid));
}

/** Host activation and Atlas input selection are independent settings. */
export function createReferenceLorePort(getContext, loadWorldInfo, getAdditionalBooks = async () => []) {
  const capture = () => {
    const c = getContext();
    return {
      c, id: c?.chatId ?? c?.chat_id, metadata: c?.chatMetadata,
      signature: JSON.stringify([
        c?.characterId ?? null,
        c?.chatMetadata?.world_info ?? null,
        c?.characters?.[c.characterId]?.data?.extensions?.world ?? null,
        [...atlasLoreReadPolicy(c)].sort(),
      ]),
    };
  };
  const valid = s => {
    const n = capture();
    return n.id === s.id && n.metadata === s.metadata && n.signature === s.signature;
  };
  async function books(c) {
    const extra = await getAdditionalBooks();
    const names = Array.isArray(extra) ? extra
      : extra && typeof extra === 'object' ? [extra.primary, ...(extra.additional ?? [])] : [extra];
    return [...new Set([
      c?.chatMetadata?.world_info, c?.characters?.[c.characterId]?.data?.extensions?.world,
      ...names.map(x => typeof x === 'string' ? x : x?.name),
    ].filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))];
  }
  // Auxiliary host bindings may change without replacing chatMetadata. Recheck
  // the complete book set after awaits, before publishing a read or starting a write.
  async function current(s, names) {
    if (!valid(s)) return false;
    const latest = await books(getContext());
    return valid(s) && JSON.stringify([...latest].sort()) === JSON.stringify([...names].sort());
  }
  const stale = () => Error('聊天已切换或世界书设置已变化，请重新操作');
  async function entry(id) {
    const [name, uid] = JSON.parse(id), s = capture(), names = await books(s.c);
    if (!valid(s)) throw stale();
    if (!names.includes(name)) throw Error('该世界书不属于当前聊天或角色卡');
    const port = await loadWorldInfo();
    if (!valid(s)) throw stale();
    const data = await port.loadWorldInfo(name);
    if (!await current(s, names)) throw stale();
    if (!data?.entries?.[String(uid)]) throw Error('世界书条目已不存在');
    return { name, uid: String(uid), s, port, data };
  }
  return {
    async read() {
      const s = capture(), names = await books(s.c);
      if (!names.length || !valid(s)) return [];
      const port = await loadWorldInfo();
      if (!valid(s)) return [];
      const rows = [];
      for (const name of names) {
        const data = await port.loadWorldInfo(name);
        if (!valid(s)) return [];
        for (const [uid, e] of Object.entries(data?.entries ?? {})) rows.push({
          id: atlasLoreEntryId(name, uid), book: name, uid,
          title: e.comment || e.key?.join(' · ') || `条目 ${uid}`, kind: name,
          content: String(e.content ?? ''), enabled: e.disable !== true, keys: e.key ?? [], target: null,
        });
      }
      if (!await current(s, names)) return [];
      const excluded = atlasLoreReadPolicy(s.c);
      return rows.map(row => ({ ...row, atlasReadable: !excluded.has(row.id) }));
    },
    async toggle(id) {
      const { name, uid, port, data } = await entry(id);
      // Do not mutate a host-owned object before persistence succeeds.
      const next = { ...data, entries: { ...data.entries,
        [uid]: { ...data.entries[uid], disable: data.entries[uid].disable !== true } } };
      await port.saveWorldInfo(name, next, true);
    },
    async setAtlasRead(id, enabled) {
      if (typeof enabled !== 'boolean') throw Error('ATLAS 读取开关必须是布尔值');
      const { name, uid, s } = await entry(id);
      if (!s.c?.extensionSettings || typeof s.c.saveSettingsDebounced !== 'function') throw Error('宿主无法保存 ATLAS 读取设置');
      const previous = s.c.extensionSettings[SETTINGS_KEY], excluded = atlasLoreReadPolicy(s.c), key = atlasLoreEntryId(name, uid);
      if (enabled) excluded.delete(key); else excluded.add(key);
      const next = { ...(previous ?? {}), excludedLoreEntries: [...excluded] };
      s.c.extensionSettings[SETTINGS_KEY] = next;
      try { await s.c.saveSettingsDebounced(); }
      catch (error) {
        if (s.c.extensionSettings[SETTINGS_KEY] === next) s.c.extensionSettings[SETTINGS_KEY] = previous;
        throw error;
      }
    },
  };
}
