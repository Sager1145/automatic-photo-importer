# Library browser

Open **Library browser** in the sidebar and choose a configured photo or video library. **Refresh index** reads the library into a local, rebuildable catalog. The status shows indexing progress, known details and placement coverage. An offline library keeps its indexed details; reconnect its drive to load previews or refresh it.

In **Categories**, select rows to narrow the next columns. Command/Ctrl-click adds alternatives within a column; different columns narrow the result together. The virtual hierarchy always ends in Files. Use the block palette to add Date, Name, Format, Camera, Lens, Focal length, Aperture, Shutter speed or ISO. Drag a palette block into the path, drag existing blocks to reorder, or use **Insert at position**, the Add buttons, **Move earlier**, **Move later** and **Remove block** with the keyboard. Repeated fields have independent selections.

Select a path block to configure it. Dates support year, month including year, or day and safe display tokens (`YYYY`, `MM`, `DD`). Names group by first character or full name; formats group by extension or media kind. New Aperture, Shutter speed and ISO blocks start with standard photographic stop buckets. Labels use f-numbers, ISO values and shutter fractions such as `1/125 s`. Switch **Numeric grouping** to **Exact values** to see intermediate values recorded by the camera, or edit **Bucket boundaries** and enter a custom range. Shutter boundaries and ranges accept fractions such as `1/125`; ISO inputs accept `ISO 400`. Existing saved views retain their grouping choices.

New **Aperture**, **ISO** and **Shutter speed** blocks, including built-in presets, start with standard-stop ranges. Aperture boundaries run from f/1 to f/32; ISO uses doubling steps from ISO 50 to ISO 102400; shutter boundaries use nominal photographic durations from 1/8000 s to 30 s, including exact fractions such as 1/125 s and 1/60 s. Range labels show their edges explicitly, for example **≥ f/2.8 – < f/4** or **≥ 1/125 s – < 1/60 s**. Empty ranges are hidden unless selected. Shared boundaries belong to the following range, so no capture is counted twice.

Choose **Exact values** to see the recorded values, including intermediate settings such as f/1.8, ISO 125 and 1/160 s. Values are never rounded or reassigned to a nominal stop. The boundary editor accepts and displays photographic labels such as `f/2.8`, `ISO 400`, `1/125 s` and `2 s`. Previously saved views and custom preset boundaries keep their existing settings; adding a new block or choosing a built-in preset uses the new defaults.

**Browser presets** in the sidebar includes single-field and multi-field views. Enter a name and choose **Save current view** to save the entire hierarchy and its options. Rename or delete a custom preset using its adjacent controls. Presets and the current view persist locally when the app restarts. **Restore default view** restores the default hierarchy.

**Real folders** follows existing directories. Selecting a file opens its thumbnail and indexed details; **Full EXIF** reads further tags on request. Arrow keys navigate the lists, Space selects/previews, and Escape closes the preview or clears a selection. The column separator adjusts column width.

Browsing and hierarchy editing do not change media bytes, formats, EXIF, names or paths, create classification folders, or change organization preferences. **Open organization tool** only navigates to the separate organization page. Review and apply any physical reorganization there.

The SQLite catalog and thumbnail/browser caches live in local application data. Indexing a large existing library takes time; results show current coverage. Removing or corrupting a catalog requires reindexing, rather than changing originals.
