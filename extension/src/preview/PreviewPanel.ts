import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';

export interface ElementSelection {
  selector: string;
  outerHtml: string;
  tagName: string;
  classes: string;
  text: string;
}

const _selectionEmitter = new EventEmitter();

/**
 * Renders static HTML/CSS/JS files directly in a VS Code webview panel.
 * No localhost, no npm, no server — works offline.
 * Supports bidirectional element selection: click any element in the preview
 * to target it for editing in the sidebar.
 */
export class PreviewPanel {
  private static _current: PreviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _cwd: string;

  static show(cwd: string, htmlFile: string): void {
    if (PreviewPanel._current) {
      PreviewPanel._current._update(cwd, htmlFile);
      PreviewPanel._current._panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'ogacodePreview',
      'OgaCode Preview',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'elementSelected') {
        _selectionEmitter.emit('select', msg as ElementSelection);
      }
    });
    panel.onDidDispose(() => { PreviewPanel._current = undefined; });
    PreviewPanel._current = new PreviewPanel(panel, cwd, htmlFile);
  }

  static onElementSelected(cb: (data: ElementSelection) => void): vscode.Disposable {
    _selectionEmitter.on('select', cb);
    return { dispose: () => { _selectionEmitter.off('select', cb); } };
  }

  private constructor(panel: vscode.WebviewPanel, cwd: string, htmlFile: string) {
    this._panel = panel;
    this._cwd = cwd;
    this._update(cwd, htmlFile);
  }

  private _update(cwd: string, htmlFile: string): void {
    this._cwd = cwd;
    this._panel.title = `Preview — ${path.basename(htmlFile)}`;
    this._panel.webview.html = this._buildHtml(cwd, htmlFile);
  }

  private _buildHtml(cwd: string, htmlFile: string): string {
    const htmlPath = path.join(cwd, htmlFile);
    if (!fs.existsSync(htmlPath)) {
      return `<html><body style="color:#f88;font-family:sans-serif;padding:20px">
        File not found: ${htmlFile}</body></html>`;
    }

    let html = fs.readFileSync(htmlPath, 'utf8');

    // Inline all linked CSS files
    html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi,
      (_, href) => {
        if (href.startsWith('http')) { return _; }
        const cssPath = path.join(path.dirname(htmlPath), href);
        if (!fs.existsSync(cssPath)) { return ''; }
        return `<style>${fs.readFileSync(cssPath, 'utf8')}</style>`;
      },
    );

    // Inline all local script files
    html = html.replace(/<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/gi,
      (_, src) => {
        if (src.startsWith('http')) { return _; }
        const jsPath = path.join(path.dirname(htmlPath), src);
        if (!fs.existsSync(jsPath)) { return ''; }
        return `<script>${fs.readFileSync(jsPath, 'utf8')}</script>`;
      },
    );

    // Inline local images as base64
    html = html.replace(/src=["'](?!http|data:)([^"']+\.(png|jpg|jpeg|gif|svg|webp))["']/gi,
      (_, imgPath) => {
        const fullPath = path.join(path.dirname(htmlPath), imgPath);
        if (!fs.existsSync(fullPath)) { return `src="${imgPath}"`; }
        const ext = path.extname(imgPath).slice(1).replace('jpg', 'jpeg');
        const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
        const b64 = fs.readFileSync(fullPath).toString('base64');
        return `src="data:${mime};base64,${b64}"`;
      },
    );

    // Inject selection overlay before </body>
    const overlay = `<script>
(function() {
  var vscode = acquireVsCodeApi();
  var selected = null;

  document.addEventListener('mouseover', function(e) {
    if (e.target === document.body || e.target === document.documentElement) { return; }
    if (e.target.id === '__oga_bar__' || e.target === selected) { return; }
    e.target.style.outline = '2px solid #007acc';
    e.target.style.outlineOffset = '2px';
    e.target.style.cursor = 'pointer';
  }, true);

  document.addEventListener('mouseout', function(e) {
    if (e.target !== selected) {
      e.target.style.outline = '';
      e.target.style.outlineOffset = '';
      e.target.style.cursor = '';
    }
  }, true);

  document.addEventListener('click', function(e) {
    if (e.target.id === '__oga_bar__') { return; }
    e.preventDefault();
    e.stopPropagation();
    if (selected) { selected.style.outline = ''; selected.style.outlineOffset = ''; }
    selected = e.target;
    selected.style.outline = '2px solid #f90';
    selected.style.outlineOffset = '2px';
    editBar.style.display = 'none';
    vscode.postMessage({
      command: 'elementSelected',
      selector: getCssSelector(e.target),
      outerHtml: e.target.outerHTML.slice(0, 600),
      tagName: e.target.tagName.toLowerCase(),
      classes: e.target.className || '',
      text: (e.target.innerText || '').slice(0, 100),
    });
  }, true);

  function getCssSelector(el) {
    var path = [];
    while (el && el.nodeType === 1) {
      var sel = el.tagName.toLowerCase();
      if (el.id) { path.unshift('#' + el.id); break; }
      if (el.className && typeof el.className === 'string') {
        sel += '.' + Array.from(el.classList).slice(0, 3).join('.');
      }
      var nth = 1, sib = el;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === el.tagName) { nth++; } }
      if (nth > 1) { sel += ':nth-of-type(' + nth + ')'; }
      path.unshift(sel);
      el = el.parentElement;
    }
    return path.join(' > ');
  }

  var editBar = document.createElement('div');
  editBar.id = '__oga_bar__';
  editBar.style.cssText =
    'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
    'background:#1e1e1e;color:#ccc;padding:8px 18px;border-radius:20px;' +
    'font:13px/1 sans-serif;z-index:2147483647;pointer-events:none;' +
    'box-shadow:0 4px 20px rgba(0,0,0,.5);border:1px solid #444;white-space:nowrap;';
  editBar.textContent = '✏︎  Click any element to edit it in OgaCode';
  document.body.appendChild(editBar);
})();
</script>`;

    if (html.includes('</body>')) {
      html = html.replace('</body>', overlay + '</body>');
    } else {
      html += overlay;
    }

    return html;
  }
}
