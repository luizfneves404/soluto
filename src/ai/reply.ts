import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

export const OPENAI_CHAT_MODEL_ID = 'gpt-5.4-mini' as const

export function createAssistantLanguageModel(openaiApiKey: string) {
  const openai = createOpenAI({ apiKey: openaiApiKey })
  return openai(OPENAI_CHAT_MODEL_ID)
}

export async function generateAssistantReply(openaiApiKey: string, userText: string) {
  const model = createAssistantLanguageModel(openaiApiKey)
  return generateText({
    model,
    prompt: userText,
  })
}
