import 'dotenv/config';
import OpenAI from 'openai';
import { readFile, writeFile, access, constants, mkdir, readdir } from 'fs/promises';
import path from 'path';

if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type IncidentAnalysis = {
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: 'network' | 'database' | 'application' | 'security' | 'infrastructure' | 'unknown';
  summary: string;
  root_cause: string;
  action_items: string[];
  confidence: 'low' | 'medium' | 'high';
  needs_human_review: boolean;
};

function isValidIncidentAnalysis(value: unknown): value is IncidentAnalysis {
  if (!value || typeof value !== 'object') return false;

  const v = value as Record<string, unknown>;

  const validSeverity = ['low', 'medium', 'high', 'critical'].includes(String(v.severity));
  const validCategory = ['network', 'database', 'application', 'security', 'infrastructure', 'unknown'].includes(String(v.category));
  const validConfidence = ['low', 'medium', 'high'].includes(String(v.confidence));

  return (
    validSeverity &&
    validCategory &&
    typeof v.summary === 'string' &&
    typeof v.root_cause === 'string' &&
    Array.isArray(v.action_items) &&
    v.action_items.every(item => typeof item === 'string') &&
    validConfidence &&
    typeof v.needs_human_review === 'boolean'
  );
}

function applyHeuristicOverrides(log: string, analysis: IncidentAnalysis): IncidentAnalysis {
  const text = log.toLowerCase();
  const updated = { ...analysis };

  if (text.includes('enospc') || text.includes('no space left on device') || text.includes('disk full')) {
    updated.category = 'infrastructure';
    if (updated.severity === 'low' || updated.severity === 'medium') {
      updated.severity = 'high';
    }
    updated.confidence = 'high';
    updated.needs_human_review = false;
  }

  if (
    text.includes('oomkilled') ||
    text.includes('out of memory') ||
    text.includes('oom') ||
    text.includes('exit code 137')
  ) {
    updated.category = 'infrastructure';
    if (updated.severity === 'low' || updated.severity === 'medium') {
      updated.severity = 'high';
    }
    updated.confidence = 'high';
    updated.needs_human_review = false;
  }

  if (text.includes('crashloopbackoff') || text.includes('crash loop')) {
    updated.category = 'infrastructure';
    updated.severity = 'critical';
    updated.confidence = 'high';
    updated.needs_human_review = false;
  }

  if (text.includes('deadlock detected')) {
    updated.category = 'database';
    if (updated.severity === 'low' || updated.severity === 'medium') {
      updated.severity = 'high';
    }
    updated.confidence = 'high';
    updated.needs_human_review = false;
  }

  if (
    (text.includes('redis') ||
      text.includes('mongo') ||
      text.includes('postgres') ||
      text.includes('mysql')) &&
    text.includes('connection refused')
  ) {
    updated.category = 'database';
    if (updated.severity === 'low') {
      updated.severity = 'medium';
    }
  }

  if (
    text.includes('invalid api token') ||
    text.includes('accessdenied') ||
    text.includes('access denied') ||
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('permission denied')
  ) {
    updated.category = 'security';
  }

  if (text.includes('enotfound') || text.includes('dns')) {
    updated.category = 'network';
  }

  return updated;
}

function generateMarkdownReport(filename: string, analysis: IncidentAnalysis): string {
  const actions = analysis.action_items.map(item => `- ${item}`).join('\n');
  const reviewFlag = analysis.needs_human_review ? '**YES**' : 'no';

  return `# ${filename}

**Severity:** ${analysis.severity} | **Category:** ${analysis.category} | **Confidence:** ${analysis.confidence} | **Review:** ${reviewFlag}

**Summary:** ${analysis.summary}

**Cause:** ${analysis.root_cause}

**Actions:**
${actions}
`;
}

const HISTORY_FILE = 'data/history.json';

async function runDir(dir: string) {
  const files = await readdir(dir);
  const results = [];
  const timestamp = Date.now();

  for (const f of files) {
    if (!f.endsWith('.log')) continue;

    const fullPath = path.join(dir, f);
    const log = (await readFile(fullPath, 'utf-8')).trim();

    try {
      const analysis = await analyzeIncident(log);
      results.push({
        file: f,
        analysis,
      });

      const baseName = f.replace('.log', '');
      const mdReport = generateMarkdownReport(f, analysis);
      await mkdir('reports', { recursive: true });
      await writeFile(`reports/${baseName}-${timestamp}.md`, mdReport);

      console.log(`OK: ${f}`);
    } catch (e) {
      console.log(`FAIL: ${f}`);
    }
  }

  const jsonOut = `reports/run-${timestamp}.json`;
  await writeFile(jsonOut, JSON.stringify(results, null, 2));
  console.log(`Saved JSON report: ${jsonOut}`);
  console.log(`Saved ${results.length} markdown reports in reports/`);
}

