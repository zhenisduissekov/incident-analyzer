import 'dotenv/config';
import OpenAI from 'openai';
import { readFile } from 'fs/promises';

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

type EvalCase = {
  name: string;
  file: string;
  expected: {
    severity: IncidentAnalysis['severity'];
    category: IncidentAnalysis['category'];
    confidence: IncidentAnalysis['confidence'];
    needs_human_review: boolean;
  };
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
    v.summary.trim().length > 0 &&
    typeof v.root_cause === 'string' &&
    v.root_cause.trim().length > 0 &&
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
- infrastructure: server down, container crash, disk full, memory pressure, deployment/platform issue
- application: internal app logic or generic application error not fitting other categories
- unknown: not enough evidence

Rules:
- Be concise.
- Do not invent facts not supported by the log.
- If uncertain, say so.
- If ambiguous, use category="unknown" or set needs_human_review=true.
- Return JSON only.

Confidence and review rules:
- Use confidence="high" only when the log strongly and directly indicates the root cause.
- If multiple plausible causes exist, use confidence="medium" or "low".
- Set needs_human_review=true when the error suggests multiple plausible explanations.
- For connection refused, timeout, unreachable host, or similar infrastructure/database/network symptoms, prefer needs_human_review=true unless the root cause is explicit.

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

function compareCase(actual: IncidentAnalysis, expected: EvalCase['expected']) {
  const checks = {
    severity: actual.severity === expected.severity,
    category: actual.category === expected.category,
    confidence: actual.confidence === expected.confidence,
    needs_human_review: actual.needs_human_review === expected.needs_human_review,
  };

  const matchedFields = Object.entries(checks)
    .filter(([, ok]) => ok)
    .map(([field]) => field);

  const mismatchedFields = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([field]) => field);

  return {
    checks,
    matchedFields,
    mismatchedFields,
    fieldScore: `${matchedFields.length}/4`,
  };
}

async function main() {
  const raw = await readFile('data/eval-cases.json', 'utf-8');
  const cases = JSON.parse(raw) as EvalCase[];

  let passed = 0;
  const fieldTotals = {
    severity: 0,
    category: 0,
    confidence: 0,
    needs_human_review: 0,
  };

  for (const testCase of cases) {
    const log = (await readFile(testCase.file, 'utf-8')).trim();
    const actual = await analyzeIncident(log);
    const result = compareCase(actual, testCase.expected);

    const casePassed = result.mismatchedFields.length === 0;
    if (casePassed) {
      passed += 1;
    }

    fieldTotals.severity += result.checks.severity ? 1 : 0;
    fieldTotals.category += result.checks.category ? 1 : 0;
    fieldTotals.confidence += result.checks.confidence ? 1 : 0;
    fieldTotals.needs_human_review += result.checks.needs_human_review ? 1 : 0;

    console.log(`\n=== ${testCase.name} ===`);
    console.log('Log:', log);
    console.log(`PASS: ${casePassed ? 'yes' : 'no'}`);
    console.log('Expected:', testCase.expected);
    console.log('Actual:', {
      severity: actual.severity,
      category: actual.category,
      confidence: actual.confidence,
      needs_human_review: actual.needs_human_review,
    });
    console.log('Field score:', result.fieldScore);
    if (result.mismatchedFields.length > 0) {
      console.log('Mismatched fields:', result.mismatchedFields);
    }
    console.log('Checks:', result.checks);
  }

  console.log(`\nSummary: ${passed}/${cases.length} cases passed`);
  console.log('Field accuracy:', {
    severity: `${fieldTotals.severity}/${cases.length}`,
    category: `${fieldTotals.category}/${cases.length}`,
    confidence: `${fieldTotals.confidence}/${cases.length}`,
    needs_human_review: `${fieldTotals.needs_human_review}/${cases.length}`,
  });
}

main().catch((error) => {
  console.error('Eval failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});