#!/usr/bin/env node
// Standalone R2 reachability probe. PUTs a tiny object, GETs it back,
// asserts byte equality, then DELETEs. Intended for one-shot smoke
// testing via the probe-infra workflow.

import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadBucketCommand,
} from '@aws-sdk/client-s3';

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

const key = `probes/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
const body = JSON.stringify({ probe: 'ok', ts: new Date().toISOString() });

async function streamToString(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

try {
	console.log(`== HEAD bucket ${bucket} ==`);
	await client.send(new HeadBucketCommand({ Bucket: bucket }));
	console.log('  OK');

	console.log(`== PUT ${key} (${body.length} bytes) ==`);
	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: 'application/json; charset=utf-8',
		}),
	);
	console.log('  OK');

	console.log(`== GET ${key} ==`);
	const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	const roundTrip = await streamToString(got.Body);
	if (roundTrip !== body) {
		console.error('  FAIL: round-trip mismatch');
		console.error(`  expected: ${body}`);
		console.error(`  got:      ${roundTrip}`);
		process.exit(2);
	}
	console.log('  OK (byte-identical)');

	console.log(`== DELETE ${key} ==`);
	await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
	console.log('  OK');

	console.log('R2 probe succeeded.');
} catch (err) {
	console.error('R2 probe failed:', err?.name ?? err, err?.message ?? '');
	if (err?.$metadata) console.error('  metadata:', err.$metadata);
	process.exit(3);
}
