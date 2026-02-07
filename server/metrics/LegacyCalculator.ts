// [GITHUB VERIFIED] Backend implementation of OBI, VWAP, DeltaZ, CVD Slope, and Advanced Scores
// Senior Quantitative Finance Developer Implementation
import { OrderbookState, bestBid, bestAsk } from './OrderbookManager';
import { OpenInterestMonitor, OpenInterestMetrics as OIMetrics } from './OpenInterestMonitor';

// Type for a trade used in the legacy metrics calculations
interface LegacyTrade {
    price: number;
    quantity: number;
    side: 'buy' | 'sell';
    timestamp: number;
}

// Constants for metric calculations
const EPSILON = 1e-12;
const MAX_TRADES_WINDOW = 10_000; // Maximum trade window (10 seconds worth)
const VOLATILITY_HISTORY_SIZE = 3600; // 1 hour of volatility history
const ATR_WINDOW = 14;
const SWEEP_DETECTION_WINDOW = 30;
const BREAKOUT_WINDOW = 15;
const ABSORPTION_WINDOW = 60;

/**
 * LegacyCalculator computes additional orderflow metrics that were
 * previously derived on the client.  These include various orderbook
 * imbalance scores, rolling delta windows, Z‐scores and session CVD
 * slope.  The implementation strives to be lightweight but still
 * produce values compatible with the original UI expectations.
 * 
 * Implements:
 * - OBI (Weighted, Deep, Divergence)
 * - Session VWAP
 * - Delta Z-Score
 * - CVD Slope
 * - Advanced Scores: Sweep, Breakout, Regime, Absorption
 * - Trade Signal
 * - Exhaustion Detection
 */
export class LegacyCalculator {
    // Keep a rolling list of trades for delta calculations (max 10 seconds)
    private trades: LegacyTrade[] = [];
    private oiMonitor: OpenInterestMonitor | null = null;

    constructor(symbol?: string) {
        if (symbol) {
            this.oiMonitor = new OpenInterestMonitor(symbol);
        }
    }

    public async updateOpenInterest() {
        if (this.oiMonitor) {
            await this.oiMonitor.updateOpenInterest();
        }
    }

    public getOpenInterestMetrics(): OIMetrics | null {
        return this.oiMonitor ? this.oiMonitor.getMetrics() : null;
    }
    // List of recent delta1s values for Z‐score computation
    private deltaHistory: number[] = [];
    // List of recent session CVD values for slope computation
    private cvdHistory: number[] = [];
    private cvdSession = 0;
    private totalVolume = 0;
    private totalNotional = 0;

    // Advanced Metrics State
    private volatilityHistory: number[] = [];
    private volumeHistory: number[] = [];
    private lastMidPrice = 0;

    /**
     * Add a trade to the calculator.  Updates rolling windows and
     * cumulative session CVD/volume/notional statistics.
     */
    addTrade(trade: LegacyTrade) {
        const now = trade.timestamp;
        // Push new trade
        this.trades.push(trade);
        // Update session metrics
        this.totalVolume += trade.quantity;
        this.totalNotional += trade.quantity * trade.price;
        this.cvdSession += trade.side === 'buy' ? trade.quantity : -trade.quantity;
        // Remove old trades beyond 10 seconds
        const cutoff = now - 10_000;
        while (this.trades.length > 0 && this.trades[0].timestamp < cutoff) {
            this.trades.shift();
        }
        // Every trade, recompute delta1s and store for Z‐score.  Compute
        // delta1s as net volume over last 1s.
        const oneSecCutoff = now - 1_000;
        let delta1s = 0;
        let delta5s = 0;
        let count1s = 0;
        for (const t of this.trades) {
            if (t.timestamp >= oneSecCutoff) {
                delta1s += t.side === 'buy' ? t.quantity : -t.quantity;
                count1s++;
            }
            if (t.timestamp >= now - 5_000) {
                delta5s += t.side === 'buy' ? t.quantity : -t.quantity;
            }
        }
        // Store delta1s history for Z calculation (limit 60 entries)
        this.deltaHistory.push(delta1s);
        if (this.deltaHistory.length > 60) {
            this.deltaHistory.shift();
        }
        // Store cvdSession history for slope calculation (limit 60 entries)
        this.cvdHistory.push(this.cvdSession);
        if (this.cvdHistory.length > 60) {
            this.cvdHistory.shift();
        }
        // Store volume history for absorption detection
        this.volumeHistory.push(trade.quantity);
        if (this.volumeHistory.length > 100) {
            this.volumeHistory.shift();
        }
    }

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================

