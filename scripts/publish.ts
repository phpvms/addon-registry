#!/usr/bin/env bun
/**
 * scripts/publish.ts — post merged package changes to a webhook.
 *
 * Runs on push to main (post-merge). Does two things:
 *
 *   1. POSTs the *changed* publisher files to WEBHOOK_URL as a single payload.
 *   2. Writes a *full catalogue* snapshot (every packages/*.yml) to OUTPUT_FILE,
 *      which the workflow uploads as a build artifact.
 *
 * Both share this shape (full file JSON per data entry):
 *
 *   {
 *     meta: { commit, author, email, message, ref, repository, timestamp, count },
 *     data: [ { meta: {...}, addons: [...] }, ... ]
 *   }
 *
 * Usage:
 *   bun scripts/publish.ts [file ...]                publish the given YAMLs
 *   BASE_SHA=.. HEAD_SHA=.. bun scripts/publish.ts   publish the push diff
 *
 * Env:
 *   WEBHOOK_URL            destination endpoint. If unset, the POST is skipped
 *                          (so merges to main don't fail before it's configured).
 *   WEBHOOK_SECRET         optional; sent as a header for the receiver to verify.
 *   WEBHOOK_SECRET_HEADER  optional; header name for the secret (default: X-Webhook-Secret).
 *   OUTPUT_FILE            optional; catalogue snapshot path (default: dist/registry.json).
 *   BASE_SHA / HEAD_SHA    push range (before/after). HEAD_SHA defaults to HEAD.
 *   COMMIT_AUTHOR_NAME     optional; recorded in meta.author.
 *   COMMIT_AUTHOR_EMAIL    optional; recorded in meta.email.
 *   COMMIT_MESSAGE         optional; recorded in meta.message.
 *   GITHUB_REPOSITORY      optional; owner/repo, recorded in meta.
 *   GITHUB_REF             optional; ref, recorded in meta.
 *   REPO_ROOT             optional; defaults to the current working directory.
 *   DRY_RUN               optional; when set, print the payload and skip the POST.
 *
 * Exits non-zero if the webhook responds with a non-2xx status.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readYaml, type PublisherYaml } from './lib/yaml.js';
import { filterPublisherYamlPaths } from './validate.js';

const ZERO_SHA = '0000000000000000000000000000000000000000';
const DEFAULT_SECRET_HEADER = 'X-Webhook-Secret';
const DEFAULT_OUTPUT_FILE = 'dist/registry.json';

interface PublishMeta {
	commit: string | null;
	author: string | null;
	email: string | null;
	message: string | null;
	ref: string | null;
	repository: string | null;
	timestamp: string;
	count: number;
}

interface PublishPayload {
	meta: PublishMeta;
	data: PublisherYaml[];
}

// --- File discovery --------------------------------------------------------

/**
 * Build the `git diff` revision range. On a new branch / first push (or a
 * manual workflow_dispatch), `before` is the zero SHA or empty — fall back to
 * the single tip commit so we still publish what just landed.
 */
export function diffRange(baseSha: string, headSha: string): string {
	return !baseSha || baseSha === ZERO_SHA ? `${headSha}^..${headSha}` : `${baseSha}...${headSha}`;
}

/** Publisher YAMLs changed between two commits (excludes deleted paths). */
function changedYamlFiles(repoRoot: string, baseSha: string, headSha: string): string[] {
	const range = diffRange(baseSha, headSha);
	const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRT', range], {
		cwd: repoRoot,
		encoding: 'utf8',
	});
	return filterPublisherYamlPaths(out.split('\n'));
}

/** Every publisher YAML under packages/ (for the full-catalogue snapshot). */
function allPublisherYamls(repoRoot: string): string[] {
	try {
		return readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })
			.filter((d) => d.isFile() && d.name.endsWith('.yml'))
			.map((d) => `packages/${d.name}`)
			.sort();
	} catch {
		return [];
	}
}

function resolveTargets(repoRoot: string): string[] {
	const args = process.argv.slice(2);
	if (args.length > 0) {
		return filterPublisherYamlPaths(args.map((a) => path.relative(repoRoot, path.resolve(repoRoot, a))));
	}
	const baseSha = process.env.BASE_SHA ?? '';
	const headSha = process.env.HEAD_SHA || 'HEAD';
	return changedYamlFiles(repoRoot, baseSha, headSha);
}

// --- Payload + delivery ----------------------------------------------------

/** Treat empty/whitespace env vars (common on workflow_dispatch) as absent. */
function env(name: string): string | null {
	const v = process.env[name];
	return v && v.trim() ? v : null;
}

export function buildPayload(repoRoot: string, targets: string[]): PublishPayload {
	const data = targets.map((rel) => readYaml<PublisherYaml>(path.join(repoRoot, rel)));
	return {
		meta: {
			commit: env('HEAD_SHA'),
			author: env('COMMIT_AUTHOR_NAME'),
			email: env('COMMIT_AUTHOR_EMAIL'),
			message: env('COMMIT_MESSAGE'),
			ref: env('GITHUB_REF'),
			repository: env('GITHUB_REPOSITORY'),
			timestamp: new Date().toISOString(),
			count: data.length,
		},
		data,
	};
}

/** Write the full-catalogue snapshot to OUTPUT_FILE and return its path. */
function writeCatalogue(repoRoot: string): string {
	const payload = buildPayload(repoRoot, allPublisherYamls(repoRoot));
	const outRel = process.env.OUTPUT_FILE || DEFAULT_OUTPUT_FILE;
	const outAbs = path.resolve(repoRoot, outRel);
	mkdirSync(path.dirname(outAbs), { recursive: true });
	writeFileSync(outAbs, `${JSON.stringify(payload, null, 2)}\n`);
	console.log(`Wrote full catalogue (${payload.meta.count} publisher file(s)) to ${outRel}.`);
	return outAbs;
}

export async function postPayload(url: string, payload: PublishPayload): Promise<void> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	const secret = process.env.WEBHOOK_SECRET;
	if (secret) {
		const headerName = process.env.WEBHOOK_SECRET_HEADER || DEFAULT_SECRET_HEADER;
		headers[headerName] = secret;
	}

	const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Webhook responded ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 500)}` : ''}`);
	}
	console.log(`Webhook accepted payload (${res.status} ${res.statusText}).`);
}

async function main(): Promise<void> {
	const repoRoot = process.env.REPO_ROOT ?? process.cwd();

	// Always emit the full-catalogue snapshot artifact, regardless of the diff.
	writeCatalogue(repoRoot);

	const targets = resolveTargets(repoRoot);
	if (targets.length === 0) {
		console.log('No publisher YAML changes detected; nothing to POST.');
		return;
	}

	console.log(`Publishing ${targets.length} publisher YAML file(s):`);
	for (const f of targets) console.log(`  - ${f}`);

	const payload = buildPayload(repoRoot, targets);

	if (process.env.DRY_RUN) {
		console.log('\nDRY_RUN set — payload (not sent):');
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	const url = process.env.WEBHOOK_URL;
	if (!url) {
		console.log('\nWEBHOOK_URL not set — skipping POST. Configure the secret to enable publishing.');
		return;
	}

	await postPayload(url, payload);
}

// Only auto-run when invoked as a script, not when imported (e.g. tests).
const entryUrl = process.argv[1] ? new URL(`file://${path.resolve(process.argv[1])}`).href : '';
if (import.meta.url === entryUrl) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
