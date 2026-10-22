// Recovered from the preserved release 0.2.1 bundle after the source files disappeared.
// Camera-card access is read-only; the explicit hardware runner only exercises imports.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import type {Action,AppState,Job,PlanEntry,Source} from '../shared';
import {plan} from '../core';
import {digest} from '../core/paths';
import {metadata} from '../platform/metadata';
import {formatMessage} from '../messages';
interface FileRecord {path:string;relative:string;size:string;mtimeNs:string;birthtimeNs:string;ino:string;dev:string;sha256:string;identityIssues?:string[];contentIssues?:string[];}
interface SourceManifest {source:Source;files:FileRecord[];symlinks:string[];complete:boolean;errors?:{path:string;error:string}[];}
interface Check {name:string;passed:boolean;error?:string;}
/** The one disk this runner may write to; main.ts configures the app from it. */
export const hardwareDestination = {path:"/Volumes/A006", volumeId:"7FCAB978-19AB-35F1-B849-4EF53D1C0448"};
const destination = hardwareDestination.path;
const volumeId = hardwareDestination.volumeId;
const hour = 36e5;
const serviceNames = /* @__PURE__ */ new Set([
	".photo-importer-recovery",
	".ds_store",
	".fseventsd",
	".spotlight-v100",
	".trashes",
	".temporaryitems",
	"$recycle.bin",
	"system volume information",
	"thumbs.db",
	"desktop.ini"
]);
const terminal = (job:Job) => [
	"complete",
	"stopped",
	"error"
].includes(job.phase);
const pause = (milliseconds:number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
/** Read every regular original even when a filesystem reports volatile inode IDs.
* Identity failures remain strict failures; content evidence is kept separately.
*/
export async function readOriginalFile(file:string, root:string, signal?:AbortSignal):Promise<FileRecord> {
	const before = await fs.lstat(file, { bigint: true });
	assert.ok(before.isFile() && !before.isSymbolicLink());
	const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat({ bigint: true });
		assert.ok(opened.isFile());
		const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1048576);
		let bytes = 0;
		for (;;) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			bytes += bytesRead;
			hash.update(buffer.subarray(0, bytesRead));
		}
		const ended = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true });
		assert.ok(current.isFile() && !current.isSymbolicLink());
		const identityIssues:string[] = [], contentIssues:string[] = [];
		for (const [label, observed] of [
			["opened", opened],
			["read", ended],
			["pathname", current]
		] as const) {
			for (const key of [
				"size",
				"mtimeNs",
				"birthtimeNs",
				"ino",
				"dev"
			] as const) if (observed[key] !== before[key]) identityIssues.push(`${key} changed at ${label}: ${file}`);
			if (observed.size !== opened.size || observed.mtimeNs !== opened.mtimeNs) contentIssues.push(`File changed while hashing at ${label}: ${file}`);
		}
		if (BigInt(bytes) !== opened.size) contentIssues.push(`Read length does not match source size: ${file}`);
		return {
			path: file,
			relative: path.relative(root, file),
			size: String(current.size),
			mtimeNs: String(current.mtimeNs),
			birthtimeNs: String(current.birthtimeNs),
			ino: String(current.ino),
			dev: String(current.dev),
			sha256: hash.digest("hex"),
			...identityIssues.length ? { identityIssues } : {},
			...contentIssues.length ? { contentIssues } : {}
		};
	} finally {
		await handle.close();
	}
}
export function compareSourceManifests(before:SourceManifest, after:SourceManifest|undefined) {
	const contentErrors:string[] = [], strictErrors:string[] = [];
	if (!before.complete || !after?.complete) contentErrors.push("Before/after source enumeration and hashing must both complete");
	for (const item of [before, after]) for (const error of item?.errors ?? []) contentErrors.push(`${error.path}: ${error.error}`);
	if (after?.source.path !== before.source.path) contentErrors.push("Source mount path changed or is unavailable");
	if (JSON.stringify(before.symlinks) !== JSON.stringify(after?.symlinks)) contentErrors.push("Source symbolic-link set changed or is unavailable");
	const oldFiles = new Map(before.files.map((file) => [file.relative, file])), newFiles = new Map((after?.files ?? []).map((file) => [file.relative, file]));
	for (const relative of /* @__PURE__ */ new Set([...oldFiles.keys(), ...newFiles.keys()])) {
		const old = oldFiles.get(relative), current = newFiles.get(relative);
		if (!old || !current) {
			contentErrors.push(`Source file added or missing: ${relative}`);
			continue;
		}
		if (old.size !== current.size || old.sha256 !== current.sha256) contentErrors.push(`Source size or SHA-256 changed: ${relative}`);
		for (const item of [old, current]) {
			contentErrors.push(...item.contentIssues ?? []);
			strictErrors.push(...item.identityIssues ?? []);
		}
		for (const key of [
			"mtimeNs",
			"birthtimeNs",
			"ino",
			"dev"
		] as const) if (old[key] !== current[key]) strictErrors.push(`${key} changed: ${relative}`);
	}
	strictErrors.push(...contentErrors);
	return {
		source: before.source.id,
		path: before.source.path,
		filesBefore: before.files.length,
		filesAfter: after?.files.length ?? 0,
		contentPreservationPassed: contentErrors.length === 0,
		strictIdentityPassed: strictErrors.length === 0,
		contentErrors,
		strictErrors
	};
}
export async function verifyCaptureTimestamps(entry:Pick<PlanEntry,'destination'|'captureTimeMs'>) {
	if (entry.captureTimeMs === void 0) return {
		destination: entry.destination,
		checked: false
	};
	const stat = await fs.lstat(entry.destination);
	assert.ok(stat.isFile() && !stat.isSymbolicLink());
	assert.ok(Math.abs(stat.mtimeMs - entry.captureTimeMs) <= 2e3, `Modified date does not match capture time: ${entry.destination}`);
	if (process.platform === "darwin") assert.ok(Math.abs(stat.birthtimeMs - entry.captureTimeMs) <= 2e3, `Created date does not match capture time: ${entry.destination}`);
	return {
		destination: entry.destination,
		checked: true,
		captureTimeMs: entry.captureTimeMs,
		modifiedMs: stat.mtimeMs,
		createdMs: stat.birthtimeMs,
		createdChecked: process.platform === "darwin"
	};
}
/** Parent must supply the same action handler used by the desktop interface. */
export async function runA006HardwareTest(getState:()=>AppState, action:(input:Action)=>Promise<void>, reportRoot:string, authorizeSource:(source:Source)=>Promise<void>):Promise<void> {
	assert.ok(process.argv.includes("--hardware-test-a006"), "Real hardware testing requires --hardware-test-a006");
	assert.ok(path.isAbsolute(reportRoot), "The report directory must be absolute");
	let ancestor = path.resolve(reportRoot);
	const missing:string[] = [];
	for (;;) try {
		ancestor = await fs.realpath(ancestor);
		break;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = path.dirname(ancestor);
		assert.notEqual(parent, ancestor);
		missing.unshift(path.basename(ancestor));
		ancestor = parent;
	}
	const report = path.join(ancestor, ...missing);
	assert.ok(report !== "/Volumes" && !report.startsWith("/Volumes/"), "Reports must be on local storage");
	await fs.mkdir(report, { recursive: true });
	const started = (/* @__PURE__ */ new Date()).toISOString();
	const checks:Check[] = [];
	const baseline:SourceManifest[] = [];
	const after:SourceManifest[] = [];
	const limitations = [
		"One physical destination cannot exercise two-disk mirror/sequential fill behavior.",
		"Only camera imports are exercised. No file organization, organization review, recovery action or finalization is performed.",
		"Capture timestamps are checked with a two-second filesystem tolerance. Missing capture timestamps preserve source filesystem dates and are reported as not capture-checked.",
		"Symbolic links are recorded without following them. Filesystem-service artifacts and AppleDouble files are excluded consistently with core.inventory; ordinary hidden and unknown files are hashed.",
		"Stop is cooperative: an outstanding filesystem call or ExFAT publication may finish before the job settles."
	];
	let phase = "preflight";
	let failure:unknown;
	let snapshots:Promise<void> = Promise.resolve();
	let reportError:unknown;
	let sources:Source[] = [];
	let manifestProgress:unknown;
	let originalPreferences:{basePath:string;parallel:number}|undefined;
	let sourcePreservation:ReturnType<typeof compareSourceManifests>[] = [];
	const testBasePath = "photobackup-hardware-" + (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
	const testRoot = path.join(destination, testBasePath);
	const json = async (name:string, value:unknown) => fs.writeFile(path.join(report, name), JSON.stringify(value, null, 2) + "\n");
	const snapshot = async (event:string, detail?:unknown) => {
		const state = getState();
		const value = {
			at: (/* @__PURE__ */ new Date()).toISOString(),
			phase,
			event,
			detail,
			manifestProgress,
			error: state.error,
			preferences: state.preferences,
			scanningSources: state.scanningSources,
			sources: state.sources.map((source) => ({
				...source,
				inventory: state.sourceInventories?.[source.id] ? {
					files: state.sourceInventories[source.id].files.length,
					media: state.sourceInventories[source.id].media
				} : void 0
			})),
			jobs: state.jobs.map(({ inventory, ...job }) => ({
				...job,
				inventory: inventory ? {
					files: inventory.files.length,
					media: inventory.media
				} : void 0
			}))
		};
		await json("live-state.json", value);
		await fs.appendFile(path.join(report, "progress.jsonl"), JSON.stringify(value) + "\n");
	};
	const record = (event:string, detail?:unknown) => {
		const pending = snapshots.then(() => snapshot(event, detail));
		snapshots = pending.catch((error) => {
			reportError = error;
		});
		return pending;
	};
	const timer = setInterval(() => {
		record("heartbeat").catch(() => {});
	}, 5e3);
	timer.unref();
	const check = async (name:string, work:()=>Promise<void>) => {
		phase = name;
		await record("check-start");
		try {
			await work();
			checks.push({
				name,
				passed: true
			});
			await record("check-pass");
		} catch (error) {
			checks.push({
				name,
				passed: false,
				error: String(error)
			});
			throw error;
		}
	};
	const bounded = async<T>(work:Promise<T>, milliseconds:number, label:string, onTimeout?:()=>void):Promise<T> => {
		let timeout:NodeJS.Timeout|undefined;
		try {
			return await Promise.race([work, new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					onTimeout?.();
					reject(/* @__PURE__ */ new Error(`Timed out: ${label}`));
				}, milliseconds);
			})]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	};
	const wait = async (test:()=>boolean, label:string, milliseconds = hour) => {
		const deadline = Date.now() + milliseconds;
		while (!test()) {
			if (reportError) throw reportError;
			if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
			await pause(100);
		}
	};
	const assertDestination = () => {
		const state = getState(), prefs = state.preferences;
		assert.equal(prefs.automatic, false, "Automatic must stay off");
		assert.equal(prefs.copyMode, "single", "Hardware test requires a single destination");
		assert.deepEqual(prefs.destinations, [destination]);
		assert.deepEqual(prefs.destinationIds, [volumeId]);
		const status = state.destinationStatus?.find((item) => item.path === destination);
		assert.ok(status?.available, "A006 must be available");
		assert.equal(status.volumeId, volumeId);
		const target = path.resolve(destination, prefs.basePath);
		assert.ok(target === destination || target.startsWith(destination + "/"), "Import root must stay inside A006");
	};
	const send = async (input:Action, milliseconds = 3e4) => {
		assertDestination();
		await bounded(action(input), milliseconds, `action ${input.type}`);
	};
	const latest = () => sources.map((source) => getState().jobs.find((job) => job.source.id === source.id));
	const passJobs = (ids:string[]) => ids.map((id) => getState().jobs.find((job) => job.id === id));
	const beginPass = async () => {
		const previous = new Set(getState().jobs.map((job) => job.id));
		for (const source of sources) await send({
			type: "start",
			sourceId: source.id
		});
		const jobs = latest();
		assert.ok(jobs.every((job) => job && !previous.has(job.id)), "Every source must receive a new job");
		return jobs.map((job) => job!.id);
	};
	const completePass = async (ids:string[]) => {
		await wait(() => passJobs(ids).every((job) => job && terminal(job)), "all import jobs to finish");
		for (const job of passJobs(ids)) {
			assert.ok(job);
			assert.equal(job.phase, "complete", `${job.source.name}: ${job.detail}`);
			assert.deepEqual(job.errors, []);
		}
	};
	const walk = async (source:Source):Promise<{files:string[];symlinks:string[]}> => {
		const files:string[] = [], symlinks:string[] = [];
		const root = await fs.realpath(source.path);
		assert.equal(root, source.path, "Source mount must remain at its canonical path");
		const visit = async (folder:string):Promise<void> => {
			for (const item of await fs.readdir(folder, { withFileTypes: true })) {
				if (serviceNames.has(item.name.toLowerCase()) || item.name.startsWith("._")) continue;
				const file = path.join(folder, item.name), stat = await fs.lstat(file);
				if (stat.isSymbolicLink()) symlinks.push(file);
				else if (stat.isDirectory()) await visit(file);
				else if (stat.isFile()) files.push(file);
			}
		};
		await visit(root);
		return {
			files: files.sort(),
			symlinks: symlinks.sort()
		};
	};
	const manifest = async (source:Source, list:SourceManifest[], filename:string) => {
		const control = new AbortController();
		const result:SourceManifest = {
			source,
			files: [],
			symlinks: [],
			complete: false
		};
		list.push(result);
		const task = (async () => {
			const contents = await walk(source);
			result.symlinks = contents.symlinks;
			for (const file of contents.files) {
				control.signal.throwIfAborted();
				manifestProgress = {
					source: source.id,
					completed: result.files.length,
					total: contents.files.length,
					file
				};
				try {
					result.files.push(await readOriginalFile(file, source.path, control.signal));
				} catch (error) {
					control.signal.throwIfAborted();
					(result.errors ??= []).push({
						path: file,
						error: String(error)
					});
				}
				if (result.files.length % 100 === 0) {
					await json(filename, list);
					await record("manifest-progress", {
						source: source.id,
						completed: result.files.length,
						total: contents.files.length,
						file
					});
				}
			}
			result.complete = !result.errors?.length;
			await json(filename, list);
			manifestProgress = {
				source: source.id,
				completed: result.files.length,
				total: contents.files.length,
				complete: result.complete
			};
		})();
		await bounded(task, hour, `full source manifest for ${source.name}`, () => control.abort());
	};
	const auditName = "Every original file and its identity remains unchanged";
	const auditOriginals = async () => {
		const failures:unknown[] = [];
		for (const original of baseline) try {
			await manifest(original.source, after, "after-manifest.json");
		} catch (error) {
			failures.push(error);
		}
		sourcePreservation = baseline.map((original) => compareSourceManifests(original, after.find((item) => item.source.id === original.source.id)));
		await json("source-preservation.json", {
			sources: sourcePreservation,
			allSourcesAttempted: after.length === baseline.length,
			contentPreservationPassed: sourcePreservation.every((item) => item.contentPreservationPassed),
			strictIdentityPassed: sourcePreservation.every((item) => item.strictIdentityPassed)
		});
		const contentErrors = sourcePreservation.flatMap((item) => item.contentErrors.map((error) => `${item.path}: ${error}`));
		checks.push({
			name: "Every original retains its path, size and SHA-256 across all sources",
			passed: contentErrors.length === 0,
			error: contentErrors.length ? contentErrors.join("\n") : void 0
		});
		for (const item of sourcePreservation) for (const error of item.strictErrors) failures.push(/* @__PURE__ */ new Error(`${item.path}: ${error}`));
		if (failures.length) throw new AggregateError(failures, failures.map((error) => String(error)).join("\n"));
	};
	const verifyDestinations = async (filename:string) => {
		const prefs = structuredClone(getState().preferences), root = path.resolve(destination, prefs.basePath);
		assert.equal(root, testRoot, "Independent verification must stay in this test root");
		const verified:{source:string;entries:number;media:number;captureDatesChecked:number;captureDatesMissing:number}[] = [], timestamps:Awaited<ReturnType<typeof verifyCaptureTimestamps>>[] = [];
		for (const original of baseline) {
			assertDestination();
			const control = new AbortController();
			const result = await bounded(plan(original.source.path, [root], {
				backup: false,
				template: prefs.template,
				separateMedia: prefs.separateMedia,
				editedFolder: prefs.editedFolder,
				unknownRules: {}
			}, (file) => metadata(file, { preview: false, details: false }), control.signal), hour, `verification plan for ${original.source.name}`, () => control.abort());
			const hashes = new Map(original.files.map((file) => [file.path, file.sha256]));
			let checked = 0, missing = 0;
			for (const entry of result.plans[0].entries) {
				assert.ok(entry.destination.startsWith(testRoot + path.sep), "Destination verification escaped the test root");
				assert.equal(entry.digest, hashes.get(entry.source), `Source content changed: ${entry.source}`);
				assert.ok(entry.skip, `Missing or incorrect destination: ${entry.destination}`);
				assert.equal(await bounded(digest(entry.destination, control.signal), hour, `destination hash ${entry.destination}`, () => control.abort()), hashes.get(entry.source), `Destination hash mismatch: ${entry.destination}`);
				const dates = await verifyCaptureTimestamps(entry);
				timestamps.push(dates);
				if (dates.checked) checked++;
				else missing++;
			}
			verified.push({
				source: original.source.id,
				entries: result.plans[0].entries.length,
				media: result.inventory.media,
				captureDatesChecked: checked,
				captureDatesMissing: missing
			});
			await json(filename, {
				sources: verified,
				timestamps
			});
		}
	};
	try {
		await check("A006 identity and idle read-only sources", async () => {
			assertDestination();
			const state = getState();
			assert.ok(!state.review && !state.busyReview, "Finish the current review first");
			assert.ok(state.jobs.every(terminal), "Existing jobs must be idle");
			assert.ok(!state.scanningSources?.length, "Existing scans must be idle");
			assert.deepEqual(state.preferences.unknownRules, {}, "Use default unknown-extension rules for this import exercise");
			await assert.rejects(fs.lstat(testRoot), { code: "ENOENT" }, "The hardware test root must not already exist");
			sources = structuredClone(state.sources.filter((source) => source.transport === "storage"));
			assert.ok(sources.length > 0, "At least one mounted camera-card source is required");
			for (const source of sources) {
				assert.ok(source.path.startsWith("/Volumes/"));
				assert.ok(source.path !== destination && !source.path.startsWith(destination + "/"));
			}
			originalPreferences = {
				basePath: state.preferences.basePath,
				parallel: state.preferences.parallel
			};
			await send({
				type: "preferences",
				patch: {
					basePath: testBasePath,
					parallel: 2
				}
			});
			assert.equal(getState().preferences.parallel, 2);
			assert.equal(getState().preferences.basePath, testBasePath);
		});
		await check("Native read-only access authorization for connected cards", async () => {
			for (const source of sources) await authorizeSource(source);
		});
		await check("Every authorized card is selected for import", async () => {
			for (const source of sources) await send({ type: "selectSource", sourceId: source.id, selected: true });
			await wait(() => sources.every((source) => getState().sources.find((item) => item.id === source.id)?.selected === true), "every card selected", 3e4);
		});
		await check("Read-only inventories for all storage sources", async () => {
			const previous = new Map(sources.map((source) => [source.id, getState().sourceInventories?.[source.id]]));
			await send({ type: "scanSources" });
			const deadline = Date.now() + 12e4;
			await wait(() => sources.every((source) => {
				const current = getState().sourceInventories?.[source.id];
				return !!current && current !== previous.get(source.id);
			}), "all source inventories", deadline - Date.now());
			await json("inventories.json", Object.fromEntries(sources.map((source) => [source.id, getState().sourceInventories![source.id]])));
			await send({ type: "stop" });
			await wait(() => !getState().scanningSources?.length, "read-only scan cancellation", 3e4);
		});
		await check("Original-file baseline including ordinary hidden and unknown files", async () => {
			for (const source of sources) await manifest(source, baseline, "baseline-manifest.json");
			assert.ok(baseline.every((item) => item.complete && item.files.every((file) => !file.contentIssues?.length)), "Every source baseline must have complete stable content hashes");
		});
		await check("Two parallel imports queue remaining sources and Stop settles", async () => {
			const ids = await beginPass();
			const running = passJobs(ids).filter((job) => job && !terminal(job) && job.phase !== "queued");
			assert.ok(running.length <= 2, "At most two import jobs may run");
			if (sources.length > 2) assert.ok(passJobs(ids).some((job) => job?.phase === "queued"), "Additional sources should queue");
			await record("initial-queue", {
				expectedQueued: Math.max(0, sources.length - 2),
				jobs: passJobs(ids)
			});
			await wait(() => {
				const jobs = passJobs(ids);
				const error = jobs.find((job) => job?.phase === "error");
				if (error) throw new Error(`${error.source.name}: ${error.detail}`);
				if (jobs.every((job) => job && terminal(job))) throw new Error("All jobs finished before a copy with byte progress could be stopped; Stop-during-copy coverage is unavailable");
				return jobs.some((job) => job?.phase === "copying" && (job.progress?.bytes ?? 0) > 0);
			}, "copy byte progress before Stop");
			const requested = Date.now();
			await send({ type: "stop" });
			await wait(() => passJobs(ids).every((job) => job && terminal(job)), "stopped import jobs", 12e4);
			assert.ok(passJobs(ids).some((job) => job?.phase === "stopped"), "Stop must stop at least one job");
			assert.ok(passJobs(ids).every((job) => job?.phase !== "error"), "Stop must not turn into import errors");
			await record("stop-settled", {
				elapsedMs: Date.now() - requested,
				jobs: passJobs(ids)
			});
		});
		await check("Restart every source and finish imports", async () => {
			await completePass(await beginPass());
		});
		await check("Repeat every import verifies existing data without copying", async () => {
			const ids = await beginPass();
			await completePass(ids);
			for (const job of passJobs(ids)) {const detail=formatMessage(job!.detail!,'en');assert.match(detail, /^0 copied · [\d,]+ verified · 0 errors$/u, detail);}
		});
		await check("Independent destination hashes and capture timestamps match every imported file", () => verifyDestinations("destination-verification.json"));
		await check("One real photograph exposes metadata and preview status", async () => {
			const photo = sources.flatMap((source) => getState().sourceInventories?.[source.id]?.files ?? []).find((file) => [
				"RAW",
				"JPEG",
				"HEIF",
				"Images"
			].includes(file.kind));
			assert.ok(photo, "A real photo is required for metadata/preview coverage");
			const result = await bounded(metadata(photo.path), 12e4, "real photo metadata and preview");
			assert.ok(Object.keys(result.fields).length > 0, "Photo metadata must expose fields");
			assert.ok(result.shutterCount || result.shutterNote, "Shutter-count availability must be explained");
			assert.ok(result.preview || result.fields.PreviewStatus, "Preview availability must be reported");
			await json("photo-metadata.json", {
				path: photo.path,
				camera: result.camera,
				date: result.date,
				shutterCount: result.shutterCount,
				shutterNote: result.shutterNote,
				previewAvailable: !!result.preview,
				previewCharacters: result.preview?.length ?? 0,
				previewStatus: result.fields.PreviewStatus,
				metadataFieldCount: Object.keys(result.fields).length
			});
		});
		await check(auditName, auditOriginals);
		assertDestination();
		if (reportError) throw reportError;
	} catch (error) {
		failure = error;
		try {
			await bounded(action({ type: "stop" }), 3e4, "Stop after hardware-test failure");
			await wait(() => getState().jobs.every(terminal), "all jobs to settle after failure", 12e4);
		} catch (stopError) {
			checks.push({
				name: "Stop after failure",
				passed: false,
				error: String(stopError)
			});
		}
		if (baseline.length === sources.length && baseline.length > 0 && baseline.every((item) => item.complete) && !checks.some((item) => item.name === auditName)) try {
			await check(auditName, auditOriginals);
		} catch {}
	} finally {
		if (originalPreferences) try {
			await wait(() => getState().jobs.every(terminal), "jobs to settle before restoring preferences", 12e4);
			await bounded(action({
				type: "preferences",
				patch: originalPreferences
			}), 3e4, "restore original import preferences");
			assert.equal(getState().preferences.basePath, originalPreferences.basePath);
			assert.equal(getState().preferences.parallel, originalPreferences.parallel);
			checks.push({
				name: "Original import preferences restored",
				passed: true
			});
		} catch (error) {
			checks.push({
				name: "Original import preferences restored",
				passed: false,
				error: String(error)
			});
			failure ??= error;
		}
		clearInterval(timer);
		await snapshots;
		await json("baseline-manifest.json", baseline);
		await json("after-manifest.json", after);
		await record(failure ? "failed" : "finished", { failure: failure ? String(failure) : void 0 });
		await json("summary.json", {
			started,
			finished: (/* @__PURE__ */ new Date()).toISOString(),
			passed: !failure && !reportError,
			contentPreservationPassed: sourcePreservation.length === sources.length && sources.length > 0 && sourcePreservation.every((item) => item.contentPreservationPassed),
			strictIdentityPassed: sourcePreservation.length === sources.length && sources.length > 0 && sourcePreservation.every((item) => item.strictIdentityPassed),
			destination,
			volumeId,
			testBasePath,
			testRoot,
			originalPreferences,
			sources,
			checks,
			limitations,
			error: failure ? String(failure) : reportError ? String(reportError) : void 0
		});
	}
	if (failure) throw failure;
	if (reportError) throw reportError;
}
