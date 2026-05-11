import { generateAssistantAgentReply, OPENAI_CHAT_MODEL_ID } from './agent'

export { OPENAI_CHAT_MODEL_ID }

export async function generateAssistantReply(openaiApiKey: string, userText: string) {
  return generateAssistantAgentReply(
    { OPENAI_API_KEY: openaiApiKey },
    { userKey: 'default', threadId: 'default' },
    [{ role: 'user', content: userText }],
  )
}
