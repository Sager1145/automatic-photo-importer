import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BrandLogo } from './BrandLogo';
import { bootTiming, createBootController, type BootController, type BootPhase } from './boot-controller';

// Cold start only: once the splash has played (or been skipped) this renderer never shows it again.
let played = false;
let appReady = false;
const readyListeners = new Set<() => void>();
/** The app calls this when its first state has arrived; the splash then finishes. */
export function markAppReady() { appReady = true; for (const listener of readyListeners) listener(); }
export function resetBootForTests() { played = false; appReady = false; readyListeners.clear(); }

const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// html[data-boot]: running (intro/hold), reveal (the app fades up beneath the gliding logo), done. QA waits for done.
const rootState = (phase: BootPhase) => phase === 'done' ? 'done' : phase === 'fly' || phase === 'fade' ? 'reveal' : 'running';

/** Splash above the app while it loads. Shorter than 1.2 s, skippable, and gone once the app is ready or after 2.5 s at most. */
export function Boot() {
  const [reduced] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<BootPhase>(() => played ? 'done' : reduced ? 'hold' : 'intro');
  const logo = useRef<HTMLDivElement>(null);
  const controller = useRef<BootController | undefined>(undefined);
  useLayoutEffect(() => {
    if (played) { document.documentElement.dataset.boot = 'done'; return; }
    document.documentElement.dataset.boot = 'running';
    const instance = controller.current = createBootController({ reduced, onPhase: next => { if (next === 'done') played = true; setPhase(next); } });
    const ready = () => instance.ready();
    readyListeners.add(ready);
    if (appReady) instance.ready();
    return () => { readyListeners.delete(ready); instance.dispose(); };
  }, [reduced]);
  useLayoutEffect(() => { document.documentElement.dataset.boot = rootState(phase); }, [phase]);
  // The logo is 8 px lower than its place when it appears: the card rises by that many pixels, whatever the scale.
  useLayoutEffect(() => {
    const box = logo.current;
    if (box && box.offsetWidth) box.style.setProperty('--rise', String(8 * 1024 / box.offsetWidth));
  }, []);
  // Shared-element glide: the logo moves and shrinks onto the sidebar's real logo.
  // The sidebar settles (fits its sections) right after the first state renders, so the target is read again on every frame:
  // the logo always travels straight to where the sidebar logo really is, and ends exactly on it.
  useLayoutEffect(() => {
    const box = logo.current;
    if (phase !== 'fly' || !box) return;
    const from = box.getBoundingClientRect();
    if (!from.width) return;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const target = document.querySelector('.brand-logo')?.getBoundingClientRect();
      if (!target || !target.width) return;
      const progress = Math.min(1, (now - start) / bootTiming.fly), eased = 1 - (1 - progress) ** 4;
      box.style.transform = `translate(${(target.left - from.left) * eased}px,${(target.top - from.top) * eased}px) scale(${1 + (target.width / from.width - 1) * eased})`;
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    step(start);
    return () => cancelAnimationFrame(frame);
  }, [phase]);
  useEffect(() => {
    if (phase === 'done') return;
    const skip = () => controller.current?.skip();
    window.addEventListener('keydown', skip);
    return () => window.removeEventListener('keydown', skip);
  }, [phase === 'done']);
  if (phase === 'done') return null;
  return <div className="boot" data-boot-splash data-phase={phase} data-mode={reduced ? 'crossfade' : 'full'} aria-hidden="true" onPointerDown={() => controller.current?.skip()} onClick={() => controller.current?.skip()}>
    <div className="boot-logo" ref={logo}><BrandLogo /></div>
  </div>;
}
