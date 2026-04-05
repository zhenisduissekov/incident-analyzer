# Incident Analyzer

CLI tool that analyzes production logs using LLM + heuristics.

## Why

Debugging production incidents from logs is slow and requires context. 

This tool generates a structured first hypothesis (severity, root cause, actions) to help engineers start debugging faster. It is NOT a replacement for human debugging — it's a starting point.

Built for real production scenarios: MongoDB outages, CDN cache issues, CI/CD timeouts.

## Impact

- Helps generate a structured first debugging hypothesis quickly
- Can reduce time to start investigation for common incidents
- Enables batch triage of multiple logs to identify the primary issue

## Usage Scenario

On-call engineer gets PagerDuty alert: "MongoDB timeout errors"

```
# Download logs from 3 services
# Run analysis on entire folder

$ npm start -- --dir incidents/
OK: cf-cache.log
OK: mongo-error.log
OK: pipeline-timeout.log
Saved 3 markdown reports in reports/
```

**Result:** 3 incident reports in 10 seconds

| File | Severity | Category | Assessment |
|------|----------|----------|------------|
| cf-cache.log | medium | infrastructure | Not the culprit |
| mongo-error.log | **high** | **database** | **This is our incident** |
| pipeline-timeout.log | medium | infrastructure | Side effect |

**Engineer can start with:**
- More structured first hypothesis (category, severity, root cause)
- Better triage across multiple services
- Appropriate caution flags (`needs_human_review`) for operational incidents

## Example

### Input
```
2024-01-15T14:32:18Z [error] MongoError: connection refused to rs0/shard1.mongodb.net:27017
MongoNetworkError: failed to connect to server [shard1.mongodb.net:27017] on first connect
MongoServerSelectionError: connection timed out
Operation: aggregate pipeline with $search stage
Collection: products
Query: { $search: { index: 'default', text: { query: 'laptop', path: 'name' } } }
Atlas Cluster: production-shard-00
Current connections: 497/500
Connection pool exhausted
```

### Output
```markdown
# mongo-error.log

**Severity:** high | **Category:** database | **Confidence:** medium | **Review:** **YES**

**Summary:** Connection refused and timeout errors while querying the MongoDB database.

**Cause:** Connection pool exhausted, leading to inability to connect to the MongoDB server.

**Actions:**
- Investigate connection pool settings and limits.
- Monitor MongoDB server health and performance.
- Review application logic for potential connection leaks.
```

## Features

- Log → structured analysis (severity, category, summary, root cause)
- LLM-powered with heuristic overrides for known patterns
- Batch processing for folders (`--dir`)
- Markdown reports for human review
- Conservative `needs_human_review` flag for operational incidents

## Architecture

```
log input → GPT-4o-mini → JSON → heuristic overrides → markdown report
                ↑
           strict prompt with:
           - category rules (security/database/network/infrastructure/app)
           - severity guidance (low/medium/high/critical)
           - needs_human_review policy for infrastructure/CI incidents
           - schema validation
```

**Key components:**
- **LLM layer:** GPT-4o-mini generates structured analysis with temperature=0
- **Validation:** JSON schema validation ensures consistent output
- **Heuristics:** Rule-based overrides for known failure patterns (OOM, disk full, crash loops)
- **Batch mode:** Processes folders, generates per-file markdown reports + combined JSON

## Why heuristics are needed

LLMs tend to:
- Default to "medium" severity for most incidents
- Hallucinate root causes when not explicitly present in logs
- Misclassify infrastructure issues as application errors

Heuristic overrides correct these cases for known patterns:
- **Disk full / OOM** → severity high, category infrastructure
- **Crash loops** → severity critical, needs review false
- **Connection refused** → category database/network depending on service

## Why not just use ChatGPT?

- **Enforces structured output** — JSON schema validation, not free text
- **Deterministic corrections** — heuristics override LLM for known patterns
- **Batch processing** — analyze entire folders, not one-by-one
- **Consistent reports** — same format for every incident
- **Captures repeatable workflow in code** — not ad hoc prompting every time

## Install

```bash
npm install
```

Add your OpenAI API key to `.env`:
```
OPENAI_API_KEY=sk-...
```

## Usage

