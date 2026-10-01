import { timingSafeEqual } from 'node:crypto';
import type { AgentConfig } from './feedback-agent';

export interface ProviderAttemptTrace {
  attempt: number;
  status: number;
  ok: boolean;
  content: string;
  contentChars: number;
  reasoningChars: number;
  toolCallCount: number;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
}

/** Attempt-local provider guard. Goose may retry internally; only the configured
 * bounded turn budget may reach the paid provider. */
export function summaryProviderGateway(config: AgentConfig, signal: AbortSignal, upstream = 'https://openrouter.ai', onTurn: (turn: ProviderAttemptTrace) => void = () => undefined, options: { allowTools?: boolean; maxProviderAttempts?: number; maxConcurrentRequests?: number; reasoningEffort?: "low"|"medium"|"high"; onReasoningStall?: () => void } = {}) {
  let dispatched = 0;
  let inFlight = 0;
  let consecutiveReasoningStalls = 0;
  const pendingTraces = new Set<Promise<void>>();
  const matchesKey = (header: string | null) => {
    const expected = Buffer.from(`Bearer ${config.key}`), actual = Buffer.from(header ?? '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    const path = new URL(request.url).pathname;
    const rejected = (status: number, code: string, message: string) => Response.json({error:{code,message}},{status});
    if (!matchesKey(request.headers.get('authorization'))) return rejected(401,'provider_gateway_auth','Provider gateway authentication failed');
    if (request.method==='GET' && path==='/api/v1/models') return Response.json({data:[{id:config.model,name:config.model,context_length:65536,supported_parameters:['tools'],top_provider:{max_completion_tokens:config.maxOutputTokens}}]});
    if (request.method!=='POST' || path!=='/api/v1/chat/completions') return rejected(404,'provider_gateway_route','Provider gateway route not found');
    if (signal.aborted) return rejected(499,'provider_gateway_aborted','Provider gateway request was aborted');
    let reserved=false;
    try {
      const received = await request.text();
      if(Buffer.byteLength(received)>config.maxInputBytes*4+128000)return rejected(413,'provider_request_too_large','Provider request exceeded the configured size limit');
      const value: unknown = JSON.parse(received);
      if(!value||typeof value!=='object'||Array.isArray(value))return rejected(400,'provider_request_invalid_json','Provider request must be a JSON object');
      const body=value as Record<string,unknown>;
      if(body.model!==config.model)return rejected(400,'provider_model_mismatch','Provider request model did not match the configured model');
      if(!Array.isArray(body.messages))return rejected(400,'provider_messages_invalid','Provider request messages were missing');
      if(!Array.isArray(body.tools))return rejected(400,'provider_tools_invalid','Provider request tools were missing');
      if(!options.allowTools&&(body.tools.length||body.tool_choice!=='none'))return rejected(400,'provider_tools_forbidden','Provider tools are disabled for this agent stage');
      if(body.stream!==true)return rejected(400,'provider_stream_required','Provider request must use streaming');
      if(!Number.isSafeInteger(body.max_tokens)||Number(body.max_tokens)<1||Number(body.max_tokens)>config.maxOutputTokens)return rejected(400,'provider_token_limit_invalid','Provider token limit was invalid');
      if(signal.aborted)return rejected(499,'provider_gateway_aborted','Provider gateway request was aborted');
      if(inFlight >= (options.maxConcurrentRequests ?? config.concurrency))return rejected(429,'provider_concurrency_exhausted','Another provider request is still running');
      if(dispatched >= (options.maxProviderAttempts ?? config.maxTurns))return rejected(429,'provider_request_budget_exhausted','Provider request budget exhausted');
      // Reserve synchronously after validation so concurrent requests cannot both dispatch.
      dispatched+=1;inFlight+=1;reserved=true;
      if(options.reasoningEffort)body.reasoning={effort:options.reasoningEffort};
      const serialized=JSON.stringify(body);
      const result=await fetch(`${upstream}${path}`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json'},body:serialized,signal,redirect:'error'});
      const attempt=dispatched;
      if (!result.body) {
        inFlight -= 1;
        onTurn({attempt,status:result.status,ok:result.ok,content:'',contentChars:0,reasoningChars:0,toolCallCount:0,finishReason:null,inputTokens:null,outputTokens:null,errorCode:result.ok?null:'provider_empty_body'});
        return new Response(null,{status:result.status,headers:{'content-type':result.headers.get('content-type')??'application/json'}});
      }
      const [clientBody, traceBody] = result.body.tee();
      const tracePromise = (async () => {
        try {
          const streamText = await new Response(traceBody).text(); let output = "",reasoningChars=0,toolCallCount=0,finishReason:string|null=null,inputTokens:number|null=null,outputTokens:number|null=null,errorCode:string|null=null;
          for (const line of streamText.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim(); if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown; reasoning?:unknown; reasoning_content?:unknown; tool_calls?:unknown }; message?: { content?: unknown; reasoning?:unknown; reasoning_content?:unknown; tool_calls?:unknown }; finish_reason?:unknown }>; usage?:{prompt_tokens?:unknown;completion_tokens?:unknown}; error?:{code?:unknown} };
              const choice=parsed.choices?.[0],delta=choice?.delta??choice?.message;
              const content=delta?.content;if(typeof content==='string')output+=content;
              const reasoning=delta?.reasoning_content??delta?.reasoning;if(typeof reasoning==='string')reasoningChars+=reasoning.length;
              if(Array.isArray(delta?.tool_calls))toolCallCount+=delta.tool_calls.length;
              if(typeof choice?.finish_reason==='string')finishReason=choice.finish_reason;
              if(typeof parsed.usage?.prompt_tokens==='number')inputTokens=parsed.usage.prompt_tokens;
              if(typeof parsed.usage?.completion_tokens==='number')outputTokens=parsed.usage.completion_tokens;
              if(typeof parsed.error?.code==='string')errorCode=parsed.error.code;
            } catch { /* Ignore provider framing noise. */ }
          }
          const reasoningStall=result.ok&&finishReason==="length"&&reasoningChars>0&&toolCallCount===0&&!output.trim();
          consecutiveReasoningStalls=reasoningStall?consecutiveReasoningStalls+1:0;
          onTurn({attempt,status:result.status,ok:result.ok,content:output,contentChars:output.length,reasoningChars,toolCallCount,finishReason,inputTokens,outputTokens,errorCode:errorCode??(result.ok?null:'provider_http_error')});
          if(consecutiveReasoningStalls>=2)options.onReasoningStall?.();
        } catch { onTurn({attempt,status:result.status,ok:result.ok,content:'',contentChars:0,reasoningChars:0,toolCallCount:0,finishReason:null,inputTokens:null,outputTokens:null,errorCode:'provider_trace_unavailable'}); }
      })();
      const tracked=tracePromise.finally(()=>{inFlight-=1;});pendingTraces.add(tracked);void tracked.finally(()=>pendingTraces.delete(tracked));
      return new Response(clientBody,{status:result.status,headers:{'content-type':result.headers.get('content-type')??'application/json'}});
    } catch { if(reserved)inFlight-=1;return rejected(502,'provider_unavailable','Provider request failed'); }
  }});
  return { origin:`http://127.0.0.1:${server.port}`, waitForTurns:()=>Promise.allSettled([...pendingTraces]), stop:()=>server.stop(true) };
}
