/**
 * Migration lint — allow-list checks against the PHP AST.
 *
 * Rules (per submission-pipeline spec):
 *  - File must declare a class extending Illuminate\Database\Migrations\Migration.
 *  - Schema::create / table / drop / dropIfExists / rename: table names must
 *    be string literals matching `^{author}_*`.
 *  - DB::table('...'): same `^{author}_*` allow-list.
 *  - DB::raw(expr): allowed (used for default expressions).
 *  - DB::statement / DB::unprepared: forbidden.
 *  - eval / include* / require*: forbidden.
 *  - Foreign key referents (->on('users'), foreignId(...)->constrained()):
 *    referent table is unrestricted (chained method calls on $table are not
 *    inspected).
 *
 * AST shape notes (php-parser ^3.2):
 *  - Static call:  call.what = staticlookup{what,offset}, call.arguments=[...]
 *  - eval:         expression.kind === 'eval'
 *  - include/require: expression.kind === 'include' with `once`, `require` flags
 */

import phpParser from 'php-parser';

export interface LintError {
	rule: string;
	message: string;
	line?: number;
}

export interface LintInput {
	/** PHP source code of the migration file. */
	source: string;
	/** Path inside the zip, used for error display. */
	path: string;
	/** Author namespace (first segment of the registry `name`). */
	author: string;
}

export interface LintResult {
	path: string;
	errors: LintError[];
}

const SCHEMA_TABLE_METHODS = new Set(['create', 'table', 'drop', 'dropIfExists', 'rename']);
const FORBIDDEN_DB_METHODS = new Set(['statement', 'unprepared']);

interface AstNode {
	kind: string;
	[key: string]: unknown;
}

/**
 * Run the full lint over a single migration file. Returns a list of errors;
 * empty list means the file passes.
 */
export function lintMigration(input: LintInput): LintResult {
	const errors: LintError[] = [];
	const allowPrefix = new RegExp(`^${escapeRegex(input.author)}_`);

	let ast: AstNode;
	try {
		const Engine = (phpParser as unknown as { Engine: new (opts: unknown) => { parseCode: (src: string, file: string) => AstNode } })
			.Engine;
		const parser = new Engine({
			parser: { php8: true, suppressErrors: false },
			ast: { withPositions: true, withSource: false },
		});
		ast = parser.parseCode(input.source, input.path);
	} catch (err) {
		errors.push({
			rule: 'parse',
			message: `Failed to parse PHP: ${(err as Error).message}`,
		});
		return { path: input.path, errors };
	}

	let extendsMigration = false;

	const walk = (node: AstNode | null | undefined): void => {
		if (!node || typeof node !== 'object') return;

		// Class declaration
		if (node.kind === 'class') {
			const ext = node.extends as AstNode | null | undefined;
			if (ext && nameMatches(ext, ['Migration'])) {
				extendsMigration = true;
			}
		}

		// `eval('...')` — its own kind
		if (node.kind === 'eval') {
			errors.push({ rule: 'eval', message: '`eval` is forbidden in migrations', line: getLine(node) });
		}

		// `include 'x'`, `include_once`, `require`, `require_once` — its own kind with flags
		if (node.kind === 'include') {
			const isRequire = node.require === true;
			const isOnce = node.once === true;
			const variant = `${isRequire ? 'require' : 'include'}${isOnce ? '_once' : ''}`;
			errors.push({
				rule: 'include',
				message: `\`${variant}\` is forbidden in migrations`,
				line: getLine(node),
			});
		}

		// Static method calls: call.what.kind === 'staticlookup'
		if (node.kind === 'call') {
			const what = node.what as AstNode | undefined;
			if (what && what.kind === 'staticlookup') {
				const className = identifierName(what.what as AstNode | undefined);
				const methodName = identifierName(what.offset as AstNode | undefined);
				const args = (node.arguments as AstNode[] | undefined) ?? [];

				if (className === 'Schema' && methodName && SCHEMA_TABLE_METHODS.has(methodName)) {
					lintSchemaCall({
						method: methodName,
						args,
						line: getLine(node),
						allowPrefix,
						author: input.author,
						errors,
					});
				}

				if (className === 'DB' && methodName) {
					if (FORBIDDEN_DB_METHODS.has(methodName)) {
						errors.push({
							rule: 'db-forbidden',
							message: `\`DB::${methodName}\` is forbidden`,
							line: getLine(node),
						});
					} else if (methodName === 'table') {
						lintDbTableCall({
							args,
							line: getLine(node),
							allowPrefix,
							author: input.author,
							errors,
						});
					}
					// DB::raw and any other DB:: method are accepted; the spec only
					// forbids the explicit `statement` and `unprepared` plus restricts `table`.
				}
			}
		}

		// Recurse into all child nodes
		for (const key of Object.keys(node)) {
			if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
			const value = node[key];
			if (Array.isArray(value)) {
				for (const child of value) {
					if (child && typeof child === 'object' && 'kind' in child) walk(child as AstNode);
				}
			} else if (value && typeof value === 'object' && 'kind' in (value as object)) {
				walk(value as AstNode);
			}
		}
	};

	walk(ast);

	if (!extendsMigration) {
		errors.push({
			rule: 'class-extends',
			message: 'Migration must declare a class extending Illuminate\\Database\\Migrations\\Migration',
		});
	}

	return { path: input.path, errors };
}

