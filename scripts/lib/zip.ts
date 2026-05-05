/**
 * Zip inspection — fetch a zip from a URL, hash it, list its entries,
 * read individual entries by name. Backed by `yauzl` for the actual
 * zip-format parsing (DEFLATE, ZIP64-aware, edge-case-tolerant). We
 * keep our own narrow API so callers don't depend on yauzl directly.
 */

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';

export interface ZipEntry {
	name: string;
	size: number;
	compressedSize: number;
}

export interface ZipInspection {
	bytes: Buffer;
	sha256: string;
	entries: ZipEntry[];
}

/** Fetch a zip, compute SHA-256, list entries. */
export async function fetchAndInspectZip(url: string): Promise<ZipInspection> {
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) {
		throw new Error(`Failed to download zip from ${url}: HTTP ${res.status} ${res.statusText}`);
	}
	const arrayBuffer = await res.arrayBuffer();
	const bytes = Buffer.from(arrayBuffer);
	return inspectBuffer(bytes);
}

/** Inspect an in-memory zip buffer. Used in tests too. */
export async function inspectBuffer(bytes: Buffer): Promise<ZipInspection> {
	const sha256Hex = createHash('sha256').update(bytes).digest('hex');
	const entries = await listEntries(bytes);
	return { bytes, sha256: sha256Hex, entries };
}

/** SHA-256 of a buffer as a 64-char lowercase hex string. */
export function sha256(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parse a zip buffer's central directory and list its entries.
 *
 * Backed by yauzl's `lazyEntries` mode so we only walk the central
 * directory and never decompress until `readEntry` asks. This matters
 * for large addon zips where most entries are PHP/asset bytes we don't
 * need to read.
 */
export async function listEntries(bytes: Buffer): Promise<ZipEntry[]> {
	const zip = await openZip(bytes);
	const entries: ZipEntry[] = [];
	return new Promise<ZipEntry[]>((resolve, reject) => {
		zip.on('entry', (e: Entry) => {
			entries.push({
				name: e.fileName,
				size: e.uncompressedSize,
				compressedSize: e.compressedSize,
			});
			zip.readEntry();
		});
		zip.on('end', () => resolve(entries));
		zip.on('error', (err) => reject(err));
		zip.readEntry();
	});
}

/**
 * Read a single entry by exact path. Returns null when absent.
 *
 * The current shape opens the zip once per `readEntry` call. That is
 * cheaper than maintaining an open ZipFile across the validator's
 * async checks and avoids leaking file handles on early returns. The
 * validator only reads `module.json` plus migration files, so the
 * overhead is bounded by file count, not zip size.
 */
export async function readEntry(bytes: Buffer, entry: ZipEntry): Promise<Buffer> {
	return await readEntryByName(bytes, entry.name);
}

export async function readEntryByName(bytes: Buffer, name: string): Promise<Buffer> {
	const zip = await openZip(bytes);
	return new Promise<Buffer>((resolve, reject) => {
		let found = false;
		zip.on('entry', (e: Entry) => {
			if (e.fileName !== name) {
				zip.readEntry();
				return;
			}
			found = true;
			zip.openReadStream(e, (err, stream) => {
				if (err || !stream) {
					reject(err ?? new Error(`No read stream for ${name}`));
					return;
				}
				const chunks: Buffer[] = [];
				stream.on('data', (chunk: Buffer) => chunks.push(chunk));
				stream.on('end', () => resolve(Buffer.concat(chunks)));
				stream.on('error', (sErr) => reject(sErr));
			});
		});
		zip.on('end', () => {
			if (!found) reject(new Error(`Zip entry not found: ${name}`));
		});
		zip.on('error', (err) => reject(err));
		zip.readEntry();
	});
}

/** Find an entry whose path equals `name` at the zip root. Null if absent. */
export function findRootEntry(entries: ZipEntry[], name: string): ZipEntry | null {
	return entries.find((e) => e.name === name) ?? null;
}

/**
 * Top-level path prefixes the registry refuses to publish. Authors
 * must strip these from their release zips.
 */
export const FORBIDDEN_PATH_PREFIXES = ['.git/', '.github/', 'tests/', 'Tests/', 'node_modules/', '.idea/', '.vscode/'] as const;

export const FORBIDDEN_FILES = ['.DS_Store'] as const;

export function findForbiddenEntries(entries: ZipEntry[]): string[] {
	const offenders: string[] = [];
	for (const e of entries) {
		const isForbiddenPrefix = FORBIDDEN_PATH_PREFIXES.some((p) => e.name.startsWith(p));
		const isForbiddenFile = FORBIDDEN_FILES.some((f) => e.name === f || e.name.endsWith(`/${f}`));
		if (isForbiddenPrefix || isForbiddenFile) {
			offenders.push(e.name);
		}
	}
	return offenders;
}

/** Promise wrapper around yauzl.fromBuffer with lazyEntries enabled. */
function openZip(bytes: Buffer): Promise<ZipFile> {
	return new Promise<ZipFile>((resolve, reject) => {
		fromBuffer(bytes, { lazyEntries: true }, (err, zip) => {
			if (err || !zip) reject(err ?? new Error('Failed to open zip'));
			else resolve(zip);
		});
	});
}
