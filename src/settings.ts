import { Currency } from './types';

export interface Settings {
  baseCurrency: Currency;
  refreshIntervalSeconds: number;
  hideAmounts: boolean;
}

export const MIN_REFRESH_SECONDS = 15;
export const DEFAULT_SETTINGS: Settings = { baseCurrency: 'INR', refreshIntervalSeconds: 60, hideAmounts: false };

/** Sanitizes raw configuration values: unknown currency -> INR, interval clamped to >= 15s. */
export function parseSettings(raw: { baseCurrency?: unknown; refreshIntervalSeconds?: unknown; hideAmounts?: unknown }): Settings {
  const baseCurrency: Currency = raw.baseCurrency === 'USD' ? 'USD' : 'INR';
  const n = typeof raw.refreshIntervalSeconds === 'number' && Number.isFinite(raw.refreshIntervalSeconds) ? raw.refreshIntervalSeconds : DEFAULT_SETTINGS.refreshIntervalSeconds;
  return {
    baseCurrency,
    refreshIntervalSeconds: Math.max(MIN_REFRESH_SECONDS, Math.round(n)),
    hideAmounts: raw.hideAmounts === true,
  };
}

/** Abstraction over VS Code configuration so the controller stays testable without VS Code. */
export interface SettingsSource {
  get(): Settings;
  setHideAmounts(value: boolean): PromiseLike<void>;
  setBaseCurrency(value: Currency): PromiseLike<void>;
  setRefreshIntervalSeconds(value: number): PromiseLike<void>;
}
