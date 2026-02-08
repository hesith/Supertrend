import axios from 'axios';
import 'dotenv/config';
import Binance from 'node-binance-api';
import { ATR } from 'technicalindicators';
import { SupertrendPoint } from '../interfaces/binance/indicators/supertrend';

export class BinanceConfig {
    private binance: any;

    constructor() {
        this.binance = new Binance().options({
            APIKEY: process.env.API_KEY!,
            APISECRET: process.env.API_SECRET!,
            useServerTime: true,
            test: true // 🔴 set false for real trading
        });
    }

    // ---------- Get Current Price ----------
    getPrice = async (symbol: string) => {
        try {
            const prices = await this.binance?.prices(symbol);
            console.log(`\n${symbol} price: ${prices[symbol]}`);
            return prices[symbol];
        } catch (error: any) {
            console.error('Price error:', error?.body || error);
            return null;
        }
    }

    getCandles = async (symbol: string, interval: string = '1h', limit: number = 100) => {
        return new Promise<{ open: number; high: number; low: number; close: number }[]>((resolve, reject) => {
            this.binance.candlesticks(symbol, interval, (error: any, ticks: any[]) => {
                if (error) return reject(error);
                if (!ticks || ticks.length === 0) return reject(new Error("No candle data"));

                const candles = ticks.map(t => ({
                    open: parseFloat(t[1]),
                    high: parseFloat(t[2]),
                    low: parseFloat(t[3]),
                    close: parseFloat(t[4]),
                }));

                resolve(candles.slice(-limit));
            }, { limit });
        });
    };

    getCandlesByPublicEndpoint = async (symbol: string, interval: string = '5m', limit: number = 100) => {
        try {
            const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
            const resp = await axios.get(url);
            const candles = resp.data.map((t: any) => ({
                open: parseFloat(t[1]),
                high: parseFloat(t[2]),
                low: parseFloat(t[3]),
                close: parseFloat(t[4]),
            }));
            return candles;
        } catch (err) {
            console.error('Error fetching candles', err);
            return [];
        }
    };


    calculateSupertrend = (
        candles: { high: number; low: number; close: number }[],
        period: number = 12,
        multiplier: number = 3
    ): SupertrendPoint[] => {
        if (candles.length < period + 1) {
            throw new Error('Not enough candles');
        }

        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const closes = candles.map(c => c.close);

        const atr = ATR.calculate({ high: highs, low: lows, close: closes, period });

        const result: SupertrendPoint[] = [];

        // Align candles with ATR
        for (let i = 0; i < atr.length; i++) {
            const idx = i + period;
            const high = highs[idx];
            const low = lows[idx];
            const close = closes[idx];
            const hl2 = (Number(high) + Number(low)) / 2;

            let upperBand = hl2 + multiplier * Number(atr[i]);
            let lowerBand = hl2 - multiplier * Number(atr[i]);

            if (i === 0) {
                result.push({
                    upperBand,
                    lowerBand,
                    supertrend: upperBand,
                    trend: 'down',
                });
                continue;
            }

            const prev = result[i - 1];

            // 🔹 Band persistence
            if (prev?.trend === 'up') {
                lowerBand = Math.max(lowerBand, prev.lowerBand);
            } else {
                upperBand = Math.min(upperBand, Number(prev?.upperBand));
            }

            let trend = prev?.trend;

            // 🔹 Trend switch logic
            if (prev?.trend === 'down' && Number(close) > prev.upperBand) {
                trend = 'up';
            } else if (prev?.trend === 'up' && Number(close) < prev.lowerBand) {
                trend = 'down';
            }

            const supertrend = trend === 'up' ? lowerBand : upperBand;

            result.push({
                upperBand,
                lowerBand,
                supertrend,
                trend,
            });
        }

        return result;
    };


}


