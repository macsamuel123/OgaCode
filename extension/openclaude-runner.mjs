#!/usr/bin/env node
/**
 * openclaude-runner.mjs
 * Thin Node.js wrapper around the @gitlawb/openclaude SDK.
 * Spawned by cli.ts for each agent task. Streams JSON lines to stdout.
 *
 * Usage:  node openclaude-runner.mjs "<task>" "<cwd>"
 *
 * Event JSON lines:
 *   { type: "pre_tool_use",  tool: string, args: object }
 *   { type: "post_tool_use", success: bool, output: string, error: string }
 *   { type: "complete",      success: bool, msg: string, files: string[] }
 *   { type: "error",         msg: string }
 */

import { execSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';

const task = process.argv[2];
const cwd  = process.argv[3];

if (!task || !cwd) {
  process.stderr.write('Usage: node openclaude-runner.mjs "<task>" "<cwd>"\n');
  process.exit(1);
}

// ── Provider override: prefer DeepSeek → Groq → fallback to whatever OpenClaude has ──
// Must be set BEFORE importing the SDK (it reads env at load time).
if (process.env.DEEPSEEK_API_KEY) {
  process.env.CLAUDE_CODE_USE_OPENAI = 'true';
  process.env.OPENAI_API_KEY = process.env.DEEPSEEK_API_KEY;
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1';
  process.env.OPENAI_MODEL = process.env.OPENAI_MODEL || 'deepseek-chat';
} else if (process.env.GROQ_API_KEY) {
  process.env.CLAUDE_CODE_USE_OPENAI = 'true';
  process.env.OPENAI_API_KEY = process.env.GROQ_API_KEY;
  process.env.OPENAI_BASE_URL = 'https://api.groq.com/openai/v1';
  process.env.OPENAI_MODEL = process.env.OPENAI_MODEL || 'moonshotai/kimi-k2-instruct';
}

// ── Locate the SDK in global npm modules ─────────────────────────────────────
let sdkPath;
try {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  sdkPath = path.join(globalRoot, '@gitlawb', 'openclaude', 'dist', 'sdk.mjs');
} catch {
  process.stderr.write('npm not found in PATH\n');
  process.exit(1);
}

let query;
try {
  const sdk = await import(pathToFileURL(sdkPath).href);
  query = sdk.query;
} catch (e) {
  process.stderr.write(
    `Cannot load @gitlawb/openclaude SDK from ${sdkPath}\n` +
    `Install it first: npm install -g @gitlawb/openclaude\n` +
    `Error: ${e.message}\n`
  );
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function textOf(content) {
  if (typeof content === 'string') { return content; }
  if (Array.isArray(content)) {
    return content
      .map(b => (typeof b === 'string' ? b : (b.text ?? JSON.stringify(b))))
      .join('');
  }
  return JSON.stringify(content);
}

// ── Run agent ─────────────────────────────────────────────────────────────────
try {
  const q = query({
    prompt: task,
    options: {
      cwd,
      permissionMode: 'auto-accept',
      canUseTool: async (_name, _input) => ({ behavior: 'allow' }),
    },
  });

  for await (const msg of q) {
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_use') {
          emit({ type: 'pre_tool_use', tool: block.name, args: block.input ?? {} });
        }
      }

    } else if (msg.type === 'user' && msg.isSynthetic) {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_result') {
          const output = textOf(block.content).slice(0, 500);
          emit({
            type: 'post_tool_use',
            success: !block.is_error,
            output: block.is_error ? '' : output,
            error:  block.is_error ? output : '',
          });
        }
      }

    } else if (msg.type === 'result') {
      emit({
        type: 'complete',
        success: msg.subtype === 'success' && !msg.is_error,
        msg: (msg.result ?? msg.error ?? 'Done').trim(),
        files: [],
      });
      // result is always the last message — exit cleanly
    }
  }

} catch (e) {
  emit({ type: 'error', msg: e.message ?? String(e) });
  process.exit(1);
}
