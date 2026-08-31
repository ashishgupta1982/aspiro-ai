/**
 * JSON recovery from Claude text responses.
 *
 * Lifted verbatim from moneyHub, the only app that had it. Everywhere else a
 * response truncated at max_tokens was thrown away whole.
 */
/**
 * Extract the first JSON array or object from a Claude text response.
 * Three layers of robustness:
 *
 *  1. Direct parse of the trimmed body (or the contents of a fenced code
 *     block if one wraps the whole response).
 *  2. Direct parse of the substring starting at the first `[` or `{` — peels
 *     off leading prose like "Here's the JSON: [...]".
 *  3. **Partial-array recovery** — when the response was truncated mid-array
 *     (e.g. Claude hit `max_tokens`), salvage every top-level element that
 *     was fully written before the cut-off and synthesise a closing `]`.
 *     Returns the complete elements as an array; the caller can detect that
 *     truncation happened via `response.stop_reason === 'max_tokens'`.
 */
export function extractJson(text) {
  if (!text) return null;

  // Strip a ```json ... ``` wrapper if present (closing fence required).
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();

  // 1. Direct parse.
  try { return JSON.parse(body); } catch {}

  // 2. Skip leading prose to first JSON value.
  const start = body.search(/[\[{]/);
  if (start === -1) return null;
  const value = body.slice(start);
  try { return JSON.parse(value); } catch {}

  // 3. Partial recovery for truncated arrays.
  if (value[0] === '[') {
    const recovered = recoverPartialArray(value);
    if (recovered) return recovered;
  }

  return null;
}

/**
 * Single-pass scan over a string starting with `[`. Tracks brace/bracket
 * depth and string state. Whenever the depth returns to 0 via a `}` at the
 * array's top level, remembers that position as the end of a complete
 * element. If the scan reaches the array's closing `]` at depth 0, returns
 * the full array. If it falls off the end without closing (truncation),
 * returns whatever elements completed cleanly, wrapped in a fresh `]`.
 *
 * Returns null if no complete elements could be salvaged.
 */
function recoverPartialArray(body) {
  // body[0] === '[' has already been checked by the caller.
  let i = 1;
  let depth = 0;
  let inString = false;
  let escape = false;
  let lastCompleteEnd = -1; // exclusive — index just past the last complete element's closing `}`

  while (i < body.length) {
    const c = body[i];

    if (escape) {
      escape = false;
      i++;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        // Top-level element just closed.
        lastCompleteEnd = i + 1;
      }
    } else if (c === ']') {
      if (depth === 0) {
        // Array closed normally — try the full slice; if for some reason it
        // doesn't parse, fall through to the salvage path below.
        try { return JSON.parse(body.slice(0, i + 1)); } catch {}
        break;
      }
      depth--;
    }
    i++;
  }

  if (lastCompleteEnd < 0) return null;
  try {
    return JSON.parse(body.slice(0, lastCompleteEnd) + ']');
  } catch {
    return null;
  }
}
