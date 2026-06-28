# ADR-004: Persistent LLM decision cache with model in the hash

**Status**: Accepted
**Date**: 2026-05
**Deciders**: Gael

## Context

The matcher (and other agents) makes thousands of LLM judge calls during a typical onboarding session. Many of these calls are **identical** — the same invoice line against the same candidate set — because:

- The same supplier sends the same products month after month.
- Eval runs re-process the same fixtures repeatedly during prompt tuning.
- A/B tests between models run the same inputs through different models.

Without caching, every iteration costs real money. With a poor cache, A/B test results get polluted.

## Decision

Persist every LLM judge call in PostgreSQL, keyed by a SHA-256 hash of:

```
(tenant_id, invoice_text, candidates_concatenated, model_name)
```

Schema:

```sql
CREATE TABLE juez_llm_cache (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  request_hash    CHAR(64) NOT NULL,
  invoice_text    TEXT NOT NULL,
  candidates_json JSONB NOT NULL,
  response_json   JSONB NOT NULL,
  model           TEXT NOT NULL,
  tokens_in       INT,
  tokens_out      INT,
  cost_usd        NUMERIC(10, 6),
  duration_ms     INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, request_hash)
);

CREATE INDEX ix_juez_cache_lookup ON juez_llm_cache (tenant_id, request_hash);
CREATE INDEX ix_juez_cache_model  ON juez_llm_cache (model, created_at DESC);
```

Lookup before every API call:

```js
const hash = sha256(`${tenantId}|${invoice}|${candidates}|${model}`);
const cached = await pool.query(
  `SELECT response_json FROM juez_llm_cache WHERE tenant_id = $1 AND request_hash = $2`,
  [tenantId, hash],
);
if (cached.rows[0]) return cached.rows[0].response_json;
```

Store after every API call:

```js
await pool.query(`
  INSERT INTO juez_llm_cache (...)
  VALUES (...)
  ON CONFLICT (tenant_id, request_hash) DO NOTHING
`, [...]);
```

## Alternatives considered

### A. No cache (rejected)

- Pros: simpler code.
- Cons: pays full LLM cost on every iteration; dev cycle becomes expensive.

### B. In-memory cache (rejected)

- Pros: faster lookup.
- Cons: doesn't survive process restarts; can't be inspected, replayed, or used for analytics.

### C. Redis (rejected for this use case)

- Pros: fast.
- Cons: another container; loses the relational queries (sum cost per day, group by model, etc.) that PostgreSQL gives for free.

### D. Hash without model (rejected after a bug)

This was the original implementation. The bug: when I A/B tested Haiku vs Gemini, Gemini's response would overwrite Haiku's for the same input, polluting both runs. Fix: include the model in the hash. Now every model has its own cache space.

## Consequences

### Positive

- **~80% cost reduction during development.** Most prompt iterations re-process previously-seen inputs; those return from cache for free.
- **Reproducible eval runs.** Re-running the same eval suite returns identical results until the prompt changes (which changes the hash via the prompt-version field — *see follow-ups*).
- **A/B testing is honest.** Each model gets its own cache namespace; results don't cross-contaminate.
- **Free analytics dataset.** I can query `juez_llm_cache` to answer questions like *what fraction of decisions are matches vs new vs ambiguous?* or *how does Haiku's confidence distribution compare to Gemini's?* without any extra logging code.
- **Cost & latency are tracked per call.** When we want to know "how much did the matcher cost this month", it's a `SUM(cost_usd) WHERE created_at > ...` query.

### Negative

- **Cache invalidation when the prompt changes is currently manual.** If I update the system prompt, the hash should change but doesn't (the prompt isn't in the hash). Mitigation: I version the prompt and bump `JUEZ_PROMPT_VERSION` env var, which gets concatenated into the hash. See follow-ups.
- **Storage grows with usage.** A pilot client generates ~1,000 cache rows per onboarding session. Manageable; would need partitioning at much higher volume.
- **Cache entries can be stale if the catalog changes.** If a catalog product is renamed or removed, the cache might return a decision pointing to a no-longer-existing product. Mitigation: cross-check the matched product still exists at apply-time.

### Neutral

- The `ON CONFLICT DO NOTHING` clause means concurrent inserts of the same key don't fail — they're idempotent.
- Each row is ~1KB on average; 100K rows = 100MB. Fine for our needs.

## Follow-ups

- ✅ Include the model in the hash (already done — was the original bug).
- ⏳ Include a prompt-version identifier in the hash so prompt changes invalidate cleanly.
- ⏳ Add a background job to expire cache entries older than N days for each model (currently keep everything forever; will revisit at scale).
- ⏳ Build a Grafana dashboard on top of the cache table for cost-per-day, latency distribution, and model-mix analytics.

## Lessons

1. **Cache as a first-class data product.** Treating the cache as a database table (not just a key-value store) unlocks free analytics. I've answered more questions from this table than from purpose-built logging.
2. **Cache key bugs are silent and devastating.** The "missing model" bug took me an hour to diagnose because nothing crashed — just decisions were subtly wrong. Now I write down what's in every cache key, deliberately.
3. **Persistent caches let you experiment cheaply.** The same eval suite run 50 times during prompt tuning only pays LLM costs on the first run. Everything after is free.
