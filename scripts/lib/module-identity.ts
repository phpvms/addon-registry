export interface ModuleIdentityResult {
	valid: boolean;
	errors: string[];
}

/**
 * Validate the parsed `module.json` for registry identity.
 *
 * The registry only inspects one field: `registry_id`. It MUST equal the
 * registry `name` (e.g. `acme/reports`). Every other field — including
 * Laravel-Modules' own `name` and `alias` — is owned by phpVMS core
 * runtime and intentionally not policed here. We do not run schema
 * validation against module.json because the registry is not the
 * source of truth for the module's runtime shape.
 */
export function checkModuleIdentity(parsedModule: unknown, registryName: string): ModuleIdentityResult {
	const errors: string[] = [];

	if (!parsedModule || typeof parsedModule !== 'object') {
		errors.push('module.json must be an object');
		return { valid: false, errors };
	}

	const m = parsedModule as { registry_id?: unknown };
	if (typeof m.registry_id !== 'string' || m.registry_id !== registryName) {
		errors.push(
			`module.json.registry_id (${JSON.stringify(m.registry_id)}) must equal registry name "${registryName}"`,
		);
	}

	return { valid: errors.length === 0, errors };
}
