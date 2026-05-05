import { renderReleaseBlock } from './append-release-block.js';
import type { PackageCheckOutcome } from './checks.js';

export const VALIDATOR_COMMENT_MARKER = 'phpvms-addon-registry:validator-comment';

/**
 * Render the validator comment body. One comment summarises every changed
 * YAML in the PR. The marker (managed by the caller) lets re-runs update
 * the same comment instead of creating new ones.
 */
export function renderValidatorComment(outcomes: PackageCheckOutcome[]): string {
	const overallPass = outcomes.every((o) => o.issues.length === 0);
	const heading = overallPass ? '## Registry validation: passed' : '## Registry validation: failed';
	const sections: string[] = [heading, ''];

	for (const outcome of outcomes) {
		const status = outcome.issues.length === 0 ? 'PASS' : 'FAIL';
		const skipNote = outcome.skipped ? ` _(upstream checks skipped — ${outcome.skipReason})_` : '';
		sections.push(`### [${status}] \`${outcome.yamlPath}\`${skipNote}`);
		sections.push('');

		if (outcome.issues.length > 0) {
			sections.push('**Issues:**');
			for (const issue of outcome.issues) {
				sections.push(`- \`${issue.rule}\` — ${issue.message}`);
			}
			sections.push('');
		}

		if (outcome.resolvedRelease && !outcome.skipped) {
			sections.push('**Proposed `release:` block (the post-merge bot will append this):**');
			sections.push('');
			sections.push('```yaml');
			sections.push(renderReleaseBlock(outcome.resolvedRelease).trimEnd());
			sections.push('```');
			sections.push('');
		}

		if (outcome.migrationLints.length > 0) {
			const migrationsTotal = outcome.migrationLints.length;
			const migrationErrors = outcome.migrationLints.reduce((acc, l) => acc + l.errors.length, 0);
			sections.push(`**Migration lint:** ${migrationsTotal} file(s) inspected, ${migrationErrors} issue(s).`);
			sections.push('');
		}
	}

	return sections.join('\n').trimEnd() + '\n';
}
