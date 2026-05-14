# soluto

Soluto is a Telegram agent bot planned for Cloudflare Workers.

```txt
bun install
bun run dev
```

Set Worker secrets:

```txt
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put OPENAI_API_KEY
```

Optionally set a webhook secret and pass the same value when registering the Telegram webhook:

```txt
bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

```txt
bun run deploy
```

After deploy, register the Telegram webhook:

```txt
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  --json '{"url":"https://<worker-url>/telegram/webhook","secret_token":"<optional-webhook-secret>"}'
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
bun run cf-typegen
```

Today the webhook runs one **`generateText`** pass per Telegram text message (GPT `gpt-5.4-mini` via `@ai-sdk/openai`) and posts the assistant reply back to the chat. The same module exposes **`createAssistantLanguageModel`** so a future **`ToolLoopAgent`** (agent loop) can reuse the configured model instance.

## Overview

The goal is to run a small Telegram webhook API. The runtime should stay simple enough to fit Cloudflare Workers limits and make each dependency explicit.

## Why Not Mastra

Mastra's Cloudflare deployer currently produces a Worker bundle that exceeds the Cloudflare Workers Free 3 MB gzip limit even for a very small app. The planned runtime removes Mastra from the production path and uses smaller, direct building blocks.

## Tech Stack

- **Cloudflare Workers**: production runtime.
- **Hono**: HTTP API for the Telegram webhook.
- **Vercel AI SDK**: model calls, tool calling, and agent loop.
- **OpenAI GPT**: primary GPT model provider.
- **Groq**: fast model and audio transcription provider.
- **Skills**: local capability definitions loaded by the agent loop.
- **Daytona**: sandboxed shell command execution.
- **Cloudflare R2**: file system style object storage.
- **Cloudflare Durable Objects**: per-user Telegram chat history.
- **TypeScript**: application language.
- **Bun**: local package manager and development runner.

## Architecture

Telegram sends updates to a Hono webhook route running on Cloudflare Workers.

The Worker validates the Telegram request and runs a single-turn model completion with the Vercel AI SDK. Planned later: route each Telegram user through a Durable Object for chat history and replace the one-shot **`generateText`** call with an AI SDK **agent loop** (for example **`ToolLoopAgent`**), keeping tools and retrieval behind that loop.

Until then there is no Durable Object in the execution path—the Worker calls OpenAI directly and replies on Telegram.

Planned next: tools that use Daytona for sandbox commands and Cloudflare R2 as a file surface, wired through an agent loop. The Worker will send the assistant text to Telegram once that turn finishes.

## Runtime State

- The deployed webhook keeps no chat history server-side yet.
- Planned: files in Cloudflare R2, commands in Daytona, history in Durable Objects.
- Secrets are provided through Cloudflare Worker secrets.

## Plans

- Use Google Calendar REST API and expose it as tools for the agent