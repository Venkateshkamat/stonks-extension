import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('stonks.openPortfolio', () => {
      void vscode.window.showInformationMessage('Portfolio panel coming soon');
    }),
  );
}

export function deactivate(): void {
  // nothing to clean up
}
