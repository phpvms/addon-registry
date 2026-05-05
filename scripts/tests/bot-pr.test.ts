import { describe, it, expect } from 'vitest';
import { releaseBranchName, bumpBranchName, slugify, bumpPrTitle, releaseBlockPrTitle } from '../lib/bot-pr.js';

describe('bot PR helpers', () => {
	it('slugifies registry names with slash to hyphen', () => {
		expect(slugify('acme/reports')).toBe('acme-reports');
	});

	it('forms release branch names', () => {
		expect(releaseBranchName('acme/reports', '1.2.3')).toBe('bot/release-acme-reports-1.2.3');
	});

	it('forms bump branch names', () => {
		expect(bumpBranchName('acme/reports', '1.3.0')).toBe('bot/bump-acme-reports-1.3.0');
	});

	it('forms bump PR titles', () => {
		expect(bumpPrTitle('acme/reports', '1.2.3', '1.3.0')).toBe('bump: acme/reports 1.2.3 → 1.3.0');
	});

	it('forms release-block PR titles', () => {
		expect(releaseBlockPrTitle('acme/reports', '1.2.3')).toBe('release-block: acme/reports 1.2.3');
	});
});
