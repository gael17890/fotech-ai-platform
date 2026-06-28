# ADR-002: Multi-model gateway with env-var model swap

**Status**: Accepted
**Date**: 2026-06
**Deciders**: Gael

## Context

The platform uses multiple LLM providers for different tasks:
- **Claude Sonnet 4.6** — orchestrator
- **Claude Haiku 4.5** — matcher judge, tactical sub-agents
- **Kimi K2.6 (via Fireworks)** — invoice extractor
- **Gemini (Flash, Pro)** — under evaluation
- **DeepSeek V3** — under evaluation

Each provider has its own SDK, auth model, rate-limit profile, and pricing. Wiring them in directly would lock the platform to specific providers and make A/B testing expensive (write custom code per provider).

Two options:

1. **Use each provider's native SDK** for what they're best at.
2. **Route everything through a gateway** that exposes an OpenAI-compatible interface to the application code.

## Decision

Use **Vercel AI Gateway** for the providers it supports, with the model selected by an environment variable (`JUEZ_MODEL`).

```js
const CONFIG = {
  BASE_URL: process.env.AI_GATEWAY_BASE_URL || 'https://ai-gateway.vercel.sh/v1',
  MODEL: process.env.JUEZ_MODEL || 'anthropic/claude-haiku-4-5',
};
```

Switching from Haiku to Gemini Flash for a run is one shell command:

```bash
JUEZ_MODEL='google/gemini-2.5-flash' node evals/runner.js
```

Keep **direct provider SDKs** (no gateway) for the few cases where the gateway adds friction:
- Kimi K2.6 through Fireworks — Vercel doesn't carry Kimi K2.6 at time of decision.
- The Pipecat voice agent — too tightly coupled to provider-specific streaming APIs.

## Alternatives considered

### A. Direct SDKs for everything (rejected)

- Pros: native features, no abstraction overhead.
- Cons: per-provider auth/retry/error-handling logic; model swap requires code change.

### B. OpenRouter (deferred, may reconsider)

- Pros: broader model catalog than Vercel; good pricing.
- Cons: as of evaluation, less mature SLA and observability than Vercel. Will revisit if Vercel proves limiting.

### C. LiteLLM proxy self-hosted (rejected)

- Pros: full control, no markup.
- Cons: another container to run; operational burden for a single developer; Vercel's markup is negligible at our volume.

## Consequences

### Positive

- Eval suite can compare Haiku vs Gemini Flash vs DeepSeek on the same prompts with no code changes.
- One API key, one auth model, one error-handling code path.
- Model selection becomes a runtime concern (env var) instead of a build-time concern (code).
- The cache key includes the model, so cached results from one model don't pollute another's run.

### Negative

- **Free-tier rate limits are not always what the gateway page implies.** Discovered during a baseline run: Vercel's $5 trial credit puts certain calls into a free-tier rate-limit pool even when you have credit. A long batch run hit 429s after ~75 calls. Mitigation: kill switch on HTTP 429; direct Anthropic for large batches; investigate Vercel's paid tier.
- **Gateway features lag native SDKs.** Some Claude features (prompt caching beta, batch API) are gateway-pending. For those, fall back to direct SDK.
- **Single point of failure** if the gateway is down. Mitigation: cache existing decisions in PostgreSQL so a gateway outage doesn't kill in-flight runs.

### Neutral

- Gateway adds ~50–150ms to first-token latency vs direct provider call. Acceptable for the use case.
- Costs are passed through transparently (no markup at the current pricing tier).

## Lessons from production

1. **Test for rate limits before relying on a gateway for batch work.** I lost a baseline run to this. Detect HTTP 429 explicitly and treat it as a kill-switch condition, not as a retry-able error.
2. **Include the model in the cache key.** Without this, A/B testing two models silently pollutes each other's cache. Discovered after a confusing run.
3. **Keep direct-SDK fallbacks ready.** For the matcher judge specifically, I have a `juez-anthropic-direct.js` path that's used when the gateway misbehaves. Same prompt, same output shape, different endpoint.

## Follow-ups

- Build the direct-Anthropic fallback into the cache layer transparently — if the gateway errors with `OUT_OF_BUDGET`, retry against direct Anthropic if a direct API key is configured.
- Document the model-selection guide for future agents: which task → which model → why.
