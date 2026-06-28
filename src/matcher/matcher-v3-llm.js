/**
 * matcher-v3-llm.js
 *
 * The hybrid matcher orchestrator. Given an invoice line and a list of
 * catalog candidates, decides:
 *   - match (with a specific candidate)
 *   - new (no candidate matches)
 *   - ambiguous (needs human review)
 *
 * Flow:
 *
 *   invoiceLine
 *       │
 *       ▼
 *   ┌────────────────────────┐
 *   │  alias lookup          │  fast path: known supplier alias
 *   │  (database, O(log n))  │  → if hit with times_used>=2: match
 *   └───────────┬────────────┘
 *               │ miss
 *               ▼
 *   ┌────────────────────────┐
 *   │  score-literal.js      │  n-gram Jaccard, top 3
 *   └───────────┬────────────┘
 *               │
 *               ├──── top1 >= 0.95          → match (direct)
 *               ├──── top1 >= 0.80 AND
 *               │     margin >= 0.20        → match (margin)
 *               ├──── top1 < 0.15           → new
 *               │
 *               ▼  ambiguous middle
 *   ┌────────────────────────┐
 *   │  juez-llm.js           │  Claude Haiku, cached
 *   └───────────┬────────────┘
 *               │
 *               ▼
 *           decision
 */

'use strict';

const score   = require('./score-literal');
const judge   = require('./juez-llm');

// Thresholds tuned empirically over the eval suite. See docs/matcher-evolution.md.
const THRESHOLDS = {
  CLEAR_MATCH:   0.95,  // top1 >= this → match without LLM
  STRONG_TOP1:   0.80,  // top1 >= this AND margin >= CLEAR_MARGIN → match
  CLEAR_MARGIN:  0.20,
  NEW_TOP1:      0.15,  // top1 < this → new without LLM
};

const JUDGE_TOP_N = 3;

/**
 * Optional alias lookup. If not provided, the matcher skips the fast path.
 * Inject via constructor or call: { aliasLookup: async (tenantId, supplierId, text) => alias|null }
 */
let _aliasLookup = null;

function setAliasLookup(fn) {
  _aliasLookup = fn;
}

/**
 * Main entry point.
 *
 * @param {object} args
 * @param {string} args.invoiceLine       text of the invoice line
 * @param {Array}  args.candidates        catalog candidates [{ name_in_db, id, ... }]
 * @param {string} args.tenantId
 * @param {string} [args.supplierId]      enables alias fast path if provided
 * @param {boolean} [args.allowJudge]     default true; set false to disable LLM
 *
 * @returns {Promise<{
 *   decision: 'match'|'new'|'ambiguous',
 *   match: object|null,
 *   via: string,
 *   confidence: number,
 *   reason: string,
 *   top1_score: number,
 *   margin: number,
 *   judge_source?: 'cache'|'llm'|'budget_exhausted'|'error',
 *   cost_usd?: number,
 *   duration_ms?: number
 * }>}
 */
