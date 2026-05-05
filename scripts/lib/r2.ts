import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export interface R2Credentials {
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
}

/**
 * Read R2 credentials from environment variables. Throws if any are missing.
 */
export function loadR2CredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): R2Credentials {
	const accountId = env.R2_ACCOUNT_ID;
	const accessKeyId = env.R2_ACCESS_KEY_ID;
	const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
	const bucket = env.R2_BUCKET;
	const missing: string[] = [];
	if (!accountId) missing.push('R2_ACCOUNT_ID');
	if (!accessKeyId) missing.push('R2_ACCESS_KEY_ID');
	if (!secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
	if (!bucket) missing.push('R2_BUCKET');
	if (missing.length > 0) {
		throw new Error(`Missing required R2 environment variables: ${missing.join(', ')}`);
	}
	return {
		accountId: accountId!,
		accessKeyId: accessKeyId!,
		secretAccessKey: secretAccessKey!,
		bucket: bucket!,
	};
}

export function buildR2Client(creds: R2Credentials): S3Client {
	return new S3Client({
		region: 'auto',
		endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: creds.accessKeyId,
			secretAccessKey: creds.secretAccessKey,
		},
	});
}

/**
 * Put a JSON document at the given key. Replaces whatever exists.
 * `body` is bytes-or-string; for byte-stable comparisons callers should
 * pass an already-serialised string and we do not re-serialise.
 */
export async function putObject(
	client: S3Client,
	creds: R2Credentials,
	key: string,
	body: string | Uint8Array,
	contentType: string,
): Promise<void> {
	await client.send(
		new PutObjectCommand({
			Bucket: creds.bucket,
			Key: key,
			Body: body,
			ContentType: contentType,
		}),
	);
}

export async function putJson(client: S3Client, creds: R2Credentials, key: string, json: string): Promise<void> {
	await putObject(client, creds, key, json, 'application/json; charset=utf-8');
}
