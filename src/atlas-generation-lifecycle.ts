/** Host generation events have no request ID. Track nesting and completion aliases locally. */
export type AtlasGenerationSignal = 'received' | 'ended' | 'after-commands';
export type AtlasGenerationMetadata = {
  generationType?: string; dryRun?: boolean; automaticTrigger?: boolean; quietPromptPresent?: boolean;
};
type Frame = AtlasGenerationMetadata & {
  sequence: number; gated: boolean; startedAt: number; completed: boolean;
  rawEnded: boolean; afterCommands: boolean; stopped: boolean;
};
export function createAtlasGenerationLifecycle(now: () => number = Date.now) {
  let sequence = 0, frames: Frame[] = [];
  function lastMatching(predicate: (frame: Frame) => boolean): Frame | null {
    for (let i = frames.length - 1; i >= 0; i--) if (predicate(frames[i]!)) return frames[i]!;
    return null;
  }
  function prune() { frames = frames.filter(f => now() - f.startedAt < 30 * 60_000).slice(-128); }
  function current() { prune(); return lastMatching(f => !f.completed); }
  function decision(frame: Frame | null, duplicate = false) {
    return { gated: frame?.gated === true, duplicate, details: {
      generationSequence: frame?.sequence ?? 0,
      generationType: frame?.generationType ?? 'unknown',
      dryRun: frame?.dryRun === true, automaticTrigger: frame?.automaticTrigger === true,
      quietPromptPresent: frame?.quietPromptPresent === true,
    } };
  }
  return {
    reset() { frames = []; },
    start(gated: boolean, metadata: AtlasGenerationMetadata = {}) {
      prune(); const frame: Frame = { ...metadata, sequence: ++sequence, gated, startedAt: now(),
        completed: false, rawEnded: false, afterCommands: false, stopped: false };
      frames.push(frame); return decision(frame);
    },
    message() { return decision(current()); },
    complete(signal: AtlasGenerationSignal, foreground = false) {
      const active = current();
      // RECEIVED is an observation of a visible floor, not another request completion.
      // Raw ENDED closes that request; AFTER_COMMANDS may be a second notification.
      if (signal === 'received') {
        const frame = foreground ? lastMatching(f => !f.completed && !f.gated) ?? active : active;
        return decision(frame ?? frames.at(-1) ?? null);
      }
      if (signal === 'ended') {
        const stopped = lastMatching(f => f.completed && f.stopped && !f.rawEnded);
        if (stopped && (!active || stopped.sequence > active.sequence)) {
          stopped.rawEnded = true; return decision(stopped, true);
        }
      }
      if (signal === 'after-commands') {
        const ended = lastMatching(f => f.completed && (f.rawEnded || f.stopped) && !f.afterCommands);
        // A nested request's second completion must not pop its foreground parent.
        if (ended && (!active || ended.sequence > active.sequence)) {
          ended.afterCommands = true; return decision(ended, true);
        }
      }
      if (!active) return decision(frames.at(-1) ?? null, frames.length > 0);
      active.completed = true;
      active.rawEnded = signal === 'ended'; active.afterCommands = signal === 'after-commands';
      return decision(active);
    },
    stop() { const active = current(); if (active) { active.completed = true; active.stopped = true; } return decision(active); },
  };
}
