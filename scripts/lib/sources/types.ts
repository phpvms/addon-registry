/**
 * Source abstraction — how the validator retrieves an addon's release zip
 * from whatever backend the package YAML's `source.type` names.
 *
 * Each source implementation owns the type-specific logic (auth, release
 * discovery, download). It returns the inspected zip plus any issues it
 * hit, rather than throwing, so the validator can aggregate per package.
 *
 * To add a new source type:
 *   1. implement `AddonSource` in a sibling file (e.g. `url.ts`),
 *   2. register it in `index.ts`,
 *   3. add its `type` (and any required fields) to `schema/package.schema.json`.
 */

import type { PackageSource } from '../yaml.js';
import type { ZipInspection } from '../zip.js';

export interface SourceIssue {
	rule: string;
	message: string;
}

export interface ResolvedSource {
	/** The downloaded + inspected zip, or null when retrieval failed. */
	inspection: ZipInspection | null;
	/** Issues encountered while resolving/fetching (empty on success). */
	issues: SourceIssue[];
}

export interface AddonSource {
	/** The `source.type` discriminator this implementation handles. */
	readonly type: string;
	/** Validate the source config, then download and inspect the release zip. */
	resolve(source: PackageSource, opts: { token?: string }): Promise<ResolvedSource>;
}
