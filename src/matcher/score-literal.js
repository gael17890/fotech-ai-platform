/**
 * score-literal.js
 *
 * Pure n-gram Jaccard similarity for product matching. Zero LLM calls.
 *
 * This is the deterministic half of the hybrid matcher. It runs first,
 * handles the easy cases (very high or very low similarity), and only
 * defers to the LLM judge in the ambiguous middle.
 *
 * The full production version has additional pieces (presentation
 * synonyms, hard filters on form/pack/concentration, brand extraction,
 * form-group fallback). The simplified version here shows the core
 * idea cleanly. See docs/matcher-evolution.md for the full story.
 */

'use strict';

// ──────────────────────────────────────────────────────────────────────
// Presentation synonyms (small subset; full table has ~60 entries)
// ──────────────────────────────────────────────────────────────────────
const PRESENTATION_SYNONYMS = {
  TAB:  ['TABS', 'TABLETA', 'TABLETAS', 'COMP', 'COMPRIMIDO', 'COMPRIMIDOS'],
  CAP:  ['CAPS', 'CAPSULA', 'CAPSULAS'],
  SUSP: ['SUSPENSION'],
  SOL:  ['SOLUCION'],
  INY:  ['INYECTABLE', 'INYECT'],
  AMP:  ['AMPOLLA', 'AMPOLLAS', 'AMPTAS', 'AMPOLLETAS'],
  GTS:  ['GOTAS', 'GOTA'],
  CMA:  ['CREMA'],
  UNG:  ['UNGUENTO', 'UNGTO'],
  AER:  ['AEROSOL', 'SPRAY'],
  OFT:  ['OFTALMICA', 'OFTALMICO'],
  JBE:  ['JARABE'],
};

/**
 * Normalize a text by replacing presentation synonyms with their canonical
 * form. Word-boundary aware so 'TABLETAS' becomes 'TAB' but 'ATABLE' stays put.
 *
 * Bug history kept here as a warning: `\b` in a JS string literal is the
 * backspace character (ASCII 0x08), not the regex word-boundary anchor.
 * You need '\\b' in the source string to get '\b' in the regex.
 */
function normalizePresentation(text) {
  let out = String(text).toUpperCase();
  for (const [canonical, variants] of Object.entries(PRESENTATION_SYNONYMS)) {
    for (const v of variants) {
      const pattern = new RegExp('\\b' + v + '\\b', 'gi');
      out = out.replace(pattern, canonical);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// N-gram generation
// ──────────────────────────────────────────────────────────────────────

/**
 * Produce the set of n-grams (default n=3) from a text. The text is
 * first cleaned (strip punctuation, collapse whitespace) and lowercased.
 */
function ngrams(text, n = 3) {
  const cleaned = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < n) return new Set([cleaned]);

  const grams = new Set();
  for (let i = 0; i <= cleaned.length - n; i++) {
    grams.add(cleaned.slice(i, i + n));
  }
  return grams;
}

// ──────────────────────────────────────────────────────────────────────
// Jaccard similarity
// ──────────────────────────────────────────────────────────────────────

/**
 * Jaccard similarity between two sets: |A ∩ B| / |A ∪ B|.
 * Range [0, 1]. Higher is more similar.
 */
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ──────────────────────────────────────────────────────────────────────
// Scoring
// ──────────────────────────────────────────────────────────────────────

/**
 * Score a single (invoice line, candidate) pair.
 * Returns a number in [0, 1].
 */
function scorePair(invoiceLine, candidate) {
  const a = normalizePresentation(invoiceLine);
  const b = normalizePresentation(candidate);
  return jaccard(ngrams(a), ngrams(b));
}

/**
 * Score all candidates for a given invoice line and return them sorted
 * by score descending. Each item is { candidate, score }.
 *
 * @param {string} invoiceLine - the line from the supplier's invoice
 * @param {Array<{name_in_db: string}>} candidates - candidates from catalog
 * @returns {Array<{candidate: object, score: number}>}
 */
function scoreAll(invoiceLine, candidates) {
  return candidates
    .map(c => ({
      candidate: c,
      score: scorePair(invoiceLine, c.name_in_db),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Pick the top N candidates by score. Returns same shape as scoreAll.
 *
 * @param {string} invoiceLine
 * @param {Array<object>} candidates
 * @param {number} n - default 3
 */
function topN(invoiceLine, candidates, n = 3) {
  return scoreAll(invoiceLine, candidates).slice(0, n);
}

module.exports = {
  normalizePresentation,
  ngrams,
  jaccard,
  scorePair,
  scoreAll,
  topN,
  PRESENTATION_SYNONYMS,
};
