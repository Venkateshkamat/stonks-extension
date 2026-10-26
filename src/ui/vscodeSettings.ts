import * as vscode from 'vscode';
import { parseSettings, Settings, SettingsSource } from '../settings';

export class VsCodeSettings implements SettingsSource {
  get(): Settings {
    const c = vscode.workspace.getConfiguration('stonks');
    return parseSettings({
      baseCurrency: c.get('baseCurrency'),
      refreshIntervalSeconds: c.get('refreshIntervalSeconds'),
      hideAmounts: c.get('hideAmounts'),
    });
  }

  async setHideAmounts(value: boolean): Promise<void> {
    const c = vscode.workspace.getConfiguration('stonks');
    // Respect a workspace-level override if one exists; otherwise write the user setting.
    const target =
      c.inspect('hideAmounts')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await c.update('hideAmounts', value, target);
  }
}