async function ensureHistoryDir(): Promise<void> {
  try {
    await access('data', constants.F_OK);
  } catch {
    await mkdir('data', { recursive: true });
  }
}

type HistoryEntry = {
  timestamp: string;
  input: string;
  output: IncidentAnalysis;
};

async function saveHistory(input: string, output: IncidentAnalysis): Promise<void> {
  await ensureHistoryDir();

  const entry: HistoryEntry = {
    timestamp: new Date().toISOString(),
    input,
    output,
  };

  let history: HistoryEntry[] = [];

  try {
    await access(HISTORY_FILE, constants.F_OK);
    const data = await readFile(HISTORY_FILE, 'utf-8');
    history = JSON.parse(data) as HistoryEntry[];
    if (!Array.isArray(history)) {
      throw new Error('History file is not an array');
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      console.warn('Warning: history file was unreadable, starting fresh');
    }
    history = [];
  }

  history.push(entry);
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}
async function analyzeIncident(log: string): Promise<IncidentAnalysis> {
  const prompt = `Analyze this incident log and return valid JSON with exactly these fields:
{
  "severity": "low | medium | high | critical",
  "category": "network | database | application | security | infrastructure | unknown",
  "summary": "string",
  "root_cause": "string",
  "action_items": ["string"],
  "confidence": "low | medium | high",
  "needs_human_review": true
}

Category rules:
- security: authentication, authorization, invalid token, forbidden, permission denied
- database: connection refused, query failure, DB timeout, Mongo, Postgres, MySQL
- network: DNS, socket timeout, connection reset, unreachable host
- infrastructure: server down, container crash, disk full, memory pressure, deployment/platform issue, upstream, cache, edge nodes, runner, CI job, pipeline, pod/container/node, gateway, service unavailable
- application: internal app logic or generic application error not fitting other categories
- unknown: not enough evidence

Rules:
- Be concise.
- Do not invent facts not supported by the log.
- If uncertain, say so.
- If ambiguous, use category="unknown" or set needs_human_review=true.
- Return JSON only.

Severity guidance:
- low: minor issue, localized impact, no clear service degradation
- medium: partial failure, degraded behavior, transient or recoverable issue
- high: major functionality broken, important dependency unavailable, repeated failures likely
- critical: full outage, crash loop, disk full preventing operation, service cannot start, or severe production-wide impact

Needs human review guidance:
- If the incident involves infrastructure, CI/CD, cache, upstream, connection failures, or timeouts, prefer needs_human_review=true unless the root cause is explicitly confirmed in the log.
- Use confidence="high" and needs_human_review=false only when the log explicitly states the cause with clear evidence.
- When multiple symptoms appear (e.g., connection refused + timeout + pool exhaustion), set needs_human_review=true even if confidence is high.

Incident log: ${log}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You are an incident analysis expert. Respond only with valid JSON.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const parsed = JSON.parse(response.choices[0].message.content || '{}');

  if (!isValidIncidentAnalysis(parsed)) {
    throw new Error('Model returned invalid analysis schema');
  }

  const finalAnalysis = applyHeuristicOverrides(log, parsed);
  return finalAnalysis;
}

async function main() {
  const arg = process.argv[2];

  if (!arg) {
    console.error('Usage: npm start -- "<incident log>"');
    console.error('       npm start -- --file <path>');
    process.exit(1);
  }

  if (arg === '--dir') {
    const dir = process.argv[3];
    if (!dir) {
      console.error('Error: --dir requires a path');
      process.exit(1);
    }
    await runDir(dir);
    return;
  }

  let log: string;

  if (arg === '--file') {
    const filePath = process.argv[3];
    if (!filePath) {
      console.error('Error: --file requires a path argument');
      process.exit(1);
    }
    try {
      log = (await readFile(filePath, 'utf-8')).trim();
    } catch (error) {
      console.error('Error reading file:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    log = arg.trim();
  }

  try {
    const analysis = await analyzeIncident(log);
    await saveHistory(log, analysis);
    console.log(JSON.stringify(analysis, null, 2));
  } catch (error) {
    console.error('Analysis failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();