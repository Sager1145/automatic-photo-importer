# Time remaining (ETA) estimates

Imports run for hours on spinning external drives. Each stage, each job and the dashboard total show "about 12 min left". This note explains how the estimate is computed and why. The code is in `desktop/eta*.ts`, with tests in `desktop/tests/eta*.test.ts` and `verify-progress.test.ts`.

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

The code is in `desktop/eta-model.ts` (the model), `eta.ts` (the per-job tracker and `stampEstimates`), `eta-priors.ts` (saved history) and `eta-format.ts` (rounding and the display hold). Everything in them is pure given `now`.

1. **Two costs per step.** A step costs `a * files + b * GB` seconds (`a` in s/file, `b` in s/GB). Metadata steps have `b = 0`. Each step starts from a prior (the built-in table in `eta-model.ts`, or saved history) and is fitted from its own progress: windows of at least 5 s with progress, a ridge fit of the two multipliers with decay of 600 s, then a shift along the observed mix so the total time matches. A coefficient the data cannot tell apart (only small files so far, so no bytes) stays near its prior. Without a byte total (comparing, moves) bytes follow the mix seen so far.
2. **Whole job.** The job's time left is the sum over the current step and every step still ahead. Later steps take their coefficients from, in order, this session's exact drive pair, the saved exact pair, the session's drive class, the saved class, then the defaults. The step order depends on the job kind (`import`, `organization`, `duplicates`, `finalize`, `undo`, `originals`); the kind is passed in by `main.ts` through `EtaTracker.plan`, never guessed from step names.
3. **Publishing.** An import's last step is `verifying:link` or `verifying:copy` (or `publish:*` with verification off). exFAT and other file systems without hard links publish by copying, which costs much more; `main.ts` predicts it from the file system or an earlier run, and `Progress.work.publishCopy` corrects it once a file is published by copying.
4. **Verifying counts bytes.** `Progress.work` carries what the estimate counts: files published and the bytes of the staged files published. Files already in the backup add files only. With several pieces (a video folder, two destinations) a piece still waiting counts nothing and a finished one counts all its files, so the counter never goes back.
5. **Uncertainty.** 0.15 once 60 s are observed, 0.35 while warming up, 0.3 or 0.5 with exact history (two runs or one), 0.6 with class history, 1.0 with defaults, plus 0.3 when totals come from a listing estimate. The range is `[eta / (1 + u), eta * (1 + u)]`. "about 2–4 h" is shown when high/low is at least 1.6 and the estimate is at least 10 min; otherwise one value.
6. **Percentages.** A step's fraction is the model cost of the work done over the cost of all its work; the job's is the same sum over all steps. The card bar and the overview use that one number, so a verifying step of a long import reads about 40%, not 98%. The overview total is the sum of work done over the sum of work of all jobs (finished jobs keep their final cost). A shown fraction never decreases and stays below 100% until the job is finished.
7. **Display.** The tracker keeps `EtaSmoother`. The job's value then goes through a `DisplayHold`: it changes at most every 5 s; goes down after 5 s below the shown bucket's lower edge (at once below half); goes up only after 20 s at 1.15 times and at least 60 s more, at most once a minute. The job's first 10 s of observed time read "Estimating time left…". The time left is removed while a job is stopping. A step's time left appears once a window has closed.
8. **Shared drives (overview only).** Jobs writing to the same destination drive in copy or verify steps are one group. When their summed byte rate is at least 0.7 times the drive's saved solo rate, processor sharing applies: with estimates `E1 <= ... <= En` (measured while sharing), the time is `sum (Ei - Ei-1)(n-i+1)/n`. Otherwise the longest sets it. Each job's own time stays as measured. Steps shared for more than 20% of their time are not saved.
9. **Saved history.** `userData/eta-priors.json` (mode 0600, written atomically, at most every 30 s, never on the publish path) keeps, per step and per drive pair or drive class, the fitted `a` and `b`, the number of runs and up to 8 summaries. It is updated only from steps that ran at least 30 s over at least 20 files or 1 GB. Drive pairs are keyed by a truncated HMAC of the volume ids with a random salt kept in the file; it holds no paths, file names or volume names, and is never part of preferences or operation reports. A read error gives the defaults. At most 200 entries (the least recently updated go first).
10. **Listing.** On a drive or card, the bytes found are measured against the drive's used space (the old `EtaEstimator`). On a folder, where the total is unknown, only a rate is shown.
11. **Delete originals.** It re-reads the source and every backup copy, so its work is `(1 + backups) * size` bytes (`default 10 s/GB per read`). `deleteOriginals` reports bytes done and total; `main.ts` stores them with the time left on `Job.deletingOriginals`.
12. **Shown together.** Every progress line shows the elapsed time and the time left side by side (`ProgressTiming` in `RootApp.tsx`). Jobs use `Job.startedAt`; the review, the backup folder check and source scans get a `startedAt` from `stampEstimates`.

## Earlier approach

Before the model, each stage had one EWMA of throughput over `bytes + files * 1 MiB`, remembered per step for the session, and the job time added later steps at default rates. Verifying reported files only and its bytes were interpolated, which made hours of exFAT publishing look like minutes, and the bar weighted the last 10% for verification.

## Read speed

Copying reports its own speed. For the steps that report none, `stampEstimates` measures one with `RateMeter` (an EWMA of the running total with a 5 s time constant, so it falls during a stall): bytes read for organization reading and comparing with the destination, the bytes published for verification (the bytes of the files published), and files per second for metadata checking, which reads only headers. Every speed goes through `formatSpeed` in `i18n.tsx`: decimal units (B/s, KB/s, MB/s, GB/s), 3 significant digits, and `speedUnit` holds the shown unit until the speed falls below 0.9 of it, so it does not flicker near a boundary.

## Sources

- rclone accounting: https://github.com/rclone/rclone/blob/master/fs/accounting/stats.go
- tqdm smoothing and EMA: https://github.com/tqdm/tqdm/blob/master/tqdm/std.py
- rsync progress: https://github.com/RsyncProject/rsync/blob/master/progress.c
- pv `--average-rate-window`: https://man7.org/linux/man-pages/man1/pv.1.html
- restic backup progress: https://github.com/restic/restic/blob/master/internal/ui/backup/progress.go
- Firefox `getTimeLeft`: https://github.com/mozilla/gecko-dev/blob/master/toolkit/mozapps/downloads/DownloadUtils.sys.mjs
- Rapid Photo Downloader 0.9.0 notes (time remaining modeled on Firefox): https://damonlynch.net/rapid/release090.html
