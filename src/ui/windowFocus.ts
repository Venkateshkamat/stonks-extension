import * as vscode from 'vscode';
import { Emitter } from '../util/emitter';
import { FocusSource } from '../util/focus';

/** FocusSource backed by vscode.window.state / onDidChangeWindowState. */
export class WindowFocus implements FocusSource, vscode.Disposable {
  private readonly changed = new Emitter<boolean>();
  readonly onDidChange = this.changed.event;
  private readonly sub: vscode.Disposable;

  constructor() {
    this.sub = vscode.window.onDidChangeWindowState((e) => this.changed.fire(e.focused));
  }

  get focused(): boolean {
    return vscode.window.state.focused;
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}
