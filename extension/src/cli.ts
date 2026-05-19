import { spawn, execSync } from 'child_process';
import * as path from 'path';

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  files: string[];
}

// openclaude-runner.mjs lives next to this file's compiled output (dist/)
// __dirname = extension/dist at runtime
const RUNNER = path.join(__dirname, '..', 'openclaude-runner.mjs');

/** Read a key from the Python keychain (ogacode service). Returns empty string on failure. */
function readKeychain(keyName: string): string {
  try {
    const out = execSync(
      `python -c "import keyring; v=keyring.get_password('ogacode','${keyName}'); print(v or '')"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return out;
  } catch {
    return '';
  }
}

/**
 * Spawns openclaude-runner.mjs which uses the @gitlawb/openclaude SDK.
 * Passes DeepSeek/Groq API keys from the OS keychain so the runner
 * can override OpenClaude's default Anthropic provider.
 * Requires: npm install -g @gitlawb/openclaude
 */
export function runAgent(
  task: string,
  cwd: string,
  onEvent: (evt: AgentEvent) => void,
): Promise<AgentResult> {
  // Build env with provider keys so openclaude-runner can pick the right LLM
  const deepseekKey = readKeychain('deepseek_api_key');
  const groqKey     = readKeychain('groq_api_key');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(deepseekKey ? { DEEPSEEK_API_KEY: deepseekKey } : {}),
    ...(groqKey     ? { GROQ_API_KEY: groqKey }         : {}),
  };

  return new Promise((resolve, reject) => {
    const proc = spawn('node', [RUNNER, task, cwd], {
      cwd,
      env,
      windowsHide: true,
    });

    let buffer = '';
    let result: AgentResult = { success: false, summary: '', files: [] };

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
          const evt = JSON.parse(trimmed) as AgentEvent & { files?: string[] };
          if (evt.type === 'complete') {
            result = {
              success: (evt['success'] as boolean) ?? true,
              summary: (evt['msg'] as string) ?? '',
              files: (evt['files'] as string[]) ?? [],
            };
          } else if (evt.type === 'error') {
            reject(new Error((evt['msg'] as string) ?? 'Unknown error'));
          } else {
            onEvent(evt);
          }
        } catch { /* non-JSON line, skip */ }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString('utf8').trim();
      if (msg) { onEvent({ type: 'correction', msg }); }
    });

    proc.on('close', (code) => {
      if (result.summary) {
        resolve(result);
      } else if (code !== 0) {
        reject(new Error(
          `openclaude-runner exited ${code ?? '?'}\n` +
          'Make sure @gitlawb/openclaude is installed: npm install -g @gitlawb/openclaude'
        ));
      } else {
        resolve(result);
      }
    });

    proc.on('error', () => {
      reject(new Error(
        'Cannot start Node.js. Make sure Node.js is installed and in PATH.'
      ));
    });
  });
}
