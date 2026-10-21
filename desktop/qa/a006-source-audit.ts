// Recovered verbatim from the release 0.2.1 bundle; historical read-only evidence mode.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {constants,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {isDeepStrictEqual,promisify} from 'node:util';
import type {Source} from '../shared';
interface LegacyFileRecord {path:string;relative:string;size:string;mtimeNs:string;ino:string;dev:string;sha256:string;}
interface LegacyManifest {source:Source;files:LegacyFileRecord[];symlinks:string[];complete:boolean;}
interface HardwareSummary {destination:string;volumeId:string;passed:boolean;started?:string;finished?:string;checks:{name:string;passed:boolean}[];}
interface Volume {path:string;uuid:string;filesystem?:string;}
/** Read-only supplement for one recorded exFAT identity anomaly. Never alters the strict hardware report. */
const report = "/private/tmp/photo-importer-a006-hardware-authorized";
const bindings = {
	"summary.json": "a3fd708156dbf7d5af2ede00cab77548e9349522fb508a1d2ea91218c1371bf6",
	"baseline-manifest.json": "41881413e2b82dc49916e85b3ef86743df9b91fd1e1dbda3d8d9fb375d2c95b0",
	"after-manifest.json": "072d6ee9f3093a2a6c8c02c193a6cdaaa234797759a8e3251c587f2a50bb3934"
};
const markerPath = "/Volumes/Untitled 1/SONY/SONYCARD.IND";
const lastMarkerPath = "/Volumes/Untitled 2/PRIVATE/SONY/SONYCARD.IND";
const markerVolume = {
	path: "/Volumes/Untitled 1",
	uuid: "AA262E16-3901-31A2-85ED-59B081877D56"
};
const lastVolume = {
	path: "/Volumes/Untitled 2",
	uuid: "B25DBA1E-3CEA-3740-B5F7-2E1B14E9B7BB"
};
const failedCheck = "Every original file and its identity remains unchanged";
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
const sha = (value:string|Buffer) => createHash("sha256").update(value).digest("hex");
const json = async<T>(name:string):Promise<T> => JSON.parse(await fs.readFile(path.join(report, name), "utf8"));
const withoutInode = ({ ino, ...record }:LegacyFileRecord) => record;
function markerChange(before:LegacyFileRecord, current:LegacyFileRecord, exactPath:string) {
	assert.equal(before.path, exactPath);
	assert.equal(current.path, exactPath);
	assert.equal(before.ino, "-8");
	assert.ok(exactPath === markerPath || exactPath === lastMarkerPath);
	assert.ok(BigInt(current.ino) < 0n, "Only the two observed empty markers may have volatile negative inode values");
	assert.equal(before.size, "0");
	assert.deepEqual(withoutInode(current), withoutInode(before));
}
function source6Matches(current:LegacyManifest, expected:LegacyManifest) {
	assert.deepEqual(current.source, expected.source);
	assert.deepEqual(current.symlinks, expected.symlinks);
	assert.equal(current.complete, true);
	assert.equal(current.files.length, 47);
	for (let index = 0; index < expected.files.length; index++) {
		const before = expected.files[index], after = current.files[index];
		if (before.path === lastMarkerPath) markerChange(before, after, lastMarkerPath);
		else assert.deepEqual(after, before);
	}
}
async function originals() {
	const actual:Record<string,string> = {};
	for (const name of Object.keys(bindings)) actual[name] = sha(await fs.readFile(path.join(report, name)));
	const summary = await json<HardwareSummary>("summary.json");
	assert.equal(summary.destination, "/Volumes/A006");
	assert.equal(summary.volumeId, "7FCAB978-19AB-35F1-B849-4EF53D1C0448");
	return {
		actual,
		summary
	};
}
async function knownFailure() {
	const { actual, summary } = await originals();
	assert.deepEqual(actual, bindings, "Original hardware evidence changed");
	assert.equal(summary.passed, false);
	assert.ok(summary.started && summary.finished);
	assert.deepEqual(summary.checks.filter((check) => !check.passed).map((check) => check.name), [failedCheck]);
	assert.ok(summary.checks.filter((check) => check.name !== failedCheck).every((check) => check.passed === true));
	const baseline = await json<LegacyManifest[]>("baseline-manifest.json"), after = await json<LegacyManifest[]>("after-manifest.json");
	assert.equal(baseline.length, 6);
	assert.equal(after.length, 5);
	assert.ok([...baseline, ...after].every((item) => item.complete === true));
	assert.equal(baseline.reduce((count, item) => count + item.files.length, 0), 8005);
	assert.equal(after.reduce((count, item) => count + item.files.length, 0), 7958);
	const differences:{path:string;before:LegacyFileRecord;after:LegacyFileRecord}[] = [];
	for (let index = 0; index < 5; index++) {
		assert.deepEqual(after[index].source, baseline[index].source);
		assert.deepEqual(after[index].symlinks, baseline[index].symlinks);
		assert.equal(after[index].files.length, baseline[index].files.length);
		for (let file = 0; file < baseline[index].files.length; file++) if (!isDeepStrictEqual(baseline[index].files[file], after[index].files[file])) differences.push({
			path: baseline[index].files[file].path,
			before: baseline[index].files[file],
			after: after[index].files[file]
		});
	}
	assert.equal(differences.length, 1);
	const anomaly = differences[0];
	assert.equal(anomaly.path, markerPath);
	assert.equal(anomaly.before.ino, "-8");
	assert.equal(anomaly.after.ino, "-18");
	assert.equal(anomaly.before.size, "0");
	assert.deepEqual(withoutInode(anomaly.before), withoutInode(anomaly.after));
	assert.equal(baseline[5].source.path, lastVolume.path);
	assert.equal(baseline[5].source.id, lastVolume.uuid);
	assert.equal(baseline[5].files.length, 47);
	return {
		summary,
		actual,
		baseline,
		after,
		anomaly
	};
}
/** Local evidence gate shared by maintenance; importing this file never touches a card. */
export async function validatedA006HardwareEvidence() {
	const { summary } = await originals();
	if (summary.passed === true) {
		assert.ok(summary.checks.length && summary.checks.every((check) => check.passed === true));
		return {
			summary,
			supplement: false
		};
	}
	const evidence = await knownFailure();
	const supplement = await json<Record<string,unknown>>("source-audit-supplement.json");
	assert.equal(supplement.contentPreservationPassed, true);
	assert.equal(supplement.strictIdentityPassed, false);
	assert.equal(supplement.coverage, 8005);
	assert.deepEqual(supplement.originalBindings, bindings);
	const sourceBytes = await fs.readFile(path.join(report, "source-audit-source6.json")), markerBytes = await fs.readFile(path.join(report, "source-audit-marker.json"));
	assert.equal(sha(sourceBytes), supplement.source6SHA256);
	assert.equal(sha(markerBytes), supplement.markerSHA256);
	const source6:LegacyManifest = JSON.parse(sourceBytes.toString());
	source6Matches(source6, evidence.baseline[5]);
	const sourceVolumeBytes = await fs.readFile(path.join(report, "source-audit-source6-volume.json"));
	assert.equal(sha(sourceVolumeBytes), supplement.source6VolumeSHA256);
	const sourceVolume:Volume = JSON.parse(sourceVolumeBytes.toString());
	assert.deepEqual(sourceVolume, {
		...lastVolume,
		filesystem: "exfat"
	});
	const marker:{record:LegacyFileRecord;volume:Volume} = JSON.parse(markerBytes.toString());
	assert.deepEqual(marker.volume, {
		...markerVolume,
		filesystem: "exfat"
	});
	markerChange(evidence.anomaly.before, marker.record, markerPath);
	assert.deepEqual(supplement.anomalies, [{
		...evidence.anomaly,
		current: marker.record,
		volume: marker.volume
	}, {
		path: lastMarkerPath,
		before: evidence.baseline[5].files.find((file) => file.path === lastMarkerPath),
		current: source6.files.find((file) => file.path === lastMarkerPath),
		volume: sourceVolume
	}]);
	return {
		summary,
		supplement: true
	};
}
export async function runA006SourceAudit() {
	if (process.argv.slice(2).length) throw new Error("Usage: node --import tsx Scripts/a006-source-audit.mts");
	assert.equal(await fs.realpath(report), report, "Report directory must be the fixed local directory");
	let phase = "original-evidence", completed = 0;let timer:NodeJS.Timeout|undefined;
	let result:Record<string,unknown> = {
		contentPreservationPassed: false,
		strictIdentityPassed: false,
		coverage: 0
	};
	const output = (name:string, value:unknown) => fs.writeFile(path.join(report, name), JSON.stringify(value, null, 2) + "\n", { mode: 384 });
	const arm = (operation:string) => {
		phase = operation;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			const failure = {
				...result,
				contentPreservationPassed: false,
				phase,
				completed,
				error: "Read operation exceeded 120 seconds",
				finished: (/* @__PURE__ */ new Date()).toISOString()
			};
			writeFileSync(path.join(report, "source-audit-supplement.json"), JSON.stringify(failure, null, 2) + "\n", { mode: 384 });
			console.error(JSON.stringify(failure));
			process.exit(2);
		}, 12e4);
	};
	const exec = promisify(execFile);
	async function volume(expected:Volume) {
		arm("volume " + expected.path);
		const { stdout } = await exec("/usr/sbin/diskutil", [
			"info",
			"-plist",
			expected.path
		], {
			timeout: 8e3,
			maxBuffer: 1048576
		});
		const uuid = stdout.match(/<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.toUpperCase();
		const filesystem = stdout.match(/<key>FilesystemType<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.toLowerCase();
		assert.equal(uuid, expected.uuid);
		assert.equal(filesystem, "exfat");
		assert.equal(await fs.realpath(expected.path), expected.path);
		return {
			...expected,
			filesystem
		};
	}
	async function read(file:string, root:string) {
		arm("hash " + file);
		assert.equal(await fs.realpath(file), file);
		const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const before = await handle.stat({ bigint: true });
			assert.ok(before.isFile());
			const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1048576);
			for (;;) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
				if (!bytesRead) break;
				hash.update(buffer.subarray(0, bytesRead));
			}
			const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true });
			for (const field of [
				"size",
				"mtimeNs",
				"ino",
				"dev"
			] as const) {
				assert.equal(after[field], before[field], `Changed during read: ${file} ${field}`);
				assert.equal(current[field], before[field], `Changed pathname: ${file} ${field}`);
			}
			return {
				path: file,
				relative: path.relative(root, file),
				size: String(current.size),
				mtimeNs: String(current.mtimeNs),
				ino: String(current.ino),
				dev: String(current.dev),
				sha256: hash.digest("hex")
			};
		} finally {
			await handle.close();
		}
	}
	try {
		arm(phase);
		const original = await originals();
		result = {
			...result,
			originalBindings: original.actual
		};
		await output("source-audit-supplement.json", {
			...result,
			phase
		});
		const evidence = await knownFailure();
		result = {
			...result,
			anomaly: evidence.anomaly
		};
		await output("source-audit-supplement.json", {
			...result,
			phase
		});
		const markerInfo = await volume(markerVolume);
		const record = await read(markerPath, markerVolume.path);
		await output("source-audit-marker.json", {
			record,
			volume: markerInfo
		});
		markerChange(evidence.anomaly.before, record, markerPath);
		const sourceVolume = await volume(lastVolume);
		await output("source-audit-source6-volume.json", sourceVolume);
		const source6:LegacyManifest = {
			source: evidence.baseline[5].source,
			files: [],
			symlinks: [],
			complete: false
		};
		const files:string[] = [];
		async function walk(folder:string):Promise<void> {
			arm("enumerate " + folder);
			assert.equal(await fs.realpath(folder), folder);
			for (const item of await fs.readdir(folder, { withFileTypes: true })) {
				if (serviceNames.has(item.name.toLowerCase()) || item.name.startsWith("._")) continue;
				const file = path.join(folder, item.name), stat = await fs.lstat(file);
				if (stat.isSymbolicLink()) source6.symlinks.push(file);
				else if (stat.isDirectory()) await walk(file);
				else if (stat.isFile()) files.push(file);
			}
		}
		await walk(lastVolume.path);
		files.sort();
		source6.symlinks.sort();
		assert.equal(files.length, 47);
		assert.deepEqual(source6.symlinks, evidence.baseline[5].symlinks);
		for (const file of files) {
			const fresh = await read(file, lastVolume.path), expected = evidence.baseline[5].files[source6.files.length];
			source6.files.push(fresh);
			completed = source6.files.length;
			await output("source-audit-source6.json", source6);
			if (file === lastMarkerPath) markerChange(expected, fresh, lastMarkerPath);
			else assert.deepEqual(fresh, expected, `Fresh source6 identity/content mismatch: ${file}`);
			console.log(JSON.stringify({
				phase,
				completed,
				total: 47
			}));
		}
		source6.complete = true;
		await volume(lastVolume);
		await output("source-audit-source6.json", source6);
		result = {
			contentPreservationPassed: true,
			strictIdentityPassed: false,
			coverage: 8005,
			firstFiveCoverage: 7958,
			freshSource6Coverage: 47,
			originalBindings: evidence.actual,
			source6SHA256: sha(await fs.readFile(path.join(report, "source-audit-source6.json"))),
			source6VolumeSHA256: sha(await fs.readFile(path.join(report, "source-audit-source6-volume.json"))),
			markerSHA256: sha(await fs.readFile(path.join(report, "source-audit-marker.json"))),
			anomalies: [{
				...evidence.anomaly,
				current: record,
				volume: markerInfo
			}, {
				path: lastMarkerPath,
				before: evidence.baseline[5].files.find((file) => file.path === lastMarkerPath),
				current: source6.files.find((file) => file.path === lastMarkerPath),
				volume: sourceVolume
			}],
			finished: (/* @__PURE__ */ new Date()).toISOString(),
			limitations: ["The original strict hardware test remains failed. The two named zero-byte SONYCARD.IND exFAT markers have volatile negative inode identifiers; recorded before/after/current values remain in this report. Byte content, size, modification time, device and path match. No general inode exception is applied.", "The first five manifests were completed by the original hardware audit; only the missing sixth source and the known marker are freshly read here."]
		};
		await output("source-audit-supplement.json", result);
		await validatedA006HardwareEvidence();
		console.log(JSON.stringify(result));
	} catch (error) {
		result = {
			...result,
			contentPreservationPassed: false,
			phase,
			completed,
			error: String(error),
			finished: (/* @__PURE__ */ new Date()).toISOString()
		};
		await output("source-audit-supplement.json", result);
		console.error(JSON.stringify(result));
		process.exitCode = 1;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
