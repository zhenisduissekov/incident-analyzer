# Incident Analyzer

CLI tool that analyzes production logs using LLM + heuristics.

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

- May hallucinate root cause with insufficient context
- Best results with multi-line logs (rich context)
- Action items can be generic ("investigate X")
- Severity sometimes conservative for production incidents
- Requires OpenAI API key

## License

MIT
