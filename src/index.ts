import type { Chat } from 'chat'
import { Hono } from 'hono'

import { createSolutoChat } from './bot'

export { ChatStateDurableObject } from './chat-state-durable-object'

type Bindings = Cloudflare.Env & {
  TELEGRAM_WEBHOOK_SECRET?: string
}

let chatInstance: Chat | null = null

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => {
  return c.json({ ok: true, service: 'soluto' })
})

app.post('/telegram/webhook', async (c) => {
  if (!c.env.TELEGRAM_BOT_TOKEN) {
    console.error(JSON.stringify({ event: 'missing_telegram_bot_token' }))
    return c.json({ ok: false, error: 'missing_telegram_bot_token' }, 500)
  }

  if (!chatInstance) {
    chatInstance = createSolutoChat(c.env)
  }

  const executionCtx = c.executionCtx
  const webhookOptions =
    executionCtx === undefined
      ? undefined
      : {
          waitUntil: (task: PromiseLike<unknown>) =>
            executionCtx.waitUntil(Promise.resolve(task)),
        }

  return chatInstance.webhooks.telegram(c.req.raw, webhookOptions)
})

export default app