```bash
# Single log from CLI
npm start -- "Error: timeout after 5000ms"

# From file
npm start -- --file logs/example.log

# Batch folder
npm start -- --dir logs/
```

## Real Examples

### 1. MongoDB Connection Pool Exhaustion

**What the model got right:**
- ✅ Severity `high` — production DB with 497/500 connections
- ✅ Category `database` — correctly identified MongoDB issue
- ✅ Root cause — connection pool exhaustion explicitly stated in log

**Where it's cautious:**
- ⚠️ Confidence `medium` — appropriately conservative for operational incident
- ⚠️ `needs_human_review: true` — correct flag for follow-up required

**Assessment:** Solid analysis. Action items are generic but point in right direction.

---

### 2. Cloudflare Cache Invalidation Failure

**What the model got right:**
- ✅ Severity `high` — 47/200 edge nodes affected
- ✅ Category `infrastructure` — correctly classified upstream/cache issue
- ✅ Root cause — 502 Bad Gateway with wrong content-type captured

**Where it's cautious:**
- ⚠️ Confidence `medium` — multiple symptoms (edge nodes, upstream, cache)
- ⚠️ `needs_human_review: true` — appropriate for multi-layer incident

**Assessment:** Good triage. Would help on-call engineer prioritize quickly.

---

### 3. GitLab CI Pipeline Timeout

**What the model got right:**
- ✅ Category `infrastructure` — CI/CD execution issue, not app bug
- ✅ Root cause — "waiting for database connection" from last log line

**Where it could be better:**
- ⚠️ Severity `medium` — debatable for production deploy blocker
- ⚠️ Action items circular — "investigate DB connection" for DB wait

**Assessment:** Useful for initial classification, but severity might need human bump.

---

### 4. Known Failure Mode — Single-line Operational Errors

**Input:**
```
2024-01-15T03:22:10Z [error] Connection refused: redis-master:6379
```

**Initial model output (without heuristics):**
- Severity: `medium` ❌
- Category: `application` ❌

**Problem:** 
- Single-line error lacks context
- Model defaults to "medium" without explicit severity signals
- Connection refused to infrastructure service misclassified as application error

**After heuristic override:**
- Severity: `high` ✅ (connection refused to critical service)
- Category: `database` ✅ (Redis is infrastructure dependency)

**Why this matters:**
This is exactly why heuristics were added. Pure LLM output can under-classify operational incidents. Rule-based corrections catch obvious patterns (OOM, disk full, connection refused) that LLMs miss without rich context.

---

## Status

MVP / experimental. Focused on log triage and initial hypothesis generation, not full root-cause automation or remediation.

## What this project demonstrates

- **LLM integration** with structured output and schema validation
- **Rule-based post-processing** (heuristics) for reliability in production scenarios
- **CLI and batch workflows** for incident triage at scale
- **Critical evaluation** of model limitations on real-world logs

## Repository structure

```
├── index.ts          # CLI analyzer with batch mode
├── eval.ts           # Evaluation harness for testing
├── logs/             # Real incident logs (MongoDB, Cloudflare, GitLab CI)
├── reports/          # Generated markdown and JSON reports
├── samples/          # Synthetic test cases
└── data/             # Evaluation cases and history
```

## Limitations

- Root cause may be incorrect if not explicitly present in logs — LLMs hallucinate without constraints
- Category classification can be ambiguous (application vs infrastructure vs network)
- Works best with multi-line logs; single errors lack context
- Severity often defaults to "medium" without explicit guidance
- Action items can be generic ("investigate X") rather than specific
- Requires OpenAI API key

## What I learned building this

**LLM behavior:**
- LLMs overconfidently infer root causes without sufficient evidence — schema validation is essential
- Multi-line context drastically improves output quality
- Pure prompt engineering is not enough — hybrid systems (LLM + rules) work better for production

**Engineering decisions:**
- Heuristic overrides are essential for reliability (OOM, disk full, crash loops)
- Conservative `needs_human_review` flag prevents false confidence on operational incidents
- Temperature=0 and strict JSON schema improve consistency

**Production insight:**
- This is a triage tool, not a diagnosis. It helps engineers start with the right category and severity, not replace debugging.

## License

MIT