    /**
     * Calculate Average True Range (ATR) from recent trades
     * ATR measures volatility using price differences
     */
    private calculateATR(): number {
        if (this.trades.length < 2) return 0;

        const trueRanges: number[] = [];
        for (let i = 1; i < this.trades.length; i++) {
            const current = this.trades[i].price;
            const previous = this.trades[i - 1].price;
            const tr = Math.abs(current - previous);
            trueRanges.push(tr);
        }

        if (trueRanges.length === 0) return 0;
        const windowSize = Math.min(ATR_WINDOW, trueRanges.length);
        return trueRanges.slice(-windowSize).reduce((a, b) => a + b, 0) / windowSize;
    }

    /**
     * Calculate Standard Deviation of an array
     */
    private calculateStdDev(values: number[]): number {
        if (values.length === 0) return 0;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
        return Math.sqrt(variance);
    }

    /**
     * Linear Regression Slope calculation
     */
    private calculateSlope(values: number[]): number {
        const n = values.length;
        if (n < 2) return 0;

        const xs = [...Array(n).keys()];
        const ys = values;
        const sumX = xs.reduce((a, b) => a + b, 0);
        const sumY = ys.reduce((a, b) => a + b, 0);
        const sumXX = xs.reduce((a, b) => a + b * b, 0);
        const sumXY = xs.reduce((sum, x, i) => sum + x * ys[i], 0);
        const denom = n * sumXX - sumX * sumX;

        if (Math.abs(denom) < EPSILON) return 0;
        return (n * sumXY - sumX * sumY) / denom;
    }

    // =========================================================================
    // ADVANCED METRICS CALCULATIONS
    // =========================================================================

    /**
     * GÖREV 1: Sweep/Fade Score
     * 
     * Sweep algılama: Agresif alıcıların/satıcıların orderbook'ta seviye
     * atlayarak doldurması (sweep) veya kısmi doldurmaları (fade).
     * 
     * Sweep = İşlem fiyat hareketi >= bid-ask spread
     * Fade = İşlem fiyat hareketi < bid-ask spread
     * 
     * @returns [-1.0, +1.0] - Positive = aggressive buyers, Negative = aggressive sellers
     */
    private calculateSweepFadeScore(spread: number, midPrice: number): number {
        if (this.trades.length < 10) return 0;
        if (spread < EPSILON) return 0;

        const recentTrades = this.trades.slice(-SWEEP_DETECTION_WINDOW);
        let sweepBuyVol = 0;
        let sweepSellVol = 0;
        let fadeBuyVol = 0;
        let fadeSellVol = 0;

        for (const trade of recentTrades) {
            const priceDeviation = Math.abs(trade.price - midPrice);

            // Sweep tanısı: Büyük spread atlayan işlem (>= %50 spread)
            if (priceDeviation > spread * 0.5) {
                if (trade.side === 'buy') {
                    sweepBuyVol += trade.quantity;
                } else {
                    sweepSellVol += trade.quantity;
                }
            } else {
                // Fade: Spread içinde kalan işlem
                if (trade.side === 'buy') {
                    fadeBuyVol += trade.quantity;
                } else {
                    fadeSellVol += trade.quantity;
                }
            }
        }

        // Combined score: Sweep dominance with fade adjustment
        const totalSweep = sweepBuyVol + sweepSellVol;
        const totalFade = fadeBuyVol + fadeSellVol;
        const totalVol = totalSweep + totalFade;

        if (totalVol < EPSILON) return 0;

        // Sweep'lerin net yönü (ağırlıklı)
        const sweepNet = totalSweep > 0 ? (sweepBuyVol - sweepSellVol) / totalSweep : 0;
        // Fade'lerin net yönü (daha az ağırlık)
        const fadeNet = totalFade > 0 ? (fadeBuyVol - fadeSellVol) / totalFade : 0;

        // Sweep'e %70, Fade'e %30 ağırlık
        const sweepWeight = totalSweep / totalVol;
        const score = sweepNet * sweepWeight + fadeNet * (1 - sweepWeight) * 0.3;

        return Math.max(-1, Math.min(1, score));
    }

