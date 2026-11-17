/**
 * The LOCAL FileIO — a test fixture, not production code (ADR-0040).
 *
 * It was a second implementation of the `FileIO` contract living in
 * `src/infra/fs-bridge.ts` while the production backend (`ctxFsIO`) lived
 * beside it — so the tool-layer tests ran against a SHADOW of the contract
 * (empty `emitObserved`, no write-intent, its own error vocabulary), and the
 * two backends' fences were never compared.
 *
 * Moving it here makes that honest: the production module carries ONE
 * implementation, and a test that wants the local filesystem asks for it
 * explicitly. The behaviour is unchanged — same probe contract, same error
 * codes, same `domainError` mapping — because the contract did not move, only
 * its home did.
 *
 * @module dsh-hashline-edittool/test/support/local-io
 */

import { lstat, readFile, rename, stat, unlink } from "node:fs/promises";
import { writeAtomic } from "../../src/infra/fs-write.js";
import { fileSnap } from "../../src/infra/file-snap.js";
import { resolveTarget, toCwd } from "../../src/infra/paths.js";
import { errCode } from "../../src/infra/utils.js";
import { probeVerdict } from "../../src/infra/probe-verdict.js";
import type { FileIO, FileProbe } from "../../src/infra/fs-bridge.js";

/** The domain error a local IO raises — the same shape the host backend uses. */
function domainError(code: string, message: string): never {
	const error = new Error(`[${code}] ${message}`);
	(error as Error & { code?: string }).code = code;
	throw error;
}

/**
 * FileIO over the host filesystem directly: the fixture a test uses when it
 * wants REAL files (a temp dir) without a host filesystem service.
 */
