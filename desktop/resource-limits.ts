import * as os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';

/** The one place that knows how much CPU and memory the app may use. Everything that sizes a pool or a buffer reads it
 * here; the settings (preferences.maxCpuThreads, memoryLimitMB) are the source and take effect for the next job. */
export const MB = 1024 * 1024;
export interface Host { cores: number; totalMemBytes: number }
export interface Limits { maxCpuThreads: number; memoryLimitMB: number }
export const hostNow = (): Host => ({ cores: os.availableParallelism(), totalMemBytes: os.totalmem() });

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const totalMB = (host: Host) => host.totalMemBytes / MB;

/** Threads: 1 up to every core. */
export const cpuRange = (host: Host = hostNow()) => ({ min: 1, max: Math.max(1, Math.floor(host.cores)) });
/** Memory: 512 MB up to 75% of the machine's memory (never below the minimum). */
export const memoryRange = (host: Host = hostNow()) => ({ min: 512, max: Math.max(512, Math.floor(totalMB(host) * 0.75)) });
/** Half the cores, at least two (one on a single-core machine): 5 on a 10-core Mac. */
export const defaultCpuThreads = (host: Host = hostNow()): number => clamp(Math.max(2, Math.floor(host.cores / 2)), cpuRange(host).min, cpuRange(host).max);
/** A quarter of the memory, at most 2 GB, in steps of 256 MB. */
export const defaultMemoryLimitMB = (host: Host = hostNow()): number => {
  const { min, max } = memoryRange(host);
  return clamp(Math.round(Math.min(2048, totalMB(host) * 0.25) / 256) * 256, min, max);
};
export const defaultLimits = (host: Host = hostNow()): Limits => ({ maxCpuThreads: defaultCpuThreads(host), memoryLimitMB: defaultMemoryLimitMB(host) });
export function clampCpuThreads(value: unknown, host: Host = hostNow()): number {
  const number = Number(value);
  return value === null || value === '' || !Number.isFinite(number) ? defaultCpuThreads(host) : clamp(Math.round(number), cpuRange(host).min, cpuRange(host).max);
}
export function clampMemoryLimitMB(value: unknown, host: Host = hostNow()): number {
  const number = Number(value);
  return value === null || value === '' || !Number.isFinite(number) ? defaultMemoryLimitMB(host) : clamp(Math.round(number), memoryRange(host).min, memoryRange(host).max);
}

let current: Limits = defaultLimits();
export const resourceLimits = (): Readonly<Limits> => current;
/** Apply new limits (each clamped to this host); fields not given keep their value. */
export function setResourceLimits(patch: Partial<Limits>, host: Host = hostNow()): Limits {
  current = {
    maxCpuThreads: patch.maxCpuThreads === undefined ? current.maxCpuThreads : clampCpuThreads(patch.maxCpuThreads, host),
    memoryLimitMB: patch.memoryLimitMB === undefined ? current.memoryLimitMB : clampMemoryLimitMB(patch.memoryLimitMB, host),
  };
  return current;
}
/** Workers for a pool that would like `cap`: never more than the thread limit, never fewer than one. */
export const cpuWorkers = (cap: number): number => Math.max(1, Math.min(current.maxCpuThreads, Math.floor(cap) || 0));
export const memoryBudgetBytes = (): number => current.memoryLimitMB * MB;
/** Structures are designed for the 2 GB default; at another budget they grow or shrink in proportion, within [min, max]. */
export const DESIGN_BUDGET_MB = 2048;
export const scaledByBudget = (base: number, min: number, max = Infinity): number => clamp(Math.round(base * current.memoryLimitMB / DESIGN_BUDGET_MB), min, max);
/** libuv threads mostly wait on the disk, so twice the thread limit, between 4 and 16 (the pool's fixed ceiling in threadpool.ts). */
export const uvThreadpoolSize = (maxCpuThreads: number): number => clamp(Math.floor(maxCpuThreads) * 2, 4, 16);

/** The limits in saved preferences, by the one rule both the thread pool (before anything starts) and normalizePreferences use:
 * a limit that is not saved is left out; any other value is clamped to this host, and an unreadable one becomes its default. */
export function savedLimits(preferences: unknown, host: Host = hostNow()): Partial<Limits> {
  const saved = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>;
  return {
    ...(saved.maxCpuThreads == null ? {} : { maxCpuThreads: clampCpuThreads(saved.maxCpuThreads, host) }),
    ...(saved.memoryLimitMB == null ? {} : { memoryLimitMB: clampMemoryLimitMB(saved.memoryLimitMB, host) }),
  };
}

