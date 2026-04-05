# Changelog: Incident Analyzer CLI

## Initial Setup
- Created single-file TypeScript CLI (`index.ts`) with `openai` and `dotenv` dependencies
- Set up `package.json` with `tsx` for running TypeScript

## User Improvements
- Added explicit API key validation check at startup
- Wrapped execution logic in `main()` function

## Prompt Engineering
- Expanded schema from 5 to 7 fields: added `confidence` and `needs_human_review`
- Switched from bullet list to JSON example format for clearer structure
- Added explicit category rules to prevent free-form guessing:
  - `security`: authentication, authorization, invalid token, forbidden, permission denied
  - `database`: connection refused, query failure, DB timeout, Mongo, Postgres, MySQL
  - `network`: DNS, socket timeout, connection reset, unreachable host
  - `infrastructure`: server down, container crash, disk full, memory pressure, deployment/platform issue
  - `application`: internal app logic or generic application error not fitting other categories
  - `unknown`: not enough evidence
- Lowered `temperature` from 0.3 to 0 for deterministic output

## Type Safety & Validation
- Added `IncidentAnalysis` TypeScript type with literal unions
- Added `isValidIncidentAnalysis()` type guard function
- Replaced `as IncidentAnalysis` cast with runtime validation:
  ```typescript
  const parsed = JSON.parse(response.choices[0].message.content || '{}');
  if (!isValidIncidentAnalysis(parsed)) {
    throw new Error('Model returned invalid analysis schema');
  }
  return parsed;
  ```

## Fixes
- Updated usage message from `ts-node` to `tsx` (correct runner)

## Final Architecture
Single `index.ts` (~110 lines) containing:
- Imports (dotenv, openai)
- Environment validation
- `IncidentAnalysis` type definition
- `isValidIncidentAnalysis()` validation helper
- OpenAI client initialization
- `analyzeIncident()` function with structured prompt
- `main()` CLI entry point
