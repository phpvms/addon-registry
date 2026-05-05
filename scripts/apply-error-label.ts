/**
 * scripts/apply-error-label.ts — manage the `error` label on bot PRs.
 *
 * Called by validate-pr.yml *only* when the PR was opened by the bot.
 * On validator failure, applies `error`. On success, removes it.
 *
 * Environment:
 *   APP_TOKEN — installation token with `issues: write`.
 *   GITHUB_REPOSITORY, PR_NUMBER, OUTCOME ("pass" | "fail")
 */

import { addLabel, buildOctokit, parseRepository, removeLabel } from './lib/github.js';

async function main(): Promise<void> {
	const repoSpec = process.env.GITHUB_REPOSITORY;
	const prRaw = process.env.PR_NUMBER;
	const outcome = process.env.OUTCOME;
	const token = process.env.APP_TOKEN ?? process.env.GITHUB_TOKEN;
	if (!repoSpec || !prRaw || !outcome || !token) {
		throw new Error('Missing required env: GITHUB_REPOSITORY, PR_NUMBER, OUTCOME, APP_TOKEN');
	}
	const prNumber = Number.parseInt(prRaw, 10);
	if (!Number.isFinite(prNumber)) throw new Error(`PR_NUMBER not a number: ${prRaw}`);

	const client = buildOctokit(token);
	const repo = parseRepository(repoSpec);

	if (outcome === 'fail') {
		await addLabel(client, repo, prNumber, 'error');
		console.log(`Applied 'error' label to PR #${prNumber}`);
	} else if (outcome === 'pass') {
		await removeLabel(client, repo, prNumber, 'error');
		console.log(`Removed 'error' label from PR #${prNumber} (if present)`);
	} else {
		throw new Error(`OUTCOME must be 'pass' or 'fail', got "${outcome}"`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
