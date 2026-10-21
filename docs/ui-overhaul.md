# Shared photo workbench

The current desktop frontend is React and TypeScript, rendered by Electron on macOS, Linux and Windows. The same bundled Inter font, Lucide icons, component markup, layout and CSS apply on every platform. Native folder and file choosers remain host controls.

## Design and references

A permanent left navigation rail, central source ledger and distinct destination bay make camera-to-library movement visible. Start, Stop and Automatic stay together above every page. A compact dashboard shows connected sources, active/queued jobs, aggregate transfer speed, transferred/planned bytes, checked files, online destinations and free space. Its next-step instruction follows actual readiness. Devices have their own compact rows, capacity strips and per-source actions; destination controls use a separate visual hierarchy rather than repeating generic cards.

### 2026-10-20 visual and motion overhaul

`styles.css` was rewritten on a single Apple-style token layer. It uses the system font stack (SF on macOS, bundled Inter elsewhere), size-specific tracking, opacity-free semantic ink colors that meet 4.5:1 contrast, an 8pt grid, capsule controls and two-layer shadows. The title bar is a translucent material that content scrolls beneath. The sidebar is a source list with a sliding selection pill. Settings is a single column of grouped sections.

Motion covers every interaction:
- Controls press instantly and release on a spring.
- Pages slide in the direction of travel; the sidebar and title bar stay still.
- The selection pill glides between items.
- Sheets, cards, rows, badges and capacity strips animate in.
- Disclosures animate their height.
- The title bar lifts and sections fade up as the page scrolls.
- Scrolling past an edge uses the native macOS elastic bounce (Electron `scrollBounce`).

Reduced motion removes all of this, keeping instant state changes. Reduced transparency, increased contrast and forced colors have dedicated fallbacks.

The layout borrows the source / review / destination hierarchy from [Lightroom Classic](https://helpx.adobe.com/lightroom-classic/help/import-photos-video-catalog.html), the places / folders / file list / preview structure of [darktable](https://darktable-org.github.io/dtdocs/en/module-reference/utility-modules/lighttable/import/), and the explicit camera and storage source categories in [digiKam](https://docs.digikam.org/en/import_tools/import_overview.html). The app uses its own icon, palette, copy and components.

Coral is the default accent, matching the app icon. Ocean and forest are alternatives. System, light and dark appearance preferences are persisted through the desktop API. CSS semantic colors separately control backgrounds, surfaces, borders, text, selection, successful verification and errors. The interface uses no ambient animation; reduced-motion and increased-contrast media queries are included.

## Implemented surfaces

- Native macOS traffic-light controls, with shared minimize/maximize/close controls on the other platforms. Dragging is enabled in titlebar and heading areas, with interactive controls excluded.
- Persistent navigation for Import desk, Organization, History and Settings, with appearance controls and a source count.
- Start imports, Stop, Automatic, photo metadata preview and refresh controls. Keyboard shortcuts support Command / Control + R and Shift + Command / Control + S.
- Source ledger with device type, status, queue position, real capacity, progress, file counts, speed, stop / recheck actions and errors. Parallel-source concurrency uses a 1–5 slider.
- Destination selection, first / second copy destinations, copy policy, capacity and online / offline health, location changes and file-manager reveal actions.
- Every-file drive / folder backup and optional media-folder import.
- Real source inventories with type filtering, filename search, included / ignored status, companion labels and filename buttons that open metadata inspection. The visible table caps at 500 matching rows to bound rendering work; searching narrows the displayed set.
- Unknown-file rules in inventory and Organization. Session or remembered rules call the desktop API. Saved rules show their extension and destination folder or Ignore policy.
- Organization with folder presets, custom token template, format separation, example output path, location selection and source preferences. Text preferences save on blur or Enter. The folder preview is explicitly labeled as an example rather than runtime file data.
- Reviewed import and library-reorganization plans with actual source paths, destination paths, checksums, action labels, counts and bytes. Search and 100-row pagination keep every reviewed entry reachable. Copy reviewed files / Apply reviewed moves and Discard are explicit actions.
- Session-history timeline with details, timestamps and status glyphs.
- Modal photo / EXIF inspection, image preview when returned by the adapter, camera, capture date, shutter count / note and searchable full metadata. Native dialog behavior provides focus containment and Escape dismissal.

All device, job, inventory, capacity, history and metadata content comes from `window.importer`. There are no mock jobs, capacity values or fixture imports in the renderer. Actual copying, metadata extraction, routing, persistence and source discovery remain behind the typed desktop bridge.

## Source files

- `desktop/renderer/RootApp.tsx`: components and desktop API integration.
- `desktop/renderer/styles.css`: shared layout, controls, semantic colors, responsive rules and accessibility alternatives.
- `desktop/renderer/main.tsx`, `index.html`, `vite-env.d.ts`: React entry and build types.
- `desktop/renderer/public/fonts/InterVariable.ttf` and `OFL.txt`: bundled font and license.
- `desktop/renderer/public/icon.png`: app icon used in the shared frontend.

The earlier SwiftUI `MainView.swift` redesign was removed with the rest of the superseded SwiftUI app (see [historical implementation](legacy-implementation.md)).

## Validation and limits

`npm run typecheck` and `npm run build` pass. Production CSS resolves the font to `../fonts/InterVariable.ttf`, with the font and license copied into the output. The Vite configuration emits an advisory about its future native config-loader default; it does not prevent the build.

Runtime, visual, keyboard-only and screen-reader validation are performed by the integrating agent. No app installation, UI automation, hardware imports or running-process changes were performed by the renderer worker.

The shared desktop contract now supplies reviewed plans and explicit preview / apply / discard actions. Source Review buttons build a plan without copying. Organization exposes existing-library reorganization in single-destination mode. While a review is pending, Start and destination / folder settings are disabled; Stop or Cancel review can cancel preparation. The reviewed plan is rendered directly from backend state. Backend integration and filesystem regression validation remain the integrating agent’s responsibility.

## Readability settings

Text defaults to 125%, with a live 100–150% slider in Settings. Small captions have a larger base size, and the navigation rail is wider to accommodate readable labels. Settings also includes System/Light/Dark appearance, accents, Automatic import and the parallel-source limit. Preferences save automatically.
