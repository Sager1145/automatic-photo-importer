# Motion audit

Every user operation and state change in the renderer (`desktop/renderer/RootApp.tsx`, `styles.css`), what it changes on screen, the motion it had before this pass, and the motion it has now.

## The motion system

One vocabulary, defined once in `:root` in `styles.css` and read by JavaScript through `motionMs()`:

| Token | Value | Used for |
| --- | --- | --- |
| `--press` | 120 ms | press-down scale on buttons, chips, segments |
| `--quick` | 180 ms | colour and background changes, exits (sheets, toasts, outgoing page) |
| `--base` | 240 ms | entrances, crossfades, disclosures, every view-transition group |
| `--slow` | 300 ms | incoming page slide, progress fill, capacity strips |
| `--spring` / `--spring-duration` | sampled spring (bounce ≈ 0.15), 520 ms tail, visually settled by ≈ 250 ms | switch thumb, press release, nav indicator, icon pops |
| `--ease-out` | `cubic-bezier(.23,1,.32,1)` | fades and colour |
| `--ease-ios` | `cubic-bezier(.32,.72,0,1)` | movement (slides, morphs, height) |

Four mechanisms, each with one job:

1. **`animateInterfaceChange(change, kind)`**: wraps a DOM change in a View Transition. Kinds:
   - `forward` / `back`: page slides in the direction of travel (sidebar).
   - `category-forward` / `category-back`: the Settings panel rises or falls into place while the selection capsule glides between categories.
   - `layout`: cards and rows (`.source-row`, sidebar drives, drive list rows, destination slots, the overview, the review panel) morph to their new size and place; things that appear fade in, things that leave fade out where they were.
   - `crossfade`: everything dissolves in place (theme, accent, language, inventory selection, review pages).
2. **`interfaceChangeKind(previous, next)`**: decides which state updates from the importer are interface swaps. Only structural changes animate (sources added, removed or reordered; layout, overview, destinations, copy policy, review opening or closing; theme, accent, language). Progress ticks never start a transition.
3. **CSS transitions with `@starting-style`**: entrances of anything that appears inside a page (notices, progress blocks, rows, badges), plus colour and transform changes. They retarget smoothly when interrupted.
4. **`useAnimatedClose(ref, onClose)`**: exits for elements React would otherwise remove at once (sheets, the error toast).

