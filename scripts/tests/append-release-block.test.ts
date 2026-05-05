import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyReleaseBlock } from '../lib/append-release-block.js';

const sample = `# A package
name: acme/reports
description: Reports
category: reporting
license: MIT
keywords:
  - reports
  - analytics
source:
  type: github-release
  repository: acme/reports-addon
requirements:
  php: ">=8.3"
  phpvms: ">=7.0.0"
`;

let tmpDir: string;
let yamlPath: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'addon-registry-'));
	yamlPath = path.join(tmpDir, 'reports.yml');
	writeFileSync(yamlPath, sample, 'utf8');
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const release = {
	version: '1.2.3',
	tag: 'v1.2.3',
	zip_url: 'https://github.com/acme/reports-addon/releases/download/v1.2.3/reports.zip',
	sha256: 'a'.repeat(64),
	published_at: '2025-01-01T00:00:00Z',
};

describe('applyReleaseBlock', () => {
	it('appends a release block when none exists', () => {
		const next = applyReleaseBlock({ yamlPath, release });
		expect(next).toContain('release:');
		expect(next).toContain(`version: "${release.version}"`);
		expect(next).toContain(`sha256: "${release.sha256}"`);
		// existing fields preserved
		expect(next).toContain('name: acme/reports');
		expect(next).toContain('description: Reports');
	});

	it('replaces an existing release block on second apply', () => {
		const first = applyReleaseBlock({ yamlPath, release, write: true });
		expect(first).toContain('1.2.3');
		const next = applyReleaseBlock({
			yamlPath,
			release: { ...release, version: '2.0.0', tag: 'v2.0.0' },
			write: true,
		});
		// only one release: line
		const matches = (next.match(/^release:/gm) ?? []).length;
		expect(matches).toBe(1);
		expect(next).toContain('version: "2.0.0"');
		expect(next).not.toContain('version: "1.2.3"');
	});

	it('writes to disk when write:true', () => {
		applyReleaseBlock({ yamlPath, release, write: true });
		const ondisk = readFileSync(yamlPath, 'utf8');
		expect(ondisk).toContain(`tag: "v1.2.3"`);
	});

	it('preserves comments above existing content', () => {
		const next = applyReleaseBlock({ yamlPath, release });
		expect(next).toContain('# A package');
	});

	it('keeps keyword array order', () => {
		const next = applyReleaseBlock({ yamlPath, release });
		const reportsIdx = next.indexOf('- reports');
		const analyticsIdx = next.indexOf('- analytics');
		expect(reportsIdx).toBeGreaterThanOrEqual(0);
		expect(analyticsIdx).toBeGreaterThan(reportsIdx);
	});
});
