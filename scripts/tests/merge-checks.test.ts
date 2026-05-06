import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import {
	checkCommitsAreBotAuthored,
	checkRequiredJobsGreen,
} from '../lib/merge-checks.js';

const repo = { owner: 'phpvms', repo: 'addon-registry' };
const BOT_LOGIN = 'phpvms-registry-bot[bot]';

interface Commit {
	sha: string;
	authorLogin: string | null;
	authorType: string | null;
	verified: boolean;
	verificationReason: string;
}

function buildCommit(opts: Partial<Commit> & { sha: string }): unknown {
	return {
		sha: opts.sha,
		commit: {
			verification: {
				verified: opts.verified ?? true,
				reason: opts.verificationReason ?? 'valid',
			},
		},
		author:
			opts.authorLogin === null
				? null
				: {
						login: opts.authorLogin ?? BOT_LOGIN,
						type: opts.authorType ?? 'Bot',
					},
	};
}

function mockPaginateForCommits(commits: unknown[]): Pick<Octokit, 'paginate' | 'pulls'> {
	const iterator = async function* () {
		yield { data: commits };
	};
	return {
		paginate: {
			iterator: () => iterator(),
		},
		pulls: { listCommits: vi.fn() },
	} as unknown as Pick<Octokit, 'paginate' | 'pulls'>;
}

describe('checkCommitsAreBotAuthored', () => {
	it('returns clean when every commit is bot-authored and verified', async () => {
		const client = mockPaginateForCommits([
			buildCommit({ sha: 'a'.repeat(40) }),
			buildCommit({ sha: 'b'.repeat(40) }),
		]);
		const result = await checkCommitsAreBotAuthored(client as Octokit, repo, 1, BOT_LOGIN);
		expect(result.clean).toBe(true);
	});

	it('flags a commit authored by a human', async () => {
		const client = mockPaginateForCommits([
			buildCommit({ sha: 'a'.repeat(40) }),
			buildCommit({ sha: 'b'.repeat(40), authorLogin: 'malicious-user', authorType: 'User' }),
		]);
		const result = await checkCommitsAreBotAuthored(client as Octokit, repo, 1, BOT_LOGIN);
		expect(result.clean).toBe(false);
		expect(result.offendingSha).toBe('b'.repeat(40));
		expect(result.reason).toContain('malicious-user');
	});

	it('flags a commit by a different bot', async () => {
		const client = mockPaginateForCommits([
			buildCommit({ sha: 'c'.repeat(40), authorLogin: 'other-bot[bot]', authorType: 'Bot' }),
		]);
		const result = await checkCommitsAreBotAuthored(client as Octokit, repo, 1, BOT_LOGIN);
		expect(result.clean).toBe(false);
		expect(result.reason).toContain('other-bot[bot]');
	});

	it('flags an unverified commit signature', async () => {
		const client = mockPaginateForCommits([
			buildCommit({
				sha: 'd'.repeat(40),
				verified: false,
				verificationReason: 'unsigned',
			}),
		]);
		const result = await checkCommitsAreBotAuthored(client as Octokit, repo, 1, BOT_LOGIN);
		expect(result.clean).toBe(false);
		expect(result.reason).toContain('verification failed');
	});

	it('flags a commit with null author', async () => {
		const client = mockPaginateForCommits([
			buildCommit({ sha: 'e'.repeat(40), authorLogin: null }),
		]);
		const result = await checkCommitsAreBotAuthored(client as Octokit, repo, 1, BOT_LOGIN);
		expect(result.clean).toBe(false);
	});

	it('flags an empty PR', async () => {
		const client = mockPaginateForCommits([]);
		const result = await checkCommitsAreBotAuthored(client as Octokit, repo, 1, BOT_LOGIN);
		expect(result.clean).toBe(false);
		expect(result.reason).toContain('no commits');
	});
});

interface CheckRunFixture {
	name: string;
	status: string;
	conclusion: string | null;
}

function mockPaginateForChecks(runs: CheckRunFixture[]): Pick<Octokit, 'paginate' | 'checks'> {
	const iterator = async function* () {
		yield { data: runs };
	};
	return {
		paginate: { iterator: () => iterator() },
		checks: { listForRef: vi.fn() },
	} as unknown as Pick<Octokit, 'paginate' | 'checks'>;
}

describe('checkRequiredJobsGreen', () => {
	const headSha = 'f'.repeat(40);

	it('returns allGreen when every required job has a successful completed run', async () => {
		const client = mockPaginateForChecks([
			{ name: 'test', status: 'completed', conclusion: 'success' },
			{ name: 'validate', status: 'completed', conclusion: 'success' },
			{ name: 'build', status: 'completed', conclusion: 'success' },
		]);
		const r = await checkRequiredJobsGreen(client as Octokit, repo, headSha, ['test', 'validate']);
		expect(r.allGreen).toBe(true);
		expect(r.missing).toEqual([]);
		expect(r.failed).toEqual([]);
	});

	it('marks a required job as missing when it has not completed yet', async () => {
		const client = mockPaginateForChecks([
			{ name: 'test', status: 'completed', conclusion: 'success' },
			{ name: 'validate', status: 'in_progress', conclusion: null },
		]);
		const r = await checkRequiredJobsGreen(client as Octokit, repo, headSha, ['test', 'validate']);
		expect(r.allGreen).toBe(false);
		expect(r.missing).toEqual(['validate']);
		expect(r.failed).toEqual([]);
	});

	it('marks a required job as failed when the run conclusion is not success', async () => {
		const client = mockPaginateForChecks([
			{ name: 'test', status: 'completed', conclusion: 'failure' },
			{ name: 'validate', status: 'completed', conclusion: 'success' },
		]);
		const r = await checkRequiredJobsGreen(client as Octokit, repo, headSha, ['test', 'validate']);
		expect(r.allGreen).toBe(false);
		expect(r.failed).toEqual(['test']);
	});

	it('marks a required job as missing when no run exists with that name', async () => {
		const client = mockPaginateForChecks([
			{ name: 'test', status: 'completed', conclusion: 'success' },
		]);
		const r = await checkRequiredJobsGreen(client as Octokit, repo, headSha, ['test', 'validate']);
		expect(r.allGreen).toBe(false);
		expect(r.missing).toEqual(['validate']);
	});

});
