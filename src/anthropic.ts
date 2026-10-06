import Anthropic from "@anthropic-ai/sdk";

// Sonnet 5: cheaper than Sonnet 4.6 ($2/$10 vs $3/$15 per MTok — the launch
// price was made permanent) AND a strict upgrade on agentic web research
// (Anthropic's BrowseComp curves dominate 4.6). One caveat baked into cost
// math elsewhere: the 4.7+ tokenizer emits ~30% more tokens for the same
// text, so the net saving is smaller than the sticker gap, never negative.
export const DEFAULT_MODEL = "claude-sonnet-5";

export type ProgressEvent =
  | { type: "start"; model: string }
  | { type: "search"; query: string; index: number }
  | { type: "fetch"; url: string; index: number }
  | { type: "thinking" }
  | { type: "output_started" }
  | { type: "done"; searchesUsed: number; fetchesUsed: number };

export type OnProgress = (event: ProgressEvent) => void;

/** output_config.effort levels this engine will set. */
export type EffortLevel = "low" | "medium" | "high";

/**
 * Sonnet 5 issues independent searches in bursts of 3–5 per turn. When a
 * burst overshoots max_uses, the extra calls come back as
 * max_uses_exceeded and the model spends further turns retrying them
 * ("the tool hit a hard limit") — observed in benchmark transcripts. The
 * prompt states the real budget; the tool gets this much slack so a burst
 * at the end of the budget lands instead of erroring.
 */
export const BURST_HEADROOM = 4;

/**
 * A long server-tool turn can come back as stop_reason "pause_turn" with
 * the output tool not yet called. Each continuation re-sends the paused
 * content as-is; this caps how many times before giving up.
 */
const MAX_PAUSE_CONTINUATIONS = 3;

/**
 * Token accounting for one call. Callers forward this to their own telemetry
 * so cost-per-dossier is a measured number rather than an estimate — nothing
 * else in the pipeline records tokens (the usage meters count leads and
 * dossiers, which is billing, not spend).
 *
 * `batched` matters for reading the numbers back: batched tokens bill at half
 * price, so a batched call's input_tokens is NOT comparable to a live one's
 * without halving the rate.
 */
export type CallUsage = {
  /** Which model spent these tokens — rates differ ~3x between families. */
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  batched: boolean;
};

/**
 * Fires once per model call. Separate from `onProgress` on purpose: progress
 * is user-facing narration, usage is our books — it must never end up in the
 * event rows the dashboard renders.
 */
export type OnUsage = (usage: CallUsage) => void;

/** Normalize the SDK's nullable usage fields into plain numbers. */
function readUsage(message: Anthropic.Message, batched: boolean): CallUsage {
  const u = message.usage;
  return {
    model: message.model,
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
    batched,
  };
}

/**
 * Run a tool-use call where the model is expected to ultimately call a
 * specific structured-output tool. Returns that tool call's input.
 *
 * If `webSearch` is true, the server-side web_search tool is added. If
 * `webFetch` is true, the server-side web_fetch tool is added — it retrieves
 * a specific URL directly, which rescues sites that search engines haven't
 * indexed (web_search can only find what's indexed). web_fetch only fetches
 * URLs already present in the conversation or in prior search results.
 *
 * With either server tool enabled, `tool_choice` stays on "auto" so the
 * model can search/fetch freely before calling the output tool. (Forcing
 * tool_choice to a specific tool blocks server tools entirely — they're
 * mutually exclusive.) Otherwise `tool_choice` is forced to the output tool
 * for deterministic single-call structured generation.
 *
 * Streams the response so callers get live progress events (one per web
 * search or fetch the model issues) — the CLI spinner and the web
 * playground both feed off `onProgress`.
 */
