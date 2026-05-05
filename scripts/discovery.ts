/**
 * scripts/discovery.ts — version discovery sweep.
 *
 * Modes:
 *  - sweep      (default): check all non-revoked, non-archived YAMLs
 *  - dispatch   --name acme/reports --tag v1.2.3 [--repository acme/x]
 *  - merge      --skip packages/acme/reports.yml (skip just-merged YAML)
 *
 * Behavior:
 *  - For each candidate, resolve the latest stable release.
 *  - If the resolved version differs from the YAML's pinned version,
 *    open or update a `bot/bump-{author}-{name}-{version}` PR with the
 *    new release block.
 *  - Skip if there's already an open bot PR for the same package
 *    (concurrent-bump prevention). When the existing PR is for an older
 *    version, retarget the branch by force-updating its single commit.
 *
 * Environment:
 *   GITHUB_TOKEN     — read-only for upstream queries.
 *   APP_TOKEN        — App installation token for opening PRs.
 *   GITHUB_REPOSITORY — owner/repo of this registry (required for dispatch / merge / sweep).
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildOctokit, parseRepository, type RepoIdentity } from './lib/github.js';
import { readYaml, type PackageYaml } from './lib/yaml.js';
import { resolveRelease, type ResolvedRelease } from './lib/resolve-release.js';
import { applyReleaseBlock } from './lib/append-release-block.js';
import {
	bumpBranchName,
	bumpPrTitle,
	commitFileToBranch,
	findOpenBotPrForPackage,
	getBaseSha,
	openOrUpdateBotPr,
	releaseBlockPrTitle,
	releaseBranchName,
	upsertBranch,
} from './lib/bot-pr.js';
import { compareVersions } from './lib/semver.js';

interface CliArgs {
	mode: 'sweep' | 'dispatch' | 'merge';
	skip?: string;
	name?: string;
	tag?: string;
	dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { mode: 'sweep', dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--dispatch') args.mode = 'dispatch';
		else if (a === '--merge') args.mode = 'merge';
		else if (a === '--sweep') args.mode = 'sweep';
		else if (a === '--name') args.name = argv[++i];
		else if (a === '--tag') args.tag = argv[++i];
		else if (a === '--skip') args.skip = argv[++i];
		else if (a === '--dry-run') args.dryRun = true;
	}
	return args;
}

interface PackageRef {
	yamlRelPath: string;
	yamlAbsPath: string;
	data: PackageYaml;
}

function listPackageYamls(repoRoot: string): PackageRef[] {
	const out: PackageRef[] = [];
	const packagesDir = path.join(repoRoot, 'packages');
	for (const author of readdirSync(packagesDir)) {
		const authorDir = path.join(packagesDir, author);
		if (!statSync(authorDir).isDirectory()) continue;
		for (const file of readdirSync(authorDir)) {
			if (file === 'meta.yml') continue;
			if (!file.endsWith('.yml')) continue;
			const yamlAbsPath = path.join(authorDir, file);
			const yamlRelPath = path.join('packages', author, file);
			let data: PackageYaml;
			try {
				data = readYaml<PackageYaml>(yamlAbsPath);
			} catch {
				continue;
			}
			out.push({ yamlRelPath, yamlAbsPath, data });
		}
	}
	return out;
}

async function processOne(opts: {
	pkg: PackageRef;
	repoIdent: RepoIdentity;
	repoRoot: string;
	octokit: ReturnType<typeof buildOctokit>;
	writeOctokit: ReturnType<typeof buildOctokit>;
	dryRun: boolean;
	preferTag?: string;
}): Promise<void> {
	const { pkg, repoIdent, octokit, writeOctokit, dryRun, preferTag } = opts;

	if (pkg.data.revoked === true || pkg.data.archived === true) {
		console.log(`  skip ${pkg.data.name}: ${pkg.data.revoked ? 'revoked' : 'archived'}`);
		return;
	}

	const outcome = await resolveRelease({
		yamlAbsPath: pkg.yamlAbsPath,
		octokit,
		preferTag,
	});

	if (outcome.kind !== 'release') {
		console.log(`  ${pkg.data.name}: ${outcome.kind}${'details' in outcome ? ` — ${outcome.details}` : ''}`);
		return;
	}

	const resolved = outcome.release;
	const pinned = pkg.data.release?.version;
	const isInitialRelease = !pinned;
	const isNewer = pinned ? compareVersions(resolved.version, pinned) > 0 : true;

	if (!isInitialRelease && !isNewer) {
		console.log(`  ${pkg.data.name}: pinned ${pinned} ≥ upstream ${resolved.version}, no bump needed`);
		return;
	}

	console.log(
		`  ${pkg.data.name}: ${isInitialRelease ? `pinning initial ${resolved.version}` : `${pinned} -> ${resolved.version}`}`,
	);

	if (dryRun) {
		console.log('    (dry run; not opening PR)');
		return;
	}

	// Prevent duplicate bumps: any open bot PR for this package wins.
	const existingPr = await findOpenBotPrForPackage(writeOctokit, repoIdent, pkg.data.name);
	if (existingPr && !existingPr.head.endsWith(`-${resolved.version}`)) {
		console.log(
			`    open bot PR #${existingPr.number} (${existingPr.head}) found; retargeting its branch to ${resolved.version}`,
		);
		await retargetExistingPr({
			octokit: writeOctokit,
			repoIdent,
			pkg,
			resolved,
			branch: existingPr.head,
		});
		return;
	}
	if (existingPr && existingPr.head.endsWith(`-${resolved.version}`)) {
		console.log(`    open bot PR #${existingPr.number} already targeting ${resolved.version}; nothing to do`);
		return;
	}

	// Branch + title differ for initial release vs. version bump per spec
	// (release-automation/spec.md). The bot/release-* branch is for the
	// post-merge release-block append; bot/bump-* is for upstream version
	// updates against an already-pinned package.
	const branch = isInitialRelease
		? releaseBranchName(pkg.data.name, resolved.version)
		: bumpBranchName(pkg.data.name, resolved.version);
	const baseSha = await getBaseSha(writeOctokit, repoIdent, 'main');
	await upsertBranch(writeOctokit, repoIdent, branch, baseSha);

	const newContent = applyReleaseBlock({ yamlPath: pkg.yamlAbsPath, release: resolved });
	const message = isInitialRelease
		? `release: ${pkg.data.name} ${resolved.version}`
		: `bump: ${pkg.data.name} ${pinned} -> ${resolved.version}`;

	const committed = await commitFileToBranch(writeOctokit, repoIdent, {
		branch,
		pathInRepo: pkg.yamlRelPath,
		newContent,
		message,
	});
	if (!committed) {
		console.log(`    no-op: ${pkg.yamlRelPath} on ${branch} already at ${resolved.version}`);
		return;
	}

	const title = isInitialRelease
		? releaseBlockPrTitle(pkg.data.name, resolved.version)
		: bumpPrTitle(pkg.data.name, pinned!, resolved.version);

	const body = renderBumpBody({ pkg, resolved, pinned });
	const { number, created } = await openOrUpdateBotPr(writeOctokit, repoIdent, {
		branch,
		title,
		baseBranch: 'main',
		body,
	});
	console.log(`    ${created ? 'opened' : 'updated'} PR #${number}`);
}

/**
 * Retarget an open bot PR to a newer upstream version.
 *
 * INVARIANT: this is called on a workflow checkout of `main`, so
 * `pkg.yamlAbsPath` reads `main`'s YAML content (the version pinned
 * before this discovery run). `applyReleaseBlock(write:false)` returns
 * the desired new content without mutating the local working tree, then
 * we force-reset the bot branch to `main`'s tip and commit the new
 * content there. The original bot branch's commit history is discarded;
 * we keep a single squash-mergeable commit per branch.
 */
