import React from 'react';

export interface MetricCardProps {
    title: string;
    value: number;
    showBar?: boolean;
    min?: number;
    max?: number;
    suffix?: string;
    status?: 'positive' | 'negative' | 'neutral' | 'warning' | 'highlight';
    formatter?: (val: number) => string;
}

export const MetricCard: React.FC<MetricCardProps> = ({
    title,
    value,
    showBar = false,
    min = 0,
    max = 100,
    suffix = '',
    status = 'neutral',
    formatter
}) => {

    const statusColors = {
        positive: 'text-green-400 bg-green-900/20 border-green-800/30',
        negative: 'text-red-400 bg-red-900/20 border-red-800/30',
        neutral: 'text-zinc-400 bg-zinc-900/20 border-zinc-800/30',
        warning: 'text-yellow-400 bg-yellow-900/20 border-yellow-800/30',
        highlight: 'text-blue-400 bg-blue-900/20 border-blue-800/30',
    };

    const barColors = {
        positive: 'bg-green-500',
        negative: 'bg-red-500',
        neutral: 'bg-zinc-500',
        warning: 'bg-yellow-500',
        highlight: 'bg-blue-500',
    };

    // Calculate percentage for bar. If min is negative (e.g. -100 to 100), adjust calculation.
    // For range -100 to 100, value 0 is 50%.
    const range = max - min;
    const percentage = Math.min(100, Math.max(0, ((value - min) / range) * 100));

    const displayValue = formatter ? formatter(value) : (Number.isInteger(value) ? value : value.toFixed(2));

    return (
        <div className={`flex flex-col h-20 justify-between p-2.5 rounded-lg border transition-all duration-200 ${statusColors[status]} hover:brightness-110`}>
            <div className="flex justify-between items-start">
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider leading-tight w-2/3">{title}</span>
                <span className="text-sm font-mono font-bold tracking-tight">
                    {value > 0 && status === 'positive' ? '+' : ''}{displayValue}<span className="text-[0.7em] ml-0.5 opacity-60 font-sans">{suffix}</span>
                </span>
            </div>

            {showBar && (
                <div className="w-full h-1.5 bg-zinc-950/40 rounded-full overflow-hidden mt-auto mb-1">
                    <div
                        className={`h-full transition-all duration-500 ${barColors[status]}`}
                        style={{ width: `${percentage}%` }}
                    />
                </div>
            )}

            {!showBar && <div className="mt-auto"></div>}

            <div className="flex justify-between items-center text-[8px] text-zinc-500/60 font-mono pt-1 border-t border-zinc-800/10">
                <span>{min}</span>
                <span>{max}</span>
            </div>
        </div>
    );
};
