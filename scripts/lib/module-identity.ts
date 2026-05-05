import { buildModuleValidator, type ValidationResult, type SchemaError } from './schema.js';

export interface ModuleIdentityResult {
	valid: boolean;
	errors: string[];
	moduleSchemaErrors: SchemaError[];
}

/**
 * Validate the parsed `module.json` against schema and identity rules.
 *
 * Identity rules (per submission-pipeline spec):
 *  - `module.json.alias` MUST equal the registry `name`.
 *  - `module.json.name` is informational; not enforced. Authors often use
 *    a display-style value here (e.g. "AcmeReports") which is fine.
 *
 * Schema rules: AJV-validated against `schema/module.schema.json` —
 * structural correctness only (presence of required keys, types, etc.),
 * independent of the identity match.
 */
export function checkModuleIdentity(parsedModule: unknown, registryName: string): ModuleIdentityResult {
	const validator = buildModuleValidator();
	const schemaResult: ValidationResult = validator.validate(parsedModule);
	const errors: string[] = [];

	if (!schemaResult.valid) {
		errors.push('module.json failed schema validation');
	}

	if (parsedModule && typeof parsedModule === 'object') {
		const m = parsedModule as { alias?: unknown };
		if (typeof m.alias !== 'string' || m.alias !== registryName) {
			errors.push(`module.json.alias (${JSON.stringify(m.alias)}) must equal registry name "${registryName}"`);
		}
	} else {
		errors.push('module.json must be an object');
	}

	return {
		valid: errors.length === 0,
		errors,
		moduleSchemaErrors: schemaResult.errors,
	};
}
