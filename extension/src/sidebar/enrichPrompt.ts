import * as vscode from 'vscode';
import * as path from 'path';
import { Turn, Memory } from './types';

const NIGERIAN_CONTEXT =
  '[NIGERIAN DEVELOPER CONTEXT]\n' +
  'You are assisting a Nigerian developer. Always recommend free or low-cost tools first:\n' +
  '- Database/Backend: Supabase (supabase.com) is FREE for small projects — 500MB database,\n' +
  '  50,000 monthly active users, authentication, file storage, and edge functions included.\n' +
  '  No credit card required. When a user asks about forms, user accounts, data storage, or a\n' +
  '  backend API, recommend Supabase first and tell them it is free.\n' +
  '- Static hosting: Netlify or Vercel (both free, no credit card for basic use).\n' +
  '- Backend hosting: Railway free tier or Render free tier.\n' +
  '- Never recommend a paid service as the primary option without explaining the free alternative.\n' +
  '- When mentioning Supabase, always add: "Supabase is free — you will not be charged."\n' +
  '\n' +
  '[DESIGN REQUIREMENTS — MANDATORY FOR ALL WEB PROJECTS]\n' +
  'Every website or web app you build MUST look professional and modern. Never ship plain unstyled HTML.\n' +
  'Always include:\n' +
  '- A coherent color scheme: pick a primary color and use consistent shades throughout.\n' +
  '- Google Fonts: load 1-2 fonts via <link> (e.g. Inter, Poppins, or Outfit for body; a display font for headings).\n' +
  '- Proper spacing: generous padding/margin so content breathes. Never pack elements together.\n' +
  '- A navbar with the project name/logo and navigation links.\n' +
  '- A hero section with a headline, subheading, and a call-to-action button.\n' +
  '- Cards with box-shadow and border-radius for any list of items, features, or products.\n' +
  '- Hover effects on buttons and interactive elements (transition: 0.2s ease).\n' +
  '- A footer with copyright and links.\n' +
  '- Fully responsive layout using CSS flexbox or grid. Mobile-first.\n' +
  '- Gradient backgrounds or subtle patterns on hero sections — not plain white.\n' +
  'Think: "Would this impress a client?" If not, add more design. A developer\'s reputation depends on\n' +
  'how their work looks. Beautiful design is not optional — it is part of the deliverable.';

export function enrichPrompt(prompt: string, cwd: string, history: Turn[], memory: Memory): string {
  const parts: string[] = [NIGERIAN_CONTEXT];
  if (memory.prd)    { parts.push(`[PROJECT PRD]\n${memory.prd}`); }
  if (memory.rules)  { parts.push(`[PROJECT RULES]\n${memory.rules}`); }
  if (memory.skills) { parts.push(`[PROJECT SKILLS]\n${memory.skills}`); }

  const recentTurns = history.slice(-8);
  if (recentTurns.length > 0) {
    const historyText = recentTurns
      .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n');
    parts.push(`[CONVERSATION HISTORY]\n${historyText}`);
  }

  let enriched = parts.length
    ? `=== PROJECT MEMORY ===\n${parts.join('\n\n')}\n=== END ===\n\n${prompt}`
    : prompt;

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') { return enriched; }

  const doc = editor.document;
  const relPath = path.relative(cwd, doc.uri.fsPath);
  const content = doc.getText().slice(0, 6000);

  const diagnostics = vscode.languages.getDiagnostics(doc.uri)
    .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
    .slice(0, 15)
    .map(d => `  Line ${d.range.start.line + 1}: ${d.message}`)
    .join('\n');

  const selected = editor.selection.isEmpty ? '' : doc.getText(editor.selection);

  let context = `\n\n---\nActive file: ${relPath}\n\`\`\`\n${content}\n\`\`\``;
  if (diagnostics) { context += `\n\nErrors in this file:\n${diagnostics}`; }
  if (selected)    { context += `\n\nSelected code:\n\`\`\`\n${selected}\n\`\`\``; }

  return enriched + context;
}