    /**
     * GÖREV 2: Breakout Score (Momentum)
     * 
     * Breakout momentumu, fiyatın yönü ve hızını kaç saniye boyunca
     * koruduğunu ölçer. ATR ile normalize edilir.
     * 
     * Formula: (Current MA - Previous MA) / ATR
     * 
     * @returns [-1.0, +1.0] - +1.0 = Strong UPTREND, -1.0 = Strong DOWNTREND
     */
    private calculateBreakoutScore(delta1s: number): number {
        if (this.trades.length < 5) return 0;

        const recentPrices = this.trades.slice(-BREAKOUT_WINDOW).map(t => t.price);
        const n = recentPrices.length;
        if (n < 2) return 0;

        // 1. Trend Eğimi (Linear Regression)
        const slope = this.calculateSlope(recentPrices);

        // 2. ATR (Average True Range) hesabı
        const atr = this.calculateATR();
        if (atr < EPSILON) return 0;

        // 3. Normalize slope by ATR
        const normalizedSlope = slope / atr;

        // 4. Delta confirmation (momentum check)
        // Eğer delta aynı yönde ise güven artar
        const deltaConfirm = Math.sign(delta1s) === Math.sign(slope) ? 1.0 : 0.5;

        // 5. Volume confirmation (son 5 işlem ortalamanın üstünde mi?)
        const recentVol = this.trades.slice(-5).reduce((sum, t) => sum + t.quantity, 0);
        const avgVol = this.volumeHistory.length > 0
            ? this.volumeHistory.reduce((a, b) => a + b, 0) / this.volumeHistory.length
            : recentVol / 5;
        const volumeConfirm = recentVol > avgVol * 0.8 ? 1.0 : 0.7;

        const score = normalizedSlope * deltaConfirm * volumeConfirm;
        return Math.max(-1, Math.min(1, score));
    }

    /**
     * GÖREV 3: Regime Weight (Volatilite Ağırlığı)
     * 
     * Market volatilitesini ölçer.
     * - Yüksek volatilite = 1.0 (Danger Zone)
     * - Düşük volatilite = 0.0 (Stagnation)
     * 
     * Formula: Current Volatility / Historical Max Volatility
     * 
     * @returns [0.0, 1.0]
     */
    private calculateRegimeWeight(): number {
        if (this.trades.length < 5) return 0;

        const recentPrices = this.trades.slice(-30).map(t => t.price);
        if (recentPrices.length < 2) return 0;

        // 1. Returns hesabı (logaritmik dönüşler)
        const returns: number[] = [];
        for (let i = 1; i < recentPrices.length; i++) {
            const ret = (recentPrices[i] - recentPrices[i - 1]) / recentPrices[i - 1];
            returns.push(ret);
        }

        if (returns.length === 0) return 0;

        // 2. Current Volatility (Standard Deviation of Returns)
        const currentVol = this.calculateStdDev(returns);

        // 3. Volatilite history'ye ekle
        this.volatilityHistory.push(currentVol);
        if (this.volatilityHistory.length > VOLATILITY_HISTORY_SIZE) {
            this.volatilityHistory.shift();
        }

        // 4. Historical Max (son 1 saat içindeki en yüksek volatilite)
        const maxVol = Math.max(
            ...this.volatilityHistory,
            currentVol * 1.1 // Minimum %10 buffer
        );

        if (maxVol < EPSILON) return 0;

        // 5. Normalize [0, 1]
        return Math.min(1.0, currentVol / maxVol);
    }

    /**
     * GÖREV 4: Absorption Score (Geliştirilmiş)
     * 
     * Emilim gücünü ölçer: Yüksek hacim + Düşük fiyat hareketi = Yüksek absorption
     * 
     * Formula: (Volume Intensity * Price Stability) * Direction Confidence
     * 
     * @returns [0.0, 1.0] - 0.7-1.0 = Güçlü emilim (Büyük katılımcı var)
     */
    private calculateAbsorptionScore(delta1s: number): number {
        if (this.trades.length < 5) return 0;

        const window = this.trades.slice(-ABSORPTION_WINDOW);
        if (window.length < 5) return 0;

        const prices = window.map(t => t.price);
        const quantities = window.map(t => t.quantity);

        // 1. Volume Intensity
        const totalVol = quantities.reduce((sum, q) => sum + q, 0);
        const avgVol = totalVol / window.length;
        const recentVol = quantities.slice(-10).reduce((sum, q) => sum + q, 0) / Math.min(10, quantities.length);
        const volumeIntensity = avgVol > EPSILON
            ? Math.min(2.0, recentVol / avgVol) / 2
            : 0;

        // 2. Price Stability (1 - normalized range)
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        const priceRange = avgPrice > EPSILON ? (maxPrice - minPrice) / avgPrice : 0;
        // 1% range = 0 stability, 0% range = 1 stability
        const priceStability = Math.max(0, 1 - priceRange * 100);

        // 3. Direction Confidence (tutarlılık)
        // Son 10 işlemin kaçı aynı yönde?
        const recentTrades = window.slice(-10);
        const buyCount = recentTrades.filter(t => t.side === 'buy').length;
        const sellCount = recentTrades.length - buyCount;
        const dominance = Math.abs(buyCount - sellCount) / recentTrades.length;

        // 4. Delta stability (delta değişimi az mı?)
        const deltaStability = this.deltaHistory.length >= 5
            ? 1 - Math.min(1, this.calculateStdDev(this.deltaHistory.slice(-5)) / (Math.abs(delta1s) + EPSILON))
            : 0.5;

        // 5. Combine all factors
        let absorptionScore = volumeIntensity * priceStability * (0.5 + dominance * 0.5) * (0.7 + deltaStability * 0.3);

        // 6. Iceberg detection boost
        // Eğer hacim yüksek ama spread değişmiyorsa = gizli likidite
        if (volumeIntensity > 0.5 && priceStability > 0.8) {
            absorptionScore *= 1.3; // Boost
        }

        return Math.min(1.0, absorptionScore);
    }

