import { createOpenAI } from "@ai-sdk/openai";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { generateText, type ModelMessage } from "ai";
import { Chat, type Message, type Thread, type TranscriptEntry } from "chat";

import { createDurableObjectStateAdapter } from "./durable-state-adapter";

const OPENAI_MODEL = "gpt-5.4-mini";
const TRANSCRIPT_LIMIT = 200;
const CLEAR_COMMAND = "/clear";

export type TelegramWorkerBindings = Cloudflare.Env & {
	TELEGRAM_WEBHOOK_SECRET?: string;
};

function toModelMessages(transcript: TranscriptEntry[]): ModelMessage[] {
	return transcript.map((entry) => ({
		role: entry.role,
		content: entry.text,
	}));
}

function logLlmEvent(event: string, details: Record<string, unknown>): void {
	try {
		console.info(JSON.stringify({ event, ...details }));
	} catch (error) {
		console.info(
			JSON.stringify({
				event,
				log_error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
}

export function createSolutoChat(env: TelegramWorkerBindings) {
	const state = createDurableObjectStateAdapter(env.CHAT_STATE);
	const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
	const telegram = createTelegramAdapter({
		mode: "webhook",
		botToken: env.TELEGRAM_BOT_TOKEN,
		secretToken:
			env.TELEGRAM_WEBHOOK_SECRET_TOKEN ?? env.TELEGRAM_WEBHOOK_SECRET,
		userName: env.TELEGRAM_BOT_USERNAME,
	});

	const userName =
		env.TELEGRAM_BOT_USERNAME && env.TELEGRAM_BOT_USERNAME.length > 0
			? env.TELEGRAM_BOT_USERNAME
			: "soluto";

	const chat = new Chat({
		userName,
		adapters: { telegram },
		state,
		identity: ({ author }) => {
			if (author.isMe || author.isBot === true) {
				return null;
			}
			return `telegram:${author.userId}`;
		},
		transcripts: {
			maxPerUser: 200,
			retention: "30d",
		},
	});

	chat.registerSingleton();

	const replyWithLlm = async (thread: Thread, message: Message) => {
		if (!message.userKey) {
			await thread.post(
				"I can't build LLM context for this message because no user identity was resolved.",
			);
			return;
		}

		if (message.text.trim() === CLEAR_COMMAND) {
			const { deleted } = await chat.transcripts.delete({
				userKey: message.userKey,
			});
			logLlmEvent("llm_context_cleared", {
				userKey: message.userKey,
				threadId: thread.id,
				deleted,
			});
			await thread.post("Conversation history cleared for future LLM replies.");
			return;
		}

		await chat.transcripts.append(thread, message);

		const transcript = await chat.transcripts.list({
			userKey: message.userKey,
			limit: TRANSCRIPT_LIMIT,
		});
		const messages = toModelMessages(transcript);

		logLlmEvent("llm_call_start", {
			provider: "openai",
			model: OPENAI_MODEL,
			userKey: message.userKey,
			threadId: thread.id,
			messages,
		});

		const result = await generateText({
			model: openai(OPENAI_MODEL),
			messages,
			providerOptions: {
				openai: {
					user: message.userKey,
				},
			},
			experimental_telemetry: {
				isEnabled: true,
				functionId: "telegram-reply",
				recordInputs: true,
				recordOutputs: true,
				metadata: {
					userKey: message.userKey,
					threadId: thread.id,
				},
			},
			experimental_onStepStart: (event) => {
				logLlmEvent("llm_step_start", {
					stepNumber: event.stepNumber,
					provider: event.model.provider,
					model: event.model.modelId,
					userKey: message.userKey,
					threadId: thread.id,
					messages: event.messages,
					providerOptions: event.providerOptions,
				});
			},
			onStepFinish: (event) => {
				logLlmEvent("llm_step_finish", {
					stepNumber: event.stepNumber,
					provider: event.model.provider,
					model: event.model.modelId,
					userKey: message.userKey,
					threadId: thread.id,
					finishReason: event.finishReason,
					usage: event.usage,
					requestBody: event.request.body,
					response: event.response,
				});
			},
			onFinish: (event) => {
				logLlmEvent("llm_call_finish", {
					provider: event.model.provider,
					model: event.model.modelId,
					userKey: message.userKey,
					threadId: thread.id,
					finishReason: event.finishReason,
					totalUsage: event.totalUsage,
					text: event.text,
				});
			},
		});

		const replyText = result.text;

		const sent = await thread.post(replyText);

		await chat.transcripts.append(
			thread,
			{
				role: "assistant",
				text: replyText,
				platformMessageId: sent.id,
			},
			{ userKey: message.userKey },
		);
	};

	const handleFirstUserTurn = async (thread: Thread, message: Message) => {
		await thread.subscribe();
		await replyWithLlm(thread, message);
	};

	chat.onDirectMessage(async (thread, message) => {
		await handleFirstUserTurn(thread, message);
	});

	chat.onNewMention(async (thread, message) => {
		await handleFirstUserTurn(thread, message);
	});

	chat.onNewMessage(/.+/s, async (thread, message) => {
		await handleFirstUserTurn(thread, message);
	});

	chat.onSubscribedMessage(async (thread, message) => {
		await replyWithLlm(thread, message);
	});

	return chat;
}
