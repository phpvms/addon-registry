import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { diffRange, buildPayload, postPayload } from '@phpvms/registry-client';

const ZERO_SHA = '0000000000000000000000000000000000000000';

const PUBLISHER_YAML = `meta:
  name: Acme
  url: https://acme.example.com
  maintainers:
    - acme-dev
addons:
  - name: reports
    description: Reports addon
    category: reporting
    license: MIT
    keywords:
      - reports
    source:
      type: github-release
      repository: acme/reports-addon
    requirements:
      php: ">=8.3"
      phpvms: ">=7.0.0"
`;

/** Create a throwaway repo root with the given publisher files. */
function makeRepo(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), 'publish-test-'));
	mkdirSync(path.join(root, 'packages'), { recursive: true });
	for (const [rel, contents] of Object.entries(files)) {
		writeFileSync(path.join(root, rel), contents);
	}
	return root;
}

describe('diffRange', () => {
	test('normal push uses the before...after range', () => {
		expect(diffRange('base123', 'head456')).toBe('base123...head456');
	});

	test('empty base (workflow_dispatch) falls back to HEAD^..HEAD', () => {
		expect(diffRange('', 'HEAD')).toBe('HEAD^..HEAD');
	});

	test('zero SHA (first push) falls back to the single tip commit', () => {
		expect(diffRange(ZERO_SHA, 'abc')).toBe('abc^..abc');
	});
});

describe('buildPayload', () => {
	const ENV_KEYS = ['HEAD_SHA', 'COMMIT_AUTHOR_NAME', 'COMMIT_AUTHOR_EMAIL', 'COMMIT_MESSAGE', 'GITHUB_REF', 'GITHUB_REPOSITORY'];

	afterEach(() => {
		for (const k of ENV_KEYS) delete process.env[k];
	});

	test('assembles meta from env and converts each file to JSON', () => {
		process.env.HEAD_SHA = 'deadbeef';
		process.env.COMMIT_AUTHOR_NAME = 'Jane Doe';
		process.env.COMMIT_AUTHOR_EMAIL = 'jane@example.com';
		process.env.COMMIT_MESSAGE = 'feat: add reports';
		const root = makeRepo({ 'packages/acme.yml': PUBLISHER_YAML });

		const payload = buildPayload(root, ['packages/acme.yml']);

		expect(payload.meta.commit).toBe('deadbeef');
		expect(payload.meta.author).toBe('Jane Doe');
		expect(payload.meta.email).toBe('jane@example.com');
		expect(payload.meta.message).toBe('feat: add reports');
		expect(payload.meta.count).toBe(1);
		expect(payload.data[0]!.meta.name).toBe('Acme');
		expect(payload.data[0]!.addons[0]!.name).toBe('reports');

		rmSync(root, { recursive: true, force: true });
	});

	test('count tracks the number of data entries', () => {
		const root = makeRepo({ 'packages/acme.yml': PUBLISHER_YAML, 'packages/beta.yml': PUBLISHER_YAML });

		const payload = buildPayload(root, ['packages/acme.yml', 'packages/beta.yml']);

		expect(payload.meta.count).toBe(2);
		expect(payload.data).toHaveLength(2);

		rmSync(root, { recursive: true, force: true });
	});

	test('empty / whitespace env vars normalize to null (workflow_dispatch)', () => {
		process.env.COMMIT_AUTHOR_NAME = '   ';
		const root = makeRepo({ 'packages/acme.yml': PUBLISHER_YAML });

		const payload = buildPayload(root, ['packages/acme.yml']);

		expect(payload.meta.author).toBeNull();
		expect(payload.meta.commit).toBeNull();
		expect(payload.meta.message).toBeNull();

		rmSync(root, { recursive: true, force: true });
	});
});

describe('postPayload', () => {
	const realFetch = globalThis.fetch;
	const payload = { meta: { count: 0, timestamp: 't' }, data: [] } as unknown as Parameters<typeof postPayload>[1];

	afterEach(() => {
		globalThis.fetch = realFetch;
		delete process.env.WEBHOOK_SECRET;
		delete process.env.WEBHOOK_SECRET_HEADER;
	});

	test('sends JSON body and the default secret header', async () => {
		process.env.WEBHOOK_SECRET = 's3cr3t';
		let captured: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			captured = { url, init };
			return new Response('ok', { status: 200, statusText: 'OK' });
		}) as typeof fetch;

		await postPayload('https://hook.example.com', payload);

		const headers = captured!.init.headers as Record<string, string>;
		expect(captured!.url).toBe('https://hook.example.com');
		expect(captured!.init.method).toBe('POST');
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers['X-Webhook-Secret']).toBe('s3cr3t');
		expect(JSON.parse(captured!.init.body as string).meta.count).toBe(0);
	});

	test('honors a custom secret header name', async () => {
		process.env.WEBHOOK_SECRET = 'tok';
		process.env.WEBHOOK_SECRET_HEADER = 'Authorization';
		let headers: Record<string, string> = {};
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			headers = init.headers as Record<string, string>;
			return new Response('ok', { status: 200, statusText: 'OK' });
		}) as typeof fetch;

		await postPayload('https://hook.example.com', payload);

		expect(headers.Authorization).toBe('tok');
		expect(headers['X-Webhook-Secret']).toBeUndefined();
	});

	test('omits the secret header when no secret is set', async () => {
		let headers: Record<string, string> = {};
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			headers = init.headers as Record<string, string>;
			return new Response('ok', { status: 200, statusText: 'OK' });
		}) as typeof fetch;

		await postPayload('https://hook.example.com', payload);

		expect(headers['X-Webhook-Secret']).toBeUndefined();
	});

	test('throws on a non-2xx response, including status and body', async () => {
		globalThis.fetch = (async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as typeof fetch;

		await expect(postPayload('https://hook.example.com', payload)).rejects.toThrow(/500.*boom/);
	});
});