    /**
     * GÖREV 5: Exhaustion Detection (Tükeniş Algılama)
     * 
     * Multi-Level Confirmation:
     * 1. CVD-Price Divergence
     * 2. Delta Z Reversal
     * 3. CVD Slope Flatline
     * 4. Volume Declining
     * 
     * @returns true if exhaustion detected (>= 3 conditions true)
     */
    private calculateExhaustion(
        cvd: number,
        deltaZ: number,
        priceChange: number,
        cvdSlope: number
    ): boolean {
        let exhaustionCount = 0;

        // 1. CVD-Price Divergence
        if ((cvd > 0 && priceChange < -0.05) || (cvd < 0 && priceChange > 0.05)) {
            exhaustionCount++;
        }

        // 2. Delta Z Reversal
        if (this.deltaHistory.length >= 2) {
            const lastSign = Math.sign(this.deltaHistory[this.deltaHistory.length - 1]);
            const prevSign = Math.sign(this.deltaHistory[this.deltaHistory.length - 2]);
            if (lastSign !== prevSign && lastSign !== 0 && prevSign !== 0) {
                exhaustionCount++;
            }
        }

        // 3. CVD Slope Flatline (slope çok düşük)
        if (Math.abs(cvdSlope) < 5) {
            exhaustionCount++;
        }

        // 4. Volume Declining
        if (this.volumeHistory.length >= 20) {
            const recent10 = this.volumeHistory.slice(-10).reduce((a, b) => a + b, 0);
            const prev10 = this.volumeHistory.slice(-20, -10).reduce((a, b) => a + b, 0);
            if (recent10 < prev10 * 0.8) {
                exhaustionCount++;
            }
        }

        // 5. Delta momentum fading
        if (this.deltaHistory.length >= 5) {
            const recentDeltas = this.deltaHistory.slice(-5);
            const deltaDecreasing = recentDeltas.every((d, i, arr) =>
                i === 0 || Math.abs(d) <= Math.abs(arr[i - 1]) * 1.1
            );
            if (deltaDecreasing) {
                exhaustionCount++;
            }
        }

        // En az 3 koşul true ise exhaustion
        return exhaustionCount >= 3;
    }

    // =========================================================================
    // MAIN COMPUTE METHOD
    // =========================================================================

