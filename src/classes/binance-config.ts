import axios from 'axios';
import 'dotenv/config';
import Binance from 'node-binance-api';
import { ATR } from 'technicalindicators';
import { SupertrendPoint } from '../interfaces/binance/indicators/supertrend';
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import crypto from "crypto";

// Proxy string
const proxyString = process.env.PROXY_STRING || '';
const [host, port, username, password] = proxyString.split(":");
const proxyUrl = `http://${username}:${password}@${host}:${port}`;

const BASE_URL = "https://fapi.binance.com";

export class BinanceConfig {
    private binance: any;
    private proxyAgent: any;

    private priceSocket: WebSocket | null = null;
    private latestPrice: number | null = null;

    constructor() {
        this.binance = new Binance().options({
            APIKEY: process.env.API_KEY!,
            APISECRET: process.env.API_SECRET!,
            useServerTime: true,
            test: true // 🔴 set false for real trading
        });

        this.proxyAgent = new HttpsProxyAgent(proxyUrl);

    }

    //#region Websocket
    startFuturesPriceStream(symbol: string) {
        const stream = symbol.toLowerCase();
        const wsUrl = `wss://fstream.binance.com/ws/${stream}@markPrice`;

        const connect = () => {
            console.log(`🔌 Futures WS connecting for ${symbol}.P`);

            this.priceSocket = new WebSocket(wsUrl);

            this.priceSocket.on("message", (data) => {
                const payload = JSON.parse(data.toString());

                // mark price
                this.latestPrice = parseFloat(payload.p);
            });

            this.priceSocket.on("open", () => {
                console.log(`✅ Futures WS connected: ${symbol}.P`);
            });

            this.priceSocket.on("close", () => {
                console.warn("⚠️ Futures WS closed. Reconnecting...");
                setTimeout(connect, 3000);
            });

            this.priceSocket.on("error", () => {
                this.priceSocket?.close();
            });
        };

        connect();
    }

    getLivePrice(): number {
        if (this.latestPrice === null) {
            throw new Error("Price not ready yet");
        }
        return this.latestPrice;
    }
    //#endregion

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

    getFuturesCandlesByPublicEndpoint = async (symbol: string, interval: string = '15m', limit: number = 100) => {
        try {
            const url = BASE_URL + `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
            const resp = await axios.get(url, {
                httpsAgent: this.proxyAgent,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                },
            });
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

    /** sign query string */
    sign = (queryString: string): string =>
        crypto
            .createHmac("sha256", process.env.API_SECRET || '')
            .update(queryString)
            .digest("hex");

    getServerTime = async () =>
        (await axios.get(`${BASE_URL}/fapi/v1/time`)).data.serverTime;

    getFuturesUSDTBalance = async () => {
        const serverTime = await this.getServerTime();

        const queryString = `timestamp=${serverTime}`;
        const signature = this.sign(queryString);

        const { data } = await axios.get(
            `${BASE_URL}/fapi/v2/balance?${queryString}&signature=${signature}`,
            { headers: { "X-MBX-APIKEY": process.env.API_KEY } }
        );

        return data.find((a: any) => a.asset === "USDT");
    };
}