export async function callStructured<T>(args: {
  client: Anthropic;
  model?: string;
  systemPrompt: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  toolInputSchema: Record<string, unknown>;
  cacheSystem?: boolean;
  webSearch?: boolean;
  /** The budget the prompt states; the tool itself gets BURST_HEADROOM more. */
  webSearchMaxUses?: number;
  webFetch?: boolean;
  /** Same headroom rule as webSearchMaxUses. */
  webFetchMaxUses?: number;
  /**
   * Cap on tokens kept from ONE fetched page. Costly: fetched content stays
   * in context for every subsequent turn of the server-tool loop, so a
   * generous cap is paid repeatedly, not once. Defaults to the historical
   * 15000 — tune per call site (a contact or imprint page carries a fraction
   * of that in useful content).
   */
  maxContentTokens?: number;
  maxTokens?: number;
  onProgress?: OnProgress;
  signal?: AbortSignal;
  /**
   * Route through the Message Batches API: same request, half the token
   * price. Most batches finish in minutes, but the ONLY guarantee is 24
   * hours — so after `batchWaitMs` (default 10 min) the batch is canceled
   * and the request falls back to the live API. Progress events degrade to
   * start/done — batches don't stream.
   */
  batch?: boolean;
  batchWaitMs?: number;
  /**
   * How hard the model works, across thinking, narration and tool calls
   * (output_config.effort). The API default is "high", which on Sonnet 5
   * means a long reasoning stretch before the output tool — measured at
   * 60–280 s of silence after the last search. Lower levels "proceed
   * directly to action without preamble" (Anthropic's words). Only on
   * models that support effort; Haiku 4.5 rejects it, so leave it unset there.
   */
  effort?: EffortLevel;
  /**
   * "filtered" (default): the _20260209 web tools run each search through a
   * code-execution sandbox that filters results before they reach context.
   * "direct": the tools answer directly, no sandbox round-trip. Measured
   * per call site — the sandbox saves input tokens but costs wall-clock.
   */
  webToolCalling?: "filtered" | "direct";
  /**
   * "excluded": with filtered calling, drop the search/fetch result blocks
   * that code execution already consumed from the response. They are billed
   * as OUTPUT tokens otherwise (the API echoes them back), which is where a
   * surprising share of a search call's 16–27k output tokens went. Needs the
   * _20260318 tool versions, selected automatically.
   */
  responseInclusion?: "full" | "excluded";
}): Promise<{ output: T; searchesUsed: number; fetchesUsed: number; usage: CallUsage }> {
  const model = args.model ?? DEFAULT_MODEL;

  const tool = {
    name: args.toolName,
    description: args.toolDescription,
    input_schema: args.toolInputSchema as Anthropic.Tool.InputSchema,
  } as Anthropic.Tool;

  // The _20260209 web-tool variants filter search results server-side
  // (the filtering pass is free) before they hit the context, so every
  // subsequent turn re-reads fewer input tokens — same information, less
  // money. They exist only on Sonnet 4.6+/5 and Opus 4.6+; Haiku rejects
  // them, so it keeps the basic variants.
  const modernWebTools = /claude-(sonnet-(5|4-6)|opus-(5|4-[678]))/.test(model);
  // response_inclusion only exists from the _20260318 versions on.
  const excluded = modernWebTools && args.responseInclusion === "excluded";
  const webToolExtras = modernWebTools
    ? {
        ...(args.webToolCalling === "direct" ? { allowed_callers: ["direct"] } : {}),
        ...(excluded ? { response_inclusion: "excluded" } : {}),
      }
    : {};
  const tools: Anthropic.ToolUnion[] = [tool];
  if (args.webSearch) {
    tools.push({
      type: modernWebTools
        ? excluded
          ? "web_search_20260318"
          : "web_search_20260209"
        : "web_search_20250305",
      name: "web_search",
      max_uses: (args.webSearchMaxUses ?? 3) + BURST_HEADROOM,
      ...webToolExtras,
    } as unknown as Anthropic.ToolUnion);
  }
  if (args.webFetch) {
    tools.push({
      type: modernWebTools
        ? excluded
          ? "web_fetch_20260318"
          : "web_fetch_20260209"
        : "web_fetch_20250910",
      name: "web_fetch",
      max_uses: (args.webFetchMaxUses ?? 4) + BURST_HEADROOM,
      // Bound the token cost of a single fetched page.
      max_content_tokens: args.maxContentTokens ?? 15000,
      ...webToolExtras,
    } as unknown as Anthropic.ToolUnion);
  }

  const systemBlocks: Anthropic.TextBlockParam[] = args.cacheSystem
    ? [{ type: "text", text: args.systemPrompt, cache_control: { type: "ephemeral" } }]
    : [{ type: "text", text: args.systemPrompt }];

  const serverTools = Boolean(args.webSearch || args.webFetch);
  const toolChoice: Anthropic.MessageCreateParams["tool_choice"] = serverTools
    ? { type: "auto" }
    : { type: "tool", name: args.toolName };

  args.onProgress?.({ type: "start", model });

  const requestParams = {
    model,
    max_tokens: args.maxTokens ?? 4096,
    system: systemBlocks,
    tools,
    tool_choice: toolChoice,
    messages: [{ role: "user" as const, content: args.userMessage }],
    // Not in this SDK version's types yet; the API accepts it.
    ...(args.effort ? { output_config: { effort: args.effort } } : {}),
  };
  const requestOptions = args.webFetch
    ? { headers: { "anthropic-beta": "web-fetch-2025-09-10" } }
    : {};

  if (args.batch) {
    const message = await runBatchWithFallback<T>(args, requestParams, requestOptions);
    if (message) {
      assertNotTruncated(message, args.toolName, requestParams.max_tokens);
      let searchesUsed = 0;
      let fetchesUsed = 0;
      // The SDK's Message content union predates server tools — inspect raw.
      for (const block of message.content as Array<{ type: string; name?: string }>) {
        if (block.type === "server_tool_use" && block.name === "web_search") searchesUsed++;
        else if (block.type === "server_tool_use" && block.name === "web_fetch") fetchesUsed++;
      }
      args.onProgress?.({ type: "done", searchesUsed, fetchesUsed });
      for (const block of message.content) {
        if (block.type === "tool_use" && block.name === args.toolName) {
          return {
            output: block.input as T,
            searchesUsed,
            fetchesUsed,
            usage: readUsage(message, true),
          };
        }
      }
      throw new Error(
        `model did not call tool ${args.toolName}; stop_reason=${message.stop_reason}`,
      );
    }
    // Batch didn't finish inside the wait window — fall through to live.
  }

  // Surface per-search/per-fetch progress: each server_tool_use block is one
  // web search or one page fetch; its input streams in via input_json_delta.
  // We buffer the partial JSON per block and emit once the block closes.
  let searchesUsed = 0;
  let fetchesUsed = 0;
  const usage: CallUsage = {
    model,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    batched: false,
  };
  const messages: Anthropic.MessageParam[] = [...requestParams.messages];
  let response: Anthropic.Message | undefined;

  for (let continuation = 0; continuation <= MAX_PAUSE_CONTINUATIONS; continuation++) {
    const stream = args.client.messages.stream(
      { ...requestParams, messages } as Anthropic.MessageStreamParams,
      {
        signal: args.signal,
        // web_fetch shipped behind this beta header; harmless once GA.
        ...requestOptions,
      },
    );
    const partialInputs = new Map<number, { kind: "search" | "fetch"; json: string }>();

    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start") {
        const block = event.content_block as { type?: string; name?: string };
        if (block.type === "server_tool_use" && block.name === "web_search") {
          partialInputs.set(event.index, { kind: "search", json: "" });
        } else if (block.type === "server_tool_use" && block.name === "web_fetch") {
          partialInputs.set(event.index, { kind: "fetch", json: "" });
        } else if (block.type === "tool_use") {
          args.onProgress?.({ type: "output_started" });
        }
      } else if (event.type === "content_block_delta") {
        const entry = partialInputs.get(event.index);
        if (entry && event.delta.type === "input_json_delta") {
          entry.json += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        const entry = partialInputs.get(event.index);
        if (entry?.kind === "search") {
          searchesUsed += 1;
          let query = "";
          try {
            query = (JSON.parse(entry.json || "{}") as { query?: string }).query ?? "";
          } catch {
            // partial JSON — leave query empty, still count the search
          }
          args.onProgress?.({ type: "search", query, index: searchesUsed });
          partialInputs.delete(event.index);
        } else if (entry?.kind === "fetch") {
          fetchesUsed += 1;
          let url = "";
          try {
            url = (JSON.parse(entry.json || "{}") as { url?: string }).url ?? "";
          } catch {
            // partial JSON — leave url empty, still count the fetch
          }
          args.onProgress?.({ type: "fetch", url, index: fetchesUsed });
          partialInputs.delete(event.index);
        }
      }
    });

    response = await stream.finalMessage();
    const part = readUsage(response, false);
    usage.model = part.model;
    usage.input_tokens += part.input_tokens;
    usage.output_tokens += part.output_tokens;
    usage.cache_creation_input_tokens += part.cache_creation_input_tokens;
    usage.cache_read_input_tokens += part.cache_read_input_tokens;

    // "pause_turn" postdates this SDK version's StopReason union.
    if ((response.stop_reason as string | null) !== "pause_turn") break;
    // The server-side loop paused mid-research. Everything so far (searches,
    // fetched pages, encrypted results) is in response.content — send it back
    // unchanged and the loop resumes where it stopped. Before this, a pause
    // threw "model did not call tool" and the whole run's spend was lost.
    messages.push({
      role: "assistant",
      content: response.content as unknown as Anthropic.ContentBlockParam[],
    });
    args.onProgress?.({ type: "thinking" });
  }

  args.onProgress?.({ type: "done", searchesUsed, fetchesUsed });
  assertNotTruncated(response!, args.toolName, requestParams.max_tokens);

  for (const block of response!.content) {
    if (block.type === "tool_use" && block.name === args.toolName) {
      return {
        output: block.input as T,
        searchesUsed,
        fetchesUsed,
        usage,
      };
    }
  }
  throw new Error(
    `model did not call tool ${args.toolName}; stop_reason=${response!.stop_reason}`,
  );
}

