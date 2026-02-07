/**
 * OpenInterestMonitor tracks futures open interest metrics
 * 
 * Metrics:
 * - Current OI
 * - OI delta (change)
 * - OI trend (up/down/flat)
 * - OI volatility
 * - OI-based signals
 */

export interface OpenInterestMetrics {
  openInterest: number;        // Current OI value
  delta: number;               // Change from last check
  deltaPercent: number;        // % change
  trend: 'up' | 'down' | 'flat';
  signal: 'bullish' | 'bearish' | 'neutral';
  volatility: number;          // OI volatility [0, 1]
  strength: number;            // OI strength indicator [-1, 1]
  lastUpdate: number;          // Timestamp
  source: 'real' | 'mock';
}

export class OpenInterestMonitor {
  private symbol: string;
  private currentOI = 0;
  private previousOI = 0;
  private oiHistory: Array<{ value: number; timestamp: number }> = [];
  private lastFetchTime = 0;
  private readonly FETCH_INTERVAL_MS = 60_000;  // Update every 60 seconds

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  /**
   * Fetch latest OI from Binance API
   */
  public async updateOpenInterest(): Promise<void> {
    const now = Date.now();

    // Rate limit: don't fetch more than once per minute
    if (now - this.lastFetchTime < this.FETCH_INTERVAL_MS && this.currentOI > 0) {
      return;
    }

    try {
      // Using global fetch (available in Node 18+)
      const response = await fetch(
        `https://fapi.binance.com/fapi/v1/openInterest?symbol=${this.symbol}`
      );

      if (!response.ok) {
        console.error(`Failed to fetch OI for ${this.symbol}: ${response.status}`);
        return;
      }

      const data: any = await response.json();
      const newVal = parseFloat(data.openInterest);

      if (!isNaN(newVal)) {
        this.previousOI = this.currentOI > 0 ? this.currentOI : newVal;
        this.currentOI = newVal;

        // Add to history (keep last 60 entries = 1 hour)
        this.oiHistory.push({ value: this.currentOI, timestamp: now });
        if (this.oiHistory.length > 60) {
          this.oiHistory.shift();
        }
      }

      this.lastFetchTime = now;
    } catch (error) {
      console.error(`OpenInterest fetch error for ${this.symbol}: ${error}`);
    }
  }

  /**
   * Calculate OI metrics
   */
  public getMetrics(): OpenInterestMetrics {
    const delta = this.currentOI - this.previousOI;
    const deltaPercent = this.previousOI > 0
      ? (delta / this.previousOI) * 100
      : 0;

    // Trend detection
    let trend: 'up' | 'down' | 'flat' = 'flat';
    if (Math.abs(delta) > this.currentOI * 0.0005) {  // > 0.05% change threshold
      trend = delta > 0 ? 'up' : 'down';
    }

    // OI Volatility (std dev of last 10 OI values)
    const volatility = this.calculateOIVolatility();

    // Signal based on OI + trend
    let signal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (trend === 'up' && deltaPercent > 0.1) {
      signal = 'bullish';  // OI increasing
    } else if (trend === 'down' && deltaPercent < -0.1) {
      signal = 'bearish';  // OI decreasing
    }

    // Strength indicator [-1, 1]
    const strength = Math.max(-1, Math.min(1, deltaPercent * 10));

    return {
      openInterest: this.currentOI,
      delta,
      deltaPercent,
      trend,
      signal,
      volatility,
      strength,
      lastUpdate: Date.now(),
      source: 'real',
    };
  }

  /**
   * Calculate OI volatility (standard deviation)
   */
  private calculateOIVolatility(): number {
    if (this.oiHistory.length < 2) return 0;

    const recent = this.oiHistory.slice(-10);
    const mean = recent.reduce((sum, item) => sum + item.value, 0) / recent.length;
    const variance = recent.reduce(
      (sum, item) => sum + Math.pow(item.value - mean, 2),
      0
    ) / recent.length;
    const stdDev = Math.sqrt(variance);

    // Normalize [0, 1]
    const maxOI = Math.max(...recent.map(item => item.value), 1);
    return Math.min(1, (stdDev / maxOI) * 1000); // Scale up for visibility
  }
}