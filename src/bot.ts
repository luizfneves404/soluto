import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import {
	generateText,
	type ModelMessage,
	experimental_transcribe as transcribe,
} from "ai";
import {
	type Attachment,
	Chat,
	type Message,
	type Thread,
	type TranscriptEntry,
} from "chat";

import { createDurableObjectStateAdapter } from "./durable-state-adapter";

const OPENAI_MODEL = "gpt-5.4-mini";
const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
const TRANSCRIPT_LIMIT = 200;
const CLEAR_COMMAND = "/clear";
const AUDIO_TRANSCRIPTION_SYSTEM_PROMPT =
	'Whenever a message starts with "audio: ", it is a transcription of an audio message.';
const AUDIO_TRANSCRIPTION_FAILURE_MESSAGE =
	"I couldn't transcribe that audio. Please try again or send it as text.";

export type TelegramWorkerBindings = Cloudflare.Env & {
	TELEGRAM_WEBHOOK_SECRET?: string;
};

function toModelMessages(transcript: TranscriptEntry[]): ModelMessage[] {
	return [
		{
			role: "system",
			content: AUDIO_TRANSCRIPTION_SYSTEM_PROMPT,
		},
		...transcript.map((entry) => ({
			role: entry.role,
			content: entry.text,
		})),
	];
}

function getAudioAttachments(message: Message): Attachment[] {
	return (
		message.attachments?.filter((attachment) => attachment.type === "audio") ??
		[]
	);
}

function hasTextOrAudio(message: Message): boolean {
	return (
		message.text.trim().length > 0 || getAudioAttachments(message).length > 0
	);
}

function normalizeVoiceCommand(text: string): string {
	return text
		.trim()
		.toLocaleLowerCase("pt-BR")
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
		.replace(/\s+/g, " ")
		.trim();
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
	const groq = createGroq({ apiKey: env.GROQ_API_KEY });
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

	const clearTranscript = async (thread: Thread, userKey: string) => {
		const { deleted } = await chat.transcripts.delete({
			userKey,
		});
		logLlmEvent("llm_context_cleared", {
			userKey,
			threadId: thread.id,
			deleted,
		});
		await thread.post("Conversation history cleared for future LLM replies.");
	};

	const generateReply = async (
		thread: Thread,
		message: Message,
		userKey: string,
		userText?: string,
	) => {
		const transcriptEntry =
			userText === undefined
				? message
				: ({
						role: "user",
						text: userText,
						platformMessageId: message.id,
					} as const);

		await chat.transcripts.append(
			thread,
			transcriptEntry,
			userText === undefined ? undefined : { userKey },
		);

		const transcript = await chat.transcripts.list({
			userKey,
			limit: TRANSCRIPT_LIMIT,
		});
		const messages = toModelMessages(transcript);

		logLlmEvent("llm_call_start", {
			provider: "openai",
			model: OPENAI_MODEL,
			userKey,
			threadId: thread.id,
			messages,
		});

		const result = await generateText({
			model: openai(OPENAI_MODEL),
			messages,
			providerOptions: {
				openai: {
					user: userKey,
				},
			},
			experimental_telemetry: {
				isEnabled: true,
				functionId: "telegram-reply",
				recordInputs: true,
				recordOutputs: true,
				metadata: {
					userKey,
					threadId: thread.id,
				},
			},
			experimental_onStepStart: (event) => {
				logLlmEvent("llm_step_start", {
					stepNumber: event.stepNumber,
					provider: event.model.provider,
					model: event.model.modelId,
					userKey,
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
					userKey,
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
					userKey,
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
			{ userKey },
		);
	};

	const replyWithLlm = async (thread: Thread, message: Message) => {
		if (!message.userKey) {
			await thread.post(
				"I can't build LLM context for this message because no user identity was resolved.",
			);
			return;
		}

		if (message.text.trim() === CLEAR_COMMAND) {
			await clearTranscript(thread, message.userKey);
			return;
		}

		const audioAttachment = getAudioAttachments(message)[0];
		if (!audioAttachment) {
			await generateReply(thread, message, message.userKey);
			return;
		}

		try {
			if (!audioAttachment.fetchData) {
				throw new Error("Audio attachment does not provide fetchData");
			}

			const audio = await audioAttachment.fetchData();
			const transcript = await transcribe({
				model: groq.transcription(GROQ_TRANSCRIPTION_MODEL),
				audio,
			});
			const transcribedText = transcript.text.trim();

			if (transcribedText.length === 0) {
				throw new Error("Audio transcription returned empty text");
			}

			if (normalizeVoiceCommand(transcribedText) === "limpar") {
				await clearTranscript(thread, message.userKey);
				return;
			}

			const userText = `audio: ${transcribedText}`;
			await thread.post(userText);
			await generateReply(thread, message, message.userKey, userText);
		} catch (error) {
			logLlmEvent("audio_transcription_failed", {
				userKey: message.userKey,
				threadId: thread.id,
				messageId: message.id,
				error: error instanceof Error ? error.message : String(error),
			});
			await thread.post(AUDIO_TRANSCRIPTION_FAILURE_MESSAGE);
		}
	};

	const handleFirstUserTurn = async (thread: Thread, message: Message) => {
		if (!hasTextOrAudio(message)) {
			return;
		}
		await thread.subscribe();
		await replyWithLlm(thread, message);
	};

	chat.onDirectMessage(async (thread, message) => {
		await handleFirstUserTurn(thread, message);
	});

	chat.onNewMention(async (thread, message) => {
		await handleFirstUserTurn(thread, message);
	});

	chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
		await handleFirstUserTurn(thread, message);
	});

	chat.onSubscribedMessage(async (thread, message) => {
		if (!hasTextOrAudio(message)) {
			return;
		}
		await replyWithLlm(thread, message);
	});

	return chat;
}
