/** Assemble host SSE as reply data. Never execute returned functions or accept a partial stream. */
export function assembleHostStream(wire: string) {
  const message: any = { content: '' }, calls = new Map<number, any>(), googleParts: any[] = [];
  let events = 0, done = false, finishReason: string | null = null, blockReason: string | null = null, error: any;
  const frames = wire.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n');
  for (const frame of frames) {
    const lines = frame.split('\n'), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    if (done) throw new Error('HOST_STREAM_INVALID');
    if (data.trim() === '[DONE]') { done = true; continue; }
    let chunk: any;
    try { chunk = JSON.parse(data); } catch { throw new Error('HOST_STREAM_INVALID'); }
    events++;
    if (chunk?.error) error = chunk.error;
    if (lines.some(line => line.trim() === 'event: error')) error ??= { message: 'stream error' };
    blockReason = chunk?.promptFeedback?.blockReason ?? blockReason;
    if (Array.isArray(chunk?.choices)) {
      // Only the primary completion belongs to this task; extra swipes are not operations.
      const choice = chunk.choices.find((c: any) => (c.index ?? 0) === 0);
      if (choice) {
        const delta = choice.delta ?? choice.message ?? {};
        if (typeof delta.content === 'string') message.content += delta.content;
        else if (Array.isArray(delta.content)) message.content += delta.content.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join('');
        for (const key of ['reasoning_content', 'refusal']) if (typeof delta[key] === 'string') message[key] = (message[key] ?? '') + delta[key];
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0, prior = calls.get(index) ?? { type: 'function', function: { name: '', arguments: '' } };
          if (call.type) prior.type = call.type;
          if (typeof call.function?.name === 'string') prior.function.name += call.function.name;
          if (typeof call.function?.arguments === 'string') prior.function.arguments += call.function.arguments;
          calls.set(index, prior);
        }
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      }
    }
    const candidate = chunk?.candidates?.find((c: any) => (c.index ?? 0) === 0);
    const parts = candidate?.content?.parts ?? chunk?.responseContent?.parts;
    if (Array.isArray(parts)) googleParts.push(...parts);
    finishReason = candidate?.finishReason ?? chunk?.responseContent?.finishReason ?? finishReason;
  }
  const complete = done || finishReason !== null || blockReason !== null || !!error;
  if (!events || !complete) throw new Error('HOST_STREAM_INCOMPLETE');
  if (calls.size) message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  // Native Google text parts are stream fragments, not separate paragraphs.
  const visibleParts = googleParts.filter(part => part?.thought !== true && typeof part?.text === 'string');
  const assembledParts = [...googleParts.filter(part => part?.thought === true || typeof part?.text !== 'string'),
    ...(visibleParts.length ? [{ text: visibleParts.map(part => part.text).join('') }] : [])];
  return { data: { choices: [{ message, finish_reason: finishReason }],
    ...(googleParts.length ? { responseContent: { parts: assembledParts } } : {}),
    ...(blockReason ? { promptFeedback: { blockReason } } : {}), ...(error ? { error } : {}) },
    meta: { streamed: true, streamEventCount: events, streamComplete: complete } };
}
