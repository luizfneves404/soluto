import { createGroq } from "@ai-sdk/groq";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import {
	type ModelMessage,
	type StepResult,
	type ToolSet,
	experimental_transcribe as transcribe,
} from "ai";
import {
	type Attachment,
	Chat,
	type Message,
	type Thread,
	type TranscriptEntry,
} from "chat";
import { createAssistantAgent, OPENAI_CHAT_MODEL_ID } from "./ai/agent";
import { createDurableObjectStateAdapter } from "./durable-state-adapter";

const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
const TRANSCRIPT_LIMIT = 200;
const CLEAR_COMMAND = "/clear";
const AUDIO_TRANSCRIPTION_FAILURE_MESSAGE =
	"I couldn't transcribe that audio. Please try again or send it as text.";
const AUDIO_EMPTY_TRANSCRIPT_MESSAGE =
	"I didn't catch any speech in that audio. Try again with clearer audio or send a text message.";
const MESSAGE_HANDLER_FAILURE_MESSAGE =
	"Something went wrong while processing your message. Please try again.";

export class TranscriptionFailedError extends Error {
	override readonly name = "TranscriptionFailedError";
}

function logTelegramMessageHandlerFailure(
	adapterName: string,
	threadId: string,
	error: unknown,
): void {
	const err = error instanceof Error ? error : new Error(String(error));
	console.error(
		JSON.stringify({
			event: "telegram_message_handler_failed",
			adapterName,
			threadId,
			errorName: err.name,
			message: err.message,
		}),
	);
}

function logFailureNotifyFailed(threadId: string, error: unknown): void {
	const err = error instanceof Error ? error : new Error(String(error));
	console.error(
		JSON.stringify({
			event: "telegram_failure_notification_failed",
			threadId,
			message: err.message,
		}),
	);
}

export type TelegramWorkerBindings = Cloudflare.Env & {
	OPENAI_API_KEY: string;
	TELEGRAM_WEBHOOK_SECRET: string;
};

function toModelMessages(transcript: TranscriptEntry[]): ModelMessage[] {
	return [
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
		console.info(JSON.stringify({ event, ...details }, null, 2));
	} catch (error) {
		console.info(
			JSON.stringify(
				{
					event,
					log_error: error instanceof Error ? error.message : String(error),
				},
				null,
				2,
			),
		);
	}
}

/** One-line minimal progress logs for the LLM path. */
function logLlmBrief(
	tag: "start" | "step" | "agent_ready",
	payload: Record<string, string | number | undefined>,
): void {
	console.info(`llm:${tag} ${JSON.stringify(payload, null, 2)}`);
}

type AgentStepForLog = Omit<StepResult<ToolSet>, "response">;

function stepsWithoutResponseForLog(
	steps: ReadonlyArray<StepResult<ToolSet>>,
): AgentStepForLog[] {
	return steps.map((step) => {
		const { response: _responseOmittedFromLogs, ...logged } = step;
		void _responseOmittedFromLogs;
		return logged;
	});
}

function logLlmCallComplete<
	R extends { steps: ReadonlyArray<StepResult<ToolSet>> },
>(args: {
	userKey: string;
	threadId: string;
	messages: ModelMessage[];
	provider: string;
	model: string;
	result: R;
}): void {
	const { userKey, threadId, messages, provider, model, result } = args;
	logLlmEvent("llm_call_complete", {
		...(result as Record<string, unknown>),
		steps: stepsWithoutResponseForLog(result.steps),
		userKey,
		threadId,
		messages,
		provider,
		model,
	});
}

export function createSolutoChat(env: TelegramWorkerBindings) {
	const state = createDurableObjectStateAdapter(env.CHAT_STATE);
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

	const originalProcessMessage = chat.processMessage.bind(chat);
	chat.processMessage = (adapter, threadId, messageOrFactory, options) => {
		const task = originalProcessMessage(
			adapter,
			threadId,
			messageOrFactory,
			options,
		);
		void task.catch(async (error: unknown) => {
			logTelegramMessageHandlerFailure(adapter.name, threadId, error);
			if (adapter.name !== "telegram") {
				return;
			}
			const text =
				error instanceof TranscriptionFailedError
					? AUDIO_TRANSCRIPTION_FAILURE_MESSAGE
					: MESSAGE_HANDLER_FAILURE_MESSAGE;
			try {
				await chat.getAdapter("telegram").postMessage(threadId, text);
			} catch (notifyErr) {
				logFailureNotifyFailed(threadId, notifyErr);
			}
		});
		return task;
	};

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

		logLlmBrief("start", {
			userKey,
			threadId: thread.id,
			n: messages.length,
		});

		const { agent } = await createAssistantAgent(env, {
			userKey,
			threadId: thread.id,
		});

		logLlmBrief("agent_ready", {
			userKey,
			threadId: thread.id,
		});

		const result = await agent.generate({
			messages,
			onStepFinish: (event) => {
				const toolNames = [
					...event.toolCalls.map((t) => String(t.toolName)),
					...event.dynamicToolCalls.map((t) => t.toolName),
				];
				logLlmBrief("step", {
					userKey,
					threadId: thread.id,
					step: event.stepNumber,
					...(toolNames.length > 0 ? { tools: toolNames.join(",") } : {}),
				});
			},
		});

		const replyText = result.text;

		logLlmCallComplete({
			userKey,
			threadId: thread.id,
			messages,
			provider: "openai",
			model: OPENAI_CHAT_MODEL_ID,
			result,
		});

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

		if (!audioAttachment.fetchData) {
			throw new TranscriptionFailedError(
				"Audio attachment does not provide fetchData",
			);
		}

		const audio = await audioAttachment.fetchData().catch((cause: unknown) => {
			throw new TranscriptionFailedError("Failed to fetch audio data", {
				cause,
			});
		});

		const transcript = await transcribe({
			model: groq.transcription(GROQ_TRANSCRIPTION_MODEL),
			audio,
		}).catch((cause: unknown) => {
			throw new TranscriptionFailedError("Transcription request failed", {
				cause,
			});
		});

		const transcribedText = transcript.text.trim();
		if (transcribedText.length === 0) {
			await thread.post(AUDIO_EMPTY_TRANSCRIPT_MESSAGE);
			return;
		}

		if (normalizeVoiceCommand(transcribedText) === "limpar") {
			await clearTranscript(thread, message.userKey);
			return;
		}

		const userText = `audio: ${transcribedText}`;
		await thread.post(userText);
		await generateReply(thread, message, message.userKey, userText);
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
