/**
 * scripts/build-index.ts — build & upload the registry index.
 *
 * Pipeline:
 *  1. Read all `packages/{a}/{b}.yml` and `packages/{a}/meta.yml`.
 *  2. Produce `dist/raw/packages.json` and `dist/raw/keywords.json`
 *     (deterministic, byte-stable for identical input).
 *  3. Upload both to R2 under `raw/`.
 *  4. POST to the worker's `/v1/internal/refresh` endpoint with a Bearer
 *     token from `WORKER_REFRESH_SECRET`.
 *
 * Flags:
 *   --no-upload    Build only; do not upload or refresh. Used in tests.
 *   --no-refresh   Upload but skip the refresh POST.
 *
 * Environment:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildIndex } from './lib/build-index.js';
import { buildR2Client, loadR2CredentialsFromEnv, putJson } from './lib/r2.js';

interface CliFlags {
	upload: boolean;
	refresh: boolean;
}

function parseFlags(argv: string[]): CliFlags {
	const flags: CliFlags = { upload: true, refresh: true };
	for (const a of argv) {
		if (a === '--no-upload') flags.upload = false;
		if (a === '--no-refresh') flags.refresh = false;
	}
	return flags;
}

const DEFAULT_REFRESH_URL = 'https://api.registry.phpvms.net/v1/internal/refresh';

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	const repoRoot = process.cwd();

	console.log(`Building index from ${repoRoot}/packages/ ...`);
	const result = buildIndex(repoRoot);

	const distDir = path.join(repoRoot, 'dist', 'raw');
	mkdirSync(distDir, { recursive: true });
	writeFileSync(path.join(distDir, 'packages.json'), result.packagesJson, 'utf8');
	writeFileSync(path.join(distDir, 'keywords.json'), result.keywordsJson, 'utf8');
	console.log(`Wrote ${distDir}/packages.json (${Object.keys(result.packages).length} package(s))`);
	console.log(`Wrote ${distDir}/keywords.json (${Object.keys(result.keywords).length} keyword(s))`);

	if (!flags.upload) {
		console.log('Skipping upload (--no-upload).');
		return;
	}

	const creds = loadR2CredentialsFromEnv();
	const client = buildR2Client(creds);
	console.log(`Uploading to R2 bucket "${creds.bucket}" ...`);

	try {
		await putJson(client, creds, 'raw/packages.json', result.packagesJson);
		await putJson(client, creds, 'raw/keywords.json', result.keywordsJson);
	} catch (err) {
		console.error(`R2 upload failed: ${(err as Error).message}`);
		process.exit(1);
	}

	console.log('R2 uploads complete.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
