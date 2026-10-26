import { KeyValueStore } from '../portfolio/store';
import { ChartRange, DEFAULT_CHART_RANGE, isChartRange } from '../types';
import { DEFAULT_PANEL_VIEW, isPanelView, PanelView } from './views';

export const CHART_RANGE_KEY = 'stonks.chartRange';
export const PANEL_VIEW_KEY = 'stonks.panelView';

/**
 * Persisted panel preferences (per machine; kept in globalState): the chart range and the selected view.
 *
 * Writes are cached in memory: the extension host can briefly hand back a stale globalState value (an echo of an
 * earlier write) for a few hundred ms after a newer write, which would flip the UI back. Reads therefore prefer
 * what this instance last wrote; storage is only the source for the first read after startup.
 */
export class PanelPrefs {
  private readonly written = new Map<string, unknown>();

  constructor(private readonly storage: KeyValueStore) {}

  private read(key: string, fallback: unknown): unknown {
    return this.written.has(key) ? this.written.get(key) : this.storage.get<unknown>(key, fallback);
  }

  private async write(key: string, value: unknown): Promise<void> {
    this.written.set(key, value);
    await this.storage.update(key, value);
  }

  get chartRange(): ChartRange {
    const v = this.read(CHART_RANGE_KEY, DEFAULT_CHART_RANGE);
    return isChartRange(v) ? v : DEFAULT_CHART_RANGE;
  }

  async setChartRange(range: ChartRange): Promise<void> {
    await this.write(CHART_RANGE_KEY, range);
  }

  get view(): PanelView {
    const v = this.read(PANEL_VIEW_KEY, DEFAULT_PANEL_VIEW);
    return isPanelView(v) ? v : DEFAULT_PANEL_VIEW;
  }

  async setView(view: PanelView): Promise<void> {
    await this.write(PANEL_VIEW_KEY, view);
  }
}
