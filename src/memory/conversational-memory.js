/**
 * conversational-memory.js
 *
 * Stores every turn of every conversation and recalls them via Spanish
 * full-text search. See docs/memory-and-learning.md and ADR-003.
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
// Write
// ──────────────────────────────────────────────────────────────────────

/**
 * Record a conversation turn.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.sessionId
 * @param {number} args.turnIndex
 * @param {'user'|'assistant'|'tool_result'} args.role
 * @param {string} args.content
 * @param {string} [args.toolName]   when role = 'tool_result'
 * @param {object} [args.metadata]
 */
async function recordTurn({ tenantId, sessionId, turnIndex, role, content, toolName, metadata }) {
  await getPool().query(
    `INSERT INTO aff_conversations
       (tenant_id, session_id, turn_index, role, content, tool_name, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (tenant_id, session_id, turn_index) DO NOTHING`,
    [
      tenantId,
      sessionId,
      turnIndex,
      role,
      content,
      toolName || null,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
}

// ──────────────────────────────────────────────────────────────────────
// Read
// ──────────────────────────────────────────────────────────────────────

/**
 * Recall turns matching a query, ranked by relevance and recency.
 *
 * Uses Spanish full-text search via the generated tsvector column
 * `content_tsv`.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.query        natural-language query
 * @param {number} [args.limit=10]
 * @param {number} [args.daysBack=90]
 * @returns {Promise<Array>}
 */
async function recall({ tenantId, query, limit = 10, daysBack = 90 }) {
  const r = await getPool().query(
    `SELECT
       session_id,
       turn_index,
       role,
       content,
       tool_name,
       metadata,
       created_at,
       ts_rank(content_tsv, plainto_tsquery('spanish', $2)) AS rank
     FROM aff_conversations
     WHERE tenant_id = $1
       AND content_tsv @@ plainto_tsquery('spanish', $2)
       AND created_at > now() - ($3 || ' days')::interval
     ORDER BY rank DESC, created_at DESC
     LIMIT $4`,
    [tenantId, query, daysBack, limit],
  );
  return r.rows;
}

/**
 * Recall the full transcript of a specific session.
 */
async function transcript({ tenantId, sessionId, limit = 200 }) {
  const r = await getPool().query(
    `SELECT turn_index, role, content, tool_name, metadata, created_at
       FROM aff_conversations
      WHERE tenant_id = $1 AND session_id = $2
      ORDER BY turn_index ASC
      LIMIT $3`,
    [tenantId, sessionId, limit],
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

module.exports = { recordTurn, recall, transcript, close };
