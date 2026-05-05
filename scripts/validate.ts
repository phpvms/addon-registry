/**
 * scripts/validate.ts — PR-time validator entry point.
 *
 * Triggered by `.github/workflows/validate-pr.yml`. Detects which YAML
 * files changed in the PR (relative to the merge base), runs each check,
 * posts a single PR comment, and exits non-zero if any check failed.
 *
 * Inputs (env):
 *  - GITHUB_TOKEN: token used for read-only API calls (Actions default).
 *  - APP_TOKEN (optional): App installation token used for posting the
 *    PR comment. Falls back to GITHUB_TOKEN if absent.
 *  - GITHUB_REPOSITORY: "owner/repo" of the canonical repo.
 *  - PR_NUMBER: PR number to comment on.
 *  - BASE_SHA / HEAD_SHA: commit shas defining the changed-file diff.
 *  - REPO_ROOT (optional, default cwd): repository root for file reads.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildOctokit, parseRepository, upsertComment } from './lib/github.js';
import { runPackageChecks, type PackageCheckOutcome } from './lib/checks.js';
import { renderValidatorComment, VALIDATOR_COMMENT_MARKER } from './lib/comment.js';

interface Env {
	repoRoot: string;
	githubToken: string;
	appToken?: string;
	repoSpec: string;
	prNumber: number;
	baseSha: string;
	headSha: string;
}

function readEnv(): Env {
	const repoRoot = process.env.REPO_ROOT ?? process.cwd();
	const githubToken = process.env.GITHUB_TOKEN;
	if (!githubToken) throw new Error('GITHUB_TOKEN is required');
	const repoSpec = process.env.GITHUB_REPOSITORY;
	if (!repoSpec) throw new Error('GITHUB_REPOSITORY is required (e.g. "phpvms/addon-registry")');
	const prRaw = process.env.PR_NUMBER;
	if (!prRaw) throw new Error('PR_NUMBER is required');
	const prNumber = Number.parseInt(prRaw, 10);
	if (!Number.isFinite(prNumber)) throw new Error(`PR_NUMBER is not a number: ${prRaw}`);
	const baseSha = process.env.BASE_SHA;
	const headSha = process.env.HEAD_SHA;
	if (!baseSha || !headSha) throw new Error('BASE_SHA and HEAD_SHA are required');
	return {
		repoRoot,
		githubToken,
		appToken: process.env.APP_TOKEN,
		repoSpec,
		prNumber,
		baseSha,
		headSha,
	};
}

function changedYamlFiles(repoRoot: string, baseSha: string, headSha: string): string[] {
	// `git diff` pathspecs do NOT support `**`; passing it makes git look for
	// a literal directory of that name and silently match nothing. Use an
	// unfiltered diff and filter in JS instead — same outcome, no traps.
	const out = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
		cwd: repoRoot,
		encoding: 'utf8',
	});
	return out
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.filter((l) => l.startsWith('packages/') && l.endsWith('.yml'))
		.filter((l) => path.basename(l) !== 'meta.yml');
}

async function main(): Promise<void> {
	const env = readEnv();
	const repoIdent = parseRepository(env.repoSpec);
	const readClient = buildOctokit(env.githubToken);
	const writeClient = buildOctokit(env.appToken ?? env.githubToken);

	const changed = changedYamlFiles(env.repoRoot, env.baseSha, env.headSha);
	if (changed.length === 0) {
		console.log('No package YAML changes detected; nothing to validate.');
		return;
	}

	console.log(`Validating ${changed.length} package YAML file(s):`);
	for (const f of changed) console.log(`  - ${f}`);

	const outcomes: PackageCheckOutcome[] = [];
	for (const yamlRelPath of changed) {
		console.log(`\n--- ${yamlRelPath}`);
		const outcome = await runPackageChecks({
			repoRoot: env.repoRoot,
			yamlRelPath,
			octokit: readClient,
		});
		outcomes.push(outcome);
		if (outcome.issues.length > 0) {
			console.log(`  ${outcome.issues.length} issue(s):`);
			for (const issue of outcome.issues) {
				console.log(`    - [${issue.rule}] ${issue.message}`);
			}
		} else {
			console.log(`  passed`);
		}
	}

	const body = renderValidatorComment(outcomes);
	await upsertComment(writeClient, repoIdent, env.prNumber, VALIDATOR_COMMENT_MARKER, body);

	const failed = outcomes.some((o) => o.issues.length > 0);
	if (failed) {
		console.error('\nValidation failed.');
		process.exit(1);
	}
	console.log('\nValidation passed.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