Rules: durations stay between 120 and 300 ms (the spring's long tail is imperceptible); only `transform`, `opacity`, colour and the View Transition snapshots move, so nothing re-lays out per frame; a new transition skips the running one, so every change is interruptible; the transition overlay ignores the pointer, so a click during a transition reaches the live control underneath; an exit that is overtaken by new content (a new issue for the toast, a new drive for the prompt) is cancelled and the element stays; `prefers-reduced-motion: reduce` turns off all of the above: no View Transitions, no WAAPI, CSS durations zeroed.

Deliberately not animated: direct manipulation (sliders, typing in search fields, the text-size slider, drag-resizing the window), where the interface must follow the hand without lag; repeating numbers (speed, counts, percentages), which use tabular figures and update in place so they stay readable.

## Inventory

"Before" is the state at `a96183a`. "Now" is this branch.

### Navigation

| Operation | What changes | Before | Now |
| --- | --- | --- | --- |
| Sidebar page switch (Import desk, Drives, Organization, History, Settings) | Main content, titlebar title, nav selection | View Transition: page slides 40 px in the direction of travel, title rises, nav capsule morphs. Durations 200/420 ms, hard-coded | Same choreography on tokens (`--quick` out, `--slow` in, nav capsule on the spring) |
| Settings category switch (click, arrow keys, Home/End) | Panel content, tab selection, focus | CSS keyframe on the new panel only; selection background jumped | `category-forward/back` transition: panel slides 12 px vertically in list order, selection capsule glides between tabs, focus moves inside the transition |
| Sidebar source link (jump to card) | Page may switch to Import desk, scrolls card into view, ring flash | Page slide, then a fixed 450 ms timer before scrolling | Scroll and ring wait for the page transition to finish (no magic timer); the ring fades over three `--slow` beats so it is noticed after the scroll; reduced motion jumps without the ring |
| History empty state "Go to import desk" | Page switch | Page slide | Page slide |
| Organization / Settings buttons in the destination bay | Page switch | Page slide | Page slide |

### Import desk

| Operation | What changes | Before | Now |
| --- | --- | --- | --- |
| Hide or show the Import overview | Overview removed or added; cards shift | None: everything jumped | `layout`: overview fades in place, cards glide up or down |
| List / grid layout switch | Cards reflow into one or two columns | FLIP translate only: card widths snapped | `layout`: each card morphs position and size |
| Source card appears (drive connected, folder chosen) | New card, sidebar row, drive list row | `@starting-style` rise | `layout`: card fades in while neighbours glide to make room; sidebar row the same |
| Source card disappears (drive removed) | Card and sidebar row removed | None: removed at once, neighbours glided (FLIP) | `layout`: card fades out where it was while neighbours close the gap |
| Move to top / queue reorder | Card order | FLIP glide (480 ms, hard-coded) | `layout` morph on tokens; sidebar and drive list follow the same order |
| Select / deselect a drive (chip) | Chip state, card dashed and dimmed, sidebar row dimmed | Chip colour transition; card dim jumped | Chip colour plus icon pop; card background, border and dim crossfade (`--base`) |
| Scan media / Scan all | Button spinner, scan progress block, step 1 active | Spinner, `@starting-style` on progress | Same; button icon swap pops |
| Scan / copy progress | Bar fill, counts, speed | Bar fill transitions; numbers update in place | Same (numbers deliberately static) |
| Import / Pause / Continue / Stop on a card | Action buttons swap, status text | Buttons and status jumped | Swapped buttons and icons pop in (`--spring`); status text fades up in place |
| Step completes (Scanning → Copying → Verifying) | Step marks | Check mark pops; connector colour transitions | Same |
| Import completes / Already imported | Status, calm progress block | `@starting-style` on progress | Same, plus status text fade |
| Card error | Red border, status, error badge in titlebar | Border transition; badge pops | Same |
| New-drive choice on a card | Inline choice block | `@starting-style` rise | Same |
| Drive details disclosure | Height, chevron | Height animates (`::details-content`), chevron rotates | Same, on tokens |
| Inventory: choose another source's files | Inventory panel content | None | `crossfade` |
| Inventory: filter / search | Table rows | None | None (typing; direct manipulation) |
| Inventory: other-file rules toggle | Rules editor | `@starting-style` rise | Same |
| Parallel sources slider | Limit text | None | None (direct manipulation) |
| Titlebar Start ↔ Pause, Automatic on/off | Button label and icon | Colours transition; icon jumped | Icon pops in on swap |
| Refresh (⌘R) / Start (⇧⌘S) shortcuts | State refresh | None | None (keyboard, high frequency) |

### Organization

| Operation | What changes | Before | Now |
| --- | --- | --- | --- |
| Organization card appears in Sources & queue | New card | `@starting-style` | `layout` with the other cards |
| Pause / Resume / Stop an organization | Buttons, status, bar | Jumped | Icon pops, status fades in place, bar keeps its transition |
| Organizing now card | Card appears/disappears | `@starting-style` entrance | Same |
| Destination picker (two destinations) | Paths, folder scope | None | `crossfade` |
| Review changes… / review opens | Review panel at the top of the page | `@starting-style` | `layout`: panel fades in, page content glides down |
| Apply / Discard review | Review panel removed | None: page jumped | `layout`: panel fades out, content glides up |
| Review table pages (Previous / Next) | Table rows | None | `crossfade` |
| Backup folder check mode | Segmented selection, note | Colour transition | Same |
| Misplaced files found / in order | Status line | `@starting-style` | Same |
| Recovery list: Resume, Recheck, Refresh | Rows | Rows rise in | Same |
| Undo / Release originals | Confirm sheet | Sheet animates in and out | Same |

### Sheets, dialogs, toasts

| Operation | What changes | Before | Now |
| --- | --- | --- | --- |
| All errors panel open / close | Modal sheet, backdrop | `@starting-style` in, WAAPI out (220 ms) | Same, durations from tokens |
| Error group "Show drive" | Sheet closes, page may switch, card flashes | Sheet out, page slide | Same |
| Error details disclosure | Height | None (not in the disclosure list) | Height animates like every other `<details>` |
| New drive prompt open / answered / auto-close | Sheet, row states, unplugged badge | In: animated; Escape/close: animated; auto-close after answers: vanished | Auto-close now plays the same exit |
| Metadata sheet open / close | Sheet | Animated | Same, tokens |
| All metadata disclosure | Height, chevron | Animated | Same |
| Release originals confirm | Sheet | Animated | Same |
| Error toast appears | Toast | `@starting-style` rise | Same |
| Error toast dismissed or times out | Toast | Vanished | Falls away the way it came (`--quick`) |
| Error count changes | Badge | Pops | Same |

### Settings

| Operation | What changes | Before | Now |
| --- | --- | --- | --- |
| Switches (all) | Thumb, track colour | Spring thumb, colour fade | Same |
| Segmented controls (folder order, month names, unknown files, backup mode, backup check, appearance) | Pressed segment | Colour fade + press scale | Same (the pressed segment cannot slide without an extra element per control; the colour fade is the Apple pattern for small segments) |
| Media layout presets | Selected card, radio dot | Colour fade, dot jumped | Dot pops in on the spring |
| Folder path builder: month/day options appear | Extra options row | None | `@starting-style` rise |
| Video backup folder fields (A separate video backup folder) | Extra section | None | `@starting-style` rise |
| Advanced custom template disclosure | Height | None | Height animates |
| Destination chosen / changed / removed, copy policy | Destination slots | None | `layout`: slots morph, new slot fades in, removed slot fades out |
| Remembered / ignored drives: Forget, Stop ignoring | Rows | Rows rise in; removal jumped | Same entrance; removal falls back to the page crossfade of the next state (no structural transition, low frequency) |
| Saved file rules: Edit / Save rule | Editor, rows | `@starting-style` | Same |
| Settings locked notice | Notice | `@starting-style` | Same |
| Language | All text | None | `crossfade` across the whole window |
| Appearance Light / Dark / System, and OS theme change | Every colour | None: hard cut | `crossfade` across the whole window |
| Accent colour | Accent colours, check mark | None | `crossfade`; check mark pops |
| Text size slider | Type scale, layout | Live | Live (direct manipulation, no animation) |
| Reset text size | Type scale | None | Live (rare; follows the slider's behaviour) |
| Show the import overview switch | Overview on the desk | None | Switch animates; the desk updates without motion because it is off-screen |

### History

| Operation | What changes | Before | Now |
| --- | --- | --- | --- |
| New history entry | Row at the top | Row rises in | Same |
| Empty state ↔ first entry | Empty card replaced by the list | None | Empty card rises in like other cards |

### Window

| Operation | What changes | Before | Now |
| --- | --- | --- | --- |
| Resize between compact and wide (container queries) | Column count, button labels collapse to icons, settings tab strip | Instant reflow | Instant reflow (live resize must follow the pointer); scroll-driven titlebar shadow unchanged |
| Scroll | Titlebar hairline, sections reveal | Scroll-driven | Same |

## Layers

Static stacking, bottom to top: page content (cards are `position: relative`, the destination bay and Settings list are sticky at `z-index: auto`), the sidebar (`z-index: 30`), the titlebar (`40`), the error toast (`60`), then sheets in the top layer.

During a View Transition every named element becomes a group drawn above everything unnamed, in paint order, and outside any clipping ancestor. Rules that keep each layer where it belongs:

| Layer | Problem it had | Rule |
| --- | --- | --- |
| Sidebar and Settings selection capsules | The gliding capsule was drawn over its own label (sidebar hid it with a blend mode) | Labels and icons get their own groups, so the capsule passes beneath them |
| Settings selection capsule in a narrow window | The strip scrolled sideways; the capsule escaped the strip's clipping and drew over the last visible tab | The strip wraps onto more rows instead of scrolling |
| Titlebar | Its blur cannot be captured, so moving content showed through; its scroll shadow widened the old snapshot and drew the old buttons 20 px low | Opaque background and no scroll shadow while a transition runs |
| Error toast | Unnamed, so it was flattened into the bottom snapshot and sank under the page | Its own group, drawn last |
| Sheets (All errors, metadata, confirmations, new drives) | A layout change arriving under an open sheet lifted the page above the backdrop | No transition runs while a sheet is open; the change applies directly |

Reduced motion runs no View Transitions, so none of these groups exist; the static order above is all there is.

Checked by the Electron QA "Transitions keep each layer in place" (records each transition's layers and that none runs under an open sheet).

## Reduced motion

`prefers-reduced-motion: reduce` (or `--force-prefers-reduced-motion` in QA):

- `animateInterfaceChange` applies the change directly with no View Transition.
- `useAnimatedClose` closes at once.
- CSS sets every transition and animation duration to 0 and removes the scroll-driven effects; the indeterminate bar becomes a steady fill.

Covered by `desktop/tests/motion.test.ts` (the helper and the state classifier) and the Electron QA check "Every page and Settings category switch animates through the motion helper" (`npm run codex:test`, and with `-- --reduced-motion`).
