import { describe, expect, test } from "bun:test";

import { ChatStateDurableObject } from "./chat-state-durable-object";

function createStorage(seed = new Map<string, unknown>()) {
	return {
		seed,
		ctx: {
			storage: {
				get: async <T>(key: string) => seed.get(key) as T | undefined,
				put: async (key: string, value: unknown) => {
					seed.set(key, value);
				},
			},
		} as unknown as DurableObjectState,
	};
}

async function rpc(instance: ChatStateDurableObject, body: Record<string, unknown>) {
	const response = await instance.fetch(
		new Request("https://chat-state/rpc", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	const json = (await response.json()) as {
		ok: boolean;
		result?: unknown;
		error?: string;
	};
	return { response, json };
}

describe("ChatStateDurableObject", () => {
	test("persists subscriptions and cache across instances", async () => {
		const { seed, ctx } = createStorage();
		const first = new ChatStateDurableObject(ctx, {});

		await expect(
			rpc(first, { op: "subscribe", threadId: "telegram:chat-1" }),
		).resolves.toMatchObject({ json: { ok: true, result: null } });
		await rpc(first, {
			op: "set",
			key: "transcripts:telegram:user-1",
			value: [{ role: "user", text: "hello" }],
		});

		const second = new ChatStateDurableObject(createStorage(seed).ctx, {});
		await expect(
			rpc(second, { op: "isSubscribed", threadId: "telegram:chat-1" }),
		).resolves.toMatchObject({ json: { ok: true, result: true } });
		await expect(
			rpc(second, { op: "get", key: "transcripts:telegram:user-1" }),
		).resolves.toMatchObject({
			json: { ok: true, result: [{ role: "user", text: "hello" }] },
		});
	});

	test("keeps locks exclusive and releases only matching tokens", async () => {
		const { ctx } = createStorage();
		const instance = new ChatStateDurableObject(ctx, {});

		const acquired = await rpc(instance, {
			op: "acquireLock",
			threadId: "telegram:chat-1",
			ttlMs: 10_000,
		});
		expect(acquired.json.ok).toBe(true);
		expect(acquired.json.result).toMatchObject({ threadId: "telegram:chat-1" });

		await expect(
			rpc(instance, {
				op: "acquireLock",
				threadId: "telegram:chat-1",
				ttlMs: 10_000,
			}),
		).resolves.toMatchObject({ json: { ok: true, result: null } });

		await rpc(instance, {
			op: "releaseLock",
			lock: {
				...(acquired.json.result as Record<string, unknown>),
				token: "wrong-token",
			},
		});
		await expect(
			rpc(instance, {
				op: "acquireLock",
				threadId: "telegram:chat-1",
				ttlMs: 10_000,
			}),
		).resolves.toMatchObject({ json: { ok: true, result: null } });

		await rpc(instance, { op: "releaseLock", lock: acquired.json.result });
		const reacquired = await rpc(instance, {
			op: "acquireLock",
			threadId: "telegram:chat-1",
			ttlMs: 10_000,
		});
		expect(reacquired.json.result).toMatchObject({
			threadId: "telegram:chat-1",
		});
	});

	test("supports bounded message queues", async () => {
		const { ctx } = createStorage();
		const instance = new ChatStateDurableObject(ctx, {});

		await expect(
			rpc(instance, {
				op: "enqueue",
				threadId: "telegram:chat-1",
				entry: { message: { id: "1" }, enqueuedAt: 1, expiresAt: 10 },
				maxSize: 2,
			}),
		).resolves.toMatchObject({ json: { ok: true, result: 1 } });
		await rpc(instance, {
			op: "enqueue",
			threadId: "telegram:chat-1",
			entry: { message: { id: "2" }, enqueuedAt: 2, expiresAt: 20 },
			maxSize: 2,
		});
		await rpc(instance, {
			op: "enqueue",
			threadId: "telegram:chat-1",
			entry: { message: { id: "3" }, enqueuedAt: 3, expiresAt: 30 },
			maxSize: 2,
		});

		await expect(
			rpc(instance, { op: "queueDepth", threadId: "telegram:chat-1" }),
		).resolves.toMatchObject({ json: { ok: true, result: 2 } });
		await expect(
			rpc(instance, { op: "dequeue", threadId: "telegram:chat-1" }),
		).resolves.toMatchObject({
			json: {
				ok: true,
				result: { message: { id: "2" }, enqueuedAt: 2, expiresAt: 20 },
			},
		});
		await expect(
			rpc(instance, { op: "dequeue", threadId: "telegram:chat-1" }),
		).resolves.toMatchObject({
			json: {
				ok: true,
				result: { message: { id: "3" }, enqueuedAt: 3, expiresAt: 30 },
			},
		});
	});

	test("rejects unsupported methods and operations", async () => {
		const { ctx } = createStorage();
		const instance = new ChatStateDurableObject(ctx, {});

		const getResponse = await instance.fetch(
			new Request("https://chat-state/rpc", { method: "GET" }),
		);
		expect(getResponse.status).toBe(405);

		const unsupported = await rpc(instance, { op: "nope" });
		expect(unsupported.response.status).toBe(500);
		expect(unsupported.json).toMatchObject({
			ok: false,
			error: "unsupported op: nope",
		});
	});
});
