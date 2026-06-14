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

export interface PublisherValidator {
	validate: (data: unknown) => ValidationResult;
	categories: string[];
}

/** @deprecated Use PublisherValidator instead. */
export type PackageValidator = PublisherValidator;

/**
 * Build a validator for a publisher file (`packages/{publisher}.yml`).
 * Combines the JSON schema with a runtime check that each addon's `category`
 * is in `schema/categories.yml`.
 */
export function buildPublisherValidator(): PublisherValidator {
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
			if (ok && data && typeof data === 'object' && 'addons' in data) {
				const addons = (data as { addons?: unknown }).addons;
				if (Array.isArray(addons)) {
					for (let i = 0; i < addons.length; i++) {
						const addon = addons[i] as { category?: unknown };
						const cat = addon?.category;
						if (typeof cat === 'string' && !categorySet.has(cat)) {
							errors.push({
								path: `/addons/${i}/category`,
								message: `category "${cat}" is not in schema/categories.yml. Allowed: ${categories.join(', ')}`,
								keyword: 'enum',
								params: { allowedValues: categories },
							});
						}
					}
				}
			}
			return { valid: errors.length === 0, errors };
		},
	};
}

/** @deprecated Use buildPublisherValidator instead. */
export const buildPackageValidator = buildPublisherValidator;

export function formatErrorList(errors: SchemaError[]): string {
	return errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
}
