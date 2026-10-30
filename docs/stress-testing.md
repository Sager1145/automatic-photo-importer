# Stress and edge-case testing — 2026-10-22

## Summary

A new edge-case suite runs in `npm test`. A new opt-in stress suite runs with `npm run test:stress`. Together they exercise scale, the full media mix, metadata, layouts, failure modes, organization and crash recovery on synthetic fixtures. Every fixture lives in its own temporary folder or private disk image; no real card or drive was touched.

The results below come from `architecture-review-3` (`65b8d30`) merged into this branch, which includes the parallel copy engine from `claude/import-speed`.

- Before the merge, the suites found two bugs that could stop a file from being imported. Both are fixed, each with a regression test (see [Bugs fixed](#bugs-fixed)).
- On the merged code, all 11 stress tests pass. `npm test` passes 575 of 576 tests. The one failure, an exFAT test that came in with the merge, is listed under [Open failures](#open-failures) and not fixed here.
- No test lost, overwrote or corrupted a file.
- The slowest work is organizing in place: about 100 ms per file on APFS. Importing to exFAT is also slow, at about 460 ms per file (see [Known limits](#known-limits)).

## How to run

| Command | What | Time on the test Mac |
|---|---|---|
| `npm test` | Whole backend suite, including the new `edge-*.test.ts` files and the extended `process-crash.test.ts` | 55 s (576 tests) |
| `npm run test:stress` | `desktop/stress/*.stress.ts`; sizes scale with `STRESS_SCALE` (default `1`) | 26.6 min at scale 1 |
| `npm run codex:test -- --no-build --large=N` | Electron smoke test with N misplaced media files seeded into the first destination | not timed in this run |

Notes:
- The native camera bridge needs `IMPORTER_NATIVE_BRIDGE` set for `npm test`.
- The stress suite prints `STRESS {...}` lines and appends them to `build/stress-timings.jsonl`.
- Run the two suites one after the other, not at the same time. Together they need a few GB of free space.

## What was tested

| Area | Where | Result |
|---|---|---|
| Every listed extension in either case, filed by format in all six layouts | `edge-media`, stress | Pass |
| Companions and proxies of every camera family, per layout | `edge-media` | Pass |
| Unknown formats, camera service files, extensionless files (never dropped silently) | `edge-media` | Pass |
| Unicode, NFD, emoji, 255-byte, control-character and dash-led names | `edge-media` | Pass |
| 64-level source tree; 150-level tree with long CJK names | `edge-media`, stress | Pass |
| Garbled camera names and dates, missing/empty/garbage EXIF, time zones, dateless files | `edge-media` | Pass (after fix 2) |
| Folder path builder round-trips; every template plans valid folders | `edge-media` | Pass |
| Capture dates exFAT or APFS cannot store | `edge-filesystems` | Pass (after fix 1) |
| exFAT destination (no hard links): import, re-import, organize, undo | `edge-filesystems`, stress | Pass |
| Full destination, read-only folder and volume | `edge-filesystems` | Pass |
| Destination drive unplugged mid-copy | `edge-filesystems` | Pass |
| Source rewritten or removed mid-copy; destination folder renamed or replaced by a link | `edge-failures` | Pass |
| Several cards importing at once into one destination (1, 4 and 10 cards, clashing names) | `edge-failures`, stress | Pass |
| Stopped import leaves no partial files and a retry completes exactly | `edge-failures` | Pass |
| Organization in place (video-root, both strategies), finalize, layout supersession | `edge-organization` | Pass |
| Organization or undo stopped part-way; two organizations started at once | `edge-organization` | Pass |
| SIGKILL during import stage with a foreign target | `process-crash` | Pass |
| 30,000-file scan, plan, plan reusing the scan, misplaced check | stress | Pass |
| 3,000-file copy, then re-plan and re-run with everything verified in place | stress | Pass |
| 5,000-file organization in place, check, undo to the exact original tree | stress | Pass |
| Import killed with SIGKILL 6 times, then resumed | stress | Pass (exact copy, no leftovers) |
| Organization and undo killed with SIGKILL 8 times, then resumed | stress | Pass (every file always present, exact original tree after undo) |

## Bugs fixed

1. **A capture date the destination cannot store failed the copy** (`9a1880c`). On exFAT, a photo dated before 1980 or after 2107 failed with "Destination filesystem did not preserve the requested Created/Modified dates". So did a garbled date such as 9999-12-31 on APFS. The file was never imported. It now gets the source file's own dates, as a file without a capture date does. Copy-time dates are still never accepted.
2. **A camera name containing braces broke the whole plan** (`1dc2077`). An EXIF Model such as `Brace{year}Cam` made the folder builder reject the plan as an invalid template, because it looked for unknown tokens after substitution. It now checks the template itself and substitutes only its own values.
3. **Test-only: the unplug test leaked disk images** (this commit). `a destination drive unplugged mid-run…` unmounts its image with `umount -f`. Cleanup then tried to detach it by its mount path, which no longer existed. So every `npm test` run left a 64 MB image attached, with its backing file deleted but its space still in use. 195 such images had built up, holding about 11 GB, which likely added to today's full disk. The fixture now detaches by device. They were detached by hand.

## Open failures

Found on the merged code and not fixed here:

- **`exfat-staging.test.ts`: "a copy stopped while publishing on exFAT is finished in place by the next import, not copied again"** fails every time (3 of 3 runs): `Missing expected rejection (AbortError)` at line 89.
  - The test stops the copy once the destination file has any bytes, and expects `execute()` to reject with `AbortError`. On the merged code the copy finishes without seeing the stop.
  - The test comes from `d3f2ecf` ("Bind import receipts to the inode the bytes went to on exFAT"). The parallel copy engine comes from `59636e3` ("Scan and copy several files at once…"). The two first met in merge `e893f6c`.
  - Either the new engine no longer checks the abort signal while publishing on exFAT, or the way the test triggers the stop no longer fits the new engine. This needs a look from whoever owns the copy engine.

## Timings

Measured on the test Mac (APFS internal disk, about 35 GB free) at `STRESS_SCALE=1`, one run, nothing else running. Earlier figures are from run 1 on the pre-merge copy engine, where it ran the same step at the same size.

| Step | Files | Time | Per file | Peak RSS | Earlier |
|---|---|---|---|---|---|
| Create fixture | 30,000 | 4.9 s | | 133 MB | |
| Inventory (scan) | 30,000 | 1.0 s | 0.03 ms | 197 MB | 31.1 s (with other runs going at once) |
| Plan into empty destination | 30,000 | 5.5 s | 0.2 ms | 335 MB | |
| Plan reusing the scan | 30,000 | 5.7 s | | 465 MB | |
| Misplaced check (read-only) | 30,000 | 2.9 s | | 657 MB | |
| Copy small files | 3,000 | 94.9 s | 32 ms | 278 MB | 376 s, 125 ms/file |
| Re-plan, all present | 3,000 | 2.0 s | | 315 MB | |
| Re-run, all verified in place | 3,000 | 8.0 s | 2.7 ms | 297 MB | |
| All extensions copied, per layout (6 layouts) | 67 | 1.5–3.2 s | | ~290 MB | 6.4–9.1 s |
| 150-level deep tree copy | 50 | 1.7 s | | 286 MB | 10.6 s |
| Parallel import, 1 card | 150 | 5.0 s | | 281 MB | 14.4 s |
| Parallel import, 4 cards | 600 | 22.5 s | | 278 MB | 39.4 s |
| Parallel import, 10 cards | 1,500 | 96.9 s | 65 ms | 240 MB | 95.1 s |
| Organization plan | 5,000 | 5.4 s | | 310 MB | 3.9 s |
| Organization in place (rename) | 5,000 | 488.5 s | 98 ms | 181 MB | 211 s for 4,375 moved |
| Misplaced check after organizing | 5,000 | 6.3 s | | 199 MB | |
| Undo organization | 5,000 | 283.7 s | 57 ms | 199 MB | |
| exFAT import | 600 | 276.9 s | 460 ms | 107 MB | 122 s |
| exFAT organization (rename) | 600 | 87.8 s | 146 ms | 164 MB | 39.2 s for 525 moved |
| exFAT undo | 600 | 30.2 s | 50 ms | 167 MB | |
| Import with 6 SIGKILLs, then resume | 400 | 18.0 s | | 164 MB | 27.1 s |
| Organization and undo with 8 SIGKILLs | 400 | 78.5 s | | 112 MB | |

The whole stress suite took 1,596 s (26.6 min). The organize test alone took 13.4 min, and the exFAT test 7 min.

## Known limits

- **Organizing in place is slow.** On APFS it took about 100 ms per file to move and 57 ms per file to undo. 5,000 files took 8 minutes to organize and almost 5 more to undo. This is slower per file than in run 1, though run 1 was done with other runs going at once, so the two are not strictly comparable. The fixtures are small, so the time is per-file overhead, not data; where it goes was not profiled.
- **Importing to exFAT is slow.** It took about 460 ms per file for small files, roughly 14 times the APFS rate on the same Mac, and 2.3 times slower than run 1. exFAT has no hard links, so each file is staged, synced and published separately. This may be worth profiling with the new copy engine.
- **Small-file copies are dominated by per-file cost.** The new engine copies small files about 4 times faster than before (32 vs 125 ms per file). That cost is still mostly fixed overhead per file, not bytes.
- **Memory grows with the plan.** Peak RSS reached 657 MB while planning and checking 30,000 files. That is fine for a card, but it grows linearly with very large libraries.
- **Not covered:** physical cards, cameras over USB (PTP/MTP), network shares and FAT32 were not exercised. The Electron smoke test with `--large=N` was not timed in this run.

## Hardware exFAT end-to-end test

`Scripts/hw/run.mts` is a harness (`Scripts/hw/harness.mts`) plus scenario groups (`Scripts/hw/groups/<name>.mts`, run in file-name order, each in its own sub-folder of the sandboxes; a throwing group counts as a failure and the run continues). The `01-cycle` group runs import, re-import, conflict, organization, undo, finalize, duplicate removal, an interrupted organization and NFC names on real external exFAT volumes:

```
node --import tsx Scripts/hw/run.mts --source=/Volumes/A006 --library=/Volumes/Untitled [--keep] [--files=N] [--host-key=<path>] [--only=<group,...>]
node --import tsx Scripts/test-hardware-exfat.mts ...   # wrapper: same as run.mts --only=01-cycle
```

It only writes inside one `photo-importer-hw-test-<ISO time>` folder it creates on each volume (a guard rejects every other path), keeps app data in a fresh temporary folder, and removes only those folders at the end unless `--keep` is given. Metadata comes from a synthetic table, so no camera files are needed. It prints a PASS/FAIL/SKIP line per check, per-scenario timings and the exFAT inode observations, and exits non-zero on any failure.