async function decide({ invoiceLine, candidates, tenantId, supplierId, allowJudge = true }) {
  // ─── 0. Alias fast path ───────────────────────────────────────────
  if (_aliasLookup && supplierId) {
    try {
      const alias = await _aliasLookup(tenantId, supplierId, invoiceLine);
      if (alias && alias.times_used >= 2) {
        const matched = candidates.find(c => c.id === alias.catalog_product_id);
        if (matched) {
          return {
            decision: 'match',
            match: matched,
            via: 'alias',
            confidence: 100,
            reason: `learned alias (used ${alias.times_used} times)`,
            top1_score: 1.0,
            margin: 1.0,
          };
        }
      }
    } catch (e) {
      // Alias errors should not break matching; log and continue.
      console.error('[matcher] alias lookup error:', e.message);
    }
  }

  // ─── 1. Edge case: no candidates ──────────────────────────────────
  if (!candidates || candidates.length === 0) {
    return {
      decision: 'new',
      match: null,
      via: 'no_candidates',
      confidence: 100,
      reason: 'no candidates to compare',
      top1_score: 0,
      margin: 0,
    };
  }

  // ─── 2. Literal scorer ────────────────────────────────────────────
  const ranked = score.scoreAll(invoiceLine, candidates);
  const top1   = ranked[0];
  const top2   = ranked[1] || { score: 0 };
  const margin = top1.score - top2.score;

  // ─── 3. Deterministic shortcuts ───────────────────────────────────
  if (top1.score >= THRESHOLDS.CLEAR_MATCH) {
    return {
      decision: 'match',
      match: top1.candidate,
      via: 'score_top1_clear',
      confidence: Math.round(top1.score * 100),
      reason: 'top1 above clear-match threshold',
      top1_score: top1.score,
      margin,
    };
  }

  if (top1.score >= THRESHOLDS.STRONG_TOP1 && margin >= THRESHOLDS.CLEAR_MARGIN) {
    return {
      decision: 'match',
      match: top1.candidate,
      via: 'score_top1_margin',
      confidence: Math.round(top1.score * 100),
      reason: `top1 strong and beats top2 by ${margin.toFixed(2)}`,
      top1_score: top1.score,
      margin,
    };
  }

  if (top1.score < THRESHOLDS.NEW_TOP1) {
    return {
      decision: 'new',
      match: null,
      via: 'score_low',
      confidence: Math.round((1 - top1.score) * 100),
      reason: `top1 score ${top1.score.toFixed(2)} below new-product threshold`,
      top1_score: top1.score,
      margin,
    };
  }

  // ─── 4. Ambiguous middle → LLM judge ──────────────────────────────
  if (!allowJudge) {
    return {
      decision: 'ambiguous',
      match: null,
      via: 'judge_disabled',
      confidence: 0,
      reason: 'judge disabled; in ambiguous range',
      top1_score: top1.score,
      margin,
    };
  }

  const topCandidates = ranked.slice(0, JUDGE_TOP_N).map(r => r.candidate);
  const verdict = await judge.consult({
    invoice: invoiceLine,
    candidates: topCandidates,
    tenantId,
  });

  if (verdict.source === 'error' || !verdict.resp) {
    // Fall back to deterministic top1 as match if the judge failed
    // and top1 is at least decent. Otherwise ambiguous.
    if (top1.score >= 0.60) {
      return {
        decision: 'match',
        match: top1.candidate,
        via: 'fallback_judge_error',
        confidence: Math.round(top1.score * 100),
        reason: `judge error (${verdict.error || 'unknown'}); using top1 as fallback`,
        top1_score: top1.score,
        margin,
        judge_source: 'error',
      };
    }
    return {
      decision: 'ambiguous',
      match: null,
      via: 'judge_error',
      confidence: 0,
      reason: `judge error: ${verdict.error || 'unknown'}`,
      top1_score: top1.score,
      margin,
      judge_source: 'error',
    };
  }

  return interpretVerdict(verdict, ranked, top1.score, margin);
}

function interpretVerdict(verdict, ranked, top1Score, margin) {
  const { elegido, confianza, razon } = verdict.resp;
  const base = {
    top1_score: top1Score,
    margin,
    judge_source: verdict.source,
    cost_usd: verdict.cost_usd,
    duration_ms: verdict.duration_ms,
  };

  if (typeof elegido === 'number' && elegido >= 1 && elegido <= ranked.length) {
    return {
      decision: 'match',
      match: ranked[elegido - 1].candidate,
      via: 'judge_chose_' + elegido,
      confidence: confianza || 0,
      reason: razon,
      ...base,
    };
  }
  if (elegido === 'ninguno') {
    return {
      decision: 'new',
      match: null,
      via: 'judge_none',
      confidence: confianza || 0,
      reason: razon,
      ...base,
    };
  }
  // "ambiguo" or unknown
  return {
    decision: 'ambiguous',
    match: null,
    via: 'judge_ambiguous',
    confidence: confianza || 0,
    reason: razon || 'judge marked as ambiguous',
    ...base,
  };
}

module.exports = {
  decide,
  setAliasLookup,
  THRESHOLDS,
  JUDGE_TOP_N,
};
