/**
 * juez-llm.js
 *
 * The LLM-as-judge for product matching ambiguity.
 *
 * Calls a chat-completion API (OpenAI-compatible: Vercel AI Gateway,
 * OpenRouter, OpenAI, Anthropic via gateway, etc.) and returns a
 * structured decision: which of the top-3 candidates matches the
 * invoice line, or "none" (new product) or "ambiguous" (human review).
 *
 * Key design decisions (see docs/llm-judge-pattern.md):
 *   - Persistent cache by (tenant + invoice + candidates + model)
 *   - Budget caps with kill switch on HTTP 402 / 429 / "insufficient"
 *   - Temperature=0 for reproducibility
 *   - Strict JSON output, enum-shaped "elegido" field
 *
 * Environment variables consumed:
 *   AI_GATEWAY_API_KEY     required
 *   AI_GATEWAY_BASE_URL    default: https://ai-gateway.vercel.sh/v1
 *   JUEZ_MODEL             default: anthropic/claude-haiku-4-5
 *   JUEZ_BUDGET_USD        default: 5.00
 *   JUEZ_MAX_TOKENS        default: 2048
 *   JUEZ_TIMEOUT_MS        default: 15000
 */

'use strict';

try {
  require('dotenv').config();
} catch (_) { /* dotenv is optional */ }

const crypto = require('crypto');
const { Pool } = require('pg');

// ──────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────
const CONFIG = {
  BASE_URL:       process.env.AI_GATEWAY_BASE_URL  || 'https://ai-gateway.vercel.sh/v1',
  MODEL:          process.env.JUEZ_MODEL           || 'anthropic/claude-haiku-4-5',
  MAX_TOKENS:     parseInt(process.env.JUEZ_MAX_TOKENS || '2048', 10),
  TIMEOUT_MS:     parseInt(process.env.JUEZ_TIMEOUT_MS || '15000', 10),
  TEMPERATURE:    0,
  BUDGET_USD:     parseFloat(process.env.JUEZ_BUDGET_USD || '5.00'),
};

// Pricing per 1M tokens (input / output). Used when the gateway
// doesn't return a cost field. Update as providers change prices.
const PRICING_PER_MTOK = {
  'anthropic/claude-haiku-4-5':   { in: 1.00, out: 5.00  },
  'anthropic/claude-sonnet-4-6':  { in: 3.00, out: 15.00 },
  'google/gemini-2.5-flash':      { in: 0.075, out: 0.30 },
  'google/gemini-2.5-pro':        { in: 1.25, out: 10.00 },
  'deepseek/deepseek-v3':         { in: 0.27, out: 1.10  },
  'openai/gpt-4o-mini':           { in: 0.15, out: 0.60  },
};

function calcCostUsd(model, tokIn, tokOut) {
  const p = PRICING_PER_MTOK[model];
  if (!p) return null;
  return (tokIn * p.in + tokOut * p.out) / 1e6;
}

// ──────────────────────────────────────────────────────────────────────
// System prompt (structure shown; full clinical rules kept private)
// ──────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a Mexican pharmaceutical expert.

You decide whether an invoice line corresponds to a product in the
catalog, or if it is a new product. You reason like a pharmacist,
not a string-matcher.

PRESENTATION EQUIVALENCES (synonyms):
  TAB = TABS = TABLETA = TABLETAS = COMP = COMPRIMIDO
  CAP = CAPS = CAPSULA = CAPSULAS
  SUSP = SUSPENSION
  SOL = SOLUCION
  ... (full table redacted in this showcase)

CLINICAL INTERCHANGEABILITY:
  TAB ~ CAP only if everything else matches exactly.
  SUSP != SOL (different liquids).
  Different routes (OFT vs ORAL vs NASAL) = different products.

DIFFERENTIATORS (make it a different product):
  FORTE, PLUS, NF, DUO, PEDIATRICO, ADULTO, EXTRA, LP

