# Incident Analyzer

CLI tool that analyzes production logs using LLM + heuristics.

## Why

Debugging production incidents from logs is slow and requires context. 

This tool generates a structured first hypothesis (severity, root cause, actions) to help engineers start debugging faster. It is NOT a replacement for human debugging — it's a starting point.

Built for real production scenarios: MongoDB outages, CDN cache issues, CI/CD timeouts.

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

## Limitations

- Root cause may be incorrect if not explicitly present in logs — LLMs hallucinate without constraints
- Category classification can be ambiguous (application vs infrastructure vs network)
- Works best with multi-line logs; single errors lack context
- Severity often defaults to "medium" without explicit guidance
- Action items can be generic ("investigate X") rather than specific
- Requires OpenAI API key

## What I learned building this

**LLM behavior:**
- LLMs default severity to "medium" without strong guidance — need explicit rubric
- Root cause hallucination is real without schema validation and constraints
- Multi-line logs significantly improve analysis quality vs single error lines

**Engineering decisions:**
- Heuristic overrides are essential for reliability (OOM, disk full, crash loops)
- Conservative `needs_human_review` flag prevents false confidence on operational incidents
- Temperature=0 and strict JSON schema improve consistency

**Production insight:**
- This is a triage tool, not a diagnosis. It helps engineers start with the right category and severity, not replace debugging.

## License

MIT
