import { describe, it, expect } from 'vitest';
import { renderReleaseBlock } from '../lib/append-release-block.js';

describe('renderReleaseBlock', () => {
	it('renders all fields in stable order with quoted values', () => {
		const block = renderReleaseBlock({
			version: '1.2.3',
			tag: 'v1.2.3',
			zip_url: 'https://github.com/acme/reports-addon/releases/download/v1.2.3/reports.zip',
			sha256: 'a'.repeat(64),
			published_at: '2025-01-01T00:00:00Z',
		});
		// First line is `release:`, then each field is indented and double-quoted.
		expect(block.startsWith('release:\n')).toBe(true);
		expect(block).toContain('  version: "1.2.3"');
		expect(block).toContain('  tag: "v1.2.3"');
		expect(block).toContain('  zip_url: "https://github.com/acme/reports-addon/releases/download/v1.2.3/reports.zip"');
		expect(block).toContain(`  sha256: "${'a'.repeat(64)}"`);
		expect(block).toContain('  published_at: "2025-01-01T00:00:00Z"');
		// Stable: re-rendering produces identical bytes
		const a = renderReleaseBlock({
			version: '1.2.3',
			tag: 'v1.2.3',
			zip_url: 'https://example.com/x.zip',
			sha256: 'b'.repeat(64),
			published_at: '2025-01-01T00:00:00Z',
		});
		const b = renderReleaseBlock({
			version: '1.2.3',
			tag: 'v1.2.3',
			zip_url: 'https://example.com/x.zip',
			sha256: 'b'.repeat(64),
			published_at: '2025-01-01T00:00:00Z',
		});
		expect(a).toBe(b);
	});
});
