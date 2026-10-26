import * as vscode from 'vscode';
import { parseSettings, Settings, SettingsSource } from '../settings';
import { Currency } from '../types';

export class VsCodeSettings implements SettingsSource {
  get(): Settings {
    const c = vscode.workspace.getConfiguration('stonks');
    return parseSettings({
      baseCurrency: c.get('baseCurrency'),
      refreshIntervalSeconds: c.get('refreshIntervalSeconds'),
      hideAmounts: c.get('hideAmounts'),
    });
  }

  setHideAmounts(value: boolean): Promise<void> {
    return this.write('hideAmounts', value);
  }

  setBaseCurrency(value: Currency): Promise<void> {
    return this.write('baseCurrency', value);
  }

  setRefreshIntervalSeconds(value: number): Promise<void> {
    return this.write('refreshIntervalSeconds', value);
  }

  private async write(key: string, value: unknown): Promise<void> {
    const c = vscode.workspace.getConfiguration('stonks');
    // Respect a workspace-level override if one exists (otherwise the write would have no visible effect);
    // else write the user (Global) setting.
    const target = c.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await c.update(key, value, target);
  }
}
