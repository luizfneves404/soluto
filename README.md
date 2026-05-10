# soluto

Soluto agent bot for Telegram.

## Getting Started

Install dependencies (once per clone):

```shell
bun install
```

Start the development server:

```shell
bun run dev
```

Open [http://localhost:4111](http://localhost:4111) in your browser to access [Mastra Studio](https://mastra.ai/docs/studio/overview). It provides an interactive UI for building and testing your agents, along with a REST API that exposes your Mastra application as a local service. This lets you start building without worrying about integration right away.

You can start editing files inside the `src/mastra` directory. The development server will automatically reload whenever you make changes.

## Telegram bot local test

1. Create a bot in Telegram with `@BotFather`, then copy the bot token and username.
2. Create `.env` from `.env.example` and fill:

```shell
OPENAI_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=your_bot_username
```

3. Start Mastra:

```shell
bun run dev
```

4. Open the bot on your phone and send a direct message like `weather in Lisbon`.

See results in the terminal!

## Cloudflare Workers

This project includes Mastra's Cloudflare deployer and the `@mastra/cloudflare` package. Telegram is configured in webhook mode, which is the correct mode for Workers.

Before deployment, set these Cloudflare secrets:

```shell
bunx wrangler secret put OPENAI_API_KEY
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_BOT_USERNAME
bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET_TOKEN
```

After deployment, register Telegram with:

```shell
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"https://YOUR-WORKER-DOMAIN/api/agents/weather-agent/channels/telegram/webhook\",
    \"secret_token\": \"$TELEGRAM_WEBHOOK_SECRET_TOKEN\"
  }"
```

Mastra's Durable Objects storage adapter (`CloudflareDOStorage`) must be constructed inside a Durable Object from `ctx.storage.sql`. The generated Cloudflare deployer Worker does not run the Mastra server inside a Durable Object by default, so a production Durable Objects backend requires a custom Worker entry that exports a Durable Object class and forwards requests through that object.

## Learn more

To learn more about Mastra, visit our [documentation](https://mastra.ai/docs/). Your bootstrapped project includes example code for [agents](https://mastra.ai/docs/agents/overview), [tools](https://mastra.ai/docs/agents/using-tools), [workflows](https://mastra.ai/docs/workflows/overview), [scorers](https://mastra.ai/docs/evals/overview), and [observability](https://mastra.ai/docs/observability/overview).

If you're new to AI agents, check out our [course](https://mastra.ai/learn) and [YouTube videos](https://youtube.com/@mastra-ai). You can also join our [Discord](https://discord.gg/BTYqqHKUrf) community to get help and share your projects.

## Deploy to the Mastra platform

The [Mastra platform](https://projects.mastra.ai) provides two products for deploying and managing AI applications built with the Mastra framework:

- **Studio**: A hosted visual environment for testing agents, running workflows, and inspecting traces
- **Server**: A production deployment target that runs your Mastra application as an API server

Learn more in the [Mastra platform documentation](https://mastra.ai/docs/mastra-platform/overview).

# Tech

- Bun (pnpm was taking too long on build)