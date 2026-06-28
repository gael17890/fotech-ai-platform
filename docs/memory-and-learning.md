# Memory and Learning

How the platform remembers conversations and learns from corrections — **without retraining a model**.

There are two distinct systems doing different work:

1. **Conversational memory** — what was said, by whom, when, indexed for full-text retrieval.
2. **Alias learning** — a continuously growing map from supplier-specific names to catalog products, accumulated from admin confirmations.

Together they make the platform smarter every day without any of the cost, complexity, or operational risk of fine-tuning.

## Conversational memory

### The shape

```sql
CREATE TABLE aff_conversations (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  turn_index      INT  NOT NULL,
  role            TEXT NOT NULL,  -- 'user' | 'assistant' | 'tool_result'
  content         TEXT NOT NULL,
  tool_name       TEXT,           -- when role = 'tool_result'
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- the magic: a generated tsvector column for Spanish full-text search
  content_tsv     TSVECTOR GENERATED ALWAYS AS (
                    to_tsvector('spanish', coalesce(content, ''))
                  ) STORED,

  UNIQUE (tenant_id, session_id, turn_index)
);

CREATE INDEX ix_aff_conv_tsv      ON aff_conversations USING GIN (content_tsv);
CREATE INDEX ix_aff_conv_session  ON aff_conversations (tenant_id, session_id, turn_index);
CREATE INDEX ix_aff_conv_created  ON aff_conversations (tenant_id, created_at DESC);
```

Every turn in every conversation gets a row. The `content_tsv` column is a **generated column** — PostgreSQL computes the tokenized, stemmed Spanish vector automatically on insert, and the GIN index makes searches fast even at millions of rows.

### The retrieval

```js
// src/memory/conversational-memory.js (sanitized)
async function recall(tenantId, query, { limit = 10, sessionsBack = 30 } = {}) {
  const result = await pool.query(`
    SELECT
      session_id,
      turn_index,
      role,
      content,
      created_at,
      ts_rank(content_tsv, plainto_tsquery('spanish', $2)) AS rank
    FROM aff_conversations
    WHERE tenant_id = $1
      AND content_tsv @@ plainto_tsquery('spanish', $2)
      AND created_at > now() - ($3 || ' days')::interval
    ORDER BY rank DESC, created_at DESC
    LIMIT $4
  `, [tenantId, query, sessionsBack, limit]);
  return result.rows;
}
```

This lets the agent answer queries like:

- *"What did we do with Distributor A last week?"* → recalls the relevant onboarding session.
- *"Remind me which product we said was generic on Tuesday"* → finds the turn where I confirmed it.
- *"The medication the admin asked about yesterday"* → finds it by keyword + recency.

The agent calls `recall()` as a tool. The retrieved turns become context for the current LLM call.

### Why lexical, not embeddings

I considered pgvector embeddings. I went with `tsvector` because:

1. **Pharmaceutical names are very specific tokens.** `DOLXEN`, `BRUNADOL`, `METOCLOPRAMIDA` aren't "similar to" anything else — they're either present or absent. Embedding similarity adds nothing for that case.
2. **Cost.** `tsvector` is free; embeddings cost API calls per insert and per query.
3. **Spanish out of the box.** PostgreSQL's `spanish` stemmer handles the common cases (singular/plural, verb conjugation) without configuration.
4. **Multi-tenant by row.** The `tenant_id` filter is a simple WHERE clause; embeddings would need separate indices per tenant or a more complex filter.

If the use case were "find conceptually related conversations" (e.g., support ticket triage), embeddings would win. For "find the specific words the admin said about X", lexical wins.

This is documented as [ADR-003: PostgreSQL tsvector RAG](decisions/003-postgres-tsvector-rag.md).

## Alias learning

### The problem it solves

Suppliers name products their own way. The same `DOLXEN 500MG c/10` might appear as `DOLXEN 500MG C/10 TABLETAS`, `dolxen 500 mg tabs 10`, or `DLX-500/10` depending on which supplier you ask. The matcher can handle most of this, but **some variations are essentially arbitrary** — you can't infer the mapping from the strings alone.

Worse: the *same supplier* sometimes uses different names for the same product across invoices, because their internal SKU changed or because two employees enter data differently.

### The schema

```sql
CREATE TABLE aff_aliases_producto (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  supplier_id         TEXT NOT NULL,
  alias_text          TEXT NOT NULL,            -- the name as it appears on the invoice
  alias_normalized    TEXT NOT NULL,            -- after presentation/brand normalization
  catalog_product_id  BIGINT NOT NULL,          -- the canonical product it points to
  times_used          INT  NOT NULL DEFAULT 1,  -- confidence signal
  first_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used           TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin              TEXT NOT NULL,            -- 'admin_confirm' | 'auto_match' | 'imported'
  metadata            JSONB,

  UNIQUE (tenant_id, supplier_id, alias_normalized)
);

CREATE INDEX ix_aliases_lookup      ON aff_aliases_producto
  (tenant_id, supplier_id, alias_normalized);
CREATE INDEX ix_aliases_product     ON aff_aliases_producto
  (tenant_id, catalog_product_id);
```

