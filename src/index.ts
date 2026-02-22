

// @ts-ignore
import 'dotenv/config';
import { BinanceConfig } from "./classes/binance-config";
import { colorTrend, getPostionSide, getPostionType } from './utilities/general';
// @ts-ignore
import express from "express";
// @ts-ignore
import { Request, Response } from "express";

const cron = require("node-cron");

/* =========================
   Express Health Server
   ========================= */

const app = express();
const PORT = process.env.PORT || 3000;

let botStarted = false; // 🔐 IMPORTANT GUARD

app.get("/", (_req: Request, res: Response) => {
    console.log("🔔 Ping received");
    if (!botStarted) {
        botStarted = true;
        console.log("🚀 Starting trading bot...");
        startBot(); // start bot ONLY once
    }
    res.status(200).send("Trading bot is running");
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Health server listening on port ${PORT}`);
});

/* =========================
   Self Ping (Safe Now)
   ========================= */

cron.schedule("*/13 * * * *", async () => {
    try {
        await fetch("https://supertrend-31go.onrender.com");
        console.log("🔔 Self-ping sent");
    } catch (err) {
        console.error("Ping failed:", err);
    }
});

/* =========================
   Trading Bot Logic
   ========================= */

const sleep = (ms: number) =>
    new Promise(resolve => setTimeout(resolve, ms));

enum PositionType {
    Open = 1,
    Close = 2
}

function startBot() {
    (async () => {
        const binance = new BinanceConfig()
        binance.startFuturesPriceStream("ETHUSDT");

        const leverage = 2;
        const takeProfitPerc = 30 / 100;

        let lastTrend: 'up' | 'down' | undefined = undefined;
        let hasOpenedPosition = false;
        let hasTradedInCurrentTrend = false;

        const getTakeProfit = async (orderTrendDir: 'up' | 'down') => {
            try {
                // ⏱ wait 5 seconds to avoid update latencies
                await sleep(5000);

                const candles = await binance.getFuturesCandlesByPublicEndpoint('ETHUSDT', '15m', 2);
                const previousCandle = candles?.[0];

                const previousCandleOpen = previousCandle?.open;
                const previousCandleClose = previousCandle?.close;
                const previousBodyLength = Math.abs(previousCandleClose - previousCandleOpen);
                const takeProfitLength = previousBodyLength * takeProfitPerc;

                if (orderTrendDir == 'up') {
                    return previousCandleClose + takeProfitLength;
                }
                else {
                    return previousCandleClose - takeProfitLength;
                }
            } catch (ex) {
                console.log('Take profit calculation error:', ex);
            }
        }

        const startOrder = async (orderTrend: 'up' | 'down') => {
            if (await binance.getCurrentlyOpenedPosition() != 0) return;
            
            try {
                const tradableBalance = await binance.getFuturesUSDTBalance();

                if (tradableBalance?.availableBalance) {
                    const orderSide = getPostionSide(orderTrend);
                    const orderCapital = Math.floor(Number(tradableBalance?.availableBalance));
                    console.log('Tradable balance:', orderCapital);

                    if (orderSide) {
                        const payload = { side: orderSide, usdtAmount: orderCapital, leverage }
                        const { filledQty, side } = await binance.openPosition(payload);

                        if (filledQty) {
                            console.log("Opened a", side, "position at", binance.getLivePrice(), "USDT. Position size:", orderCapital * leverage, "USDT");
                            hasOpenedPosition = true;

                            const filledQuantity = Number(filledQty.toString());
                            const tp = await getTakeProfit(orderTrend)
                            const payload = { filledQty: filledQuantity, side: orderSide, takeProfit: tp }
                            const res = await binance.placeTakeProfit(payload);

                            if (res) {
                                console.log("Take profit set:", tp, "USDT");
                            } else {
                                console.log("Take profit setting failed");
                            }
                        }
                    }
                }
            } catch (ex) {
                console.log('Order open error', ex)
            }
        }

        const closeOrder = async () => {
            try {
                const res = await binance.closePositionFully();

                if (res.filledQty) {
                    console.log("Position closed after expiration at", binance.getLivePrice())

                    hasOpenedPosition = false;
                    hasTradedInCurrentTrend = true;
                }
            } catch (ex) {
                console.log('Order close error', ex)
            }
        }

        while (true) {
            try {
                const candles = await binance.getFuturesCandlesByPublicEndpoint('ETHUSDT', '15m', 150);
                const st = binance.calculateSupertrend(candles);

                // st.forEach((point, idx) => {
                //     console.log(
                //         `Candle ${idx + 1}: Supertrend=${point.supertrend.toFixed(2)}, Trend=${colorTrend(point.trend)}`
                //     );
                // });

                const currentCandleTrend = st[st.length - 1]?.trend;

                const previousCandleTrend = st[st.length - 2]?.trend;
                const secondPreviousCandleTrend = st[st.length - 3]?.trend;

                if (!lastTrend) {
                    // if trend not set, set here (possibly at the beginning)
                    lastTrend = currentCandleTrend;
                    console.log(new Date().toLocaleTimeString())
                    console.log('Setting trend', colorTrend(lastTrend))

                } else {
                    if (currentCandleTrend != lastTrend) {
                        // pre identify trend change
                        console.log(`Trend reversing ${colorTrend(lastTrend) + ' ==>> ' + colorTrend(currentCandleTrend)}`)
                        if (hasTradedInCurrentTrend) hasTradedInCurrentTrend = false;
                    }

                    if (previousCandleTrend != secondPreviousCandleTrend && !hasOpenedPosition && !hasTradedInCurrentTrend) {
                        // confirm trend change
                        console.log("Trend reveresed to", colorTrend(previousCandleTrend));
                        lastTrend = previousCandleTrend;

                        // Open a position here
                        if (secondPreviousCandleTrend) startOrder(secondPreviousCandleTrend);
                    }

                    if (hasOpenedPosition && secondPreviousCandleTrend == lastTrend) {
                        // close the position normally (after 15 min candle close)
                        await closeOrder();
                    }

                    if (hasOpenedPosition) {
                        // identify auto closed position then reset values
                        const positionAmt = await binance.getCurrentlyOpenedPosition();

                        if (positionAmt === 0) {
                            hasOpenedPosition = false;
                            hasTradedInCurrentTrend = true;
                        }
                    }
                }

            } catch (err) {
                console.error('Error:', err);
            } finally {
                // ⏱ wait 2 seconds
                await sleep(2000);
            }

        }


    })()
};