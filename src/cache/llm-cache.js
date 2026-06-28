/**
 * llm-cache.js
 *
 * Persistent LLM decision cache backed by PostgreSQL. See ADR-004 for
 * the design rationale.
 *
 * Cache key is sha256 of (tenant_id + invoice + candidates + model).
 * Including the model is critical — without it, A/B testing two models
 * silently pollutes each other's cache. See ADR-004 for the bug history.
 *
 * This module exposes a generic cache pattern. The matcher's judge uses
 * it; other agents can too.
 */

'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

// ──────────────────────────────────────────────────────────────────────
// Pool (lazy)
// ──────────────────────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      host:     process.env.PGHOST     || 'localhost',
      port:     parseInt(process.env.PGPORT || '5432', 10),
      user:     process.env.PGUSER     || 'postgres',
      password: process.env.PGPASSWORD || '',
      database: process.env.PGDATABASE || 'fotech',
      max: 2,
      idleTimeoutMillis: 10_000,
    });
  }
  return _pool;
}

// ──────────────────────────────────────────────────────────────────────
// Hash function
// ──────────────────────────────────────────────────────────────────────

/**
 * Calculate a stable cache key from the request components.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.invoice       the invoice line text
 * @param {Array}  args.candidates    [{ name_in_db: string }, ...]
 * @param {string} args.model         the LLM model identifier
 * @param {string} [args.promptVersion]  optional prompt version to invalidate cleanly
 *
 * @returns {string} 64-char hex SHA-256
 */
function calcHash({ tenantId, invoice, candidates, model, promptVersion = 'v1' }) {
  const candStr = candidates.map(c => c.name_in_db).join('||');
  const payload = `${tenantId}|${invoice}|${candStr}|${model}|${promptVersion}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ──────────────────────────────────────────────────────────────────────
// Read
// ──────────────────────────────────────────────────────────────────────

/**
 * Look up a cached decision.
 *
 * @returns {Promise<object|null>} the cached row or null if miss
 */
async function lookup(tenantId, hash) {
  const r = await getPool().query(
    `SELECT response_json, model, cost_usd, duration_ms, created_at
       FROM juez_llm_cache
      WHERE tenant_id = $1 AND request_hash = $2
      LIMIT 1`,
    [tenantId, hash],
  );
  return r.rows[0] || null;
}

// ──────────────────────────────────────────────────────────────────────
// Write
// ──────────────────────────────────────────────────────────────────────

/**
 * Store a decision in the cache. Idempotent (ON CONFLICT DO NOTHING).
 */
async function store({
  tenantId,
  hash,
  invoice,
  candidates,
  model,
  response,
  tokensIn,
  tokensOut,
  costUsd,
  durationMs,
}) {
  try {
    await getPool().query(
      `INSERT INTO juez_llm_cache
         (tenant_id, request_hash, invoice_text, candidates_json,
          response_json, model, tokens_in, tokens_out, cost_usd, duration_ms)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, request_hash) DO NOTHING`,
      [
        tenantId,
        hash,
        invoice,
        JSON.stringify(candidates.map(c => ({ name_in_db: c.name_in_db }))),
        JSON.stringify(response),
        model,
        tokensIn,
        tokensOut,
        costUsd,
        durationMs,
      ],
    );
  } catch (e) {
    // Don't throw — cache failures should not break the calling code path.
    console.error('[llm-cache] store error:', e.message);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Analytics
// ──────────────────────────────────────────────────────────────────────

/**
 * Quick stats for a tenant. Useful for ops dashboards.
 */
async function stats(tenantId, { days = 30 } = {}) {
  const r = await getPool().query(
    `SELECT
       model,
       COUNT(*)            AS calls,
       SUM(cost_usd)       AS cost_usd,
       AVG(duration_ms)    AS avg_latency_ms,
       MAX(created_at)     AS last_used_at
     FROM juez_llm_cache
     WHERE tenant_id = $1
       AND created_at > now() - ($2 || ' days')::interval
     GROUP BY model
     ORDER BY calls DESC`,
    [tenantId, days],
  );
  return r.rows;
}

// ──────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────

async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = {
  calcHash,
  lookup,
  store,
  stats,
  close,
};
