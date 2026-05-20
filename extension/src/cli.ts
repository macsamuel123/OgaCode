import { spawn, execSync } from 'child_process';
import * as path from 'path';

let _keychainCheck: { ok: boolean; msg: string } | null = null;

/**
 * Pre-flight: verify Python + keyring are reachable before spawning the runner.
 * Skipped entirely when managed server URL is configured, or when API keys are already in env.
 * Result is cached for the session so repeated calls are free.
 */
export function checkKeychainSetup(serverUrl?: string): { ok: boolean; msg: string } {
  if (serverUrl) { return { ok: true, msg: '' }; }
  if (process.env['DEEPSEEK_API_KEY'] || process.env['GROQ_API_KEY']) {
    return { ok: true, msg: '' };
  }
  if (_keychainCheck !== null) { return _keychainCheck; }

  try {
    execSync('python --version', { timeout: 3000, stdio: 'pipe' });
  } catch {
    _keychainCheck = {
      ok: false,
      msg: 'Python not found in PATH. Install Python and run "ogacode setup" to store your API key, or set DEEPSEEK_API_KEY / GROQ_API_KEY in your environment.',
    };
    return _keychainCheck;
  }

  try {
    execSync('python -c "import keyring"', { timeout: 3000, stdio: 'pipe' });
  } catch {
    _keychainCheck = {
      ok: false,
      msg: '"keyring" package not installed. Run: pip install keyring',
    };
    return _keychainCheck;
  }

  _keychainCheck = { ok: true, msg: '' };
  return _keychainCheck;
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  files: string[];
}

// runner.mjs lives next to this file's compiled output (dist/)
// __dirname = extension/dist at runtime
const RUNNER = path.join(__dirname, '..', 'runner.mjs');

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
 * Spawns runner.mjs which wraps the OgaCode engine SDK.
 * In managed mode (serverUrl set), passes OGACODE_SERVER_URL + OGACODE_TOKEN.
 * In BYO mode, reads DeepSeek/Groq keys from the OS keychain.
 */
export function runAgent(
  task: string,
  cwd: string,
  onEvent: (evt: AgentEvent) => void,
  signal?: AbortSignal,
  serverUrl?: string,
  token?: string,
): Promise<AgentResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (serverUrl) {
    env['OGACODE_SERVER_URL'] = serverUrl;
    if (token) { env['OGACODE_TOKEN'] = token; }
  } else {
    const deepseekKey = readKeychain('deepseek_api_key');
    const groqKey     = readKeychain('groq_api_key');
    if (deepseekKey) { env['DEEPSEEK_API_KEY'] = deepseekKey; }
    if (groqKey)     { env['GROQ_API_KEY']     = groqKey; }
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('node', [RUNNER, task, cwd], {
      cwd,
      env,
      windowsHide: true,
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
        resolve({ success: false, summary: 'Interrupted by user.', files: [] });
      }, { once: true });
    }

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
        reject(new Error(`OgaCode engine exited with code ${code ?? '?'}. See ONBOARDING.md for setup steps.`));
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
