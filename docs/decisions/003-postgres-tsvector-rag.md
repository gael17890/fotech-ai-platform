# ADR-003: PostgreSQL `tsvector` for lexical RAG instead of embeddings

**Status**: Accepted
**Date**: 2026-05
**Deciders**: Gael

## Context

The platform needs **memory** — the ability for an agent to recall something from a previous conversation, like *"what did we decide about Distributor A last week?"*. This is a retrieval problem: given a natural-language query, return the relevant past turns.

Standard 2025-style answer: embeddings + vector database (or `pgvector`). The agent's question gets embedded, similarity search returns the top-k semantically similar turns, those go into the LLM context.

For our domain, this is over-engineered. The questions admins ask are almost always **lexical**: they mention a specific supplier, drug, batch number, or date. The embedding similarity adds nothing on top of "does the turn contain this word".

Two options:

1. **Embeddings + pgvector** — semantic similarity.
2. **PostgreSQL `tsvector` + GIN index** — lexical match with Spanish stemming.

## Decision

Use `tsvector` with the `spanish` text-search configuration.

```sql
ALTER TABLE aff_conversations
  ADD COLUMN content_tsv TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('spanish', coalesce(content, ''))
  ) STORED;

CREATE INDEX ix_aff_conv_tsv ON aff_conversations USING GIN (content_tsv);
```

Queries become:

```sql
SELECT *, ts_rank(content_tsv, plainto_tsquery('spanish', $1)) AS rank
FROM aff_conversations
WHERE tenant_id = $2
  AND content_tsv @@ plainto_tsquery('spanish', $1)
ORDER BY rank DESC
LIMIT 10;
```

## Alternatives considered

### A. pgvector with embeddings (rejected for now)

- Pros: handles semantic similarity ("medicine for headaches" → "paracetamol").
- Cons:
  - **Cost per insert**: every conversation turn needs an embedding API call. At thousands of turns per session, this adds up.
  - **Cost per query**: every query also needs an embedding call.
  - **The use cases we serve don't need it.** Admins query by specific words (supplier names, drug names, dates), not by paraphrase.
  - **Spanish embeddings** quality varies by provider; would need empirical comparison vs the lexical baseline.

### B. Hybrid (tsvector + embeddings) (rejected for now)

- Pros: best of both worlds.
- Cons: doubles the implementation complexity for marginal gain in our use case. Worth revisiting if we expand to a more general consumer assistant.

### C. External vector DB (Pinecone, Weaviate) (rejected)

- Pros: purpose-built.
- Cons: another piece of infrastructure to operate; multi-tenant story is harder than `WHERE tenant_id = $1`; PostgreSQL is already running.

## Consequences

### Positive

- **Zero per-query and per-insert API cost.** `tsvector` indexing is automatic at insert time; queries are free.
- **Sub-millisecond retrieval at our scale** (tens of thousands of turns).
- **Multi-tenant by row** — one `WHERE` clause filters by tenant. No per-tenant index files or model copies.
- **Spanish out of the box.** The `spanish` configuration handles common stemming (`vendí` → `vender`, `pedidos` → `pedido`) without configuration.
- **Auditable.** A query's results are reproducible — same query against same data returns the same rows in the same order. Embeddings don't always have this property across model versions.

### Negative

- **Misses semantic matches.** *"What did we say about the painkiller?"* won't recall a turn about *"paracetamol"* unless the word *painkiller* (or its Spanish equivalent) was actually used. For our use case, this is acceptable — admins use specific terms.
- **Doesn't help with cross-lingual queries.** If we ever expand to mixed Spanish-English chat, the `spanish` configuration won't index English well. We'd need to add English-language index columns or move to embeddings.
- **No "find similar" functionality.** Can't ask "find turns similar to this one". For the current platform there's no need.

### Neutral

- The `tsvector` column adds modest storage overhead (~30% of the text size).
- The GIN index is updated on every insert. Acceptable at our write rate; would need attention at very high write volume.

## When to revisit

Reconsider this decision if:

- The platform expands to a more **general-purpose assistant** where users ask paraphrased questions.
- We need to **cluster conversations** by topic for analytics.
- A **future client requires English-Spanish mixed conversation**.
- A specific use case shows up where embeddings would unlock new value (e.g., proactive "this seems related to that thing two weeks ago" suggestions).

For now: lexical wins on cost, latency, simplicity, and accuracy for our actual workload.

## Lessons

1. **Default 2025-style architecture is not always right.** Embeddings everywhere is the modern default, but it's a sledgehammer for some nails.
2. **Profile the workload first.** I logged 200 admin queries during a pilot phase before deciding. ~95% of them were keyword-based. The data justified the decision.
3. **Spanish full-text search in PostgreSQL is underrated.** Most documentation is English-centric, but the `spanish` configuration is solid.