/**
 * A response cut off by max_tokens still carries the output tool block —
 * with partial JSON, which then fails schema validation with a misleading
 * "prospects: Required". Name the real cause. The usual trigger is prose:
 * narration written in the final turn shares the token budget with the
 * tool input, and 27k tokens of it were once observed before the JSON.
 */
function assertNotTruncated(message: Anthropic.Message, toolName: string, maxTokens: number) {
  if (message.stop_reason !== "max_tokens") return;
  throw new Error(
    `model hit max_tokens (${maxTokens}) before finishing ${toolName}; output_tokens=${message.usage?.output_tokens ?? "?"} — the structured output was truncated`,
  );
}

/**
 * Submit the request as a one-item batch and poll until it ends — or until
 * `batchWaitMs` passes, in which case the batch is canceled and null is
 * returned so the caller falls back to the live API. The discount is only
 * worth taking when the queue is fast; the 24-hour tail is not a latency
 * a user-facing runner can sit in.
 */
async function runBatchWithFallback<T>(
  args: { client: Anthropic; signal?: AbortSignal; batchWaitMs?: number },
  requestParams: Anthropic.MessageCreateParamsNonStreaming,
  requestOptions: Record<string, unknown>,
): Promise<Anthropic.Message | null> {
  const waitMs = args.batchWaitMs ?? 10 * 60_000;
  const deadline = Date.now() + waitMs;
  const batch = await args.client.messages.batches.create(
    { requests: [{ custom_id: "structured", params: requestParams }] },
    requestOptions,
  );
  const POLL_MS = 15_000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (args.signal?.aborted) {
      await args.client.messages.batches.cancel(batch.id).catch(() => {});
      throw new Error("aborted while waiting for batch result");
    }
    if (Date.now() > deadline) {
      await args.client.messages.batches.cancel(batch.id).catch(() => {});
      return null;
    }
    const state = await args.client.messages.batches.retrieve(batch.id);
    if (state.processing_status === "ended") break;
  }
  let message: Anthropic.Message | null = null;
  for await (const entry of await args.client.messages.batches.results(batch.id)) {
    if (entry.result.type === "succeeded") message = entry.result.message;
    else if (entry.result.type === "canceled") return null;
    else throw new Error(`batch request ${entry.result.type}`);
  }
  if (!message) throw new Error("batch ended with no result");
  return message;
}
