/**
 * Validate a release zip's parsed `module.json` for the registry.
 *
 * phpVMS's own runtime parser is intentionally lenient (it fills defaults
 * for missing fields to support legacy nwidart manifests). The registry
 * holds curated submissions to a higher bar, so we require the fields a
 * well-formed phpVMS addon should declare:
 *
 *   - `registry_id` — MUST equal the registry `name` (e.g. `acme/reports`).
 *   - `schema_version` — integer >= 1.
 *   - `type` — one of `module` or `theme`.
 *   - `description` — non-empty string.
 *   - `database.tables` — when present, every table must be namespaced
 *     under `{author}_`, matching the migration allow-list.
 *
 * Other module.json fields (Laravel-Modules' `name`/`alias`, `providers`,
 * `version`, `compat`, deprecated nwidart keys) are owned by phpVMS core
 * and intentionally not policed here.
 */

export interface ModuleManifestIssue {
	rule: string;
	message: string;
}

export interface ModuleManifestResult {
	valid: boolean;
	errors: ModuleManifestIssue[];
}

const VALID_TYPES = new Set(['module', 'theme']);

export function checkModuleManifest(parsedModule: unknown, registryName: string): ModuleManifestResult {
	const errors: ModuleManifestIssue[] = [];

	if (!parsedModule || typeof parsedModule !== 'object') {
		return { valid: false, errors: [{ rule: 'module-identity', message: 'module.json must be an object' }] };
	}

	const m = parsedModule as Record<string, unknown>;
	const author = registryName.split('/')[0] ?? '';

	// registry_id must equal the registry name
	if (typeof m.registry_id !== 'string' || m.registry_id !== registryName) {
		errors.push({
			rule: 'module-identity',
			message: `module.json.registry_id (${JSON.stringify(m.registry_id)}) must equal registry name "${registryName}"`,
		});
	}

	// schema_version: integer >= 1
	if (typeof m.schema_version !== 'number' || !Number.isInteger(m.schema_version) || m.schema_version < 1) {
		errors.push({
			rule: 'module-schema-version',
			message: `module.json.schema_version must be an integer >= 1 (got ${JSON.stringify(m.schema_version)})`,
		});
	}

	// type: module | theme
	if (typeof m.type !== 'string' || !VALID_TYPES.has(m.type)) {
		errors.push({
			rule: 'module-type',
			message: `module.json.type must be "module" or "theme" (got ${JSON.stringify(m.type)})`,
		});
	}

	// description: non-empty string
	if (typeof m.description !== 'string' || m.description.trim() === '') {
		errors.push({ rule: 'module-description', message: 'module.json.description must be a non-empty string' });
	}

	// database.tables: when declared, must be namespaced under {author}_
	const database = m.database as { tables?: unknown } | undefined;
	if (database && Array.isArray(database.tables)) {
		const prefix = `${author}_`;
		for (const table of database.tables) {
			if (typeof table === 'string' && table.trim() !== '' && !table.startsWith(prefix)) {
				errors.push({
					rule: 'module-tables',
					message: `module.json database.tables entry "${table}" must start with "${prefix}" (addon namespace)`,
				});
			}
		}
	}

	return { valid: errors.length === 0, errors };
}
