import { spawn } from 'child_process';

export interface AgentEvent {
  type: string;
  [key: string]: unknown;  // index signature so it's assignable to Record<string, unknown>
}

export interface AgentResult {
  success: boolean;
  summary: string;
  files: string[];
}

/**
 * Spawns `ogacode --json <task>` in the given directory and streams events.
 * The CLI writes files directly to disk; this just surfaces progress to the UI.
 */
export function runAgent(
  task: string,
  cwd: string,
  onEvent: (evt: AgentEvent) => void,
): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ogacode', ['--json', task], {
      cwd,
      shell: true,
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
        } catch { /* non-JSON startup line from rich, skip */ }
      }
    });

    proc.on('close', (code) => {
      if (result.summary) {
        resolve(result);
      } else if (code !== 0) {
        reject(new Error(`ogacode exited ${code ?? '?'} — run ogacode doctor to check connectivity`));
      } else {
        resolve(result);
      }
    });

    proc.on('error', () => {
      reject(new Error('Cannot find ogacode. Make sure it is installed: pip install -e . (in the cli folder)'));
    });
  });
}
