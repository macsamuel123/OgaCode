import { spawn, execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

let _keychainCheck: { ok: boolean; msg: string } | null = null;

/**
 * Pre-flight: verify Python + ogacode package are reachable before spawning.
 * Result is cached for the session so repeated calls are free.
 */
export function checkKeychainSetup(): { ok: boolean; msg: string } {
  if (_keychainCheck !== null) { return _keychainCheck; }

  try {
    execSync('python --version', { timeout: 3000, stdio: 'pipe' });
  } catch {
    _keychainCheck = {
      ok: false,
      msg: 'Python not found in PATH. Install Python 3.10+ and run "pip install -e path/to/ogacode/cli".',
    };
    return _keychainCheck;
  }

  try {
    execSync('python -c "import ogacode"', { timeout: 5000, stdio: 'pipe' });
  } catch {
    _keychainCheck = {
      ok: false,
      msg: 'OgaCode Python package not found. Run: pip install -e "C:\\Users\\User\\OgaCode\\cli"',
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

export interface PlanComponent {
  name: string;
  files: string[];
  dependencies: string[];
  description: string;
}

export interface PlanStepDetail {
  action: string;
  files: string[];
  verification: string;
}

export interface PlanResult {
  summary: string;
  steps: string[];
  components: PlanComponent[];
  stepDetails: PlanStepDetail[];
  isDefault: boolean;
}

/**
 * Generates a plan for the task without executing it.
 * Returns null on failure so callers can fall through to direct execution.
 */
export function getPlan(
  task: string,
  cwd: string,
  serverUrl?: string,
  token?: string,
): Promise<PlanResult | null> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (serverUrl) { env['OGACODE_SERVER_URL'] = serverUrl; }
  if (token)     { env['OGACODE_TOKEN']      = token; }

  const taskFile = path.join(tmpdir(), `ogacode-plan-${Date.now()}.txt`);
  writeFileSync(taskFile, task, 'utf8');

  return new Promise((resolve) => {
    const proc = spawn(
      'python', ['-m', 'ogacode.cli', '--plan-only', '--task-file', taskFile],
      { cwd, env, windowsHide: true },
    );

    const timeout = setTimeout(() => { proc.kill(); resolve(null); }, 60000);
    let buffer = '';
    let stderrBuf = '';

    proc.stdout.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });

    proc.on('close', () => {
      clearTimeout(timeout);
      try { unlinkSync(taskFile); } catch { /* ignore */ }
      if (stderrBuf.trim()) {
        console.error('[OgaCode getPlan] stderr:', stderrBuf.trim().slice(0, 500));
      }
      for (const line of buffer.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
          const evt = JSON.parse(trimmed) as {
            type: string; summary?: string; steps?: string[];
            components?: PlanComponent[]; step_details?: PlanStepDetail[]; is_default?: boolean;
          };
          if (evt.type === 'plan' && evt.summary && evt.steps) {
            resolve({
              summary: evt.summary,
              steps: evt.steps,
              components: evt.components ?? [],
              stepDetails: evt.step_details ?? [],
              isDefault: evt.is_default ?? false,
            });
            return;
          }
        } catch { /* skip non-JSON */ }
      }
      resolve(null);
    });

    proc.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

/** Read a key from the Python keychain (ogacode service). Returns empty string on failure. */
export function readKeychain(keyName: string): string {
  const safeKey = keyName.replace(/'/g, "'\\''");
  try {
    const out = execSync(
      `python -c "import keyring; v=keyring.get_password('ogacode','${safeKey}'); print(v or '')"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[OgaCode] keychain read failed for '${keyName}': ${msg}`);
    return '';
  }
}

export interface PlanThenRunHandle {
  plan: Promise<PlanResult>;
  approve: (steps?: string[]) => Promise<AgentResult>;
  reject: () => void;
  abort: () => void;
}

export function planThenRun(
  task: string,
  cwd: string,
  serverUrl: string,
  token: string,
  onEvent: (evt: AgentEvent) => void,
  signal?: AbortSignal,
): PlanThenRunHandle {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['OGACODE_SERVER_URL'] = serverUrl;
  env['OGACODE_TOKEN']      = token;

  const taskFile = path.join(tmpdir(), `ogacode-merge-${Date.now()}.txt`);
  writeFileSync(taskFile, task, 'utf8');

  const proc = spawn(
    'python', ['-m', 'ogacode.cli', '--merge', '--task-file', taskFile],
    { cwd, env, windowsHide: true },
  );

  let stdoutBuffer = '';
  let stderrLog = '';
  let planResolve!: (value: PlanResult) => void;
  let executeResolve!: (value: AgentResult) => void;
  let executeReject!: (reason: Error) => void;
  let planRejected = false;

  const planPromise = new Promise<PlanResult>((resolve) => {
    planResolve = resolve;
  });

  const abort = () => {
    proc.kill('SIGTERM');
    try { unlinkSync(taskFile); } catch { /* ignore */ }
  };

  if (signal) {
    signal.addEventListener('abort', abort, { once: true });
  }

  let planParsed = false;

  proc.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const evt = JSON.parse(trimmed) as Record<string, unknown>;
        if (evt.type === 'plan' && !planParsed) {
          planParsed = true;
          planResolve({
            summary: (evt['summary'] as string) ?? '',
            steps: (evt['steps'] as string[]) ?? [],
            components: (evt['components'] as PlanComponent[]) ?? [],
            stepDetails: (evt['step_details'] as PlanStepDetail[]) ?? [],
            isDefault: (evt['is_default'] as boolean) ?? false,
          });
        } else if (evt.type === 'complete') {
          if (executeResolve) {
            executeResolve({
              success: (evt['success'] as boolean) ?? true,
              summary: (evt['msg'] as string) ?? '',
              files: (evt['files'] as string[]) ?? [],
            });
          }
        } else if (evt.type === 'error') {
          if (executeReject) {
            executeReject(new Error((evt['msg'] as string) ?? 'Unknown error'));
          }
        } else if (evt.type === 'cancelled') {
          if (executeReject && !planRejected) {
            executeReject(new Error('Task cancelled by user.'));
          }
        } else if (evt.type !== 'plan') {
          onEvent(evt as AgentEvent);
        }
      } catch { /* non-JSON line, skip */ }
    }
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    const msg = chunk.toString('utf8').trim();
    if (msg) {
      stderrLog += msg + '\n';
      if (/error|traceback|exception|fail|warning/i.test(msg)) {
        onEvent({ type: 'correction', msg });
      }
    }
  });

  proc.on('close', (code) => {
    try { unlinkSync(taskFile); } catch { /* ignore */ }
    if (!planParsed) {
      const detail = stderrLog.trim().slice(0, 300);
      const errMsg = code !== 0 && detail
        ? `Process exited with code ${code}: ${detail}`
        : 'Failed to generate plan. Check your OgaCode token and server URL.';
      planResolve({
        summary: `Error: ${errMsg}`,
        steps: ['Plan generation failed.'],
        components: [], stepDetails: [], isDefault: true,
      });
    }
  });

  proc.on('error', (err) => {
    try { unlinkSync(taskFile); } catch { /* ignore */ }
    planResolve({
      summary: `Error: ${err.message}`,
      steps: ['Failed to start OgaCode.'],
      components: [], stepDetails: [], isDefault: true,
    });
  });

  const approve = (steps?: string[]): Promise<AgentResult> => {
    return new Promise((resolve, reject) => {
      executeResolve = resolve;
      executeReject = reject;
      const approval: Record<string, unknown> = { action: 'approve' };
      if (steps && steps.length > 0) { approval.steps = steps; }
      proc.stdin.write(JSON.stringify(approval) + '\n');
    });
  };

  const reject = () => {
    planRejected = true;
    proc.stdin.write(JSON.stringify({ action: 'reject' }) + '\n');
    setTimeout(() => {
      try { proc.kill(); } catch { /* already dead */ }
      try { unlinkSync(taskFile); } catch { /* ignore */ }
    }, 2000);
  };

  return { plan: planPromise, approve, reject, abort };
}

