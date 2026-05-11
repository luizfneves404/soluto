import {
	createOpenAI,
	type OpenAILanguageModelResponsesOptions,
} from "@ai-sdk/openai";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { type ModelMessage, ToolLoopAgent, type ToolSet } from "ai";

export const OPENAI_CHAT_MODEL_ID = "gpt-5.4-mini" as const;
export const GOOGLE_CALENDAR_TOOLKIT = "googlecalendar" as const;

const ENABLED_COMPOSIO_TOOLKITS = [GOOGLE_CALENDAR_TOOLKIT] as const;

export type AssistantAgentBindings = {
	OPENAI_API_KEY: string;
	COMPOSIO_API_KEY: string;
};

export type AssistantAgentContext = {
	userKey: string;
	threadId: string;
	/** Persisted from prior turns; when set, `composio.use()` reuses the tool-router session. */
	composioSessionId?: string;
};

export type AssistantAgentInstance = {
	agent: ToolLoopAgent;
	/** Present when Composio is configured; store per user and pass back as `context.composioSessionId`. */
	composioSessionId?: string;
};

export function composioToolRouterSessionStateKey(userKey: string): string {
	return `composio:tool-router-session:${userKey}`;
}

function createComposio(env: AssistantAgentBindings) {
	return new Composio({
		apiKey: env.COMPOSIO_API_KEY,
		provider: new VercelProvider({ strict: true }),
	});
}

type ComposioInstance = NonNullable<ReturnType<typeof createComposio>>;

async function loadComposioToolsForSession(
	composio: ComposioInstance,
	userId: string,
	storedSessionId: string | undefined,
): Promise<{ tools: ToolSet; composioSessionId: string }> {
	const session = storedSessionId
		? await composio.use(storedSessionId)
		: await composio.create(userId, {
				toolkits: [...ENABLED_COMPOSIO_TOOLKITS],
			});
	const tools = (await session.tools()) as ToolSet;
	return { tools, composioSessionId: session.sessionId };
}

export async function createCalendarConnectionUrl(
	env: AssistantAgentBindings,
	userKey: string,
): Promise<string | null> {
	const composio = createComposio(env);

	const connectionRequest = await composio.toolkits.authorize(
		userKey,
		GOOGLE_CALENDAR_TOOLKIT,
	);

	return connectionRequest.redirectUrl ?? null;
}

export async function createAssistantAgent(
	env: AssistantAgentBindings,
	context: AssistantAgentContext,
): Promise<AssistantAgentInstance> {
	const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
	const composio = createComposio(env);
	const composioUserId = context.userKey;

	const loaded = await loadComposioToolsForSession(
		composio,
		composioUserId,
		context.composioSessionId,
	);
	const tools = loaded.tools;
	const composioSessionId = loaded.composioSessionId;

	const agent = new ToolLoopAgent({
		model: openai(OPENAI_CHAT_MODEL_ID),
		instructions: `You are Soluto, a helpful assistant in Telegram. Keep responses formatted for mobile reading. Be proactive, not overly hesitant, in order to fulfill the user's intent as quickly and efficiently as possible. If something doesn't work at first, try something else: be relentlessly resourceful. If the action is potentially irreversible and the user's intent is unclear, you should ask for confirmation.
Use Google Calendar tools when the user's request involves their calendar, scheduling, availability, or events.
Whenever a message starts with "audio: ", it is a transcription of an audio message. Keep in mind that transcriptions may be inaccurate when inferring user intent.`,
		tools,
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

	return { agent, composioSessionId };
}

export async function generateAssistantAgentReply(
	env: AssistantAgentBindings,
	context: AssistantAgentContext,
	messages: ModelMessage[],
) {
	const { agent, composioSessionId } = await createAssistantAgent(env, context);

	const result = await agent.generate({
		messages,
	});

	return { ...result, composioSessionId };
}
