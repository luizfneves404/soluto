import {
	createOpenAI,
	type OpenAILanguageModelResponsesOptions,
} from "@ai-sdk/openai";
import { type ModelMessage, ToolLoopAgent } from "ai";

export const OPENAI_CHAT_MODEL_ID = "gpt-5.4-mini" as const;

export type AssistantAgentBindings = {
	OPENAI_API_KEY: string;
};

export type AssistantAgentContext = {
	userKey: string;
	threadId: string;
};

export type AssistantAgentInstance = {
	agent: ToolLoopAgent;
};

export async function createAssistantAgent(
	env: AssistantAgentBindings,
	context: AssistantAgentContext,
): Promise<AssistantAgentInstance> {
	const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });

	const agent = new ToolLoopAgent({
		model: openai(OPENAI_CHAT_MODEL_ID),
		instructions: `You are Soluto, a helpful assistant in Telegram. Keep responses formatted for mobile reading. Be proactive, not overly hesitant, in order to fulfill the user's intent as quickly and efficiently as possible. If something doesn't work at first, try something else: be relentlessly resourceful. If the action is potentially irreversible and the user's intent is unclear, you should ask for confirmation.
Whenever a message starts with "audio: ", it is a transcription of an audio message. Transcriptions may be innacurate! Correct possible mistakes and prioritize meaning over exact wording, searching for similar, more probable words when the user says something weird.`,
		tools: {},
		providerOptions: {
			openai: {
				user: context.userKey,
				reasoningEffort: "none",
				textVerbosity: "low",
			} satisfies OpenAILanguageModelResponsesOptions,
		},
		experimental_telemetry: {
			isEnabled: true,
			functionId: "telegram-agent",
			recordInputs: true,
			recordOutputs: true,
			metadata: {
				userKey: context.userKey,
				threadId: context.threadId,
			},
		},
	});

	return { agent };
}

export async function generateAssistantAgentReply(
	env: AssistantAgentBindings,
	context: AssistantAgentContext,
	messages: ModelMessage[],
) {
	const { agent } = await createAssistantAgent(env, context);

	const result = await agent.generate({
		messages,
	});

	return result;
}
