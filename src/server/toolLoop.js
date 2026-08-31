import { callClaude, textOf } from './call.js';
import { estimateCost } from '../models.js';

/**
 * The Claude tool-use loop.
 *
 * Four apps each had their own copy — CookBook 292 lines, DoIt 377, RunCoach
 * 361, GolfSoc 80 — running the identical algorithm and differing only in tool
 * definitions, `max_tokens` and which safety nets they happened to have.
 * This is the union of those safety nets:
 *
 *   - Every `tool_use` block gets a `tool_result`, always. Claude can emit
 *     several in one turn (parallel tool calls) and the API 400s with
 *     "tool_use ids were found without tool_result blocks" if even one is
 *     missing. CookBook learned this; GolfSoc's copy would have hit it.
 *   - Each tool executes inside its own try/catch, so one failing tool yields
 *     `{ error }` to Claude rather than aborting the turn. GolfSoc had no
 *     try/catch at all — a thrown tool killed the whole request.
 *   - ALL text blocks are joined, not just the first. Server-side web search
 *     returns many small text blocks, one per citation segment, and taking
 *     `.find()` silently truncated the answer to its first fragment.
 *
 * What stays in the app: tool definitions, executors, system prompts and
 * `max_tokens`. Those are product, not plumbing.
 *
 * Returns a SUPERSET of `{ assistantMessage, toolsUsed }` — the shape all four
 * apps already return — so existing call sites need no change.
 *
 * @param {object}   o
 * @param {string}   o.model
 * @param {number}   o.maxTokens
 * @param {string|Array} o.system
 * @param {Array}    o.messages       conversation so far.
 * @param {Array}    o.tools          Anthropic tool definitions.
 * @param {Function} o.execute        async (name, input, block) => result.
 * @param {number}   [o.maxIterations=5]
 * @param {string[]} [o.excludeTools] names to withhold this call.
 * @param {boolean}  [o.stripCitations=false]  remove <cite> markup (web search).
 * @param {boolean}  [o.throwOnEmpty=false]    throw rather than return '' when
 *   Claude produces no text. DoIt does this so the UI can show a real error.
 * @param {string}   [o.exhaustedMessage]      returned when the loop hits
 *   `maxIterations` with tools still pending.
 */
export async function runToolLoop({
  client,
  model,
  maxTokens,
  system,
  messages,
  tools = [],
  execute,
  maxIterations = 5,
  excludeTools = [],
  stripCitations = false,
  throwOnEmpty = false,
  exhaustedMessage = null,
  logUsage = false,
  label = 'ai',
} = {}) {
  if (typeof execute !== 'function') {
    throw new Error('[aspiro-ai] runToolLoop needs an execute function');
  }

  const activeTools = excludeTools.length
    ? tools.filter((t) => !excludeTools.includes(t.name))
    : tools;

  const working = [...messages];
  const toolsUsed = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let iterations = 0;
  let exhausted = false;

  const send = () =>
    callClaude(
      { model, max_tokens: maxTokens, system, tools: activeTools, messages: working },
      { client },
    );

  let response = await send();
  inputTokens += response.usage?.input_tokens || 0;
  outputTokens += response.usage?.output_tokens || 0;

  while (response.stop_reason === 'tool_use') {
    if (iterations >= maxIterations) {
      exhausted = true;
      break;
    }
    iterations++;

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    // stop_reason said tool_use but no executable blocks — server-side tools
    // (web search) resolve without us. Nothing to answer; stop cleanly.
    if (toolUseBlocks.length === 0) break;

    const toolResults = [];
    for (const block of toolUseBlocks) {
      toolsUsed.push(block.name);
      let result;
      try {
        result = await execute(block.name, block.input || {}, block);
        if (result === undefined) result = { error: `Unknown tool: ${block.name}` };
      } catch (error) {
        console.error(`[${label}] tool ${block.name} failed:`, error.message);
        result = { error: error.message };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    working.push({ role: 'assistant', content: response.content });
    working.push({ role: 'user', content: toolResults });

    response = await send();
    inputTokens += response.usage?.input_tokens || 0;
    outputTokens += response.usage?.output_tokens || 0;
  }

  // Server-side web search never appears as a tool_use block we execute.
  const searched = [
    ...working.flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
    ...response.content,
  ].some((b) => b.type === 'web_search_tool_use');
  if (searched && !toolsUsed.includes('web_search')) toolsUsed.push('web_search');

  if (logUsage) {
    console.log(
      `[${label}] model=${model} | in=${inputTokens} out=${outputTokens} tokens` +
        ` | loops=${iterations} | est=$${estimateCost(model, inputTokens, outputTokens).toFixed(4)}`,
    );
  }

  let assistantMessage = textOf(response, { stripCitations });

  if (exhausted && !assistantMessage && exhaustedMessage) {
    assistantMessage = exhaustedMessage;
  }

  if (!assistantMessage && throwOnEmpty) {
    const err = new Error(
      exhausted
        ? 'Assistant hit the tool-iteration limit without answering'
        : 'Assistant returned no text content',
    );
    err.code = exhausted ? 'TOOL_LOOP_EXHAUSTED' : 'EMPTY_RESPONSE';
    err.debug = {
      model,
      stop_reason: response.stop_reason,
      iterations,
      final_block_types: response.content.map((b) => b.type),
      tools_used: toolsUsed,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };
    throw err;
  }

  return {
    assistantMessage,
    toolsUsed,
    iterations,
    exhausted,
    stopReason: response.stop_reason,
    usage: { inputTokens, outputTokens },
    estimatedCost: estimateCost(model, inputTokens, outputTokens),
    response,
  };
}
