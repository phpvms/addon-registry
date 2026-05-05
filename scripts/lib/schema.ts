import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { parseYaml } from './yaml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'schema');

export interface SchemaError {
	path: string;
	message: string;
	keyword: string;
	params: Record<string, unknown>;
}

export interface ValidationResult {
	valid: boolean;
	errors: SchemaError[];
}

function buildAjv(): Ajv {
	const ajv = new Ajv({ allErrors: true, strict: false });
	addFormats(ajv);
	return ajv;
}

function readJson<T = unknown>(p: string): T {
	return JSON.parse(readFileSync(p, 'utf8')) as T;
}

function readSchema(p: string): AnySchema {
	return readJson<AnySchema>(p);
}

function loadCategories(): string[] {
	const p = path.join(SCHEMA_DIR, 'categories.yml');
	const list = parseYaml<string[]>(readFileSync(p, 'utf8'));
	if (!Array.isArray(list)) throw new Error(`schema/categories.yml must be a YAML list of strings`);
	return list;
}

function formatErrors(errors: ErrorObject[] | null | undefined): SchemaError[] {
	if (!errors) return [];
	return errors.map((e) => ({
		path: e.instancePath || '/',
		message: e.message ?? 'invalid',
		keyword: e.keyword,
		params: (e.params as Record<string, unknown>) ?? {},
	}));
}

export interface PackageValidator {
	validate: (data: unknown) => ValidationResult;
	categories: string[];
}

/**
 * Build a validator for `packages/{a}/{b}.yml`. Combines the JSON schema
 * with a runtime check that `category` is in `schema/categories.yml`.
 */
export function buildPackageValidator(): PackageValidator {
	const ajv = buildAjv();
	const schema = readSchema(path.join(SCHEMA_DIR, 'package.schema.json'));
	const validate = ajv.compile(schema) as ValidateFunction<unknown>;
	const categories = loadCategories();
	const categorySet = new Set(categories);

	return {
		categories,
		validate(data: unknown): ValidationResult {
			const ok = validate(data);
			const errors = formatErrors(validate.errors);
			if (ok && data && typeof data === 'object' && 'category' in data) {
				const cat = (data as { category?: unknown }).category;
				if (typeof cat === 'string' && !categorySet.has(cat)) {
					errors.push({
						path: '/category',
						message: `category "${cat}" is not in schema/categories.yml. Allowed: ${categories.join(', ')}`,
						keyword: 'enum',
						params: { allowedValues: categories },
					});
				}
			}
			return { valid: errors.length === 0, errors };
		},
	};
}

export interface SimpleValidator {
	validate: (data: unknown) => ValidationResult;
}

/** Validator for `packages/{a}/meta.yml`. */
export function buildMetaValidator(): SimpleValidator {
	const ajv = buildAjv();
	const schema = readSchema(path.join(SCHEMA_DIR, 'meta.schema.json'));
	const validate = ajv.compile(schema) as ValidateFunction<unknown>;
	return {
		validate(data: unknown): ValidationResult {
			const ok = validate(data);
			const errors = formatErrors(validate.errors);
			return { valid: ok, errors };
		},
	};
}

/** Validator for the `module.json` shipped inside an addon zip. */
export function buildModuleValidator(): SimpleValidator {
	const ajv = buildAjv();
	const schema = readSchema(path.join(SCHEMA_DIR, 'module.schema.json'));
	const validate = ajv.compile(schema) as ValidateFunction<unknown>;
	return {
		validate(data: unknown): ValidationResult {
			const ok = validate(data);
			const errors = formatErrors(validate.errors);
			return { valid: ok, errors };
		},
	};
}

export function formatErrorList(errors: SchemaError[]): string {
	return errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
}
