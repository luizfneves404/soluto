import { createGroq, type GroqTranscriptionModelOptions } from "@ai-sdk/groq";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { experimental_transcribe as transcribe } from "ai";
import type { Message, Thread } from "chat";
import { scorers } from "../scorers/weather-scorer";
import { weatherTool } from "../tools/weather-tool";

type DefaultHandler = (thread: Thread, message: Message) => Promise<void>;

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;
if (!groqApiKey) {
	throw new Error("GROQ_API_KEY is not set");
}

const groq = createGroq({
	apiKey: groqApiKey,
});

export const weatherAgent = new Agent({
	id: "weather-agent",
	name: "Weather Agent",
	instructions: `Você é um agente de IA personalizado que facilita a vida do usuário.
Se a mensagem do usuário começar com "Áudio: ", significa que ela foi transcrita por um modelo de áudio para texto, então use o contexto para entender o que o usuário realmente quer dizer.
Seja conciso e direto em suas respostas, mas seja criativo ao resolver os problemas do usuário e usar as ferramentas disponíveis.

- Always ask for a location if none is provided
- If the location name isn't in English, please translate it
- If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
- Include relevant details like humidity, wind conditions, and precipitation

Use the weatherTool to fetch current weather data.`,
	model: "openai/gpt-5.4-mini",
	tools: { weatherTool },
	scorers: {
		toolCallAppropriateness: {
			scorer: scorers.toolCallAppropriatenessScorer,
			sampling: {
				type: "ratio",
				rate: 1,
			},
		},
		completeness: {
			scorer: scorers.completenessScorer,
			sampling: {
				type: "ratio",
				rate: 1,
			},
		},
		translation: {
			scorer: scorers.translationScorer,
			sampling: {
				type: "ratio",
				rate: 1,
			},
		},
	},
	memory: new Memory(),
	...(telegramBotToken
		? {
				channels: {
					adapters: {
						telegram: createTelegramAdapter({
							mode: "auto",
						}),
					},
					inlineMedia: ["image/*"],
					handlers: {
						onDirectMessage: async (
							thread: Thread,
							message: Message,
							defaultHandler: DefaultHandler,
						) => {
							if (message.attachments?.[0]?.type === "audio") {
								console.log("Received audio message:", message);
								const attachment = message.attachments?.[0];
								if (!attachment) {
									throw new Error("No audio attachment");
								}
								if (!attachment.fetchData) {
									throw new Error("No fetchData method");
								}
								const audioData = await attachment.fetchData();
								const result = await transcribe({
									model: groq.transcription("whisper-large-v3-turbo"),
									audio: audioData,
									providerOptions: {
										groq: {
											language: "pt",
										} satisfies GroqTranscriptionModelOptions,
									},
								});
								console.log("Transcription:", result.text);
								const transcribedMessage: Message = {
									...message,
									text: `Áudio: ${result.text}`,
									attachments: [],
									toJSON: () => message.toJSON(),
								};
								await defaultHandler(thread, transcribedMessage);
								return;
							}
							await defaultHandler(thread, message);
						},
					},
				},
			}
		: {}),
});
