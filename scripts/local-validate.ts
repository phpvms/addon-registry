/**
 * scripts/local-validate.ts — single-file validator probe for local
 * smoke testing. Bypasses the git-diff plumbing in `validate.ts` so an
 * operator can run `tsx scripts/local-validate.ts packages/foo/bar.yml`
 * without needing a PR/merge-base context.
 *
 * Intended only for the bootstrap smoke test; remove once unnecessary.
 */

import path from 'node:path';
import { runPackageChecks } from './lib/checks.js';
import { renderValidatorComment } from './lib/comment.js';
import { buildOctokit } from './lib/github.js';

async function main(): Promise<void> {
	const arg = process.argv[2];
	if (!arg) {
		console.error('usage: tsx scripts/local-validate.ts <yaml-rel-path>');
		process.exit(2);
	}
	const repoRoot = process.env.REPO_ROOT ?? process.cwd();
	const yamlRelPath = path.relative(repoRoot, path.resolve(repoRoot, arg));
	const octokit = buildOctokit(process.env.GITHUB_TOKEN);

	const outcome = await runPackageChecks({ repoRoot, yamlRelPath, octokit });

	console.log(JSON.stringify(outcome, null, 2));
	console.log('\n--- rendered PR comment ---\n');
	console.log(renderValidatorComment([outcome]));

	process.exit(outcome.issues.length === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
