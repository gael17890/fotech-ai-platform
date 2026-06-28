# RBAC Architecture

A bank-grade authorization system in PostgreSQL: 391 atomic permissions, 76 roles, 4,093 role-permission entries, 30 Separation-of-Duties rules, with ABAC and ReBAC layered on top.

## Why a custom RBAC

Odoo (the ERP underneath FOTECH) ships with its own access-control system. It's fine for general business use. It's not fine for **regulated pharmacy operations** where:

- A single user can do high-value damage (release a contaminated lot for sale)
- Auditors expect to see *who could have done what, when, and why* for any given decision
- Compliance regulations (COFEPRIS in Mexico, equivalents elsewhere) require **Separation of Duties** between roles like "creates a purchase order" and "approves a payment"
- Multi-tenant deployments need hard isolation between clients' data

So I built a parallel RBAC system in PostgreSQL that augments (doesn't replace) Odoo's, and routes every sensitive decision through a dedicated **Policy Decision Point (PDP)** service.

## The numbers

The system is loaded and active in the pilot client:

| Metric | Count |
|---|---|
| Atomic permissions | **391** |
| Functional areas | **17** |
| Roles | **76** |
| Role-permission entries (matrix) | **4,093** |
| SoD (Separation of Duties) rules | **30** |
| Tenants supported | **multi** (single-row WHERE filter) |
| Authorization decision latency (cached) | **< 1ms (Redis L1)** |
| Authorization decision latency (cold) | **~3ms (PostgreSQL L2)** |

These are verifiable by counting rows in the production database.

## The three layers

The system blends three access-control models that solve different problems:

### 1. RBAC (Role-Based Access Control)

The base layer. A user has roles; roles have permissions; permissions gate actions.

```
USER ──── has ────► ROLE ──── grants ────► PERMISSION ──── allows ────► ACTION
```

The matrix table looks like this (sketch):

```sql
CREATE TABLE rbac_role_permission (
  id              BIGSERIAL PRIMARY KEY,
  role_id         INT NOT NULL REFERENCES rbac_role(id),
  permission_id   INT NOT NULL REFERENCES rbac_permission(id),
  scope_restriction JSONB,         -- the ABAC layer (see below)
  granted_by      INT NOT NULL,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  UNIQUE (role_id, permission_id)
);
```

The 4,093 rows in this table are the **explicit grants** — there's no implicit inheritance to confuse an auditor.

### 2. ABAC (Attribute-Based Access Control)

The `scope_restriction` JSONB column on the matrix is the ABAC layer. It declares **conditions** that the request must satisfy beyond just having the role.

Examples of real `scope_restriction` values from production:

```json
{
  "branch_in": ["branch-mx-cdmx-001", "branch-mx-cdmx-002"],
  "max_amount_mxn": 50000
}
```
"Has the permission, but only at these branches and only up to MX$50,000."

```json
{
  "requires_2fa_fresh_minutes": 15,
  "four_eyes": true
}
```
"Has the permission, but needs a 2FA token less than 15 minutes old AND needs a second approver before commit."

```json
{
  "currency_locked": "MXN"
}
```
"Can transact, but only in MXN."

```json
{
  "time_window": { "start": "08:00", "end": "20:00", "tz": "America/Mexico_City" }
}
```
"Only during business hours."

These conditions are evaluated by the PDP at the time of the request. The evaluator is small and composable — adding a new condition type means adding one handler.

### 3. ReBAC (Relationship-Based Access Control)

For hierarchies — "a regional manager sees the branches under them, automatically" — I use PostgreSQL's `ltree` extension.

```sql
CREATE TABLE org_node (
  id        BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  path      LTREE NOT NULL,        -- e.g. 'mx.north.cdmx.branch001'
  name      TEXT NOT NULL,
  type      TEXT NOT NULL,         -- 'country', 'region', 'branch', etc.
  UNIQUE (tenant_id, path)
);

CREATE INDEX ix_org_node_path ON org_node USING GIST (path);
```

A query like *"all branches managed by a CDMX regional manager"* becomes:

```sql
SELECT * FROM org_node
WHERE tenant_id = $1
  AND path <@ 'mx.north.cdmx'  -- "is a descendant of"
  AND type = 'branch';
```

The GIST index makes this O(log n). The user's role grant doesn't enumerate every branch — it grants at the level (`mx.north.cdmx`) and inheritance happens at query time.

## Separation of Duties (SoD)

The 30 SoD rules are constraints that **prevent dangerous combinations of roles being held by the same user**. Classic examples:

| Rule | Why |
|---|---|
| `purchase_create` ⊥ `purchase_approve` | The same person can't both create a purchase order and approve payment for it (fraud prevention) |
| `lot_release` ⊥ `lot_quality_check` | The QC inspector can't release the lot they inspected (regulatory) |
| `inventory_adjust_in` ⊥ `inventory_adjust_out` | Anti-shrinkage: the same person can't write up *and* write down inventory without a second pair of eyes |

These are enforced at role-assignment time (you can't grant a user two SoD-incompatible roles) **and** at decision time (the PDP double-checks before authorizing a sensitive action).

The schema:

```sql
CREATE TABLE rbac_sod_rule (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  permission_a_id INT NOT NULL REFERENCES rbac_permission(id),
  permission_b_id INT NOT NULL REFERENCES rbac_permission(id),
  severity        TEXT NOT NULL,   -- 'block' | 'warn'
  active          BOOLEAN NOT NULL DEFAULT true,
  CHECK (permission_a_id < permission_b_id) -- canonical ordering
);
```

## The 17 functional areas

The 391 permissions are organized into 17 areas. The most regulatory-relevant for healthcare are highlighted:

| Area | Permissions | Notes |
|---|---|---|
| POS | 28 | |
| Inventory | 31 | |
| Logistics | 24 | |
| Marketing | 18 | |
| HR | 22 | |
| Accounting | 29 | |
| Purchases | 26 | |
| Production | 21 | |
| Quality Control | 18 | Gates lot releases |
| **Compliance (COFEPRIS)** | **21** | Sanitary registrations, BPF, lot recalls, license management |
| **Medical Visit** | **20** | Pharmaceutical-sample traceability for prescription attribution |
| Customer Service | 19 | |
| Systems / IT | 28 | |
| Legal | 16 | |
| ID / Identity | 12 | |
| BI / Analytics | 23 | |
| Transversal | 35 | Cross-cutting (audit log read, etc.) |

The two highlighted areas (Compliance and Medical Visit) implement what I call the "Escudo Legal" pattern — workflows that exist primarily to make the company **defensible** against regulatory audit or anti-corruption investigation.

### The "Escudo Legal" pattern in Medical Visit

In Mexico, pharmaceutical reps visit doctors to leave samples and discuss products. Two things have to be tracked rigorously to avoid corruption charges (similar to the US Sunshine Act):

1. **Every sample handed out** must be traceable from manufacture to delivery to a specific doctor.
2. **Every prescription written** for a given drug, after a sample was delivered, can be statistically attributed (this is what regulators look for).

The 20 permissions in this area gate:

- Logging a visit
- Distributing a sample (decrements a controlled inventory)
- Attributing a sample to a doctor
- Generating attribution reports for regulators
- Modifying historical visit records (heavily restricted — usually requires a 4-eyes + audit reason)

The hierarchy involved (rep → district supervisor → district manager → medical director) is modeled as an `ltree` path so a district manager sees their reps' activity automatically.

## The Policy Decision Point (PDP)

The PDP is a separate container (`fotech-pdp`) with its own Redis cache (`fotech-redis-pdp`). It exposes one endpoint:

```
POST /decide
{
  "subject_id": "user-12345",
  "tenant_id": "tenant-001",
  "action": "purchase.approve",
  "resource": {
    "type": "purchase_order",
    "id": "po-67890",
    "amount_mxn": 45000,
    "branch": "mx.north.cdmx.branch001"
  },
  "context": {
    "now": "2026-06-28T14:30:00-06:00",
    "two_fa_minutes_ago": 8
  }
}
```

Response:

```json
{
  "decision": "permit",
  "obligations": [
    { "type": "second_approver_required", "min_role": "regional_manager" },
    { "type": "audit_log", "level": "high" }
  ],
  "cache_ttl_seconds": 300,
  "evaluator_version": "v1.4.2"
}
```

The PDP returns three possible decisions:

- `permit` — proceed (possibly with obligations the caller must fulfill)
- `deny` — stop, with a reason
- `indeterminate` — the input is malformed or a dependency is unavailable; treat as deny

### Two-level cache

- **L1 (Redis)** — TTL 5 minutes, keyed by hash of `(subject, action, resource_type, scope_hash)`. Hit rate ~85% in production.
- **L2 (PostgreSQL prepared statement)** — when L1 misses, a parameterized query against the role-permission matrix and ABAC conditions.

The cache is invalidated explicitly on:
- Role grant or revoke
- SoD rule change
- Permission definition update

So caching never goes stale across security-relevant changes.

### Audit log

Every PDP decision (permit, deny, indeterminate) is logged in `rbac_decision_log`, partitioned monthly:

```sql
CREATE TABLE rbac_decision_log (
  id              BIGSERIAL,
  tenant_id       TEXT NOT NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject_id      TEXT NOT NULL,
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  decision        TEXT NOT NULL,
  reason          TEXT,
  obligations     JSONB,
  evaluator_version TEXT,
  PRIMARY KEY (decided_at, id)
) PARTITION BY RANGE (decided_at);
```

Monthly partitions keep queries fast and let me drop old partitions when retention policy permits.

## How this defends the CV's claims

| Claim | Defense |
|---|---|
| "391 atomic permissions" | `SELECT COUNT(*) FROM rbac_permission` returns 391 in the pilot DB |
| "76 roles with metadata" | `SELECT COUNT(*) FROM rbac_role` returns 76 |
| "4,093 role-permission entries" | `SELECT COUNT(*) FROM rbac_role_permission` returns 4,093 |
| "30 SoD rules" | `SELECT COUNT(*) FROM rbac_sod_rule WHERE active = true` returns 30 |
| "RBAC + ABAC + ReBAC" | RBAC = matrix table. ABAC = `scope_restriction` JSONB. ReBAC = `ltree` org hierarchy. |
| "PDP with L1/L2 cache" | `fotech-pdp` container + `fotech-redis-pdp` container running in production |
| "Audit log partitioned by month" | `\d+ rbac_decision_log` shows partition structure |

If you're hiring me for a healthcare AI role and want to verify any of these, I can show the schema, the running containers, and sample queries in a live screen-share.

## What's NOT here

- The **full permission catalog** is not in this repo — the 391 specific permission names reveal more about the platform's business logic than I want public.
- The **schemas in this doc are sketches** — the production schemas have additional indexing, partitioning, and constraint columns omitted for clarity.
- The **PDP source** is a Python FastAPI service that's part of the private codebase. I'm happy to walk through it in an interview.

## Related

- [`docs/production-infrastructure.md`](production-infrastructure.md) — the containers that run this
- [`docs/decisions/`](decisions/) — the ADRs for related decisions
