import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Renders static HTML/CSS/JS files directly in a VS Code webview panel.
 * No localhost, no npm, no server — works offline.
 * Mirrors the claude.ai artifact preview experience.
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
    PreviewPanel._current = new PreviewPanel(panel, cwd, htmlFile);
  }

  private constructor(panel: vscode.WebviewPanel, cwd: string, htmlFile: string) {
    this._panel = panel;
    this._cwd = cwd;
    this._update(cwd, htmlFile);
    panel.onDidDispose(() => { PreviewPanel._current = undefined; });
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

    return html;
  }
}
