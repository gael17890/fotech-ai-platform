/**
 * runner.js
 *
 * Reproducible eval runner. Reads every fixture in evals/fixtures/,
 * runs the matcher against the candidates, and writes results to
 * evals/runs/summary.json.
 *
 * Designed to be run with your own LLM API key:
 *
 *   AI_GATEWAY_API_KEY=... node evals/runner.js
 *
 * Or to run only the deterministic-scorer pieces without an LLM:
 *
 *   node evals/runner.js --no-llm
 *
 * The fixtures here are 10 anonymized invoices, not the production
 * 88-invoice suite. Suppliers are Distributor A / B / C / D.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const matcher = require('../src/matcher/matcher-v3-llm');
const score   = require('../src/matcher/score-literal');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const RUNS_DIR     = path.join(__dirname, 'runs');

const allowLlm = !process.argv.includes('--no-llm');

// ──────────────────────────────────────────────────────────────────────
// Load fixtures
// ──────────────────────────────────────────────────────────────────────
function loadFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    throw new Error('fixtures directory not found: ' + FIXTURES_DIR);
  }
  return fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      const full = path.join(FIXTURES_DIR, f);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      return { file: f, ...data };
    });
}

// ──────────────────────────────────────────────────────────────────────
// Run one fixture
// ──────────────────────────────────────────────────────────────────────
async function runFixture(fixture) {
  const results = [];
  for (const line of fixture.lines) {
    const r = await matcher.decide({
      invoiceLine: line.text,
      candidates: line.candidates,
      tenantId: fixture.tenant_id || 'showcase',
      supplierId: fixture.supplier_id,
      allowJudge: allowLlm,
    });

    // Compare to ground truth if provided
    let correct = null;
    if (line.expected) {
      if (line.expected.decision === r.decision) {
        if (r.decision === 'match' && line.expected.catalog_product_id) {
          correct = r.match?.id === line.expected.catalog_product_id;
        } else {
          correct = true;
        }
      } else {
        correct = false;
      }
    }

    results.push({
      line_id: line.id,
      text: line.text,
      decision: r.decision,
      via: r.via,
      confidence: r.confidence,
      top1_score: r.top1_score,
      margin: r.margin,
      expected_decision: line.expected?.decision,
      correct,
    });
  }
  return {
    fixture: fixture.file,
    supplier_id: fixture.supplier_id,
    lines_total: fixture.lines.length,
    results,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Aggregate
// ──────────────────────────────────────────────────────────────────────
function aggregate(runs) {
  const totals = { match: 0, new: 0, ambiguous: 0 };
  let withGroundTruth = 0;
  let correctCount = 0;

  for (const run of runs) {
    for (const r of run.results) {
      totals[r.decision] = (totals[r.decision] || 0) + 1;
      if (r.correct !== null) {
        withGroundTruth++;
        if (r.correct) correctCount++;
      }
    }
  }

  const totalLines = Object.values(totals).reduce((a, b) => a + b, 0);
  const pct = (n) => totalLines === 0 ? 0 : (n / totalLines) * 100;

  return {
    fixtures: runs.length,
    lines_total: totalLines,
    by_decision: {
      match:     { count: totals.match,     percent: +pct(totals.match).toFixed(1) },
      new:       { count: totals.new,       percent: +pct(totals.new).toFixed(1) },
      ambiguous: { count: totals.ambiguous, percent: +pct(totals.ambiguous).toFixed(1) },
    },
    ground_truth: {
      lines_with_truth: withGroundTruth,
      correct: correctCount,
      accuracy_percent: withGroundTruth === 0 ? null : +((correctCount / withGroundTruth) * 100).toFixed(1),
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('═'.repeat(60));
  console.log('FOTECH matcher eval runner');
  console.log('═'.repeat(60));
  console.log(`LLM judge enabled: ${allowLlm ? 'yes' : 'no (--no-llm)'}`);
  console.log('');

  const fixtures = loadFixtures();
  console.log(`Loaded ${fixtures.length} fixtures from ${FIXTURES_DIR}`);
  console.log('');

  const runs = [];
  for (const f of fixtures) {
    process.stdout.write(`  ${f.file.padEnd(30)} ... `);
    try {
      const r = await runFixture(f);
      runs.push(r);
      console.log(`${r.results.length} lines`);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  const summary = {
    run_at: new Date().toISOString(),
    llm_enabled: allowLlm,
    matcher_version: 'v3-llm',
    ...aggregate(runs),
  };

  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
  const summaryPath = path.join(RUNS_DIR, 'summary.json');
  const detailPath  = path.join(RUNS_DIR, 'detail.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(detailPath, JSON.stringify(runs, null, 2));

  console.log('');
  console.log('═'.repeat(60));
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(JSON.stringify(summary, null, 2));
  console.log('');
  console.log(`Wrote: ${summaryPath}`);
  console.log(`       ${detailPath}`);
})().catch(e => {
  console.error('ERROR:', e.message);
  console.error(e.stack);
  process.exit(1);
});
