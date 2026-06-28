-- ──────────────────────────────────────────────────────────────────────
-- schemas.sql
--
-- Schemas for memory, aliases, and LLM cache. See docs/memory-and-learning.md
-- and docs/decisions/004-cache-strategy.md.
-- ──────────────────────────────────────────────────────────────────────

-- ====================================================================
-- Conversational memory
-- ====================================================================
CREATE TABLE IF NOT EXISTS aff_conversations (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  turn_index      INT  NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool_result')),
  content         TEXT NOT NULL,
  tool_name       TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  content_tsv     TSVECTOR GENERATED ALWAYS AS (
                    to_tsvector('spanish', coalesce(content, ''))
                  ) STORED,

  UNIQUE (tenant_id, session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS ix_aff_conv_tsv
  ON aff_conversations USING GIN (content_tsv);

CREATE INDEX IF NOT EXISTS ix_aff_conv_session
  ON aff_conversations (tenant_id, session_id, turn_index);

CREATE INDEX IF NOT EXISTS ix_aff_conv_created
  ON aff_conversations (tenant_id, created_at DESC);


-- ====================================================================
-- Alias learning
-- ====================================================================
CREATE TABLE IF NOT EXISTS aff_aliases_producto (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  supplier_id         TEXT NOT NULL,
  alias_text          TEXT NOT NULL,
  alias_normalized    TEXT NOT NULL,
  catalog_product_id  BIGINT NOT NULL,
  times_used          INT NOT NULL DEFAULT 1,
  first_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used           TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin              TEXT NOT NULL CHECK (origin IN ('admin_confirm', 'auto_match', 'imported')),
  metadata            JSONB,

  UNIQUE (tenant_id, supplier_id, alias_normalized)
);

CREATE INDEX IF NOT EXISTS ix_aliases_lookup
  ON aff_aliases_producto (tenant_id, supplier_id, alias_normalized);

CREATE INDEX IF NOT EXISTS ix_aliases_product
  ON aff_aliases_producto (tenant_id, catalog_product_id);


-- ====================================================================
-- LLM decision cache (see ADR-004)
-- ====================================================================
CREATE TABLE IF NOT EXISTS juez_llm_cache (
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

CREATE INDEX IF NOT EXISTS ix_juez_cache_lookup
  ON juez_llm_cache (tenant_id, request_hash);

CREATE INDEX IF NOT EXISTS ix_juez_cache_model
  ON juez_llm_cache (model, created_at DESC);