HARD RULES:
  1. Concentration must match (500MG != 250MG).
  2. Pack must match (c/10 != c/20).
  3. Brand must match (with normalization tolerance).
  4. Route must match.
  5. Population must match (don't match pediatric to non-pediatric).

PARENTHETICALS in invoice text:
  Often the active ingredient.
  Sometimes the manufacturer.
  Never the primary commercial brand.

[4 worked examples redacted in this showcase]

Always respond in valid JSON, no extra text, no markdown.`;

function buildUserPrompt(invoice, candidates) {
  const lines = candidates
    .map((c, i) => `${i + 1}. ${c.name_in_db}`)
    .join('\n');
  return `Invoice line:
"${invoice}"

Candidates from catalog:
${lines}

Respond with JSON only:
{"elegido": <1|2|3|"ninguno"|"ambiguo">, "confianza": <0-100>, "razon": "<one sentence>"}`;
}

// ──────────────────────────────────────────────────────────────────────
// Cache (PostgreSQL)
// ──────────────────────────────────────────────────────────────────────
let _pool = null;
function pool() {
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

function calcHash(tenantId, invoice, candidates, model) {
  const candStr = candidates.map(c => c.name_in_db).join('||');
  const payload = `${tenantId}|${invoice}|${candStr}|${model}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function cacheLookup(tenantId, hash) {
  const r = await pool().query(
    `SELECT response_json, model, cost_usd, duration_ms
       FROM juez_llm_cache
      WHERE tenant_id = $1 AND request_hash = $2
      LIMIT 1`,
    [tenantId, hash],
  );
  return r.rows[0] || null;
}

async function cacheStore(tenantId, hash, invoice, candidates, model, resp, tokIn, tokOut, costUsd, durMs) {
  try {
    await pool().query(
      `INSERT INTO juez_llm_cache
         (tenant_id, request_hash, invoice_text, candidates_json,
          response_json, model, tokens_in, tokens_out, cost_usd, duration_ms)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, request_hash) DO NOTHING`,
      [
        tenantId, hash, invoice,
        JSON.stringify(candidates.map(c => ({ name_in_db: c.name_in_db }))),
        JSON.stringify(resp),
        model, tokIn, tokOut, costUsd, durMs,
      ],
    );
  } catch (e) {
    console.error('[juez] cache store error:', e.message);
  }
}

// ──────────────────────────────────────────────────────────────────────
// HTTP call (OpenAI-compatible)
// ──────────────────────────────────────────────────────────────────────
function apiKey() {
  return (process.env.AI_GATEWAY_API_KEY || '').trim();
}

async function callLlm(invoice, candidates, model) {
  const key = apiKey();
  if (!key) throw new Error('AI_GATEWAY_API_KEY not set');

  const body = {
    model,
    max_tokens:  CONFIG.MAX_TOKENS,
    temperature: CONFIG.TEMPERATURE,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: buildUserPrompt(invoice, candidates) },
    ],
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CONFIG.TIMEOUT_MS);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(CONFIG.BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type':  'application/json',
        'authorization': 'Bearer ' + key,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const durMs = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const lower = text.toLowerCase();
    // Kill-switch conditions (see docs/llm-judge-pattern.md "Pitfalls")
    if (
      res.status === 402 ||
      res.status === 429 ||
      lower.includes('insufficient') ||
      lower.includes('credit balance') ||
      lower.includes('payment required') ||
      lower.includes('rate-limited') ||
      lower.includes('quota')
    ) {
      const e = new Error(`OUT_OF_BUDGET: HTTP ${res.status}: ${text.slice(0, 200)}`);
      e.code = 'OUT_OF_BUDGET';
      throw e;
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const tokIn  = data?.usage?.prompt_tokens     || 0;
  const tokOut = data?.usage?.completion_tokens || 0;
  const costUsd =
    (typeof data?.usage?.cost === 'number' && data.usage.cost) ||
    calcCostUsd(model, tokIn, tokOut) ||
    0;

  let raw = data?.choices?.[0]?.message?.content || '';
  raw = String(raw).trim();
  if (!raw) throw new Error('empty completion');

  // The model sometimes wraps JSON in a markdown fence. Strip it.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    parsed = JSON.parse(stripped); // throws if still invalid
  }

  if (!('elegido' in parsed)) {
    throw new Error('response missing "elegido" field');
  }
  if (!('razon' in parsed))    parsed.razon = '';
  if (!('confianza' in parsed)) parsed.confianza = 0;

  return { resp: parsed, tokIn, tokOut, costUsd, durMs };
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────
const METRICS = {
  calls: 0,
  cache_hits: 0,
  errors: 0,
  out_of_budget: 0,
  cost_total_usd: 0,
  model: CONFIG.MODEL,
};

let _ABORT_BUDGET = false;

/**
 * Consult the judge for an ambiguous matching decision.
 *
 * @param {object} args
 * @param {string} args.invoice    the invoice line text
 * @param {Array}  args.candidates top-N candidates from the literal scorer
 * @param {string} args.tenantId
 * @param {string} [args.model]    overrides default model
 *
 * @returns {Promise<object>} { source, resp, cost_usd, duration_ms }
 *   source: 'cache' | 'llm' | 'budget_exhausted' | 'error' | 'no_candidates'
 *   resp:   { elegido, confianza, razon } | null on error
 */
async function consult({ invoice, candidates, tenantId, model }) {
  const useModel = model || CONFIG.MODEL;

  if (!candidates || candidates.length === 0) {
    return {
      source: 'no_candidates',
      resp: { elegido: 'ninguno', confianza: 100, razon: 'no candidates' },
    };
  }

  if (_ABORT_BUDGET) {
    return {
      source: 'budget_exhausted',
      resp: { elegido: 'ambiguo', confianza: 0, razon: 'judge budget exhausted (kill switch)' },
      cost_usd: 0,
      duration_ms: 0,
    };
  }

  const hash = calcHash(tenantId, invoice, candidates, useModel);

  // 1. Cache
  let cached;
  try {
    cached = await cacheLookup(tenantId, hash);
  } catch (e) {
    console.error('[juez] cache lookup error:', e.message);
  }
  if (cached) {
    METRICS.cache_hits++;
    return { source: 'cache', resp: cached.response_json, cost_usd: 0, duration_ms: 0 };
  }

  // 2. Budget cap
  if (METRICS.cost_total_usd >= CONFIG.BUDGET_USD) {
    return {
      source: 'budget_exhausted',
      resp: { elegido: 'ambiguo', confianza: 0, razon: `budget cap reached ($${CONFIG.BUDGET_USD})` },
      cost_usd: 0,
      duration_ms: 0,
    };
  }

  // 3. Call LLM
  METRICS.calls++;
  try {
    const out = await callLlm(invoice, candidates, useModel);
    METRICS.cost_total_usd += out.costUsd;
    await cacheStore(tenantId, hash, invoice, candidates, useModel, out.resp, out.tokIn, out.tokOut, out.costUsd, out.durMs);
    return { source: 'llm', resp: out.resp, cost_usd: out.costUsd, duration_ms: out.durMs };
  } catch (e) {
    METRICS.errors++;
    if (e.code === 'OUT_OF_BUDGET') {
      METRICS.out_of_budget++;
      _ABORT_BUDGET = true;
      console.error('[juez] OUT OF BUDGET — kill switch activated');
    }
    return { source: 'error', resp: null, error: e.message };
  }
}

function metrics() {
  return { ...METRICS, _abort_budget: _ABORT_BUDGET };
}

async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = {
  consult,
  metrics,
  close,
  CONFIG,
  PRICING_PER_MTOK,
};
