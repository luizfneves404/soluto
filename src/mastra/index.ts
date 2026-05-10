import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { CloudflareDeployer } from "@mastra/deployer-cloudflare";
import { PinoLogger } from "@mastra/loggers";
import {
	CloudExporter,
	DefaultExporter,
	Observability,
	SensitiveDataFilter,
} from "@mastra/observability";
import { weatherAgent } from "./agents/weather-agent";
import {
	completenessScorer,
	toolCallAppropriatenessScorer,
	translationScorer,
} from "./scorers/weather-scorer";
import { weatherWorkflow } from "./workflows/weather-workflow";
import { workspace } from "./workspace";

export const mastra = new Mastra({
	...(workspace ? { workspace } : {}),
	workflows: { weatherWorkflow },
	agents: { weatherAgent },
	scorers: {
		toolCallAppropriatenessScorer,
		completenessScorer,
		translationScorer,
	},
	storage: new InMemoryStore({ id: "mastra-storage" }),
	logger: new PinoLogger({
		name: "Mastra",
		level: "info",
	}),
	observability: new Observability({
		configs: {
			default: {
				serviceName: "mastra",
				exporters: [
					new DefaultExporter(), // Persists traces to storage for Mastra Studio
					new CloudExporter(), // Sends observability data to hosted Mastra Studio (if MASTRA_CLOUD_ACCESS_TOKEN is set)
				],
				spanOutputProcessors: [
					new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
				],
			},
		},
	}),
	deployer: new CloudflareDeployer({
		name: "soluto",
		compatibility_date: "2026-05-10",
		compatibility_flags: [
			"nodejs_compat",
			"nodejs_compat_populate_process_env",
		],
		workers_dev: false,
		preview_urls: false,
		observability: {
			logs: {
				enabled: false,
			},
		},
		main: "./.mastra/output/index.mjs",
		vars: {},
		alias: {
			typescript: "./.mastra/output/typescript-stub.mjs",
			execa: "./execa-stub.mjs",
			"readable-stream": "./readable-stream-stub.mjs",
		},
	}),
});
