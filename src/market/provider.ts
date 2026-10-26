import { Market, ProviderId, Quote } from '../types';

export interface QuoteProvider {
  readonly id: ProviderId;
  supports(market: Market): boolean;
  getQuote(symbol: string, market: Market): Promise<Quote>;
}
