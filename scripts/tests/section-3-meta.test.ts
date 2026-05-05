import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readYaml } from '../lib/yaml.js';
import { buildMetaValidator } from '../lib/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

describe('phpvms namespace meta.yml', () => {
	it('validates against schema/meta.schema.json', () => {
		const data = readYaml(path.join(ROOT, 'packages', 'phpvms', 'meta.yml'));
		const validator = buildMetaValidator();
		const result = validator.validate(data);
		if (!result.valid) {
			console.error(result.errors);
		}
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});
