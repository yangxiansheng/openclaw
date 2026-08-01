import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type CapturedRequest = { model?: string };

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
});

async function startProofModelServer(): Promise<{
  server: Server;
  baseUrl: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "claude-fable-5", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: `unexpected ${request.method} ${url.pathname}` } }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest);
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      const base = {
        id: "chatcmpl-117470-proof",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "claude-fable-5",
      };
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Persisted compaction proof summary: earlier requests were completed.",
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    })().catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof model server did not bind");
  }
  cleanupTasks.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

describe("native /compact real behavior proof (#117470)", () => {
  it(
    "persists a real compaction boundary for a stored claude-cli override",
    async () => {
      console.log("PROOF_STAGE importing session persistence");
      const [{ SessionManager }, sessionAccessor] = await Promise.all([
        import("../../agents/sessions/session-manager.js"),
        import("../../config/sessions/session-accessor.js"),
      ]);
      const { loadSessionEntry, loadTranscriptEvents, replaceSessionEntry } = sessionAccessor;
      console.log("PROOF_STAGE importing usage accounting");
      const { buildUsageWithNoCost } = await import("../../agents/stream-message-shared.js");
      console.log("PROOF_STAGE importing native slash path");
      const { maybeResolveNativeSlashCommandFastReply } = await import(
        "./get-reply-native-slash-fast-path.js"
      );
      const { createTypingController } = await import("./typing.js");
      console.log("PROOF_STAGE imports complete");
      const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-117470-proof-"));
      cleanupTasks.push(() => rm(stateDir, { recursive: true, force: true }));
      const workspaceDir = path.join(stateDir, "workspace");
      const agentDir = path.join(stateDir, "agent");
      await Promise.all([
        mkdir(workspaceDir, { recursive: true }),
        mkdir(agentDir, { recursive: true }),
      ]);
      const { baseUrl, requests } = await startProofModelServer();
      const sessionKey = "agent:main:main";
      const sessionId = "proof-session-117470";
      const storePath = path.join(stateDir, "openclaw.sqlite");
      const target = { agentId: "main", sessionId, sessionKey, storePath };
      const cfg = {
        session: { store: storePath, scope: "per-sender" },
        commands: { text: true },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            contextTokens: 372_000,
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
              "anthropic/claude-fable-5": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
        models: {
          providers: {
            anthropic: {
              baseUrl,
              apiKey: "proof-local-key",
              api: "openai-completions",
              models: [
                {
                  id: "claude-fable-5",
                  name: "Claude Fable 5 proof fixture",
                  api: "openai-completions",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_000_000,
                  maxTokens: 8_192,
                  agentRuntime: { id: "claude-cli" },
                },
              ],
            },
          },
        },
      } as OpenClawConfig;

      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId,
          updatedAt: Date.now(),
          providerOverride: "claude-cli",
          modelOverride: "claude-fable-5",
          contextTokens: 1_000_000,
          agentHarnessId: "claude-cli",
          cliSessionBindings: {
            "claude-cli": {
              sessionId: "native-claude-session-redacted",
              forceReuse: true,
              forkNextResume: true,
            },
          },
        },
      );

      const manager = SessionManager.open(target, workspaceDir);
      const usage = buildUsageWithNoCost({
        input: 2,
        output: 1,
        cacheRead: 133_495,
        cacheWrite: 1_432,
      });
      for (let turn = 1; turn <= 4; turn += 1) {
        manager.appendMessage({
          role: "user",
          content: `Persisted proof request ${turn}: ${"context ".repeat(200)}`,
          timestamp: turn * 2 - 1,
        });
        manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: `Persisted proof answer ${turn}.` }],
          stopReason: "stop",
          api: "cli",
          provider: "claude-cli",
          model: "claude-fable-5",
          usage,
          timestamp: turn * 2,
        });
      }
      const beforeEvents = await loadTranscriptEvents(target);
      const beforeCompactions = beforeEvents.filter((event) => event.type === "compaction").length;

      const result = await maybeResolveNativeSlashCommandFastReply({
        ctx: {
          Body: "/compact",
          BodyForCommands: "/compact",
          CommandBody: "/compact",
          commandText: "/compact",
          rawText: "/compact",
          agentText: "",
          CommandSource: "native",
          CommandAuthorized: true,
          SessionKey: "telegram:slash:redacted",
          CommandTargetSessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
          OriginatingChannel: "telegram",
          ChatType: "direct",
          From: "telegram:redacted",
          SenderId: "telegram:redacted",
          CommandTurn: {
            kind: "native",
            source: "native",
            authorized: true,
            commandName: "compact",
            body: "/compact",
          },
        } as never,
        cfg,
        agentId: "main",
        agentDir,
        agentCfg: cfg.agents?.defaults,
        commandAuthorized: true,
        defaultProvider: "openai",
        defaultModel: "gpt-5.6-sol",
        aliasIndex: { byKey: new Map(), byAlias: new Map() },
        provider: "openai",
        model: "gpt-5.6-sol",
        workspaceDir,
        typing: createTypingController({}),
      });

      const afterEvents = await loadTranscriptEvents(target);
      const compactionEvents = afterEvents.filter((event) => event.type === "compaction");
      const sessionEntry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
      const reply = result.handled && !Array.isArray(result.reply) ? result.reply : undefined;
      const latestCompaction = compactionEvents.at(-1);
      const verdict = {
        synthesizedTotalTokens: usage.totalTokens,
        modelRequestCount: requests.length,
        requestedModel: requests.at(-1)?.model,
        persistedCompactionDelta: compactionEvents.length - beforeCompactions,
        persistedCompactionSummary:
          latestCompaction?.type === "compaction" ? latestCompaction.summary : undefined,
        persistedContextTokens: sessionEntry?.contextTokens,
        persistedCompactionCount: sessionEntry?.compactionCount,
        reply: reply?.text,
        resolvedOneMillionBudget: reply?.text?.includes("/1.0m") === true,
        compactionSideEffectObserved: compactionEvents.length > beforeCompactions,
      };
      console.log("PROOF_ENV provider=github-actions auth=local-mock-only");
      console.log(
        `PRE_COMPACTION transcriptEvents=${beforeEvents.length} totalTokens=${usage.totalTokens}`,
      );
      console.log(
        `POST_COMPACTION modelRequests=${requests.length} compactionEntries=${compactionEvents.length}`,
      );
      console.log(`REPLY ${reply?.text ?? "<missing>"}`);
      console.log(`VERDICT_JSON ${JSON.stringify(verdict)}`);

      expect(usage.totalTokens).toBe(134_930);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.model).toBe("claude-fable-5");
      expect(compactionEvents.length).toBeGreaterThan(beforeCompactions);
      expect(latestCompaction).toMatchObject({
        type: "compaction",
        summary: expect.stringContaining("Persisted compaction proof summary"),
      });
      expect(reply?.text).toContain("/1.0m");
    },
    90_000,
  );
});
