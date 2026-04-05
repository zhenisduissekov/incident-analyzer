#!/usr/bin/env node
import 'dotenv/config';
import { OpenAI } from 'openai';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Types
type Severity = 'low' | 'medium' | 'high' | 'critical';
type Category = 'network' | 'database' | 'application' | 'security' | 'infrastructure' | 'unknown';
type Confidence = 'low' | 'medium' | 'high';

interface IncidentAnalysis {
  severity: Severity;
  category: Category;
  summary: string;
  root_cause: string;
  action_items: string[];
  confidence: Confidence;
  needs_human_review: boolean;
}

interface EvalCase {
  name: string;
  file: string;
  expected: {
    severity: Severity;
    category: Category;
    confidence: Confidence;
    needs_human_review: boolean;
  };
}

interface EvalResult {
  name: string;
  file: string;
  passed: boolean;
  actual: IncidentAnalysis;
  expected: EvalCase['expected'];
  mismatchedFields: string[];
  log: string;
}

interface RegressionReport {
  timestamp: string;
  totalCases: number;
  passed: number;
  failed: number;
  passRate: string;
  results: EvalResult[];
  summary: {
    byCategory: Record<string, { passed: number; failed: number }>;
    bySeverity: Record<string, { passed: number; failed: number }>;
  };
}

// Validation
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

// Heuristic overrides (same as index.ts)
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

// LLM Analysis
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

// Comparison logic
function compareResult(actual: IncidentAnalysis, expected: EvalCase['expected']): { passed: boolean; mismatchedFields: string[] } {
  const checks = {
    severity: actual.severity === expected.severity,
    category: actual.category === expected.category,
    confidence: actual.confidence === expected.confidence,
    needs_human_review: actual.needs_human_review === expected.needs_human_review,
  };

  const mismatchedFields = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([field]) => field);

  return {
    passed: mismatchedFields.length === 0,
    mismatchedFields,
  };
}

// Run evaluation
async function runEvaluation(casesPath: string): Promise<RegressionReport> {
  if (!existsSync(casesPath)) {
    throw new Error(`Cases file not found: ${casesPath}`);
  }

  const raw = await readFile(casesPath, 'utf-8');
  const cases = JSON.parse(raw) as EvalCase[];

  const results: EvalResult[] = [];
  let passed = 0;

  const summary = {
    byCategory: {} as Record<string, { passed: number; failed: number }>,
    bySeverity: {} as Record<string, { passed: number; failed: number }>,
  };

  for (const testCase of cases) {
    const log = (await readFile(testCase.file, 'utf-8')).trim();
    
    try {
      const actual = await analyzeIncident(log);
      const comparison = compareResult(actual, testCase.expected);

      if (comparison.passed) {
        passed++;
      }

      // Update summary stats
      const cat = actual.category;
      if (!summary.byCategory[cat]) {
        summary.byCategory[cat] = { passed: 0, failed: 0 };
      }
      if (comparison.passed) {
        summary.byCategory[cat].passed++;
      } else {
        summary.byCategory[cat].failed++;
      }

      const sev = actual.severity;
      if (!summary.bySeverity[sev]) {
        summary.bySeverity[sev] = { passed: 0, failed: 0 };
      }
      if (comparison.passed) {
        summary.bySeverity[sev].passed++;
      } else {
        summary.bySeverity[sev].failed++;
      }

      results.push({
        name: testCase.name,
        file: testCase.file,
        passed: comparison.passed,
        actual,
        expected: testCase.expected,
        mismatchedFields: comparison.mismatchedFields,
        log: log.substring(0, 200) + (log.length > 200 ? '...' : ''),
      });

      console.log(`${comparison.passed ? '✓' : '✗'} ${testCase.name}`);
    } catch (error) {
      console.error(`✗ ${testCase.name} — Error: ${error instanceof Error ? error.message : error}`);
      results.push({
        name: testCase.name,
        file: testCase.file,
        passed: false,
        actual: {} as IncidentAnalysis,
        expected: testCase.expected,
        mismatchedFields: ['error'],
        log: log.substring(0, 200) + (log.length > 200 ? '...' : ''),
      });
    }
  }

  const report: RegressionReport = {
    timestamp: new Date().toISOString(),
    totalCases: cases.length,
    passed,
    failed: cases.length - passed,
    passRate: `${((passed / cases.length) * 100).toFixed(1)}%`,
    results,
    summary,
  };

  return report;
}

// Generate markdown report
function generateMarkdownReport(report: RegressionReport): string {
  const lines: string[] = [
    '# LLM Evaluation Report',
    '',
    `**Generated:** ${report.timestamp}`,
    '',
    '## Summary',
    '',
    `- **Total cases:** ${report.totalCases}`,
    `- **Passed:** ${report.passed}`,
    `- **Failed:** ${report.failed}`,
    `- **Pass rate:** ${report.passRate}`,
    '',
    '## Results by Category',
    '',
    '| Category | Passed | Failed | Rate |',
    '|----------|--------|--------|------|',
  ];

  for (const [cat, stats] of Object.entries(report.summary.byCategory)) {
    const rate = ((stats.passed / (stats.passed + stats.failed)) * 100).toFixed(1);
    lines.push(`| ${cat} | ${stats.passed} | ${stats.failed} | ${rate}% |`);
  }

  lines.push('', '## Detailed Results', '');

  for (const result of report.results) {
    const status = result.passed ? '✓ PASS' : '✗ FAIL';
    lines.push(`### ${result.name} — ${status}`, '');
    
    if (!result.passed && result.mismatchedFields.includes('error')) {
      lines.push('**Error:** Analysis failed', '');
    } else if (!result.passed) {
      lines.push('**Mismatched fields:**', '');
      for (const field of result.mismatchedFields) {
        const actualValue = field === 'severity' ? result.actual.severity :
                           field === 'category' ? result.actual.category :
                           field === 'confidence' ? result.actual.confidence :
                           field === 'needs_human_review' ? String(result.actual.needs_human_review) :
                           'unknown';
        const expectedValue = field === 'severity' ? result.expected.severity :
                             field === 'category' ? result.expected.category :
                             field === 'confidence' ? result.expected.confidence :
                             field === 'needs_human_review' ? String(result.expected.needs_human_review) :
                             'unknown';
        lines.push(`- ${field}: expected "${expectedValue}", got "${actualValue}"`);
      }
      lines.push('');
    }

    lines.push('**Log snippet:**', '```', result.log, '```', '');
  }

  lines.push('---', '*Generated by LLM Evaluator*');
  return lines.join('\n');
}

// Save reports
async function saveReports(report: RegressionReport): Promise<void> {
  await mkdir('eval-reports', { recursive: true });
  
  const timestamp = Date.now();
  const jsonPath = `eval-reports/report-${timestamp}.json`;
  const mdPath = `eval-reports/report-${timestamp}.md`;

  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(mdPath, generateMarkdownReport(report));

  console.log(`\nSaved reports:`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);
}

// CLI
async function main() {
  const casesPath = process.argv[2] || 'data/eval-cases.json';

  console.log(`Running evaluation: ${casesPath}\n`);

  try {
    const report = await runEvaluation(casesPath);
    
    console.log('\n--- Summary ---');
    console.log(`Total: ${report.totalCases}`);
    console.log(`Passed: ${report.passed}`);
    console.log(`Failed: ${report.failed}`);
    console.log(`Pass rate: ${report.passRate}`);

    await saveReports(report);

    // Exit with error code if any failures
    if (report.failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Evaluation failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