function lintSchemaCall(opts: {
	method: string;
	args: AstNode[];
	line: number | undefined;
	allowPrefix: RegExp;
	author: string;
	errors: LintError[];
}): void {
	const { method, args, line, allowPrefix, author, errors } = opts;

	if (method === 'rename') {
		const left = stringLiteralValue(args[0]);
		const right = stringLiteralValue(args[1]);
		if (left === null) {
			errors.push({ rule: 'schema-dynamic-table', message: `Schema::rename source must be a string literal`, line });
		} else if (!allowPrefix.test(left)) {
			errors.push({
				rule: 'schema-allow-list',
				message: `Schema::rename source "${left}" must match ^${author}_*`,
				line,
			});
		}
		if (right === null) {
			errors.push({ rule: 'schema-dynamic-table', message: `Schema::rename target must be a string literal`, line });
		} else if (!allowPrefix.test(right)) {
			errors.push({
				rule: 'schema-allow-list',
				message: `Schema::rename target "${right}" must match ^${author}_*`,
				line,
			});
		}
		return;
	}

	const tableName = stringLiteralValue(args[0]);
	if (tableName === null) {
		errors.push({
			rule: 'schema-dynamic-table',
			message: `Schema::${method} table name must be a string literal`,
			line,
		});
		return;
	}
	if (!allowPrefix.test(tableName)) {
		errors.push({
			rule: 'schema-allow-list',
			message: `Schema::${method} table "${tableName}" must match ^${author}_*`,
			line,
		});
	}
}

function lintDbTableCall(opts: {
	args: AstNode[];
	line: number | undefined;
	allowPrefix: RegExp;
	author: string;
	errors: LintError[];
}): void {
	const { args, line, allowPrefix, author, errors } = opts;
	const tableName = stringLiteralValue(args[0]);
	if (tableName === null) {
		errors.push({
			rule: 'db-dynamic-table',
			message: `DB::table table name must be a string literal`,
			line,
		});
		return;
	}
	if (!allowPrefix.test(tableName)) {
		errors.push({
			rule: 'db-allow-list',
			message: `DB::table "${tableName}" must match ^${author}_*`,
			line,
		});
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLine(node: AstNode): number | undefined {
	const loc = node.loc as { start?: { line?: number } } | undefined;
	return loc?.start?.line;
}

/** Return the literal string value, or null if not a string literal. */
function stringLiteralValue(node: AstNode | undefined): string | null {
	if (!node) return null;
	if (node.kind === 'string' && typeof node.value === 'string') {
		return node.value;
	}
	return null;
}

/**
 * Resolve an identifier-like node to its (last) name segment. Handles plain
 * identifiers and namespaced names produced by php-parser (`name` nodes).
 */
function identifierName(node: AstNode | undefined): string | null {
	if (!node) return null;
	if (node.kind === 'identifier' && typeof node.name === 'string') {
		return node.name;
	}
	if (node.kind === 'name' && typeof node.name === 'string') {
		return node.name.split('\\').pop() ?? null;
	}
	return null;
}

/** True if the node names any of the candidates (matched on last segment). */
function nameMatches(node: AstNode, candidates: string[]): boolean {
	const last = identifierName(node);
	if (!last) return false;
	return candidates.includes(last);
}
