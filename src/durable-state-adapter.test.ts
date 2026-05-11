import { describe, expect, test } from "bun:test";

import {
	createDurableObjectStateAdapter,
	routeCacheKeyToShard,
} from "./durable-state-adapter";

type RpcCall = {
	shardId: string;
	payload: Record<string, unknown>;
};

function createNamespace(handler?: (call: RpcCall) => unknown) {
	const calls: RpcCall[] = [];
	const namespace = {
		idFromName: (name: string) => name,
		get: (shardId: string) => ({
			fetch: async (_url: string, init: RequestInit) => {
				const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
				const call = { shardId, payload };
				calls.push(call);
				const result = handler ? handler(call) : null;
				return Response.json({ ok: true, result });
			},
		}),
	} as unknown as DurableObjectNamespace;

	return { namespace, calls };
}

describe("routeCacheKeyToShard", () => {
	test("routes global, thread, and channel cache keys to stable shards", () => {
		expect(routeCacheKeyToShard("dedupe:telegram:1")).toBe("__chat_global__");
		expect(routeCacheKeyToShard("chat:callback:abc")).toBe("__chat_global__");
		expect(routeCacheKeyToShard("modal-context:abc")).toBe("__chat_global__");
		expect(routeCacheKeyToShard("transcripts:telegram:user-1")).toBe(
			"__chat_global__",
		);
		expect(routeCacheKeyToShard("composio:tool-router-session:telegram:1")).toBe(
			"__chat_global__",
		);
		expect(routeCacheKeyToShard("thread-state:telegram:thread-1")).toBe(
			"telegram:thread-1",
		);
		expect(routeCacheKeyToShard("channel-state:telegram:channel-1")).toBe(
			"telegram:channel-1",
		);
		expect(routeCacheKeyToShard("msg-history:telegram:thread-1")).toBe(
			"telegram:thread-1",
		);
		expect(routeCacheKeyToShard("unknown:key")).toBe("__chat_global__");
	});
});

describe("createDurableObjectStateAdapter", () => {
	test("forwards state operations to the expected Durable Object shards", async () => {
		const { namespace, calls } = createNamespace((call) => {
			if (call.payload.op === "isSubscribed") {
				return true;
			}
			if (call.payload.op === "acquireLock") {
				return {
					threadId: call.payload.threadId,
					token: "token",
					expiresAt: 123,
				};
			}
			if (call.payload.op === "getList") {
				return ["a", "b"];
			}
			if (call.payload.op === "enqueue") {
				return 1;
			}
			if (call.payload.op === "queueDepth") {
				return 2;
			}
			return null;
		});
		const adapter = createDurableObjectStateAdapter(namespace);

		await adapter.subscribe("telegram:thread-1");
		expect(await adapter.isSubscribed("telegram:thread-1")).toBe(true);
		expect(await adapter.acquireLock("telegram:thread-1", 5000)).toMatchObject({
			threadId: "telegram:thread-1",
			token: "token",
		});
		await adapter.set("transcripts:telegram:user-1", [{ text: "hello" }], 1000);
		await adapter.appendToList("msg-history:telegram:thread-1", { id: "m1" });
		expect(await adapter.getList("msg-history:telegram:thread-1")).toEqual([
			"a",
			"b",
		]);
		expect(
			await adapter.enqueue(
				"telegram:thread-1",
				{
					message: { id: "m1" } as never,
					enqueuedAt: 1,
					expiresAt: 2,
				},
				10,
			),
		).toBe(1);
		expect(await adapter.queueDepth("telegram:thread-1")).toBe(2);

		expect(calls).toEqual([
			{
				shardId: "telegram:thread-1",
				payload: { op: "subscribe", threadId: "telegram:thread-1" },
			},
			{
				shardId: "telegram:thread-1",
				payload: { op: "isSubscribed", threadId: "telegram:thread-1" },
			},
			{
				shardId: "telegram:thread-1",
				payload: {
					op: "acquireLock",
					threadId: "telegram:thread-1",
					ttlMs: 5000,
				},
			},
			{
				shardId: "__chat_global__",
				payload: {
					op: "set",
					key: "transcripts:telegram:user-1",
					value: [{ text: "hello" }],
					ttlMs: 1000,
				},
			},
			{
				shardId: "telegram:thread-1",
				payload: {
					op: "appendToList",
					key: "msg-history:telegram:thread-1",
					value: { id: "m1" },
				},
			},
			{
				shardId: "telegram:thread-1",
				payload: { op: "getList", key: "msg-history:telegram:thread-1" },
			},
			{
				shardId: "telegram:thread-1",
				payload: {
					op: "enqueue",
					threadId: "telegram:thread-1",
					entry: { message: { id: "m1" }, enqueuedAt: 1, expiresAt: 2 },
					maxSize: 10,
				},
			},
			{
				shardId: "telegram:thread-1",
				payload: { op: "queueDepth", threadId: "telegram:thread-1" },
			},
		]);
	});

	test("throws when Durable Object RPC fails", async () => {
		const namespace = {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async () =>
					Response.json(
						{ ok: false, error: "storage failed" },
						{ status: 500 },
					),
			}),
		} as unknown as DurableObjectNamespace;
		const adapter = createDurableObjectStateAdapter(namespace);

		await expect(adapter.get("transcripts:telegram:user-1")).rejects.toThrow(
			"storage failed",
		);
	});
});
