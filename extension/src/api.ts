const BASE_URL = process.env['OGACODE_API_URL'] ?? 'http://localhost:8000';

const TIMEOUT_COMPLETION_MS = 8_000;
const TIMEOUT_CHAT_MS = 45_000;

export interface OgaFile {
  path: string;
  content: string;
}

export interface ChatResult {
  response: string;
  model: string;
  cached: boolean;
  files: OgaFile[];
  deploy_cmd: string;
  stack: string;
  verified: boolean;
}

export interface FixRequest {
  user_id: string;
  files: OgaFile[];
  error_log: string;
  stack: string;
}

export async function fixBuild(req: FixRequest): Promise<ChatResult> {
  const ctrl = withTimeout(60_000);
  const res = await fetch(`${BASE_URL}/fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: ctrl.signal,
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`Fix error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<ChatResult>;
}

function withTimeout(ms: number): AbortController {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  stack: string;
}

export async function fetchHistory(userId: string): Promise<HistoryMessage[]> {
  const ctrl = withTimeout(TIMEOUT_COMPLETION_MS);
  try {
    const res = await fetch(`${BASE_URL}/history/${encodeURIComponent(userId)}`, { signal: ctrl.signal });
    if (!res.ok) return [];
    return res.json() as Promise<HistoryMessage[]>;
  } catch {
    return [];
  }
}

export interface ActiveFile {
  path: string;
  content: string;
  language: string;
}

export interface TestCase {
  name: string;
  passed: boolean;
  note: string;
}

export interface CodeFixResult {
  fixed_code: string;
  explanation: string;
  tests: TestCase[];
  all_passed: boolean;
  file_path: string;
}

export async function fixCode(userId: string, problem: string, file: ActiveFile): Promise<CodeFixResult> {
  const ctrl = withTimeout(60_000);
  const res = await fetch(`${BASE_URL}/fix-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: ctrl.signal,
    body: JSON.stringify({
      user_id: userId,
      problem,
      file_path: file.path,
      code: file.content,
      language: file.language,
    }),
  });
  if (!res.ok) {
    throw new Error(`Fix error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<CodeFixResult>;
}

export interface StreamEvent {
  type: 'step' | 'correction' | 'complete' | 'error';
  step?: string;
  msg: string;
  done?: boolean;
}

export async function chatStream(
  prompt: string,
  userId: string,
  onProgress: (evt: StreamEvent) => void,
): Promise<ChatResult> {
  const ctrl = withTimeout(180_000);
  const res = await fetch(`${BASE_URL}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: ctrl.signal,
    body: JSON.stringify({ prompt, user_id: userId }),
  });

  if (!res.ok) {
    throw new Error(`Stream error ${res.status}: ${await res.text()}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ChatResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) { break; }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) { continue; }
      try {
        const data = JSON.parse(line.slice(6)) as StreamEvent & { result?: ChatResult };
        if (data.type === 'complete' && data.result) {
          result = data.result;
        } else if (data.type === 'error') {
          throw new Error(data.msg);
        } else {
          onProgress(data);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Stream error')) { throw e; }
      }
    }
  }

  if (!result) { throw new Error('Stream ended without result'); }
  return result;
}

export interface ClarifyResult {
  questions: string[];
  stack: string;
  plan_summary: string;
}

export interface PlanResult {
  stack: string;
  deploy_cmd: string;
  files: string[];
  steps: string[];
  summary: string;
}

export async function clarify(prompt: string, userId: string): Promise<ClarifyResult> {
  const ctrl = withTimeout(15_000);
  const res = await fetch(`${BASE_URL}/clarify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: ctrl.signal,
    body: JSON.stringify({ prompt, user_id: userId }),
  });
  if (!res.ok) { return { questions: [], stack: 'static-html', plan_summary: '' }; }
  return res.json() as Promise<ClarifyResult>;
}

export async function planOnly(prompt: string, userId: string): Promise<PlanResult> {
  const ctrl = withTimeout(20_000);
  const res = await fetch(`${BASE_URL}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: ctrl.signal,
    body: JSON.stringify({ prompt, user_id: userId }),
  });
  if (!res.ok) { throw new Error(`Plan error ${res.status}`); }
  return res.json() as Promise<PlanResult>;
}

export async function healthCheck(): Promise<boolean> {
  const ctrl = withTimeout(TIMEOUT_COMPLETION_MS);
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  }
}

export async function chat(prompt: string, userId: string): Promise<ChatResult> {
  const ctrl = withTimeout(TIMEOUT_CHAT_MS);
  const res = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: ctrl.signal,
    body: JSON.stringify({ prompt, user_id: userId }),
  });

  if (!res.ok) {
    throw new Error(`Proxy error ${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<ChatResult>;
}
