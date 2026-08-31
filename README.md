# @aspiro/ai

Shared Claude integration for the Aspiro app suite: the tool-use loop, central
model configuration, JSON recovery, and durable rate limiting.

Sibling to [`@aspiro/auth`](https://github.com/ashishgupta1982/aspiro-auth) and
[`@aspiro/media`](https://github.com/ashishgupta1982/aspiro-media). Install it;
don't clone another app.

## Scope: this package is Claude-only

The name leaves room for another provider later. Nothing here pretends to
abstract one — `runToolLoop` returns Anthropic content blocks, `cache_control`
is an Anthropic concept, and `extractJson` handles Anthropic's specific habit of
fencing JSON in Markdown. That is deliberate. A provider abstraction built
before there is a second provider is a guess, and it would make every one of
those things worse. If a second provider ever lands it gets its own entry point.

## Why this exists

Eight apps each call Claude. Four grew their own tool-use loop — CookBook 292
lines, DoIt 377, RunCoach 361, GolfSoc 80 — running the **same algorithm** and
differing only in tool definitions, `max_tokens`, and which safety nets they
happened to have. Five wrote out the same admin model-config route by hand.

Where the copies drifted, they drifted on things that fail quietly:

**Model ids went stale in the database.** When Anthropic retired
`claude-sonnet-4-20250514`, every MoneyHub user who had selected it got a 404
until someone noticed and patched that one app. 113 hardcoded ids across 43
files meant there was no other way to fix it. `normalizeModel` now heals a stale
stored value on read, so no data migration is ever needed.

**The admin model picker never worked in production in three apps.** CookBook,
DoIt and Tutor App persisted their config with `fs.writeFileSync` into
`src/config/aiModels.json` — at runtime. On Vercel `/var/task` is read-only, so
the save threw `EROFS`; even had it written, the change would vanish at the next
cold start and never reach another instance. `createModelResolver` takes a
storage hook so those apps can move to the Mongo document RunCoach and
chessMaster already use.

**One missing `tool_result` is a hard 400.** Claude can emit several `tool_use`
blocks in one turn. The API rejects the next request with "tool_use ids were
found without tool_result blocks" if even one is unanswered. CookBook documented
this carefully. GolfSoc's copy had no per-tool error handling at all, so a
single throwing tool killed the whole request.

**Taking the first text block truncated answers.** Server-side web search
returns many small text blocks, one per citation segment. Three apps used
`.find(b => b.type === 'text')` and silently returned the first fragment.

## Install

```jsonc
// package.json
"dependencies": {
  "@aspiro/ai": "https://github.com/ashishgupta1982/aspiro-ai/archive/refs/tags/v0.1.0.tar.gz",
  "@anthropic-ai/sdk": "^0.36.3"
}
```

Pin the tag. Never `github:owner/repo` — npm rewrites that to `git+ssh://`,
which fails on Vercel.

Ships no React, so it needs no `transpilePackages` and no Tailwind content glob.

## Entry points

| Import | Contains | Safe in the browser |
|---|---|---|
| `@aspiro/ai` | model registry, `normalizeModel`, `extractJson` | yes |
| `@aspiro/ai/server` | everything above plus the SDK, tool loop, config, limits | **no** |

## Models

```js
import { TIERS, normalizeModel, estimateCost } from '@aspiro/ai';

TIERS.fast      // claude-haiku-4-5-20251001
TIERS.balanced  // claude-sonnet-4-6
TIERS.deep      // claude-opus-4-8
```

Apps map their own task names onto tiers. A model swap becomes a version bump
here rather than a sweep through eight repos — though still a redeploy per app.
A runtime fetch would propagate instantly, but it adds a network dependency to
every AI call and the only central service is loopback-only.

`normalizeModel(stored, fallback)` accepts a live id, a retired one, or a tier
name, and always returns something sendable.

> **`fast` carries a date suffix and the others do not.** That is not an
> inconsistency to tidy up. There is no bare `claude-haiku-4-5`, and ids from
> 4.6 onward are rejected *with* a suffix. Getting it backwards is a silent 404.

## The tool loop

```js
import { runToolLoop } from '@aspiro/ai/server';

const { assistantMessage, toolsUsed } = await runToolLoop({
  model: await models.getModel('chat'),
  maxTokens: 4096,          // your value — see below
  system: buildSystemPrompt(user),
  messages: history,
  tools,                    // your definitions
  execute: async (name, input) => {
    switch (name) {
      case 'get_recipes': return getRecipes(userId, input);
      default: return undefined;   // -> { error: 'Unknown tool: ...' }
    }
  },
});
```

Returns a **superset** of `{ assistantMessage, toolsUsed }` — the shape all four
apps already returned — so existing call sites need no change. Also on the
result: `usage`, `estimatedCost`, `iterations`, `exhausted`, `stopReason`,
`response`.

What stays in your app: tool definitions, executors, system prompts, and
`max_tokens`. Those are product decisions, not plumbing.

> **`max_tokens` values are deliberate.** They were tuned per use case over
> time. The package never supplies one.

## Model configuration

```js
const models = createModelResolver({
  defaults: { chat: 'claude-sonnet-4-6', parsing: TIERS.fast },
  loadConfig: async () => (await AppConfig.findById('ai-models').lean())?.aiModels,
  saveConfig: async (partial) => AppConfig.findByIdAndUpdate(
    'ai-models',
    { $set: Object.fromEntries(Object.entries(partial).map(([k, v]) => [`aiModels.${k}`, v])) },
    { upsert: true },
  ),
});

// pages/api/admin/ai-models.js
export default createAdminModelsHandler({ resolver: models, requireAdmin });
```

`defaults` are **fallbacks, not a description of production**. Once an admin
saves anything the stored value wins. RunCoach's stored config had every
workload on Haiku while its defaults file said Sonnet — the admin page is the
authoritative answer, not the source.

`requireAdmin(req, res)` returns the user, or `null` *after sending its own
response* to deny — the same contract as `resolveOwner` in `@aspiro/media`.

The GET response is a deliberate superset (`{ ...models, models, aiModels,
defaults, validModels, options }`) because the five existing admin pages read
three different shapes. That keeps every one of them working untouched.

Config is cached for 5 minutes, so a change takes up to that long to reach a
warm instance.

## Rate limiting

The in-memory limiters the apps ship reset on every serverless cold start and
multiply by instance count — burst shields, not budgets. These counters live in
your database.

```js
const counter = createWindowedCounter({
  count: createMongoCounter({ model: RateLimit, connect: dbConnect }),
  buckets: {
    'claude-insights': { hour: 4, day: 12 },
    'claude-total':    { hour: 15, day: 50 },   // the ceiling
  },
});
const checkClaudeRate = createClaudeRateLimit({ counter });

const verdict = await checkClaudeRate(userId, 'claude-insights');
if (!verdict.allowed) return rateLimitResponse(res, verdict, 'coaching');
```

Two tiers on purpose. A per-feature limit alone lets a user spend N times over
by rotating between features; `claude-total` is what actually bounds the bill.

**Call it once per request, before the model call — never inside a retry.** The
SDK's three attempts are one unit of user-visible work and must cost one unit of
budget.

Bucket names and numbers stay in your app: they are tuned to that app's cost per
call. Storage is a hook so the package needs no mongoose dependency — and when a
platform package eventually owns the counter, you pass that in and nothing here
changes. The model wants a string `_id`, a numeric `count`, and a TTL index on
`expiresAt`.

## Prompt caching — opt-in, never automatic

```js
const params = withCaching(
  { model, max_tokens, system, tools, messages },
  { system: true, tools: true },
);
```

**A cache write costs more than sending the same tokens normally.** It pays only
when a large prefix is re-sent within the 5-minute TTL — a long system prompt
across a conversation, or tool definitions inside a tool loop where the prefix
goes out on every iteration. For a one-shot call it is a straight loss, which is
why nothing here turns it on for you.

Before reaching for it: the cached prefix must clear the model's minimum (1024
tokens for Sonnet and Opus, 2048 for Haiku) or the breakpoint is ignored, and it
must be byte-identical between calls — interpolating a timestamp or a user name
into a "static" system prompt defeats it entirely.

## Retries are the SDK's job

`@anthropic-ai/sdk` already retries 408, 409, 429 and every 5xx — 529 overloads
included — with exponential backoff, honouring `retry-after`. The default is
`maxRetries: 2`, i.e. three attempts.

**This package adds no retry layer.** Stacking one would multiply out to nine
attempts and turn a real outage into a slow, expensive one. Tune it on the
client instead:

```js
getClient({ maxRetries: 3 });
```

## JSON out of a text response

```js
const rows = extractJson(textOf(response));
if (wasTruncated(response)) console.warn('truncated — recovered what completed');
```

Handles a fenced block, leading prose, and — the part only MoneyHub had — a
response cut off at `max_tokens`, salvaging every array element that finished
before the cut. Everywhere else that response was thrown away whole.

## Tests

```bash
npm test     # 65 tests, node:test, no network
```

The tool-loop tests are the ones that matter: they encode the invariants the
four copies disagreed on. `extractJson` was ported byte-identical from MoneyHub
and diffed against the original rather than retyped — extracting a function is
how you introduce a bug that never existed.
