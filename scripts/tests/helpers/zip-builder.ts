/**
 * Minimal zip builder for tests. Produces a stored (uncompressed) zip
 * with a single zip-format-conformant central directory. Good enough for
 * the parser-under-test in scripts/lib/zip.ts and identity/structural
 * checks. Avoids pulling a heavy dependency into devDependencies.
 */

import { Buffer } from 'node:buffer';
import { crc32 } from 'node:zlib';

export interface ZipFixtureEntry {
	path: string;
	body: string | Uint8Array;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

interface BuiltEntry {
	path: string;
	body: Buffer;
	localOffset: number;
	crc: number;
}

/**
 * Build a zip from a list of entries. All entries are stored uncompressed
 * (compression method 0). Returns the zip as a Buffer.
 */
export function buildZip(entries: ZipFixtureEntry[]): Buffer {
	const built: BuiltEntry[] = [];
	const localChunks: Buffer[] = [];
	let offset = 0;

	for (const e of entries) {
		const body = Buffer.isBuffer(e.body)
			? e.body
			: typeof e.body === 'string'
				? Buffer.from(e.body, 'utf8')
				: Buffer.from(e.body);
		const nameBuf = Buffer.from(e.path, 'utf8');
		const crc = crc32(body);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // gp flag
		local.writeUInt16LE(0, 8); // method = stored
		local.writeUInt16LE(0, 10); // mod time
		local.writeUInt16LE(0, 12); // mod date
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(body.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);

		const localOffset = offset;
		localChunks.push(local, nameBuf, body);
		offset += local.length + nameBuf.length + body.length;
		built.push({ path: e.path, body, localOffset, crc });
	}

	const cdStart = offset;
	const cdChunks: Buffer[] = [];
	for (const b of built) {
		const nameBuf = Buffer.from(b.path, 'utf8');
		const central = Buffer.alloc(46);
		central.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0, 8); // gp flag
		central.writeUInt16LE(0, 10); // method
		central.writeUInt16LE(0, 12); // mod time
		central.writeUInt16LE(0, 14); // mod date
		central.writeUInt32LE(b.crc, 16);
		central.writeUInt32LE(b.body.length, 20); // compressed
		central.writeUInt32LE(b.body.length, 24); // uncompressed
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk number
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE(0, 38); // external attrs
		central.writeUInt32LE(b.localOffset, 42);
		cdChunks.push(central, nameBuf);
		offset += central.length + nameBuf.length;
	}
	const cdSize = offset - cdStart;

	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(EOCD_SIG, 0);
	eocd.writeUInt16LE(0, 4); // disk number
	eocd.writeUInt16LE(0, 6); // disk where central starts
	eocd.writeUInt16LE(built.length, 8);
	eocd.writeUInt16LE(built.length, 10);
	eocd.writeUInt32LE(cdSize, 12);
	eocd.writeUInt32LE(cdStart, 16);
	eocd.writeUInt16LE(0, 20); // comment length

	return Buffer.concat([...localChunks, ...cdChunks, eocd]);
}