    /**
     * Compute the current legacy metrics given the current orderbook
     * state.  The orderbook is used to derive imbalance scores.  The
     * function returns an object containing all metrics required for
     * the original UI.  Undefined values are returned as null.
     */
    computeMetrics(ob: OrderbookState) {
        // Helper to calculate raw volume for a given depth (descending for bids, ascending for asks)
        const calcVolume = (levels: Map<number, number>, depth: number, isAsk: boolean): number => {
            const entries = Array.from(levels.entries());
            // Sort: Bids Descending, Asks Ascending
            entries.sort((a, b) => isAsk ? a[0] - b[0] : b[0] - a[0]);
            let vol = 0;
            for (let i = 0; i < Math.min(depth, entries.length); i++) {
                vol += entries[i][1];
            }
            return vol;
        };

        // --- A) OBI Weighted (Normalized) ---
        // Top 10 levels
        const bidVol10 = calcVolume(ob.bids, 10, false);
        const askVol10 = calcVolume(ob.asks, 10, true);

        const rawObiWeighted = bidVol10 - askVol10;
        const denomWeighted = bidVol10 + askVol10;
        // Range: [-1, +1]
        const obiWeighted = denomWeighted > EPSILON ? rawObiWeighted / denomWeighted : 0;

        // --- B) OBI Deep Book (Normalized) ---
        // Top 50 levels (representing deep liquidity)
        const bidVol50 = calcVolume(ob.bids, 50, false);
        const askVol50 = calcVolume(ob.asks, 50, true);

        const rawObiDeep = bidVol50 - askVol50;
        const denomDeep = bidVol50 + askVol50;
        // Range: [-1, +1]
        const obiDeep = denomDeep > EPSILON ? rawObiDeep / denomDeep : 0;

        // --- C) OBI Divergence (Stable Definition) ---
        // Difference between weighted (near) and deep OBI
        // Range: [-2, +2]
        const obiDivergence = obiWeighted - obiDeep;

        // Recompute rolling delta windows.
        const refTime = this.trades.length > 0
            ? this.trades[this.trades.length - 1].timestamp
            : Date.now();
        let delta1s = 0;
        let delta5s = 0;
        for (const t of this.trades) {
            if (t.timestamp >= refTime - 1_000) {
                delta1s += t.side === 'buy' ? t.quantity : -t.quantity;
            }
            if (t.timestamp >= refTime - 5_000) {
                delta5s += t.side === 'buy' ? t.quantity : -t.quantity;
            }
        }

        // Z‐score of delta1s: (value - mean) / std
        let deltaZ = 0;
        if (this.deltaHistory.length >= 5) {
            const mean = this.deltaHistory.reduce((a, b) => a + b, 0) / this.deltaHistory.length;
            const variance = this.deltaHistory.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / this.deltaHistory.length;
            const std = Math.sqrt(variance);
            deltaZ = std > EPSILON ? (delta1s - mean) / std : 0;
        }

        // CVD slope: simple linear regression on the last cvdHistory values
        const cvdSlope = this.calculateSlope(this.cvdHistory);

        // VWAP: totalNotional / totalVolume
        const vwap = this.totalVolume > EPSILON ? this.totalNotional / this.totalVolume : 0;

        // Compose object
        const bestBidPrice = bestBid(ob) ?? 0;
        const bestAskPrice = bestAsk(ob) ?? 0;
        const spread = bestAskPrice - bestBidPrice;
        const midPrice = (bestBidPrice + bestAskPrice) / 2;

        // Calculate price change for exhaustion
        const priceChange = this.lastMidPrice > EPSILON
            ? (midPrice - this.lastMidPrice) / this.lastMidPrice
            : 0;
        this.lastMidPrice = midPrice;

        // ===== ADVANCED METRICS CALCULATIONS =====

        // --- Sweep/Fade Score ---
        const sweepFadeScore = this.calculateSweepFadeScore(spread, midPrice);

        // --- Breakout Score ---
        const breakoutScore = this.calculateBreakoutScore(delta1s);

        // --- Regime Weight ---
        const regimeWeight = this.calculateRegimeWeight();

        // --- Absorption Score ---
        const absorptionScore = this.calculateAbsorptionScore(delta1s);

        // --- Exhaustion Flag ---
        const exhaustion = this.calculateExhaustion(this.cvdSession, deltaZ, priceChange, cvdSlope);

        // --- Signal ---
        // Enhanced composite signal with multiple confirmations
        let tradeSignal = 0; // 0=Neutral, 1=Buy, -1=Sell

        // Buy conditions
        const buyConditions = [
            obiWeighted > 0.2,
            deltaZ > 0.8,
            cvdSlope > 0,
            sweepFadeScore > 0.3,
            breakoutScore > 0.2
        ].filter(Boolean).length;

        // Sell conditions
        const sellConditions = [
            obiWeighted < -0.2,
            deltaZ < -0.8,
            cvdSlope < 0,
            sweepFadeScore < -0.3,
            breakoutScore < -0.2
        ].filter(Boolean).length;

        if (buyConditions >= 3 && !exhaustion) tradeSignal = 1;
        else if (sellConditions >= 3 && !exhaustion) tradeSignal = -1;

        return {
            price: midPrice,
            obiWeighted,
            obiDeep,
            obiDivergence,
            delta1s,
            delta5s,
            deltaZ,
            cvdSession: this.cvdSession,
            cvdSlope,
            vwap,
            totalVolume: this.totalVolume,
            totalNotional: this.totalNotional,
            absorptionScore,
            sweepFadeScore,
            breakoutScore,
            regimeWeight,
            tradeCount: this.trades.length,
            tradeSignal,
            exhaustion
        };
    }
}