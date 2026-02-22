import axios from 'axios';
import crypto from "crypto";
import 'dotenv/config';
import { HttpsProxyAgent } from "https-proxy-agent";
import Binance from 'node-binance-api';
import { ATR } from 'technicalindicators';
import WebSocket from "ws";
import { SupertrendPoint } from '../interfaces/binance/indicators/supertrend';

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

            this.priceSocket.on("message", (data: any) => {
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
        (await axios.get(`${BASE_URL}/fapi/v1/time`, { httpsAgent: this.proxyAgent, })).data.serverTime;

    getFuturesUSDTBalance = async () => {
        const serverTime = await this.getServerTime();

        const queryString = `timestamp=${serverTime}`;
        const signature = this.sign(queryString);

        const { data } = await axios.get(
            `${BASE_URL}/fapi/v2/balance?${queryString}&signature=${signature}`,
            { httpsAgent: this.proxyAgent, headers: { "X-MBX-APIKEY": process.env.API_KEY } }
        );

        return data.find((a: any) => a.asset === "USDT");
    };

    openPosition = async ({
        side,
        usdtAmount,
        leverage,
    }: {
        side: "BUY" | "SELL";
        usdtAmount: number;
        leverage: number;
    }) => {
        const symbol = "ETHUSDT";
        const serverTime = await this.getServerTime();

        // Set leverage
        const levQuery = `symbol=${symbol}&leverage=${leverage}&timestamp=${serverTime}`;

        console.log('Sending leverage request.. Leverage:', leverage);
        await axios.post(
            `${BASE_URL}/fapi/v1/leverage?${levQuery}&signature=${this.sign(levQuery)}`,
            null,
            { httpsAgent: this.proxyAgent, headers: { "X-MBX-APIKEY": process.env.API_KEY } }
        );


        // Calculate quantity
        const price = this.getLivePrice();
        const positionNotional = usdtAmount * leverage;
        let quantity = positionNotional / price;
        quantity = Math.floor(quantity * 1000) / 1000; // ETH precision

        // Place MARKET order
        const entryQuery = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${serverTime}`;
        const entryResp = await axios.post(
            `${BASE_URL}/fapi/v1/order?${entryQuery}&signature=${this.sign(entryQuery)}`,
            null,
            { httpsAgent: this.proxyAgent, headers: { "X-MBX-APIKEY": process.env.API_KEY } }
        );

        // Binance returns filled quantity
        const filledQty = entryResp.data?.origQty || entryResp.data?.executedQty;
        if (!filledQty) throw new Error("Failed to get filled quantity");

        return { filledQty, side };
    };

    placeTakeProfit = async ({
        filledQty,
        side,
        takeProfit,
    }: {
        filledQty: number;
        side: "BUY" | "SELL";
        takeProfit: number;
    }) => {
        const exitSide = side === "BUY" ? "SELL" : "BUY";
        const serverTime = await this.getServerTime();

        // Round to 2 decimal places because step size is 0.01
        const roundedPrice = Number(takeProfit.toFixed(2));
        const roundedQty = Number(filledQty.toFixed(2));

        const query = `symbol=ETHUSDT&side=${exitSide}&type=LIMIT&timeinforce=GTC&price=${roundedPrice}&reduceOnly=true&quantity=${roundedQty}&timestamp=${serverTime}`;

        console.log('Getting currently openened position...', await this.getCurrentlyOpenedPosition())
        console.log('Placing Take Profit at..', roundedPrice, 'on', roundedQty, 'ETH');

        await axios.post(
            `${BASE_URL}/fapi/v1/order?${query}&signature=${this.sign(query)}`,
            null,
            { httpsAgent: this.proxyAgent, headers: { "X-MBX-APIKEY": process.env.API_KEY } }
        );

        return "Take Profit set";
    };

    placeStopLoss = async ({
        filledQty,
        side,
        stopLoss,
    }: {
        filledQty: number;
        side: "BUY" | "SELL";
        stopLoss: number;
    }) => {
        const exitSide = side === "BUY" ? "SELL" : "BUY";
        const serverTime = await this.getServerTime();

        const query = `symbol=ETHUSDT&side=${exitSide}&type=STOP_MARKET&stopPrice=${stopLoss}&reduceOnly=true&quantity=${filledQty}&timestamp=${serverTime}`;

        console.log('Placing Stop Loss at..', stopLoss);

        await axios.post(
            `${BASE_URL}/fapi/v1/order?${query}&signature=${this.sign(query)}`,
            null,
            { httpsAgent: this.proxyAgent, headers: { "X-MBX-APIKEY": process.env.API_KEY } }
        );

        return "Stop Loss set";
    };

    getCurrentlyOpenedPosition = async () => {
        const symbol = "ETHUSDT";
        const timestamp = Date.now();

        const query = `symbol=${symbol}&timestamp=${timestamp}`;
        const signature = this.sign(query);

        // 1️⃣ Get current position
        const posResp = await axios.get(
            `${BASE_URL}/fapi/v2/positionRisk?${query}&signature=${signature}`,
            { httpsAgent: this.proxyAgent, headers: { "X-MBX-APIKEY": process.env.API_KEY } }
        );


        return Number(posResp.data[0].positionAmt);
    }

    closePositionFully = async () => {
        const symbol = "ETHUSDT";

        // 1️⃣ Get current position
        console.log('Getting currently openened position...')
        const positionAmt = await this.getCurrentlyOpenedPosition();

        if (positionAmt === 0) return { message: "No open position" };
        console.log('Position:', positionAmt);

        const side = positionAmt > 0 ? "BUY" : "SELL"; // original side
        const exitSide = positionAmt > 0 ? "SELL" : "BUY";

        // 2️⃣ Close using MARKET order
        const serverTime = await this.getServerTime();

        const query = `symbol=${symbol}&side=${exitSide}&type=MARKET&quantity=${Math.abs(
            positionAmt
        )}&reduceOnly=true&timestamp=${serverTime}`;

        const resp = await axios.post(
            `${BASE_URL}/fapi/v1/order?${query}&signature=${this.sign(query)}`,
            null,
            { httpsAgent: this.proxyAgent, headers: { "X-MBX-APIKEY": process.env.API_KEY } }
        );

        return {
            message: "Position fully closed",
            orderId: resp.data.orderId,
            filledQty: resp.data.executedQty,
        };
    };


}


