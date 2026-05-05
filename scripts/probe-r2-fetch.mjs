#!/usr/bin/env node
// One-shot R2 fetch probe. Reads the published index objects and prints
// their content + sizes. Intended to be invoked from a workflow_dispatch
// step to verify section 12.3 of the bootstrap change without leaking
// R2 credentials onto a developer machine.

import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

function required(name) {
	const v = process.env[name];
	if (!v) {
		console.error(`Missing required env var: ${name}`);
		process.exit(1);
	}
	return v;
}

const accountId = required('R2_ACCOUNT_ID');
const accessKeyId = required('R2_ACCESS_KEY_ID');
const secretAccessKey = required('R2_SECRET_ACCESS_KEY');
const bucket = required('R2_BUCKET');

const client = new S3Client({
	region: 'auto',
	endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
	credentials: { accessKeyId, secretAccessKey },
});

const keys = ['raw/packages.json', 'raw/keywords.json'];

async function streamToString(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

let failed = false;
for (const key of keys) {
	try {
		const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
		console.log(`== ${key} ==`);
		console.log(`  size: ${head.ContentLength} bytes`);
		console.log(`  content-type: ${head.ContentType}`);
		console.log(`  last-modified: ${head.LastModified?.toISOString()}`);
		const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
		const body = await streamToString(obj.Body);
		console.log('  body:');
		console.log(body
			.split('\n')
			.map((l) => `    ${l}`)
			.join('\n'));
	} catch (err) {
		console.error(`!! ${key}: ${err?.name ?? err} ${err?.message ?? ''}`);
		failed = true;
	}
}

process.exit(failed ? 1 : 0);
