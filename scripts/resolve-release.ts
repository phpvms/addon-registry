/**
 * scripts/resolve-release.ts — given a package YAML path, query upstream
 * and emit a fully-resolved `release:` block to stdout (or skip notice
 * to stderr if revoked/archived/unreachable).
 *
 * Usage:
 *   tsx scripts/resolve-release.ts packages/acme/reports.yml
 *
 * Environment:
 *   GITHUB_TOKEN: read-only token for upstream queries.
 */

import path from 'node:path';
import { buildOctokit } from './lib/github.js';
import { resolveRelease } from './lib/resolve-release.js';
import { renderReleaseBlock } from './lib/append-release-block.js';

async function main(): Promise<void> {
	const yamlRelPath = process.argv[2];
	if (!yamlRelPath) {
		console.error('Usage: tsx scripts/resolve-release.ts packages/{author}/{name}.yml [tag]');
		process.exit(2);
	}
	const preferTag = process.argv[3] || undefined;
	const octokit = buildOctokit(process.env.GITHUB_TOKEN);
	const yamlAbsPath = path.resolve(process.cwd(), yamlRelPath);
	const outcome = await resolveRelease({ yamlAbsPath, octokit, preferTag });

	switch (outcome.kind) {
		case 'skip':
			console.error(`Skipped: package is ${outcome.reason}`);
			return;
		case 'no-stable-release':
			console.error(`No stable release: ${outcome.details}`);
			process.exit(1);
			return;
		case 'no-zip-asset':
			console.error(`Tag ${outcome.tag} has no zip asset`);
			process.exit(1);
			return;
		case 'error':
			console.error(`Error: ${outcome.details}`);
			process.exit(1);
			return;
		case 'release':
			process.stdout.write(renderReleaseBlock(outcome.release));
			return;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
