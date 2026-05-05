import { describe, it, expect, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { commitFileToBranch } from '../lib/bot-pr.js';
import type { Octokit } from '@octokit/rest';

/**
 * Mock just the Octokit surface area `commitFileToBranch` actually uses:
 * - repos.getContent (via readFileAtBranch)
 * - repos.createOrUpdateFileContents
 *
 * Anything beyond that is unused; cast through unknown to satisfy TS.
 */
function buildMockClient(opts: {
	existing: string | null;
	createOrUpdate: ReturnType<typeof vi.fn>;
}) {
	const existing = opts.existing;
	const getContent = vi.fn().mockImplementation(async () => {
		if (existing === null) {
			const err = new Error('Not Found') as Error & { status: number };
			err.status = 404;
			throw err;
		}
		return {
			data: {
				type: 'file',
				content: Buffer.from(existing, 'utf8').toString('base64'),
				encoding: 'base64',
				sha: 'existing-blob-sha',
			},
		};
	});
	const client = {
		repos: {
			getContent,
			createOrUpdateFileContents: opts.createOrUpdate,
		},
	} as unknown as Octokit;
	return { client, getContent };
}

const repoIdent = { owner: 'phpvms', repo: 'addon-registry' };

describe('commitFileToBranch no-op detection', () => {
	it('skips the API write when the existing blob matches the new content', async () => {
		const createOrUpdate = vi.fn();
		const { client } = buildMockClient({
			existing: 'name: acme/reports\n',
			createOrUpdate,
		});
		const result = await commitFileToBranch(client, repoIdent, {
			branch: 'bot/bump-acme-reports-1.2.3',
			pathInRepo: 'packages/acme/reports.yml',
			newContent: 'name: acme/reports\n',
			message: 'noop',
		});
		expect(result).toBeNull();
		expect(createOrUpdate).not.toHaveBeenCalled();
	});

	it('writes when the content differs', async () => {
		const createOrUpdate = vi.fn().mockResolvedValue({ data: { commit: { sha: 'new-commit-sha' } } });
		const { client } = buildMockClient({
			existing: 'name: acme/reports\n',
			createOrUpdate,
		});
		const result = await commitFileToBranch(client, repoIdent, {
			branch: 'bot/bump-acme-reports-1.2.3',
			pathInRepo: 'packages/acme/reports.yml',
			newContent: 'name: acme/reports\nrelease:\n  version: "1.2.3"\n',
			message: 'bump',
		});
		expect(result).toBe('new-commit-sha');
		expect(createOrUpdate).toHaveBeenCalledOnce();
		const call = createOrUpdate.mock.calls[0]?.[0];
		expect(call.sha).toBe('existing-blob-sha');
	});

	it('creates a new file when none exists on the branch', async () => {
		const createOrUpdate = vi.fn().mockResolvedValue({ data: { commit: { sha: 'first-commit-sha' } } });
		const { client } = buildMockClient({
			existing: null,
			createOrUpdate,
		});
		const result = await commitFileToBranch(client, repoIdent, {
			branch: 'bot/release-acme-reports-1.2.3',
			pathInRepo: 'packages/acme/reports.yml',
			newContent: 'name: acme/reports\n',
			message: 'release',
		});
		expect(result).toBe('first-commit-sha');
		expect(createOrUpdate).toHaveBeenCalledOnce();
		const call = createOrUpdate.mock.calls[0]?.[0];
		expect(call.sha).toBeUndefined();
	});
});
