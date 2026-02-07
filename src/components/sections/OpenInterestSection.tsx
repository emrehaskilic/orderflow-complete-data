import React from 'react';
import { OpenInterestMetrics } from '../../types/metrics';

interface OpenInterestSectionProps {
    metrics: OpenInterestMetrics;
}

export const OpenInterestSection: React.FC<OpenInterestSectionProps> = ({ metrics }) => {
    const signalColors = {
        bullish: 'text-green-400 bg-green-900/20 border border-green-800/30',
        bearish: 'text-red-400 bg-red-900/20 border border-red-800/30',
        neutral: 'text-zinc-400 bg-zinc-900/20 border border-zinc-800/30',
    };

    const trendIcons: Record<string, string> = {
        up: '📈',
        down: '📉',
        flat: '➡️',
    };

    return (
        <section className="space-y-3 pt-3 border-t border-zinc-800/50">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                Open Interest (Futures)
            </h3>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                {/* OI Value */}
                <div className="flex flex-col h-20 justify-between p-2.5 bg-zinc-900/40 rounded-lg border border-zinc-800/30">
                    <div className="text-[10px] font-bold text-zinc-500 uppercase">Current OI</div>
                    <div className="text-xl font-mono font-bold text-zinc-200 truncate">
                        {(metrics.openInterest / 1_000_000).toFixed(2)}M
                    </div>
                    <div className="text-[8px] text-zinc-600">Contracts</div>
                </div>

                {/* OI Delta */}
                <div className="flex flex-col h-20 justify-between p-2.5 bg-zinc-900/40 rounded-lg border border-zinc-800/30">
                    <div className="text-[10px] font-bold text-zinc-500 uppercase">OI Change</div>
                    <div className={`text-xl font-mono font-bold truncate ${metrics.delta > 0 ? 'text-green-400' : metrics.delta < 0 ? 'text-red-400' : 'text-zinc-400'
                        }`}>
                        {metrics.delta > 0 ? '+' : ''}{(metrics.delta / 1_000_000).toFixed(2)}M
                    </div>
                    <div className={`text-[9px] font-mono ${metrics.deltaPercent > 0 ? 'text-green-500' : metrics.deltaPercent < 0 ? 'text-red-500' : 'text-zinc-500'
                        }`}>
                        {metrics.deltaPercent > 0 ? '+' : ''}{metrics.deltaPercent.toFixed(2)}%
                    </div>
                </div>

                {/* Trend */}
                <div className="flex flex-col h-20 justify-between p-2.5 bg-zinc-900/40 rounded-lg border border-zinc-800/30">
                    <div className="text-[10px] font-bold text-zinc-500 uppercase">Trend</div>
                    <div className="flex items-center gap-2">
                        <span className="text-xl">{trendIcons[metrics.trend]}</span>
                        <span className="text-sm font-bold text-zinc-300 capitalize">
                            {metrics.trend}
                        </span>
                    </div>
                    <div className="text-[8px] text-zinc-600">Direction</div>
                </div>

                {/* Signal */}
                <div className="flex flex-col h-20 justify-between p-2.5 bg-zinc-900/40 rounded-lg border border-zinc-800/30">
                    <div className="text-[10px] font-bold text-zinc-500 uppercase">Signal</div>
                    <div className={`text-xs font-bold px-2 py-1 rounded w-fit capitalize ${signalColors[metrics.signal]
                        }`}>
                        {metrics.signal}
                    </div>
                    <div className="text-[8px] text-zinc-600">Sentiment</div>
                </div>
            </div>

            {/* OI Interpretation */}
            <div className="bg-blue-900/10 border border-blue-800/20 rounded p-2.5 text-[10px] text-blue-300/80 leading-relaxed">
                {metrics.trend === 'up' && metrics.delta > 0 ? (
                    <span>
                        <strong>📈 OI Increasing:</strong> More traders entering positions.
                        {metrics.signal === 'bullish' && ' Bullish validation if price is up.'}
                    </span>
                ) : metrics.trend === 'down' && metrics.delta < 0 ? (
                    <span>
                        <strong>📉 OI Decreasing:</strong> Traders exiting positions.
                        {metrics.signal === 'bearish' && ' Bearish validation if price is down.'}
                    </span>
                ) : (
                    <span>
                        <strong>➡️ OI Stable:</strong> No significant change in open positions.
                    </span>
                )}
            </div>
        </section>
    );
};