async function retargetExistingPr(opts: {
	octokit: ReturnType<typeof buildOctokit>;
	repoIdent: RepoIdentity;
	pkg: PackageRef;
	resolved: ResolvedRelease;
	branch: string;
}): Promise<void> {
	const { octokit, repoIdent, pkg, resolved, branch } = opts;
	const baseSha = await getBaseSha(octokit, repoIdent, 'main');
	await upsertBranch(octokit, repoIdent, branch, baseSha);
	const newContent = applyReleaseBlock({ yamlPath: pkg.yamlAbsPath, release: resolved });
	await commitFileToBranch(octokit, repoIdent, {
		branch,
		pathInRepo: pkg.yamlRelPath,
		newContent,
		message: `bump: ${pkg.data.name} -> ${resolved.version} (retarget)`,
	});
}

function renderBumpBody(opts: { pkg: PackageRef; resolved: ResolvedRelease; pinned: string | undefined }): string {
	const { pkg, resolved, pinned } = opts;
	return [
		`Automated ${pinned ? 'version bump' : 'initial release block'} for **${pkg.data.name}**.`,
		'',
		`- Repository: \`${pkg.data.source.repository}\``,
		`- ${pinned ? `Old version: \`${pinned}\`` : 'Initial release'}`,
		`- New version: \`${resolved.version}\``,
		`- Tag: \`${resolved.tag}\``,
		`- Zip URL: ${resolved.zip_url}`,
		`- SHA-256: \`${resolved.sha256}\``,
		'',
		`This PR is opened by \`phpvms-addon-bot\` and has auto-merge enabled.`,
		`If validation fails, the bot will apply the \`error\` label.`,
	].join('\n');
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const repoRoot = process.cwd();
	const repoSpec = process.env.GITHUB_REPOSITORY;
	if (!repoSpec) throw new Error('GITHUB_REPOSITORY is required');
	const repoIdent = parseRepository(repoSpec);

	const octokit = buildOctokit(process.env.GITHUB_TOKEN);
	const writeOctokit = buildOctokit(process.env.APP_TOKEN ?? process.env.GITHUB_TOKEN);

	let candidates = listPackageYamls(repoRoot);

	if (args.mode === 'merge' && args.skip) {
		const skipNorm = args.skip.replace(/^\.\//, '');
		candidates = candidates.filter((p) => p.yamlRelPath !== skipNorm);
	}

	if (args.mode === 'dispatch') {
		if (!args.name) {
			console.error('--dispatch requires --name {author/name}');
			process.exit(2);
		}
		candidates = candidates.filter((p) => p.data.name === args.name);
		if (candidates.length === 0) {
			console.log(`No package found with name ${args.name}; exiting cleanly.`);
			return;
		}
	}

	console.log(`Discovery sweep: ${candidates.length} package(s) (mode=${args.mode}${args.dryRun ? ', dry-run' : ''})`);
	for (const pkg of candidates) {
		await processOne({
			pkg,
			repoIdent,
			repoRoot,
			octokit,
			writeOctokit,
			dryRun: args.dryRun,
			preferTag: args.mode === 'dispatch' ? args.tag : undefined,
		});
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
