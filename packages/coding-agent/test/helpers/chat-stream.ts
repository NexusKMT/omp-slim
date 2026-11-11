import { spyOn } from "bun:test";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import * as chat from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { OpenAICompletionsOptions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

/** Replace the network transport while exercising normal Chat dispatch and session guards. */
export function mockChatStream(
 handler: (model: Model<"openai-completions">, context: Context, options?: OpenAICompletionsOptions) => AssistantMessageEventStream,
): void {
 spyOn(chat, "streamOpenAICompletions").mockImplementation(handler);
}
