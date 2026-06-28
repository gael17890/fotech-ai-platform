/**
 * alias-learning.js
 *
 * The continuous-learning system. See docs/memory-and-learning.md.
 *
 * Every admin confirmation of an ambiguous match becomes a row in
 * aff_aliases_producto. Future encounters of the same alias from the
 * same supplier resolve in milliseconds via index lookup — no LLM call.
 *
 * This is how the system gets smarter without retraining a model.
 */

'use strict';

const { Pool } = require('pg');

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
// Normalization
// ──────────────────────────────────────────────────────────────────────

/**
 * Normalize an invoice line for alias lookup. Lower-case, collapse
 * whitespace, strip leading/trailing punctuation. Keep the substantive
 * tokens intact so two functionally-identical strings hash the same.
 */
function normalizeAlias(text) {
  return String(text)
    .toLowerCase()
    .replace(/[.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ──────────────────────────────────────────────────────────────────────
// Read (the fast path)
// ──────────────────────────────────────────────────────────────────────

/**
 * Look up an alias for a (tenant, supplier, invoice line) triple.
 *
 * @returns {Promise<object|null>} the alias row or null if miss
 */
async function lookup(tenantId, supplierId, invoiceLine) {
  const normalized = normalizeAlias(invoiceLine);
  const r = await getPool().query(
    `SELECT id, catalog_product_id, times_used, last_used, origin
       FROM aff_aliases_producto
      WHERE tenant_id = $1
        AND supplier_id = $2
        AND alias_normalized = $3
      LIMIT 1`,
    [tenantId, supplierId, normalized],
  );
  return r.rows[0] || null;
}

// ──────────────────────────────────────────────────────────────────────
// Write (the learning signal)
// ──────────────────────────────────────────────────────────────────────

/**
 * Record an admin confirmation. The admin clicked a candidate to resolve
 * an ambiguous match — that's the strongest possible training signal.
 *
 * If the alias already exists, increment its usage counter.
 */
async function recordConfirmation({ tenantId, supplierId, invoiceLine, catalogProductId, metadata }) {
  const normalized = normalizeAlias(invoiceLine);
  await getPool().query(
    `INSERT INTO aff_aliases_producto
       (tenant_id, supplier_id, alias_text, alias_normalized, catalog_product_id, origin, metadata)
     VALUES ($1, $2, $3, $4, $5, 'admin_confirm', $6::jsonb)
     ON CONFLICT (tenant_id, supplier_id, alias_normalized)
     DO UPDATE SET
       times_used = aff_aliases_producto.times_used + 1,
       last_used  = now(),
       origin     = CASE
                      WHEN aff_aliases_producto.origin = 'auto_match' THEN 'admin_confirm'
                      ELSE aff_aliases_producto.origin
                    END`,
    [
      tenantId,
      supplierId,
      invoiceLine,
      normalized,
      catalogProductId,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
}

/**
 * Record a high-confidence auto-match. Same table, lower-trust origin.
 * These are filterable so we can audit / retroactively purge if needed.
 */
async function recordAutoMatch({ tenantId, supplierId, invoiceLine, catalogProductId, score, metadata }) {
  const normalized = normalizeAlias(invoiceLine);
  const meta = { ...(metadata || {}), score };
  await getPool().query(
    `INSERT INTO aff_aliases_producto
       (tenant_id, supplier_id, alias_text, alias_normalized, catalog_product_id, origin, metadata)
     VALUES ($1, $2, $3, $4, $5, 'auto_match', $6::jsonb)
     ON CONFLICT (tenant_id, supplier_id, alias_normalized)
     DO UPDATE SET
       times_used = aff_aliases_producto.times_used + 1,
       last_used  = now()`,
    [tenantId, supplierId, invoiceLine, normalized, catalogProductId, JSON.stringify(meta)],
  );
}

// ──────────────────────────────────────────────────────────────────────
// Analytics
// ──────────────────────────────────────────────────────────────────────

/**
 * How many aliases exist per supplier. Useful to track learning velocity.
 */
async function aliasCountBySupplier(tenantId) {
  const r = await getPool().query(
    `SELECT supplier_id,
            COUNT(*)                                       AS total_aliases,
            COUNT(*) FILTER (WHERE origin = 'admin_confirm') AS confirmed_aliases,
            COUNT(*) FILTER (WHERE origin = 'auto_match')    AS auto_aliases,
            SUM(times_used)                                AS total_uses
       FROM aff_aliases_producto
      WHERE tenant_id = $1
      GROUP BY supplier_id
      ORDER BY total_uses DESC`,
    [tenantId],
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
  normalizeAlias,
  lookup,
  recordConfirmation,
  recordAutoMatch,
  aliasCountBySupplier,
  close,
};
