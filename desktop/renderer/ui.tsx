import { flushSync } from 'react-dom';
import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { Trash2, type LucideIcon } from 'lucide-react';
import type { Action } from '../shared';
import { useTranslation } from './i18n';

/** The controls, sheets and motion every renderer page shares. */
export type Dispatch = (action: Action) => void;
export function Icon({ icon: IconComponent, size = 18, className = '' }: { icon: LucideIcon; size?: number; className?: string }) {
  return <IconComponent size={size} strokeWidth={1.8} aria-hidden="true" className={className} />;
}
export function Button({ children, icon, kind = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon; kind?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  return <button type="button" className={`button button-${kind} ${children === undefined || children === null || children === false ? 'button-icon-only' : ''} ${className}`} {...props}>{icon && <Icon icon={icon} />}{children}</button>;
}
export function CardHeader({ icon, title, id, detail, children }: { icon: LucideIcon; title: string; id?: string; detail?: ReactNode; children?: ReactNode }) {
  return <div className="card-header"><span className="card-icon"><Icon icon={icon} size={17} /></span><div className="card-title"><h3 id={id}>{title}</h3>{detail && <p>{detail}</p>}</div>{children && <div className="card-actions">{children}</div>}</div>;
}
// Motion: one set of durations and curves, defined in styles.css (:root) and read here. See docs/motion-audit.md.
export function reducedMotion(): boolean { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
export function motionToken(name: '--quick' | '--base' | '--slow' | '--ease-ios'): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
export const motionMs = (name: '--quick' | '--base' | '--slow') => parseFloat(motionToken(name)) || 0;
/** Pages slide in the direction of travel, Settings panels rise or fall, cards morph to their new place, everything else crossfades. */
export type InterfaceChange = 'crossfade' | 'layout' | 'forward' | 'back' | 'category-forward' | 'category-back';
export let interfaceTransition: ViewTransition | undefined;
// DOM order does not reflect the top layer: an automatic prompt can open over
// metadata even though its element occurs earlier in the tree.
export const sheetOrder = new WeakMap<HTMLDialogElement, number>();
let sheetSequence = 0;
/** Runs a DOM change as a View Transition; a newer change skips the running one, and reduced motion applies it directly. */
export function animateInterfaceChange(change: () => void, kind: InterfaceChange = 'crossfade') {
  interfaceTransition?.skipTransition();
  // While a sheet or an error message is up the page changes without a transition: a transition's snapshots
  // would be drawn above the sheet's backdrop, and it takes every click and hit test away from the error message.
  if (!document.startViewTransition || reducedMotion() || document.querySelector('dialog[open], [data-error-layer]:popover-open')) { change(); return; }
  document.documentElement.dataset.transition = kind;
  const transition = interfaceTransition = document.startViewTransition(() => flushSync(change));
  void transition.finished.catch(() => {}).then(() => { if (interfaceTransition === transition) { interfaceTransition = undefined; delete document.documentElement.dataset.transition; } });
}
export const interfaceSettled = () => interfaceTransition?.finished.catch(() => {}) ?? Promise.resolve();
// A sheet opened mid-transition would render beneath the page snapshots, so finish the transition first.
// Errors are always on top: a sheet that opens over an error surface (the toast, All errors) is put back beneath it.
export function showSheet(dialog: HTMLDialogElement | null) {
  interfaceTransition?.skipTransition();
  if (dialog) { dialog.showModal(); sheetOrder.set(dialog, ++sheetSequence); }
  for (const error of document.querySelectorAll<HTMLElement>('[data-error-layer]')) {
    if (error === dialog) continue;
    if (error instanceof HTMLDialogElement) { if (error.open) { error.close(); error.showModal(); sheetOrder.set(error, ++sheetSequence); } }
    else if (error.matches(':popover-open')) { error.hidePopover(); error.showPopover(); }
  }
}
/** Plays the exit of something React is about to remove (a sheet, the toast), then removes it. onClose returns false when new content arrived meanwhile: the element then stays, fully shown. */
export function useAnimatedClose(element: RefObject<HTMLElement | null>, onClose: () => void | false) {
  const closing = useRef(false);
  return useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const done = () => { closing.current = false; if (onClose() === false) for (const animation of element.current?.getAnimations() ?? []) animation.cancel(); };
    const node = element.current;
    if (!node || reducedMotion()) { done(); return; }
    const animation = node.animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY(10px) scale(.97)'}],{duration:motionMs('--quick'),easing:motionToken('--ease-ios'),fill:'forwards'});
    void animation.finished.catch(() => {}).then(done);
  },[element,onClose]);
}
/** The skeleton every confirmation shares: a sheet with a title, a body and Cancel / danger buttons. A 'second' step opens with Cancel focused, so Return never confirms by accident. */
export function ConfirmSheet({ step, title, confirmLabel, confirmDisabled, testId, confirmTestId, onCancel, onConfirm, children }: { step?: 'first' | 'second'; title: string; confirmLabel: string; confirmDisabled?: boolean; testId: string; confirmTestId?: string; onCancel: () => void; onConfirm: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null), heading = useId();
  const close = useAnimatedClose(dialog, onCancel);
  useEffect(() => { const element = dialog.current; showSheet(element); if (step === 'second') element?.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus(); return () => element?.close(); }, [step]);
  return <dialog className="activity-dialog confirm-dialog" ref={dialog} aria-labelledby={heading} data-testid={testId} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-heading"><h2 id={heading}>{title}</h2></div>
    <div className="activity-content">{children}</div>
    <div className="dialog-footer">{step === 'second' ? <Button autoFocus data-autofocus onClick={close}>{t("Cancel")}</Button> : <Button onClick={close}>{t("Cancel")}</Button>}<Button kind="danger" icon={Trash2} data-testid={confirmTestId} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button></div>
  </dialog>;
}
export function ReleaseConfirm({ size, root, onCancel, onConfirm }: { size: string; root: string; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  return <ConfirmSheet title={t("Release {size}?", { size })} confirmLabel={t("Release {size}", { size })} testId="release-confirm" onCancel={onCancel} onConfirm={onConfirm}><p>{t("This deletes the kept originals. Undo won't be possible.")}</p><p className="recovery-root">{root}</p></ConfirmSheet>;
}
/** Deleting recovery files asks twice: the first sheet says undo goes away and how much is freed, the
 * second asks again with the exact amount, Cancel focused. Only confirming the second deletes. */
export type DeleteRecoveryStep = 'closed' | 'first' | 'second';
export function nextConfirmStep(step: DeleteRecoveryStep, choice: 'open' | 'confirm' | 'cancel'): { step: DeleteRecoveryStep; delete: boolean } {
  if (choice === 'cancel') return { step: 'closed', delete: false };
  if (choice === 'open') return { step: step === 'closed' ? 'first' : step, delete: false };
  if (step === 'first') return { step: 'second', delete: false };
  return { step: 'closed', delete: step === 'second' };
}
