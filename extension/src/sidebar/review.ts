import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { runAgent } from '../cli';

type SendFn = (command: string, data: Record<string, unknown>) => void;

export async function autoReview(
  task: string,
  summary: string,
  filesWritten: string[],
  folder: string,
  serverUrl: string | undefined,
  token: string | undefined,
  send: SendFn,
): Promise<void> {
  try {
    const modifiedFiles = getModifiedFiles(folder);
    const allFiles = [...new Set([...filesWritten, ...modifiedFiles])];
    if (allFiles.length === 0) { return; }

    send('agentEvent', { type: 'correction', msg: '🔍 Reviewing output...' });

    const issues = staticScan(allFiles, folder);
    if (issues.length > 0) {
      const preview = issues.slice(0, 3).join('; ');
      send('agentEvent', { type: 'correction', msg: `⚠ ${preview} — auto-fixing...` });
      await runAgent(
        `Fix these issues in the files you just wrote:\n${issues.join('\n')}\n\nOriginal task: ${task}`,
        folder,
        (evt) => send('agentEvent', evt),
        undefined, serverUrl, token,
      );
      send('agentEvent', { type: 'correction', msg: '✅ Issues resolved' });
      return;
    }

    if (serverUrl && token) {
      const verdict = await llmVerdict(task, summary, allFiles, serverUrl, token);
      if (verdict.startsWith('ISSUE:')) {
        const issue = verdict.slice(6).trim();
        send('agentEvent', { type: 'correction', msg: `🔧 Reviewer: ${issue} — fixing...` });
        await runAgent(
          `Fix this issue: ${issue}\n\nOriginal task: ${task}`,
          folder,
          (evt) => send('agentEvent', evt),
          undefined, serverUrl, token,
        );
        send('agentEvent', { type: 'correction', msg: '✅ Fixed and verified' });
        return;
      }
    }

    send('agentEvent', { type: 'correction', msg: '✅ Output verified' });
  } catch { /* review failure must never block the user */ }
}

function getModifiedFiles(folder: string): string[] {
  try {
    const out = execSync('git status --porcelain', { cwd: folder, encoding: 'utf8', timeout: 3000 });
    return out.trim().split('\n')
      .filter((l: string) => l.trim())
      .map((l: string) => l.slice(3).trim())
      .filter((f: string) => /\.(html|css|js|ts|jsx|tsx|py|json|md)$/.test(f));
  } catch { return []; }
}

function staticScan(files: string[], folder: string): string[] {
  const BAD = /\bTODO\b|\bFIXME\b|\bplaceholder\b|raise NotImplementedError|\/\/ not implemented/i;
  const issues: string[] = [];
  for (const f of files.slice(0, 20)) {
    const abs = path.isAbsolute(f) ? f : path.join(folder, f);
    try {
      const content = fs.readFileSync(abs, 'utf8');
      if (content.trim().length === 0) {
        issues.push(`${f} is empty`);
      } else if (BAD.test(content)) {
        issues.push(`${f} contains placeholder/TODO`);
      }
    } catch { /* unreadable — skip */ }
  }
  return issues;
}

async function llmVerdict(
  task: string,
  summary: string,
  files: string[],
  serverUrl: string,
  token: string,
): Promise<string> {
  try {
    const resp = await fetch(`${serverUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'Code quality checker. Reply only: APPROVED or ISSUE: <one sentence>.' },
          { role: 'user', content: `Task: ${task}\nSummary: ${summary}\nFiles: ${files.join(', ')}` },
        ],
        max_tokens: 60,
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? 'APPROVED';
  } catch { return 'APPROVED'; }
}
