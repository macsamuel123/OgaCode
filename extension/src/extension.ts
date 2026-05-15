import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SidebarProvider(context.extensionUri, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ogacode.sidebar', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
}

export function deactivate(): void {}
