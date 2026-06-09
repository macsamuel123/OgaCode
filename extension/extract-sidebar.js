const fs = require('fs');
const dist = fs.readFileSync('dist/extension.js', 'utf8');

// Find the webview HTML template
const htmlStart = dist.indexOf('<!DOCTYPE html>');
const html = dist.slice(htmlStart, dist.indexOf('`', htmlStart));

// Find the <script src= tag, then grab the comment block after it
const scriptTagIdx = html.indexOf('<script src=');
const scriptCloseIdx = html.indexOf('<\/script>', scriptTagIdx);
const commentStart = html.indexOf('/*', scriptTagIdx) + 2;
const commentEnd = html.lastIndexOf('*/', scriptCloseIdx);
let js = html.slice(commentStart, commentEnd).trim();

// Remove the jsdiag hide line (element no longer exists in HTML)
js = js.replace(/document\.getElementById\('jsdiag'\)\.style\.display = 'none';\s*/g, '');

// Remove the _clickTest pointerdown listener
js = js.replace(/document\.addEventListener\('pointerdown'[^}]+\}, \{ once: true \}\);\s*/g, '');

fs.writeFileSync('sidebar.js', js, 'utf8');
console.log('sidebar.js written:', js.length, 'chars');
console.log('First line:', js.split('\n').find(l => l.trim()));
