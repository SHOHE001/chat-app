import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { runModerationCycle } from './moderation.js';

const execFileAsync = promisify(execFile);

function positiveNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function createClaudeInvoker({
  claudeBin = process.env.CLAUDE_BIN || 'claude',
  haikuBudget = positiveNumber('MODERATION_HAIKU_BUDGET_USD', 0.10),
  opusBudget = positiveNumber('MODERATION_OPUS_BUDGET_USD', 0.75),
  timeoutMs = positiveNumber('MODERATION_TIMEOUT_MS', 10 * 60 * 1000),
} = {}) {
  return async (model, schema, prompt) => {
    const budget = model === 'haiku' ? haikuBudget : opusBudget;
    const { stdout } = await execFileAsync(claudeBin, [
      '-p', '--model', model, '--safe-mode', '--tools', '',
      '--no-session-persistence', '--max-budget-usd', String(budget),
      '--output-format', 'json', '--json-schema', JSON.stringify(schema), prompt,
    ], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    });
    const envelope = JSON.parse(stdout);
    const result = envelope.structured_output ??
      (typeof envelope.result === 'string' ? JSON.parse(envelope.result) : envelope.result);
    if (!result || typeof result !== 'object') throw new Error(`${model} returned no structured output`);
    return result;
  };
}

export async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dbPath = path.resolve(root, process.env.DB_PATH || 'data/chat.db');
  const db = openDb(dbPath);
  try {
    const batchSize = Math.floor(positiveNumber('MODERATION_BATCH_SIZE', 50));
    const strikeThreshold = Math.floor(positiveNumber('MODERATION_STRIKE_THRESHOLD', 3));
    const maxOpusCalls = Math.floor(positiveNumber('MODERATION_MAX_OPUS_CALLS', 10));
    const strikeWindowMs = positiveNumber('MODERATION_STRIKE_WINDOW_DAYS', 30) * 86400000;
    const stats = await runModerationCycle({
      db, invokeModel: createClaudeInvoker(), batchSize, strikeThreshold, strikeWindowMs, maxOpusCalls,
    });
    console.log(JSON.stringify({ event: 'moderation_cycle_complete', ...stats }));
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'moderation_cycle_failed',
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