/**
 * Spawns the OgaCode Python CLI as a subprocess.
 * Passes OGACODE_SERVER_URL + OGACODE_TOKEN so the CLI routes through the managed server.
 */
function friendlyError(msg: string): string {
  if (/timed?\s*out|warming up/i.test(msg))      { return 'OgaCode is warming up — please wait 30 seconds and try again.'; }
  if (/node.*not found|cannot start node/i.test(msg)) { return 'Node.js not found. Install it from nodejs.org and restart VS Code.'; }
  if (/python.*not found|cannot start python/i.test(msg)) { return 'Python not found. Install Python 3.10+ and restart VS Code.'; }
  if (/exited with code/i.test(msg))             { return 'The agent crashed unexpectedly. Try a simpler task or run "ogacode doctor".'; }
  if (/ECONNREFUSED|network|connection/i.test(msg)) { return "OgaCode's servers are temporarily busy. Check your connection and try again."; }
  return msg;
}

export function runAgent(
  task: string,
  cwd: string,
  onEvent: (evt: AgentEvent) => void,
  signal?: AbortSignal,
  serverUrl?: string,
  token?: string,
  _retryCount = 0,
): Promise<AgentResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (serverUrl) { env['OGACODE_SERVER_URL'] = serverUrl; }
  if (token)     { env['OGACODE_TOKEN']      = token; }

  // Write task to a temp file to avoid OS arg length limits on long enriched prompts
  const taskFile = path.join(tmpdir(), `ogacode-${Date.now()}.txt`);
  writeFileSync(taskFile, task, 'utf8');

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'python', ['-m', 'ogacode.cli', '--stream', '--task-file', taskFile],
      { cwd, env, windowsHide: true },
    );

    if (signal) {
      signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
        resolve({ success: false, summary: 'Interrupted by user.', files: [] });
      }, { once: true });
    }

    // Kill and retry once after 60s of silence (no stdout activity)
    const resetSilenceTimer = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        proc.kill();
        if (_retryCount === 0) {
          onEvent({ type: 'correction', msg: 'Agent timed out — retrying…' });
          runAgent(task, cwd, onEvent, signal, serverUrl, token, 1).then(resolve).catch(reject);
        } else {
          reject(new Error('OgaCode is warming up — please wait 30 seconds and try again.'));
        }
      }, 60_000);
    };
    let silenceTimer: ReturnType<typeof setTimeout>;
    resetSilenceTimer();

    let buffer = '';
    let stderrLog = '';
    let result: AgentResult = { success: false, summary: '', files: [] };

    proc.stdout.on('data', (chunk: Buffer) => {
      resetSilenceTimer();
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
        } catch { /* non-JSON line from Python startup, skip */ }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString('utf8').trim();
      if (msg) {
        stderrLog += msg + '\n';
        onEvent({ type: 'correction', msg });
      }
    });

    proc.on('close', (code) => {
      clearTimeout(silenceTimer);
      try { unlinkSync(taskFile); } catch { /* ignore cleanup failure */ }
      if (result.summary) {
        resolve(result);
      } else if (code !== 0) {
        const detail = stderrLog.trim().slice(0, 300);
        const hint = detail ? `\n\nDetails: ${detail}` : ' Run "pip install -e C:\\Users\\User\\OgaCode\\cli" to install OgaCode.';
        reject(new Error(friendlyError(`OgaCode exited with code ${code ?? '?'}.${hint}`)));
      } else {
        resolve(result);
      }
    });

    proc.on('error', () => {
      clearTimeout(silenceTimer);
      reject(new Error(
        'Python not found. Install Python 3.10+ from python.org and restart VS Code.'
      ));
    });
  });
}
