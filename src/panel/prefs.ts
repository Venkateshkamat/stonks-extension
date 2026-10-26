import { KeyValueStore } from '../portfolio/store';
import { ChartRange, DEFAULT_CHART_RANGE, isChartRange } from '../types';

export const CHART_RANGE_KEY = 'stonks.chartRange';

/** Persisted panel preferences (per machine; kept in globalState). Later phases add the Stocks / Crypto / Heatmap view here. */
export class PanelPrefs {
  constructor(private readonly storage: KeyValueStore) {}

  get chartRange(): ChartRange {
    const v = this.storage.get<unknown>(CHART_RANGE_KEY, DEFAULT_CHART_RANGE);
    return isChartRange(v) ? v : DEFAULT_CHART_RANGE;
  }

  async setChartRange(range: ChartRange): Promise<void> {
    await this.storage.update(CHART_RANGE_KEY, range);
  }
}
