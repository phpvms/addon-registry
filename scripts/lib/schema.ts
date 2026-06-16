import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

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
}

/**
 * Build a validator for a publisher file (`packages/{publisher}.yml`).
 * The JSON schema (schema/package.schema.json) contains the category enum inline.
 */
export function buildPublisherValidator(): PublisherValidator {
	const ajv = buildAjv();
	const schema = readSchema(path.join(SCHEMA_DIR, 'package.schema.json'));
	const validate = ajv.compile(schema) as ValidateFunction<unknown>;

	return {
		validate(data: unknown): ValidationResult {
			const ok = validate(data);
			const errors = formatErrors(validate.errors);
			return { valid: ok && errors.length === 0, errors };
		},
	};
}

export function formatErrorList(errors: SchemaError[]): string {
	return errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
}
