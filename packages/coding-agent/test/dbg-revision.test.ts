import { expect, it } from "bun:test";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { type Api, type Model, type ModelSpec, registerCustomApi } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

it("debug revision", async () => {
  using tempDir = TempDir.createSync("@pi-dbg-rev-");
  const api = "test-dbg-revision";
  let requests = 0;
  const seenContexts: unknown[] = [];
  registerCustomApi(api, (_model, context) => {
    seenContexts.push(JSON.parse(JSON.stringify(context.messages)));
    requests++;
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      if (requests === 1) {
        const message = createAssistantMessage("");
        const toolCall = { type: "toolCall", id: "call-revise-1", name: "bash", arguments: { command: "echo original" } } as const;
        message.content = [toolCall];
        message.stopReason = "toolUse";
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall as never, partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
      } else {
        const message = createAssistantMessage("done");
        stream.push({ type: "done", reason: "stop", message });
      }
    });
    return stream;
  });
  const model = buildModel({
    id: "local-dbg", name: "dbg", api, provider: "ollama", baseUrl: "http://127.0.0.1:11434",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096, maxTokens: 1024,
  } as ModelSpec<Api>) as Model<Api>;
  let handlerCalls = 0;
  const reviseBash: ExtensionFactory = pi => {
    pi.on("tool_call", async event => {
      handlerCalls++;
      console.log("HANDLER tool_call", event.toolName, JSON.stringify(event.input));
      if (event.toolName !== "bash") return undefined;
      return { input: { command: "echo revised" } };
    });
  };
  const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
  const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
  const { session } = await createAgentSession({
    cwd: tempDir.path(), agentDir: tempDir.path(), sessionManager: SessionManager.inMemory(tempDir.path()),
    authStorage, modelRegistry,
    settings: Settings.isolated({ "compaction.enabled": false, "bash.autoBackground.enabled": false, "bashInterceptor.enabled": false }),
    model, disableExtensionDiscovery: true, extensions: [reviseBash], skills: [], contextFiles: [],
    promptTemplates: [], slashCommands: [], enableMCP: false, enableLsp: false, skipPythonPreflight: true,
    toolNames: ["bash"],
  });
  try {
    console.log("hasHandlers tool_call:", session.extensionRunner?.hasHandlers("tool_call"));
    console.log("agent.beforeToolCall set:", typeof session.agent.beforeToolCall);
    session.subscribe(ev => {
      if (ev.type.startsWith("tool_")) console.log("EVENT", ev.type, JSON.stringify((ev as any).args ?? ""));
    });
    await session.sendUserMessage("run it");
    console.log("handlerCalls:", handlerCalls);
    console.log("REQ2 CONTEXT", JSON.stringify(seenContexts[1]).slice(0, 400));
    for (const m of session.agent.state.messages) {
      console.log("MSG", m.role, JSON.stringify((m as any).content).slice(0, 200));
    }
  } finally {
    await session.dispose();
    authStorage.close();
  }
  expect(true).toBe(true);
}, 30000);
