// Timeline of the start-up animation, free of React and the DOM so it can be tested with fake timers.
// intro (logo assembles) -> [hold until the first state has arrived] -> fly (logo glides into the sidebar) -> done.
// Reduced motion: wait for the first state, then a plain crossfade. Nothing ever waits past the hard cap.
export const bootTiming = { intro: 900, fly: 300, fade: 150, cap: 2500, stagger: 40 } as const;
export type BootPhase = 'intro' | 'hold' | 'fly' | 'fade' | 'done';

export interface BootController { ready(): void; skip(): void; dispose(): void; readonly phase: BootPhase }

/** Calls onPhase for every change. `ready()` means the first app state has arrived. */
export function createBootController(options: { reduced: boolean; onPhase: (phase: BootPhase) => void }): BootController {
  let phase: BootPhase = options.reduced ? 'hold' : 'intro';
  let isReady = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, run: () => void) => { const timer = setTimeout(() => { timers.delete(timer); run(); }, ms); timers.add(timer); };
  const clear = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
  const go = (next: BootPhase) => {
    if (phase === 'done' || next === phase) return;
    phase = next;
    if (next === 'done') clear();
    options.onPhase(next);
  };
  const advance = () => {
    if (phase !== 'hold' || !isReady) return;
    if (options.reduced) { go('fade'); later(bootTiming.fade, () => go('done')); }
    else { go('fly'); later(bootTiming.fly, () => go('done')); }
  };
  if (!options.reduced) later(bootTiming.intro, () => { if (phase === 'intro') { go('hold'); advance(); } });
  later(bootTiming.cap, () => go('done'));
  return {
    get phase() { return phase; },
    ready() { isReady = true; advance(); },
    skip() { go('done'); },
    dispose() { clear(); phase = 'done'; },
  };
}
