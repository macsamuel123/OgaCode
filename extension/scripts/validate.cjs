#!/usr/bin/env node
/**
 * OgaCode pre-package validator.
 * Catches the class of bugs that keep causing "send new VSIX" cycles:
 *   1. TypeScript compilation errors
 *   2. Webview calls a function that is never defined (e.g. lockSend)
 *   3. Backend sends a message the webview has no handler for
 *   4. Webview posts a message the backend has no handler for
 *   5. sendTimer set without a matching clearTimeout / unlockSend path
 *   6. Shell injection patterns in new keychain reads
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT      = path.join(__dirname, '..');
const SIDEBAR   = path.join(ROOT, 'src', 'sidebar', 'SidebarProvider.ts');
const SIDEBARJS = path.join(ROOT, 'sidebar.js');

let errors   = 0;
let warnings = 0;

const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => { console.warn(`  \x1b[33m⚠\x1b[0m ${m}`); warnings++; };
const fail = (m) => { console.error(`  \x1b[31m✗\x1b[0m ${m}`); errors++; };

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1mOgaCode pre-package validator\x1b[0m');
console.log('─'.repeat(50));

// 1. Read source
const src = fs.readFileSync(SIDEBAR, 'utf8');

// ─── Check 1: TypeScript ──────────────────────────────────────────────────────
console.log('\n[1] TypeScript compilation');
try {
  execSync('npx tsc --noEmit', { stdio: 'pipe', cwd: ROOT });
  ok('No type errors');
} catch (e) {
  const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
  fail('TypeScript errors:\n' + out.trim().slice(0, 800));
}

// ─── Load webview JS (sidebar.js external file) ───────────────────────────────
if (!fs.existsSync(SIDEBARJS)) {
  fail('sidebar.js not found — the webview script is missing from the extension root.');
  console.error('\n\x1b[31m✗ FAILED\x1b[0m\n');
  process.exit(1);
}
const webviewJs = fs.readFileSync(SIDEBARJS, 'utf8');
ok(`sidebar.js loaded (${(webviewJs.length / 1024).toFixed(1)} KB)`);

// ─── Check 2: Undefined function calls in webview JS ─────────────────────────
console.log('\n[2] Webview — undefined function calls');

// Collect definitions: `function foo(`, `var foo = function`, `var foo = (` arrow-ish
const defined = new Set();
for (const m of webviewJs.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g))   defined.add(m[1]);
for (const m of webviewJs.matchAll(/var\s+([a-zA-Z_$][\w$]*)\s*=\s*function/g)) defined.add(m[1]);

// JavaScript reserved words and keywords — never function calls
const JS_KEYWORDS = new Set([
  'if','else','for','while','do','switch','case','break','continue','return','throw',
  'try','catch','finally','new','delete','typeof','instanceof','in','of','void',
  'var','let','const','function','class','import','export','default','extends','super',
  'yield','async','await','static','get','set','from','as','with','debugger',
]);

// Known browser/DOM/VS Code API globals — not defined in webview JS but always available
const GLOBALS = new Set([
  // Browser
  'setTimeout','clearTimeout','setInterval','clearInterval',
  'parseInt','parseFloat','isNaN','isFinite',
  'JSON','String','Number','Boolean','Array','Object','Math','Date','Promise','Error','Set','Map',
  'console','document','window','navigator','location','history','Event',
  'alert','confirm','prompt','fetch','XMLHttpRequest','FormData','FileReader','Blob',
  'encodeURIComponent','decodeURIComponent','encodeURI','decodeURI','escape','unescape',
  // VS Code webview
  'acquireVsCodeApi',
  // DOM element variables declared in sidebar.js at top level
  'elementChip', 'elementChipLabel', 'clearElementBtn', 'clearElement',
  'stopbtn', 'thread', 'inp', 'sendbtn', 'prevbtn', 'runbtn', 'expobtn',
  'deploybtn', 'deployStatus', 'newchatbtn', 'memorybtn', 'memPanel',
  'historyBtn', 'historyDropdown', 'memPrd', 'memRules', 'memSkills',
  'uploadPrd', 'uploadRules', 'uploadSkills', 'saveMemBtn',
  // Node (runner context — not webview, but safe to whitelist)
  'require','module','exports','process','__dirname','__filename',
]);

// Collect function-style calls: word( — exclude method calls (preceded by .) and JS keywords
const calls = new Set();
for (const m of webviewJs.matchAll(/(?<![.\w'"`\\])([a-zA-Z_$][\w$]*)\s*\(/g)) {
  if (!JS_KEYWORDS.has(m[1])) calls.add(m[1]);
}

let undefinedFound = false;
for (const fn of [...calls].sort()) {
  if (!defined.has(fn) && !GLOBALS.has(fn)) {
    fail(`'${fn}()' is called but never defined — will throw ReferenceError at runtime`);
    undefinedFound = true;
  }
}
if (!undefinedFound) ok('All called functions are defined');

// ─── Check 3: Backend → Webview message symmetry ─────────────────────────────
console.log('\n[3] Backend → Webview message symmetry');

const backendSends     = new Set([...src.matchAll(/this\._send\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]));
const webviewHandlers  = new Set([...webviewJs.matchAll(/d\.command\s*===\s*['"]([^'"]+)['"]/g)].map(m => m[1]));

let symmetryOk = true;
for (const cmd of [...backendSends].sort()) {
  if (webviewHandlers.has(cmd)) {
    ok(`_send('${cmd}') ↔ webview handler ✓`);
  } else {
    fail(`_send('${cmd}') — no webview handler. Message silently dropped.`);
    symmetryOk = false;
  }
}
if (symmetryOk && backendSends.size > 0) ok('All backend → webview messages handled');

// ─── Check 4: Webview → Backend message symmetry ─────────────────────────────
console.log('\n[4] Webview → Backend message symmetry');

const webviewPosts     = new Set([...webviewJs.matchAll(/api\.postMessage\(\s*\{\s*command:\s*['"]([^'"]+)['"]/g)].map(m => m[1]));
const backendHandlers  = new Set([...src.matchAll(/message\.command\s*===\s*['"]([^'"]+)['"]/g)].map(m => m[1]));

let postOk = true;
for (const cmd of [...webviewPosts].sort()) {
  if (backendHandlers.has(cmd)) {
    ok(`postMessage('${cmd}') ↔ backend handler ✓`);
  } else {
    fail(`postMessage('${cmd}') — no handler in _handleMessage. Command silently ignored.`);
    postOk = false;
  }
}
if (postOk && webviewPosts.size > 0) ok('All webview → backend messages handled');

// ─── Check 5: sendTimer discipline ───────────────────────────────────────────
console.log('\n[5] sendTimer discipline');

const timerSets    = (webviewJs.match(/sendTimer\s*=\s*setTimeout/g) ?? []).length;
const timerClears  = (webviewJs.match(/clearTimeout\s*\(\s*sendTimer\s*\)/g) ?? []).length;
const unlockCalls  = (webviewJs.match(/unlockSend\s*\(\s*\)/g) ?? []).length;

// unlockSend itself calls clearTimeout(sendTimer), so each call clears the timer
const effectiveClears = timerClears + unlockCalls;

if (timerSets === 0) {
  warn('No sendTimer found — watchdog disabled?');
} else if (effectiveClears < timerSets) {
  warn(`sendTimer set ${timerSets}× but cleared/unlocked only ${effectiveClears}× — potential timer leak`);
} else {
  ok(`sendTimer set ${timerSets}×, cleared/unlocked ${effectiveClears}× — looks balanced`);
}

// Detect early-return paths that set the timer but don't cancel it
// (e.g. showBuildOptions returning without unlockSend)
const showBuildMatch = webviewJs.match(/showBuildOptions[\s\S]{0,800}?return;/);
if (showBuildMatch && !/unlockSend/.test(showBuildMatch[0])) {
  fail('showBuildOptions handler returns without calling unlockSend() — 45s watchdog will fire');
}

// ─── Check 6: Shell injection patterns ───────────────────────────────────────
console.log('\n[6] Shell injection safety');

// Flag any execSync/exec with template literals that interpolate variables not escaped
const dangerousExec = [...src.matchAll(/execSync\s*\(\s*`[^`]*\$\{(?!safeKey|safeToken|zipPath|folder|cwd|safePath|keyName)[^}]+\}[^`]*`/g)];
if (dangerousExec.length > 0) {
  for (const m of dangerousExec) {
    warn(`Potentially unsafe shell interpolation: ${m[0].slice(0, 120)}`);
  }
} else {
  ok('No obvious unsafe shell interpolations found');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
if (errors > 0) {
  console.error(`\n\x1b[31m✗ FAILED — ${errors} error(s)${warnings ? `, ${warnings} warning(s)` : ''}. Fix before packaging.\x1b[0m\n`);
  process.exit(1);
} else if (warnings > 0) {
  console.warn(`\n\x1b[33m⚠ Passed with ${warnings} warning(s). Review before packaging.\x1b[0m\n`);
} else {
  console.log(`\n\x1b[32m✓ All checks passed. Safe to package.\x1b[0m\n`);
}
