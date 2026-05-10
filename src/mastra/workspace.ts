import { Workspace } from "@mastra/core/workspace";
import { DaytonaSandbox } from "@mastra/daytona";
import { S3Filesystem } from "@mastra/s3";

/**
 * R2 at `/data` with Daytona sandbox. Omit `R2_*` env vars to disable.
 * Worker bundle: `package.json` pins `@opentelemetry/*` stubs under `vendor/*-stub`
 * so the Daytona SDK does not pull protobufjs at import time (Workers deploy 10021).
 */
function createWorkspace() {
	const bucket = process.env.R2_BUCKET;
	const accountId = process.env.R2_ACCOUNT_ID;
	const accessKeyId = process.env.R2_ACCESS_KEY_ID;
	const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

	if (!bucket || !accountId || !accessKeyId || !secretAccessKey) {
		return undefined;
	}

	const snapshotId = process.env.DAYTONA_SNAPSHOT_ID?.trim();

	return new Workspace({
		mounts: {
			"/data": new S3Filesystem({
				bucket,
				region: "auto",
				endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
				accessKeyId,
				secretAccessKey,
			}),
		},
		sandbox: new DaytonaSandbox({
			id: process.env.DAYTONA_SANDBOX_ID ?? "soluto-agent-sandbox",
			timeout: Number(process.env.DAYTONA_SANDBOX_TIMEOUT_MS ?? 600_000),
			apiKey: process.env.DAYTONA_API_KEY,
			apiUrl: process.env.DAYTONA_API_URL,
			target: process.env.DAYTONA_TARGET,
			...(snapshotId ? { snapshot: snapshotId } : {}),
		}),
	});
}

export const workspace = createWorkspace();
