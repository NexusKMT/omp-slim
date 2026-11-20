import { type } from "@oh-my-pi/omptype";
import { Effort } from "@oh-my-pi/pi-ai/effort";
import { once } from "@oh-my-pi/pi-utils";

/** Manual endpoint schema: unsupported protocols are errors; undeclared/retired fields are stripped. */
export const getModelsConfigSchemaBundle = once(() => {
	const ApiSchema = type('"openai-completions"');
	const EffortSchema = type.enumerated(
		Effort.Minimal,
		Effort.Low,
		Effort.Medium,
		Effort.High,
		Effort.XHigh,
		Effort.Max,
	);
	const OpenAICompatSchema = type({
		"+": "delete",
		"supportsStore?": "boolean",
		"supportsDeveloperRole?": "boolean",
		"supportsUsageInStreaming?": "boolean",
		"supportsStrictMode?": "boolean",
		"maxTokensField?": '"max_tokens" | "max_completion_tokens"',
	});
	const ThinkingSchema = type({
		"+": "delete",
		mode: '"effort"',
		efforts: EffortSchema.array().atLeastLength(1),
		"defaultLevel?": EffortSchema,
		"requiresEffort?": "boolean",
		"effortMap?": {
			"+": "delete",
			"minimal?": "string",
			"low?": "string",
			"medium?": "string",
			"high?": "string",
			"xhigh?": "string",
			"max?": "string",
		},
	});
	const ModelOverrideSchema = type({
		"+": "delete",
		"name?": "string",
		"api?": ApiSchema,
		"baseUrl?": "string",
		"kind?": '"chat"',
		"reasoning?": "boolean",
		"thinking?": ThinkingSchema,
		"input?": '("text" | "image")[]',
		"supportsTools?": "boolean",
		"contextWindow?": "number > 0 | null",
		"maxContextWindow?": "number > 0",
		"maxTokens?": "number > 0 | null",
		"omitMaxOutputTokens?": "boolean",
		"headers?": { "[string]": "string" },
		"compat?": OpenAICompatSchema,
		"cost?": { input: "number >= 0", output: "number >= 0", cacheRead: "number >= 0", cacheWrite: "number >= 0" },
		"promptCache?": { "+": "delete", "short?": "number > 0", "long?": "number > 0" },
		"imageCountBudget?": "number.integer > 0",
		"imageInputDecoder?": '"stb"',
		"tokenizer?": '"qwen3" | "deepseek-v3" | "kimi-k2" | "glm5" | "cl100k" | "o200k"',
	});
	const ModelDefinitionSchema = ModelOverrideSchema.and({ id: "string" });
	const ProviderAuthSchema = type('"apiKey" | "none"');
	const ProviderConfigSchema = type({
		"+": "delete",
		baseUrl: "string",
		"apiKey?": "string",
		"api?": ApiSchema,
		"auth?": ProviderAuthSchema,
		"authHeader?": "boolean",
		"headers?": { "[string]": "string" },
		"compat?": OpenAICompatSchema,
		models: ModelDefinitionSchema.array().atLeastLength(1),
	});
	const ModelsConfigSchema = type({
		"+": "delete",
		"providers?": { "[string]": ProviderConfigSchema },
	});
	return { OpenAICompatSchema, ModelOverrideSchema, ProviderAuthSchema, ModelsConfigSchema };
});

export const getModelsConfigSchema = () => getModelsConfigSchemaBundle().ModelsConfigSchema;