export function localIO(): FileIO {
	// Node's own decode never refuses a file for its content: `readText` is
	// the plain string read, and `readTextTolerant` re-reads as bytes to
	// classify (native vs lossy) without changing what comes back.
	const readLocal = async (absolutePath: string, signal?: AbortSignal): Promise<string> => {
		signal?.throwIfAborted();
		return readFile(absolutePath, "utf-8");
	};

	/** Local probe: same contract as the dsh backend, no policy. */
	const localProbe = async (
		requestedPath: string,
		cwd: string,
	): Promise<FileProbe> => {
		const absolute = toCwd(requestedPath, cwd ?? process.cwd());
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(absolute);
		} catch (error) {
			if (errCode(error) !== "ENOENT") throw error;
			info = undefined as never;
		}
		if (info === undefined) return { kind: "absent", path: await resolveTarget(absolute) };
		if (info.isSymbolicLink()) return { kind: "symlink" };
		if (info.isDirectory()) return { kind: "directory" };
		if (!info.isFile()) return { kind: "other" };
		const path = await resolveTarget(absolute);
		return { kind: "file", path, version: (await fileSnap(path)).snapshotId };
	};
	return {
		async resolve(path, cwd) {
			return resolveTarget(toCwd(path, cwd ?? process.cwd()));
		},
		async readText(absolutePath, signal) {
			return readLocal(absolutePath, signal);
		},
		async readTextTolerant(absolutePath, signal) {
			// The local deployment never refuses a file for its content, so a
			// byte-exact decode IS the native answer; only undecodable bytes
			// downgrade the classification to lossy (#273).
			signal?.throwIfAborted();
			const bytes = await readFile(absolutePath);
			const text = bytes.toString("utf-8");
			return {
				text,
				fidelity: Buffer.from(text, "utf-8").equals(bytes) ? "native" : "lossy",
			};
		},
		async writeText(absolutePath, content, signal, _exec, _sandboxPolicy) {
			signal?.throwIfAborted();
			await writeAtomic(absolutePath, content);
		},
		async emitObserved() {
			// No policy event gate on the host filesystem; nothing to record.
		},
		async emitAbsent() {
			// No policy event gate on the host filesystem; nothing to record.
			return false;
		},
		async statVersion(absolutePath) {
			try {
				return (await fileSnap(absolutePath)).snapshotId;
			} catch {
				return undefined;
			}
		},
		async statSize(absolutePath) {
			try {
				const st = await stat(absolutePath);
				return st.isFile() ? st.size : undefined;
			} catch {
				return undefined;
			}
		},

		probeFile: localProbe,
		async deleteFile(requestedPath, cwd, expected) {
			const before = await localProbe(requestedPath, cwd);
			if (before.kind === "absent") return { kind: "absent", path: before.path };
			if (before.kind !== "file") {
				const refused = probeVerdict({ probe: before, expect: "file", verb: "delete", path: requestedPath });
				if (refused === undefined) domainError("E_NOT_FILE", `Path is not a regular file: ${requestedPath}.`);
				domainError(refused.code, refused.message);
			}
			if (expected.kind === "absent") {
				domainError("E_DELETE_STALE", `The path was absent when it was probed and a file now exists: ${requestedPath}.`);
			}
			if (expected.kind !== "file") {
				domainError("E_DELETE_STALE", `The file changed after it was probed: ${requestedPath}.`);
			}
			if (expected.version !== before.version) {
				domainError("E_DELETE_STALE", `The file changed after it was probed: ${requestedPath}.`);
			}
			const after = await localProbe(requestedPath, cwd);
			if (after.kind === "absent") return { kind: "absent", path: after.path };
			if (after.kind !== "file") {
				domainError(after.kind === "symlink" ? "E_SYMLINK" : "E_NOT_FILE", `The path changed type while deleting: ${requestedPath}.`);
			}
			if (after.version !== before.version) {
				domainError("E_DELETE_STALE", `The file changed immediately before deletion: ${requestedPath}.`);
			}
			try {
				await unlink(before.path);
			} catch (error) {
				const code = errCode(error);
				if (code === "ENOENT") return { kind: "absent", path: before.path };
				if (code === "EACCES" || code === "EPERM" || code === "EBUSY" || code === "EROFS") {
					domainError("E_ACCESS", `Cannot delete ${requestedPath} (${code}).`);
				}
				if (code === "EISDIR") domainError("E_NOT_FILE", `Path became a directory while deleting: ${requestedPath}.`);
				throw error;
			}
			return { kind: "deleted", path: before.path };
		},

		async renameFile(fromPath, toPath, cwd, expected) {
			const before = await localProbe(fromPath, cwd);
			if (before.kind === "absent") domainError("E_NOT_FOUND", `File not found: ${fromPath}.`);
			if (before.kind !== "file") {
				const refused = probeVerdict({ probe: before, expect: "file", verb: "rename", path: fromPath });
				if (refused === undefined) domainError("E_NOT_FILE", `Path is not a regular file: ${fromPath}.`);
				domainError(refused.code, refused.message);
			}
			if (expected.kind !== "file" || expected.version !== before.version) {
				domainError("E_RENAME_STALE", `The file changed after it was probed: ${fromPath}.`);
			}
			const dest = await localProbe(toPath, cwd);
			// An OCCUPIED destination is refused; a free one (absent) is the
			// normal case. The verdict decides the code + wording; `undefined`
			// would mean "satisfied" — and an absent destination IS satisfied.
			// The local backend judges an OCCUPIED destination by SHAPE only:
			// a file at the destination is decided by the inode check below (the
			// case-only spelling change is legal), while anything else is a
			// plain refusal. The host backend adds a version comparison on top.
			if (dest.kind === "symlink" || dest.kind === "directory" || dest.kind === "other") {
				const verdict = probeVerdict({ probe: dest, expect: "unoccupied", verb: "rename", path: toPath });
				if (verdict === undefined) domainError("E_NOT_FILE", `Destination is not a regular file: ${toPath}.`);
				domainError(verdict.code, verdict.message);
			}
			if (dest.kind === "file") {
				// Same inode under another spelling is a case-only rename; anything
				// else is a real overwrite and is refused.
				const [a, b] = await Promise.all([
					stat(before.path, { bigint: true }),
					stat(dest.path, { bigint: true }),
				]);
				if (a.dev !== b.dev || a.ino !== b.ino) {
					const verdict = probeVerdict({ probe: dest, expect: "unoccupied", verb: "rename", path: toPath });
					if (verdict === undefined) domainError("E_NOT_FILE", `Destination is not a regular file: ${toPath}.`);
					domainError(verdict.code, verdict.message);
				}
			}
			const after = await localProbe(fromPath, cwd);
			if (after.kind !== "file" || after.version !== before.version) {
				domainError("E_RENAME_STALE", `The file changed immediately before renaming: ${fromPath}.`);
			}
			try {
				await rename(before.path, dest.path);
			} catch (error) {
				const code = errCode(error);
				if (code === "EXDEV") {
					domainError("E_CROSS_DEVICE", `Cannot rename across filesystems: ${fromPath} to ${toPath}.`);
				}
				if (code === "EACCES" || code === "EPERM" || code === "EBUSY" || code === "EROFS") {
					domainError("E_ACCESS", `Cannot rename ${fromPath} to ${toPath} (${code}).`);
				}
				if (code === "ENOENT") {
					domainError("E_NOT_FOUND", `Path not found: ${fromPath} or its destination directory.`);
				}
				if (code === "EISDIR" || code === "ENOTEMPTY") {
					domainError("E_NOT_FILE", `Path is not a regular file: ${fromPath}.`);
				}
				if (code === "EEXIST") {
					domainError("E_EXISTS", `Destination already exists: ${toPath}.`);
				}
				throw error;
			}
			return { from: before.path, to: dest.path };
		},
	};
}
