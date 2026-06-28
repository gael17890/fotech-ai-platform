/**
 * score-literal.test.js
 *
 * Unit tests for src/matcher/score-literal.js using the built-in
 * Node.js test runner (node --test).
 *
 * No LLM, no database — pure functions only.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePresentation,
  ngrams,
  jaccard,
  scorePair,
  scoreAll,
  topN,
} = require('../src/matcher/score-literal');

// ──────────────────────────────────────────────────────────────────────
// normalizePresentation
// ──────────────────────────────────────────────────────────────────────
test('normalizePresentation collapses TAB/TABS/TABLETA/TABLETAS to TAB', () => {
  assert.equal(normalizePresentation('DOLXEN c/10 TABLETAS'), 'DOLXEN C/10 TAB');
  assert.equal(normalizePresentation('DOLXEN c/10 TABS'),     'DOLXEN C/10 TAB');
  assert.equal(normalizePresentation('DOLXEN c/10 TABLETA'),  'DOLXEN C/10 TAB');
  assert.equal(normalizePresentation('DOLXEN c/10 TAB'),      'DOLXEN C/10 TAB');
});

test('normalizePresentation collapses CAP/CAPS/CAPSULA/CAPSULAS to CAP', () => {
  assert.equal(normalizePresentation('OMEPRAZOL c/14 CAPSULAS'), 'OMEPRAZOL C/14 CAP');
  assert.equal(normalizePresentation('OMEPRAZOL c/14 CAPS'),     'OMEPRAZOL C/14 CAP');
});

test('normalizePresentation respects word boundaries', () => {
  // 'TABS' inside a longer word should NOT be replaced
  assert.equal(normalizePresentation('TABSOMETHING'), 'TABSOMETHING');
  // standalone TABS should be replaced
  assert.equal(normalizePresentation('SOMETHING TABS'), 'SOMETHING TAB');
});

test('normalizePresentation upper-cases input', () => {
  assert.equal(normalizePresentation('dolxen 500mg tabs'), 'DOLXEN 500MG TAB');
});

// ──────────────────────────────────────────────────────────────────────
// ngrams
// ──────────────────────────────────────────────────────────────────────
test('ngrams produces trigrams by default', () => {
  const g = ngrams('abcd');
  assert.equal(g.size, 2);
  assert.ok(g.has('abc'));
  assert.ok(g.has('bcd'));
});

test('ngrams strips punctuation and lowercases', () => {
  const g = ngrams('Hello, World!');
  assert.ok(g.has('hel'));
  assert.ok(!g.has('Hel'));
});

test('ngrams handles short input as single-element set', () => {
  const g = ngrams('ab');
  assert.equal(g.size, 1);
  assert.ok(g.has('ab'));
});

// ──────────────────────────────────────────────────────────────────────
// jaccard
// ──────────────────────────────────────────────────────────────────────
test('jaccard of identical sets is 1', () => {
  const a = new Set(['x', 'y', 'z']);
  const b = new Set(['x', 'y', 'z']);
  assert.equal(jaccard(a, b), 1);
});

test('jaccard of disjoint sets is 0', () => {
  const a = new Set(['x', 'y']);
  const b = new Set(['a', 'b']);
  assert.equal(jaccard(a, b), 0);
});

test('jaccard of half-overlap is 1/3', () => {
  const a = new Set(['x', 'y']);
  const b = new Set(['y', 'z']);
  assert.equal(jaccard(a, b), 1 / 3);
});

test('jaccard of two empty sets is 1 (defined)', () => {
  assert.equal(jaccard(new Set(), new Set()), 1);
});

// ──────────────────────────────────────────────────────────────────────
// scorePair (end-to-end small)
// ──────────────────────────────────────────────────────────────────────
test('scorePair returns high score for near-identical names', () => {
  const s = scorePair('DOLXEN 500MG Tabletas c/10', 'DOLXEN 500MG C/10 TABLETAS');
  assert.ok(s > 0.7, `expected > 0.7, got ${s}`);
});

test('scorePair returns low score for unrelated names', () => {
  const s = scorePair('DOLXEN 500MG c/10', 'PARACETAMOL 250MG c/30');
  assert.ok(s < 0.4, `expected < 0.4, got ${s}`);
});

test('scorePair treats TAB and TABS as equivalent', () => {
  const a = scorePair('DOLXEN 500MG TABS c/10', 'DOLXEN 500MG C/10 TABLETAS');
  const b = scorePair('DOLXEN 500MG TAB c/10',  'DOLXEN 500MG C/10 TABLETAS');
  // both should be high and similar to each other
  assert.ok(a > 0.7);
  assert.ok(b > 0.7);
  assert.ok(Math.abs(a - b) < 0.05);
});

// ──────────────────────────────────────────────────────────────────────
// scoreAll / topN
// ──────────────────────────────────────────────────────────────────────
test('scoreAll returns candidates sorted by score descending', () => {
  const invoice = 'DOLXEN 500MG Tabletas c/10';
  const candidates = [
    { id: 1, name_in_db: 'PARACETAMOL 500MG C/10' },
    { id: 2, name_in_db: 'DOLXEN 500MG C/10 TABLETAS' },
    { id: 3, name_in_db: 'DOLXEN 500MG C/20 TABLETAS' },
  ];
  const result = scoreAll(invoice, candidates);
  assert.equal(result.length, 3);
  assert.equal(result[0].candidate.id, 2);
  // Sorted descending
  assert.ok(result[0].score >= result[1].score);
  assert.ok(result[1].score >= result[2].score);
});

test('topN returns the first N entries from scoreAll', () => {
  const invoice = 'DOLXEN 500MG c/10';
  const candidates = [
    { id: 1, name_in_db: 'OTHER 500MG' },
    { id: 2, name_in_db: 'DOLXEN 500MG C/10 TABLETAS' },
    { id: 3, name_in_db: 'DOLXEN 500MG C/20 TABLETAS' },
    { id: 4, name_in_db: 'UNRELATED 200MG' },
  ];
  const top = topN(invoice, candidates, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].candidate.id, 2);
});

// ──────────────────────────────────────────────────────────────────────
// Backspace-vs-word-boundary regression
// ──────────────────────────────────────────────────────────────────────
test('REGRESSION: word boundary uses \\\\b not \\b (which is backspace)', () => {
  // If we had used '\b' (the actual backspace character) instead of '\\b'
  // in the regex source, this assertion would fail because the regex
  // would no longer match word boundaries at all.
  assert.equal(normalizePresentation('XYZ TABLETAS'), 'XYZ TAB');
});
