import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const webhookCalls: Array<{
	request: Request;
	waitUntil?: (task: PromiseLike<unknown>) => void;
}> = [];
const waitUntilTasks: Promise<unknown>[] = [];

mock.module("./bot", () => ({
	createSolutoChat: () => ({
		webhooks: {
			telegram: async (
				request: Request,
				options?: { waitUntil?: (task: PromiseLike<unknown>) => void },
			) => {
				webhookCalls.push({ request, waitUntil: options?.waitUntil });
				options?.waitUntil?.(Promise.resolve("finished"));
				return Response.json({ ok: true, delegated: true });
			},
		},
	}),
}));

const { default: app } = await import("./index");

function createEnv(overrides: Partial<Cloudflare.Env> = {}) {
	return {
		OPENAI_API_KEY: "openai-test-key",
		GROQ_API_KEY: "groq-test-key",
		TELEGRAM_BOT_TOKEN: "telegram-test-token",
		TELEGRAM_BOT_USERNAME: "soluto_test_bot",
		TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
		CHAT_STATE: {} as DurableObjectNamespace,
		...overrides,
	} as Cloudflare.Env;
}

describe("worker routes", () => {
	beforeEach(() => {
		webhookCalls.length = 0;
		waitUntilTasks.length = 0;
	});

	afterEach(() => {
		mock.restore();
	});

	test("serves a health response from the root route", async () => {
		const response = await app.request("/", {}, createEnv());

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			service: "soluto",
		});
	});

	test("returns a clear error when the Telegram token is missing", async () => {
		const env = createEnv({
			TELEGRAM_BOT_TOKEN: undefined as unknown as string,
		});

		const response = await app.request(
			"/telegram/webhook",
			{
				method: "POST",
				body: JSON.stringify({ update_id: 1 }),
				headers: { "content-type": "application/json" },
			},
			env,
		);

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error: "missing_telegram_bot_token",
		});
		expect(webhookCalls).toHaveLength(0);
	});

	test("delegates Telegram webhooks to the chat adapter with waitUntil support", async () => {
		const response = await app.request(
			"/telegram/webhook",
			{
				method: "POST",
				body: JSON.stringify({ update_id: 1 }),
				headers: { "content-type": "application/json" },
			},
			createEnv(),
			{
				waitUntil: (task) => {
					waitUntilTasks.push(Promise.resolve(task));
				},
				passThroughOnException: () => {},
			} as ExecutionContext,
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			delegated: true,
		});
		expect(webhookCalls).toHaveLength(1);
		expect(webhookCalls[0].request.method).toBe("POST");
		expect(typeof webhookCalls[0].waitUntil).toBe("function");
		await expect(Promise.all(waitUntilTasks)).resolves.toEqual(["finished"]);
	});
});