The `(tenant_id, supplier_id, alias_normalized)` uniqueness constraint is the key insight: **aliases are scoped to supplier**. `DLX-500/10` from Distributor A maps to one product; the same string from Distributor B might mean something else (or nothing).

### How learning happens

Two paths populate the table:

**Path 1 — admin confirmation** (the high-trust path):

When the matcher returns "ambiguous" and the admin clicks a candidate to resolve it:

```js
// src/memory/alias-learning.js (sanitized)
async function recordConfirmation({ tenantId, supplierId, invoiceLine, catalogProductId }) {
  const aliasNormalized = normalizeAlias(invoiceLine);
  await pool.query(`
    INSERT INTO aff_aliases_producto
      (tenant_id, supplier_id, alias_text, alias_normalized, catalog_product_id, origin)
    VALUES
      ($1, $2, $3, $4, $5, 'admin_confirm')
    ON CONFLICT (tenant_id, supplier_id, alias_normalized) DO UPDATE
    SET times_used = aff_aliases_producto.times_used + 1,
        last_used  = now()
  `, [tenantId, supplierId, invoiceLine, aliasNormalized, catalogProductId]);
}
```

Every admin click is a training signal. The system gets one row smarter.

**Path 2 — auto-match** (the lower-trust path):

When the matcher returns a high-confidence match (score ≥ 0.95) and no human intervenes, the alias is recorded with `origin = 'auto_match'`. These can be filtered out later if we don't trust them retroactively.

### How aliases get used

At match time, the matcher checks the alias table **before** running the literal scorer:

```js
// src/matcher/matcher-v3-llm.js
async function decide({ invoiceLine, candidates, tenantId, supplierId }) {
  // 0. fast path: is this an exact known alias?
  const aliasHit = await aliases.lookup(tenantId, supplierId, invoiceLine);
  if (aliasHit && aliasHit.times_used >= 2) {
    return {
      decision: 'match',
      match: { catalog_product_id: aliasHit.catalog_product_id },
      via: 'alias',
      confidence: 100,
    };
  }

  // 1. literal scorer (unchanged)
  // 2. LLM judge if ambiguous (unchanged)
}
```

The `times_used >= 2` threshold matters. A single admin confirmation might be a mistake; a second use means the admin (or another admin) confirmed the same mapping, so we trust it.

### Why this beats fine-tuning

I considered fine-tuning a small model on the (invoice_line → catalog_product) mapping. Here's why I didn't:

| Concern | Fine-tuning | Alias table |
|---|---|---|
| Cost per new sample | API call per training pass | One `INSERT` |
| Latency to take effect | Hours (re-train, re-deploy) | Milliseconds |
| Cost to query | Per-token LLM cost | `O(log n)` index lookup, ~0.1ms |
| Auditability | Opaque weights | One row per mapping with `times_used`, `last_used` |
| Reversibility | Re-train from scratch | `DELETE` or `UPDATE` |
| Multi-tenant isolation | Tricky (per-tenant model or careful prompt-engineering) | One column in the WHERE clause |
| Cost to A/B test | Two model deployments | Two database queries with different filters |

For this kind of problem — **mapping known strings to known IDs with continuous human-in-the-loop correction** — fine-tuning is over-engineered. The relational database is the right tool.

This isn't a blanket statement against fine-tuning. For tasks that require **changing the model's reasoning style** (e.g., always responding in a specific format, internalizing a domain-specific style of summarization), fine-tuning makes sense. For tasks that require **mapping inputs to outputs based on accumulated examples**, a database wins.

## Combined effect

In the production system:

- **Hit rate of the alias table grows over time** as the admin uses the system. After two months of moderate use at the pilot client, ~35% of invoice lines are resolved by the alias table before the literal scorer or LLM judge ever runs.
- **Conversation memory means the admin doesn't repeat context.** *"Same as last time"* is a valid sentence — the agent looks up the previous session and uses what it finds.
- **No retraining was needed for either.** Both systems are just relational tables with the right indices.

## Honest limits

- **The alias table is supplier-scoped, so cross-supplier transfer requires a separate pass.** When a new supplier shows up, we start from zero. That's by design (different supplier conventions) but it's an onboarding cost.
- **`tsvector` retrieval doesn't handle "semantically similar" queries.** *"The medicine for headaches"* won't recall a turn about *"paracetamol"* unless the admin explicitly said "headache". This is fine for the current use cases but would matter for a more general assistant.
- **`auto_match` aliases can be wrong if a high-confidence false positive sneaks through.** I track origin so I can audit and purge if needed.

## Code

- [`src/memory/conversational-memory.js`](../src/memory/conversational-memory.js) — recall and write APIs
- [`src/memory/alias-learning.js`](../src/memory/alias-learning.js) — alias lookup and confirmation
- [`src/memory/schemas.sql`](../src/memory/schemas.sql) — the table definitions above

## Related

- [`docs/decisions/003-postgres-tsvector-rag.md`](decisions/003-postgres-tsvector-rag.md) — why lexical, not embeddings
- [`docs/matcher-evolution.md`](matcher-evolution.md) — the matcher that uses the alias table as a fast path
