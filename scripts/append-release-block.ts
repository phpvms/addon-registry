/**
 * scripts/append-release-block.ts — apply a resolved release block to a
 * YAML file in place, then print a one-line summary.
 *
 * Usage:
 *   tsx scripts/append-release-block.ts packages/acme/reports.yml [tag]
 *
 * If `tag` is given, that release is used; otherwise the latest stable
 * upstream release is selected.
 */

import path from 'node:path';
import { buildOctokit } from './lib/github.js';
import { resolveRelease } from './lib/resolve-release.js';
import { applyReleaseBlock } from './lib/append-release-block.js';

async function main(): Promise<void> {
	const yamlRelPath = process.argv[2];
	if (!yamlRelPath) {
		console.error('Usage: tsx scripts/append-release-block.ts packages/{author}/{name}.yml [tag]');
		process.exit(2);
	}
	const preferTag = process.argv[3] || undefined;
	const octokit = buildOctokit(process.env.GITHUB_TOKEN);
	const yamlAbsPath = path.resolve(process.cwd(), yamlRelPath);
	const outcome = await resolveRelease({ yamlAbsPath, octokit, preferTag });

	if (outcome.kind !== 'release') {
		console.error(`Not appending: ${outcome.kind}`);
		if ('details' in outcome) console.error(outcome.details);
		process.exit(outcome.kind === 'skip' ? 0 : 1);
	}

	applyReleaseBlock({ yamlPath: yamlAbsPath, release: outcome.release, write: true });
	console.log(`Wrote release ${outcome.release.tag} (${outcome.release.version}) to ${yamlRelPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
