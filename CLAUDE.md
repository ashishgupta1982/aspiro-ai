# @aspiro/ai

How every app talks to Claude: the model registry, the tool loop, rate limiting,
opt-in prompt caching and JSON extraction. Server-side only, ESM, no build step.
Eleven apps depend on it, so the model registry here decides which model eleven
products actually call.

## Read this first — three docs, three jobs

| You are doing | Read |
|---|---|
| Deciding how the apps *should* use AI | vault `40-Areas/Indie-Dev/10-Foundations/Foundations-AI.md` |
| Calling this package from an app | `README.md` — the API, the tool loop, worked examples |
| Changing this package | this file |

That vault note is deliberately short, because the implementation lives here.
What cannot live in code — the rules and the reasoning — lives there.

## This package is Claude-only, on purpose

The name leaves room for another provider; **nothing here pretends to abstract
one**. `runToolLoop` returns Anthropic content blocks, `cache_control` is an
Anthropic concept, and `extractJson` handles Anthropic's specific habit of
fencing JSON in Markdown.

A provider abstraction built before there is a second provider is a guess, and
it would make each of those things worse. **If a second provider ever lands it
gets its own entry point** — don't pre-emptively generalise this one.

**`/images` is that second provider** (v0.3.0, 2026-09-29): Higgsfield image
generation, first for CookBook's recipe photos. It shares nothing with the
Claude core but the registry rule — `src/images/models.js` is the one place an
image model id is written. Two things to keep true:

- **It returns a URL, never bytes.** Downloading is a URL fetch, and URL fetches
  stay in the apps behind their SSRF guards (the same line `@aspiro/media` drew
  in its v0.3.0). The app copies the result with `uploadBuffer`.
- **It bills a prepaid Higgsfield API balance** (`HF_CREDENTIALS`, from
  console.higgsfield.ai). A Higgsfield web/CLI subscription's credits are not
  reachable from here — that is the CLI's login, on a desktop.

## Editing this package changes nothing on its own

**Apps pin a tagged tarball**, so a change reaches an app only when a tag is cut
*and* that app's pin is bumped:

```jsonc
"@aspiro/ai": "https://github.com/ashishgupta1982/aspiro-ai/archive/refs/tags/v0.3.0.tar.gz"
```

Never `github:owner/repo` — npm writes `git+ssh://` into the lockfile and the
Vercel build fails.

Read the live pins rather than trusting a list, including one written here:

```bash
grep -h '"@aspiro/ai"' ../*/package.json
```

**This matters more here than anywhere else in the suite**, because a tier
repoint is invisible from inside the app: an app on an older pin keeps calling
the older model, correctly and silently, with nothing to notice. A model swap is
a version bump here *plus* a redeploy per app. A runtime fetch would propagate
instantly but adds a network dependency to every AI call, and the only central
service is loopback-only — so this is deliberate, not an oversight.

## Releasing

1. Change the code; add or update a test under `test/`.
2. Bump `version` in `package.json`.
3. Commit, then `git tag vX.Y.Z && git push && git push --tags`. **The tag is
   the release** — without it the tarball URL 404s.
4. Bump each consuming app deliberately. After a tier repoint, say plainly which
   apps are still on the old model.

## Layout

```
src/
├── index.js       TIERS, normalizeModel, estimateCost — safe to import anywhere
├── models.js      the registry: live ids, retired ids, aliases, tier pointers
├── json.js        extractJson
├── images/        generateImage on Higgsfield — its own provider, its own entry
│   ├── models.js      IMAGE_MODELS: the one place an image model id is written
│   └── higgsfield.js  submit → poll → url; cancels on timeout
└── server/
    ├── client.js      getClient — the SDK instance
    ├── call.js        the single-call path
    ├── toolLoop.js    runToolLoop
    ├── modelConfig.js the admin model-selection handler
    ├── caching.js     withCaching
    └── rateLimit.js
```

**Three entry points:** `@aspiro/ai` (pure, no SDK), `/server`, and `/images`
(Higgsfield, server-only, plain `fetch` — no SDK dependency). Consuming apps
list this in `transpilePackages`.

## Rules that must not be undone

- **`fast` carries a date suffix and the others do not.** There is no bare
  `claude-haiku-4-5`, and ids from 4.6 onward are rejected *with* a suffix.
  Getting it backwards is a silent 404 — it already happened once, to every
  MoneyHub user who had selected `claude-sonnet-4-20250514`. Not an
  inconsistency to tidy up.
- **4.x ids are deliberately not aliased onto 5.** Both `claude-sonnet-4-6` and
  `claude-opus-4-8` are still served, so an app that pinned one keeps getting
  it. An app that wants to follow the suite stores a **tier name** — `fast`,
  `balanced`, `deep` — not a literal id; a repoint here then reaches it on the
  next release.
- **Prompt caching is opt-in, never automatic.** A cache write costs more than
  sending the tokens normally, so it pays only on a large prefix re-sent inside
  the 5-minute TTL. For a one-shot call it is a straight loss. The prefix must
  also clear the model minimum (1024 tokens Sonnet/Opus, 2048 Haiku) and be
  byte-identical between calls — interpolating a timestamp or a user name into a
  "static" system prompt defeats it entirely.
- **No retry layer here.** `@anthropic-ai/sdk` already retries 408, 409, 429 and
  every 5xx including 529, with backoff, honouring `retry-after`. Stacking
  another would multiply to nine attempts and turn a real outage into a slow,
  expensive one. Tune it on the client: `getClient({ maxRetries: 3 })`.
- **`normalizeModel` must always return something sendable.** It accepts a live
  id, a retired one or a tier name. Anything stored in an app's database was
  valid once and must not become a 404 later — that is the whole reason the
  retired-id map exists.

## Gotchas

- **The registry is the only place a model id is written.** A literal id in an
  app or in this package outside `models.js` is the bug this package exists to
  prevent.
- **`npm test` is `node:test`** — no framework.
- **Rate limiting is per app**, using the app's own bucket; this package does
  not hold shared state.