/** V8 heap ceiling for the read-only scan process: half the memory budget, at least 1 GB (a large card's listing must fit). The renderer is left alone: a heap flag there could crash the interface. */
export const scanHeapMB = (): number => Math.max(1024, Math.floor(current.memoryLimitMB / 2));

/** A soft memory governor: above 90% of the limit it stops admitting new files into the copy, verify and metadata
 * pipelines until usage drops (backpressure only; running work is never cancelled). Above 100% it also reports once
 * per episode. With nothing in flight the next file is always admitted, so work can never stall. */
export class MemoryGovernor {
  paused = false;
  private active = 0;
  private warned = false;
  private waiting: { grant: () => void }[] = [];
  private timer?: ReturnType<typeof setInterval>;
  /** Work started inside governed work (a copy that hashes its file) is part of it and never waits again: that could deadlock. */
  private inside = new AsyncLocalStorage<true>();
  constructor(private readonly options: { usage: () => number; limit: () => number; onWarn?: (usageMB: number, limitMB: number) => void; onChange?: (usageMB: number, limitMB: number) => void }) {}
  /** Listen to the governor (the main process shows memory use and the over-limit warning). */
  observe(handlers: { onWarn?: (usageMB: number, limitMB: number) => void; onChange?: (usageMB: number, limitMB: number) => void }): void { Object.assign(this.options, handlers); }
  /** Look at memory now: pause, resume and warn as needed. */
  check(): void {
    const usage = this.options.usage(), limit = this.options.limit(), ratio = usage / limit;
    this.options.onChange?.(usage / MB, limit / MB);
    if (ratio >= 0.9) this.paused = true;
    else { this.paused = false; this.warned = false; this.wake(); }
    if (ratio >= 1 && !this.warned) { this.warned = true; this.options.onWarn?.(Math.round(usage / MB), Math.round(limit / MB)); }
  }
  start(everyMs = 3000): void { this.stop(); this.timer = setInterval(() => this.check(), everyMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.paused = false; this.wake(); }
  private wake(): void {
    if (!this.paused) { while (this.waiting.length) this.waiting.shift()!.grant(); }
    else if (this.active === 0) this.waiting.shift()?.grant();
  }
  /** Run one unit of pipeline work (a file's copy, hash or metadata read), waiting first while memory is above 90%. */
  async govern<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.paused && this.active > 0 && !this.inside.getStore()) {
      await new Promise<void>((resolve, reject) => {
        const entry = { grant: () => { signal?.removeEventListener?.('abort', stop); resolve(); } };
        const stop = () => { const at = this.waiting.indexOf(entry); if (at >= 0) { this.waiting.splice(at, 1); reject(new DOMException('Import stopped', 'AbortError')); } };
        if (signal?.aborted) { reject(new DOMException('Import stopped', 'AbortError')); return; }
        this.waiting.push(entry);
        signal?.addEventListener?.('abort', stop, { once: true });
      });
    }
    this.active++;
    try { return await this.inside.run(true, work); } finally { this.active--; if (this.paused && this.active === 0) this.wake(); }
  }
}
/** Extra memory held by child processes (the scan worker), supplied by the main process. */
let childMemory: () => number = () => 0;
export const setChildMemory = (read: () => number): void => { childMemory = read; };
/** This process's memory: the private bytes Electron measures (`process.getProcessMemoryInfo()`, in KB) when known, else RSS, which also counts shared and file-backed pages. */
export const privateOrRss = (info: { private?: number } | undefined, rss: number): number => info && Number.isFinite(info.private) && info.private! > 0 ? info.private! * 1024 : rss;
/** Memory of the helper processes the governor counts (the scan worker): utility processes only, by private bytes when the platform reports them. The renderer is left out: its working set includes shared pages and would throttle imports early. */
export const childProcessMemory = (metrics: { type: string; memory: { workingSetSize: number; privateBytes?: number } }[]): number => metrics.filter(item => item.type === 'Utility').reduce((sum, item) => sum + (item.memory.privateBytes || item.memory.workingSetSize) * 1024, 0);
let mainMemory: () => number = () => process.memoryUsage().rss;
export const setMainMemory = (read: () => number): void => { mainMemory = read; };
export const governor = new MemoryGovernor({ usage: () => mainMemory() + childMemory(), limit: memoryBudgetBytes });

/** At most cpuWorkers-style `cap()` calls at once, the rest queue in order (used for thumbnail decoding). A slot passes straight to the next waiter. */
export function limiter(cap: () => number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const queue: (() => void)[] = [];
  return async work => {
    if (running >= Math.max(1, cap())) await new Promise<void>(resolve => queue.push(resolve)); else running++;
    try { return await work(); } finally { const next = queue.shift(); if (next) next(); else running--; }
  };
}
