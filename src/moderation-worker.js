import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { runModerationCycle } from './moderation.js';

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
    const args = [
      '-p', '--model', model, '--safe-mode', '--tools', '',
      '--no-session-persistence', '--max-budget-usd', String(budget),
      '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    ];
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(claudeBin, args, {
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks = [];
      let size = 0;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(`${model} moderation timed out`));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          child.kill('SIGKILL');
          finish(new Error(`${model} moderation output exceeded the limit`));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.resume();
      child.on('error', () => finish(new Error(`could not start ${model} moderation`)));
      child.on('close', (code) => {
        if (code !== 0) {
          finish(new Error(`${model} moderation failed with exit code ${code}`));
          return;
        }
        finish(null, Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
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
