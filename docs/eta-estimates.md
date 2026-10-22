# Time remaining (ETA) estimates

Imports run for hours on spinning external drives. Each stage, each job and the dashboard total show "about 12 min left". This note explains how the estimate is computed and why. The code is in `desktop/eta.ts`, with tests in `desktop/tests/eta.test.ts`.

## What similar tools do

| Tool | Rate | ETA and edge cases |
|---|---|---|
| rclone (`fs/accounting/stats.go`) | It samples bytes once a second. The speed is a running average, `speed = (avg + speed·(period−1)) / period`, whose period grows to a cap. The result is an EWMA with alpha `1/period`. | `remaining / rate`. It shows `-` when the total is unknown, the rate is 0, or the remaining amount is negative. |
| tqdm (`tqdm/std.py`) | An EMA of both the items done and the time between updates, with `smoothing=0.3` (0 is the overall average, 1 is instantaneous). It applies bias correction `1/(1−β^n)` so early values are not dragged toward 0. | `remaining / rate`. When it closes, it switches to the overall average. |
| rsync `--info=progress2` (`progress.c`) | A rolling window: a ring buffer of 5 one-second samples (`PROGRESS_HISTORY_SECS`). The rate is the bytes gained since the oldest sample. | It shows `??:??:??` when the result is negative or huge. The final line uses the whole-run average. |
| pv (`--average-rate-window`) | The average over a window, 30 s by default. | ETA is shown only when the size is known. |
| restic (`internal/ui/backup/progress.go`) | Its own estimator on bytes. | ETA is shown only once the scan has finished, so the total is known, and only when the rate is above 1 KiB/s. |
| Firefox downloads (`DownloadUtils.getTimeLeft`), which Rapid Photo Downloader 0.9 adopted for its "About N minutes remaining" | The raw speed. | The ETA itself is smoothed: `new = last + (diff<0 ? 0.3 : 0.1)·diff` unless the new value is under half the old one. It is quick to go down and slow to go up. |
| Windows Explorer copy dialog | Instantaneous throughput. | It is notorious for jumping estimates when it moves from large files to many small ones. |

## Approaches compared

- **Simple average since start** (`elapsed · remaining/done`). This is stable, but it ignores speed changes. A USB drive that slows after its cache fills, or a later switch from photos to large videos, is reflected only very slowly.
- **Windowed rate** (rsync's 5 s, pv's 30 s). This reacts to changes. A short window jumps on every stall and on every burst of small files. A long window holds a buffer of samples, and its estimate stays wrong for a full window after a phase change.
- **EWMA of throughput** (rclone, tqdm). It needs constant memory. With a *time-based* alpha `α = 1 − e^(−Δt/τ)`, the smoothing does not depend on how often progress is reported. Progress here arrives every 100 ms to several seconds, depending on file size, so this matters. Bias correction (tqdm) gives a usable value from the first samples.
- **Bytes versus files.** Copying and hashing are dominated by bytes. On a spinning drive, though, every file also costs a seek, a create, a rename and an fsync. A card of 2,000 small JPEGs followed by twenty 4 GB clips misleads a bytes-only rate (the small files look slow) and a files-only rate (the clips look stalled). Metadata checking and destination comparison depend almost entirely on file count.

## Choice

1. **Work units per stage.** Stages that move data (copying, verifying, organization reading and moving) count `bytes + files × 1 MiB`. The 1 MiB per-file cost is roughly 10 ms of seek and fsync overhead at 100 MB/s. Stages that only touch metadata (checking, comparing, confirming, releasing, restoring) count files. Verifying reports only files, so its bytes are interpolated from the plan's total.
2. **Throughput: EWMA with a time-based alpha and bias correction.** τ is 20 s. The rate is `ewma / (1 − Π(1−α))`, following tqdm's correction. A long τ smooths bursts of small files. The time-based alpha keeps the result independent of how often progress is reported.
3. **Startup.** Nothing is shown, or "Estimating…" when a total is known, until 3 s have passed and at least two intervals with progress have been measured. A stage with an unknown total (listing a folder) shows no countdown, as rclone and pv do.
4. **Stalls.** An interval with no progress is folded into the rate only after it lasts 15 s. Until then, the last estimate is held. A pause to open a large file, or a drive spinning up, does not make the estimate jump. A real stall makes it grow gradually.
5. **Display hysteresis (Firefox).** The shown value counts down with the clock. It then moves toward the new raw estimate with time constants of 3 s downward and 10 s upward. A drop to less than half the shown value is accepted immediately. The value is never negative, and it never shows 0 while work remains (the minimum is 1 s).
6. **Phase changes.** Each stage has its own estimator, so a new stage starts fresh rather than averaging metadata speed with copy speed. When a stage ends, its measured rate is remembered for the rest of the app session.
7. **Whole job.** The job ETA is the current stage's remainder plus estimates for the stages still ahead. Those use the work known from the plan: the files and bytes listed, times the number of destinations, until the copy plan gives exact numbers. Each is divided by the rate remembered for that stage, or by a conservative default (checking 40 files/s, comparing 300 files/s, copying 60 MB/s, verifying 100 MB/s). The dashboard shows the longest ETA among the running jobs, because jobs run in parallel.
8. **Listing.** On a drive or card, the bytes found are measured against the drive's used space. The progress bar already does this. On a folder, where the total is unknown, only "Listing files…" is shown.

9. **Shown together.** Every progress line shows the elapsed time and the time left side by side ("12:03 elapsed · about 8 min left", `ProgressTiming` in `RootApp.tsx`). Jobs use `Job.startedAt`; the review, the backup folder check and source scans get a `startedAt` from `stampEstimates`, kept for as long as they run (a scan's listing and metadata reading share one clock).

## Read speed

Copying reports its own speed. For the steps that report none, `stampEstimates` measures one with `RateMeter` (an EWMA of the running total with a 5 s time constant, so it falls during a stall): bytes read for organization reading and comparing with the destination, the verified share of the bytes for verification, and files per second for metadata checking, which reads only headers. Every speed goes through `formatSpeed` in `i18n.tsx`: decimal units (B/s, KB/s, MB/s, GB/s), 3 significant digits, and `speedUnit` holds the shown unit until the speed falls below 0.9 of it, so it does not flicker near a boundary.

## Sources

- rclone accounting: https://github.com/rclone/rclone/blob/master/fs/accounting/stats.go
- tqdm smoothing and EMA: https://github.com/tqdm/tqdm/blob/master/tqdm/std.py
- rsync progress: https://github.com/RsyncProject/rsync/blob/master/progress.c
- pv `--average-rate-window`: https://man7.org/linux/man-pages/man1/pv.1.html
- restic backup progress: https://github.com/restic/restic/blob/master/internal/ui/backup/progress.go
- Firefox `getTimeLeft`: https://github.com/mozilla/gecko-dev/blob/master/toolkit/mozapps/downloads/DownloadUtils.sys.mjs
- Rapid Photo Downloader 0.9.0 notes (time remaining modeled on Firefox): https://damonlynch.net/rapid/release090.html
