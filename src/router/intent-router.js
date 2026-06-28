/**
 * intent-router.js
 *
 * Two-layer intent router. See docs/multi-agent-architecture.md for the
 * design rationale.
 *
 * Layer 1: regex patterns — free, ~1ms, handles ~80% of intents.
 * Layer 2: Haiku 4.5 classifier — ~1.5s, $0.0002, handles edge cases.
 *
 * The router doesn't know the domain. It only knows agent names and
 * one-line descriptions. The agents themselves contain the domain logic.
 */

'use strict';

// ──────────────────────────────────────────────────────────────────────
// Agent registry
// ──────────────────────────────────────────────────────────────────────
const AGENTS = {
  bulk_onboarding: {
    description: 'Process a supplier invoice end-to-end (extract, match, fill).',
    examples: [
      'process this invoice',
      'I got a delivery from Distributor A',
      'add these products to the catalog',
    ],
  },
  solo_onboarding: {
    description: 'Add a single product, typically from a barcode scan.',
    examples: [
      'scan this',
      'add this product',
      'register a new item',
    ],
  },
  search: {
    description: 'Natural-language query against inventory and catalog.',
    examples: [
      'do I have paracetamol',
      'what is the stock of X',
      'price of brand Y',
    ],
  },
  sale: {
    description: 'Log a sale by chat (decrements stock, attaches lot).',
    examples: [
      'I sold 200 of paracetamol',
      'charged 50 for brand X',
    ],
  },
  quote: {
    description: 'Generate a quote for a customer (WhatsApp friendly).',
    examples: [
      'quote 5 boxes of X',
      'how much is brand X',
    ],
  },
  restock: {
    description: 'Detect inventory gaps and propose purchase orders.',
    examples: [
      'what ran out today',
      'build a purchase order',
      'what should I order from supplier X',
    ],
  },
  purchase: {
    description: 'Supplier and pricing history.',
    examples: [
      'who did I last buy paracetamol from',
      'price history for brand X',
    ],
  },
  admin: {
    description: 'Reports, prescriptions, controlled substances, audit.',
    examples: [
      'monthly report',
      'list controlled substances',
      'show me prescriptions from last week',
    ],
  },
};

// ──────────────────────────────────────────────────────────────────────
// Layer 1: regex (free)
// ──────────────────────────────────────────────────────────────────────
const PATTERNS = [
  // Sale
  { agent: 'sale', re: /\b(vendí|vendi|cobré|cobre|venta\s+de|sold|charged|recibí\s+pago)\b/i },
  // Search
  { agent: 'search', re: /\b(precio|cuánto|cuanto|cuanta|busca|buscar|tienes|tengo|stock\s+de|hay\s+de|me\s+queda)\b/i },
  // Restock
  { agent: 'restock', re: /\b(falta|faltó|me\s+faltó|qué\s+pedir|que\s+pedir|resurtido|resurtir|se\s+acabó|se\s+agotó|out\s+of\s+stock)\b/i },
  // Bulk onboarding
  { agent: 'bulk_onboarding', re: /\b(factura|recibí\s+(?:pedido|entrega)|llegó\s+(?:pedido|entrega)|invoice|delivery|supplier)\b/i },
  // Quote
  { agent: 'quote', re: /\b(cotización|cotizacion|cuánto\s+cuesta|necesito\s+\d+|cotizar|quote)\b/i },
  // Purchase history
  { agent: 'purchase', re: /\b(le\s+compré|historial\s+de\s+precio|último\s+precio|de\s+quién\s+compré|price\s+history|who\s+did\s+I)\b/i },
  // Solo onboarding
  { agent: 'solo_onboarding', re: /\b(escanea|escanear|registrar\s+producto|agregar\s+producto|scan|register)\b/i },
  // Admin / reports
  { agent: 'admin', re: /\b(reporte|reportes|controlados|recetas|prescription|controlled|audit|monthly)\b/i },
];

/**
 * Try to classify the intent using regex patterns only. Free, ~1ms.
 *
 * @param {string} message
 * @returns {string|null} agent name, or null if no pattern matched
 */
function routeLayer1(message) {
  if (!message || typeof message !== 'string') return null;
  for (const { agent, re } of PATTERNS) {
    if (re.test(message)) return agent;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Layer 2: LLM classifier (Haiku)
// ──────────────────────────────────────────────────────────────────────

/**
 * System prompt for the layer-2 classifier. Intentionally short — the
 * classifier only knows agent names, not domain. ~200 tokens.
 */
function buildRouterPrompt() {
  const list = Object.entries(AGENTS)
    .map(([name, { description }]) => `- ${name}: ${description}`)
    .join('\n');
  return `You are an intent classifier for a pharmacy assistant.

Given the user's message, output ONLY one of these agent names:

${list}

If none fits, output: none

Output the agent name and nothing else. No explanation. No punctuation.`;
}

/**
 * Layer 2 router using a Haiku call.
 *
 * @param {object} args
 * @param {string} args.message
 * @param {function} args.callLlm - function ({system, user, model, maxTokens, temperature}) => Promise<{content}>
 * @returns {Promise<string|null>}
 */
async function routeLayer2({ message, callLlm }) {
  if (!message) return null;
  const result = await callLlm({
    system: buildRouterPrompt(),
    user: message,
    model: 'anthropic/claude-haiku-4-5',
    maxTokens: 20,
    temperature: 0,
  });
  const cleaned = String(result.content || '').trim().toLowerCase();
  if (cleaned === 'none') return null;
  if (cleaned in AGENTS) return cleaned;
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Combined router
// ──────────────────────────────────────────────────────────────────────

/**
 * Route a message to an agent. Tries Layer 1 first; falls back to Layer 2.
 *
 * @param {object} args
 * @param {string} args.message
 * @param {function} [args.callLlm]  required for Layer 2 fallback
 * @returns {Promise<{agent: string|null, layer: 1|2|null, latencyMs: number}>}
 */
async function route({ message, callLlm }) {
  const t0 = Date.now();

  // Try Layer 1 first
  const l1 = routeLayer1(message);
  if (l1) {
    return { agent: l1, layer: 1, latencyMs: Date.now() - t0 };
  }

  // Fallback to Layer 2 if available
  if (callLlm) {
    const l2 = await routeLayer2({ message, callLlm });
    return { agent: l2, layer: l2 ? 2 : null, latencyMs: Date.now() - t0 };
  }

  return { agent: null, layer: null, latencyMs: Date.now() - t0 };
}

module.exports = {
  AGENTS,
  PATTERNS,
  routeLayer1,
  routeLayer2,
  route,
  buildRouterPrompt,
};
