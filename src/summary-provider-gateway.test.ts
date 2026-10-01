import { afterEach, describe, expect, test } from "bun:test";
import type { AgentConfig } from "./feedback-agent";
import { summaryProviderGateway, type ProviderAttemptTrace } from "./summary-provider-gateway";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

const config: AgentConfig = {
  key: "test-provider-key",
  model: "test/tool-model",
  binary: "/tmp/goose",
  timeoutMs: 1000,
  totalTimeoutMs: 2000,
  maxOutputTokens: 6000,
  maxInputBytes: 65536,
  concurrency: 1,
  maxTurns: 3,
  modelResolution: "environment",
};

function request(origin: string) {
  return fetch(`${origin}/api/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: "inspect" }], tools: [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }], stream: true, max_tokens: 6000 }),
  });
}

describe("summaryProviderGateway", () => {
  test("preserves reasoning and tool-only streams without classifying them as empty", async () => {
    const upstream = Bun.serve({ port: 0, fetch: () => new Response([
      'data: {"choices":[{"delta":{"reasoning":"inspect files"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"shell","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":34}}',
      "data: [DONE]",
      "",
    ].join("\n"), { headers: { "content-type": "text/event-stream" } }) });
    servers.push(upstream);
    const turns: ProviderAttemptTrace[] = [];
    const gateway = summaryProviderGateway(config, new AbortController().signal, `http://127.0.0.1:${upstream.port}`, turn => turns.push(turn), { allowTools: true, maxProviderAttempts: 2 });
    servers.push(gateway);

    const response = await request(gateway.origin);
    expect(response.status).toBe(200);
    await response.text();
    await gateway.waitForTurns();
    expect(turns).toEqual([expect.objectContaining({ ok: true, contentChars: 0, reasoningChars: 13, toolCallCount: 1, finishReason: "tool_calls", inputTokens: 12, outputTokens: 34, errorCode: null })]);
  });

  test("reports request-budget exhaustion distinctly instead of as authentication failure", async () => {
    const upstream = Bun.serve({ port: 0, fetch: () => new Response("data: [DONE]\n", { headers: { "content-type": "text/event-stream" } }) });
    servers.push(upstream);
    const gateway = summaryProviderGateway(config, new AbortController().signal, `http://127.0.0.1:${upstream.port}`, () => undefined, { allowTools: true, maxProviderAttempts: 1 });
    servers.push(gateway);

    expect((await request(gateway.origin)).status).toBe(200);
    const exhausted = await request(gateway.origin);
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toEqual({ error: { code: "provider_request_budget_exhausted", message: "Provider request budget exhausted" } });
  });

  test("sets the build reasoning effort and detects repeated reasoning-only truncation", async () => {
    const bodies:Record<string,unknown>[]=[];
    const upstream=Bun.serve({port:0,async fetch(request){bodies.push(await request.json() as Record<string,unknown>);return new Response([
      'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":12,"completion_tokens":6000}}',
      "data: [DONE]","",
    ].join("\n"),{headers:{"content-type":"text/event-stream"}});}});servers.push(upstream);
    let stalls=0;const gateway=summaryProviderGateway(config,new AbortController().signal,`http://127.0.0.1:${upstream.port}`,()=>undefined,{allowTools:true,maxProviderAttempts:3,reasoningEffort:"low",onReasoningStall:()=>{stalls+=1;}});servers.push(gateway);
    await (await request(gateway.origin)).text();await gateway.waitForTurns();
    await (await request(gateway.origin)).text();await gateway.waitForTurns();
    expect(bodies.map(body=>body.reasoning)).toEqual([{effort:"low"},{effort:"low"}]);expect(stalls).toBe(1);
  });
});
