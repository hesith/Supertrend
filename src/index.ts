

// @ts-ignore
import 'dotenv/config';
import { BinanceConfig } from "./classes/binance-config";
import { colorTrend, getPostionType } from './utilities/general';
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

        const capital = 100
        const leverage = 2;
        const position = capital * leverage;
        const orderFee = position * (0.04 / 100);
        const takeProfitPerc = 30 / 100;


        let lastTrend: 'up' | 'down' | undefined = undefined;
        let hasOpenedPosition = false;
        let hasTradedInCurrentTrend = false;

        // logging
        let orderQty: number;
        let orderTrendDir: 'up' | 'down' | undefined | null;
        let takeProfit: number = 0;

        const logOrderResult = async (openOrClose: PositionType, orderTrendDirection: 'up' | 'down' | undefined, assetPrice: number) => {
            if (orderTrendDirection == undefined) return;

            console.log(new Date().toLocaleTimeString())

            if (openOrClose == PositionType.Open) {
                orderQty = position / assetPrice;

                orderTrendDir = orderTrendDirection;
                console.log('Opening position', getPostionType(orderTrendDirection), '. Current Price', assetPrice);
                hasOpenedPosition = true;
                await setTakeProfit();
            } else {
                const closingOrderValue = orderQty * assetPrice;
                if (orderTrendDir == 'up') {
                    console.log('Closing position. Current Price', assetPrice, 'Profit', closingOrderValue - position - (orderFee * 2));
                } else if (orderTrendDir == 'down') {
                    console.log('Closing position. Current Price', assetPrice, 'Profit', position - closingOrderValue - (orderFee * 2));
                }

                hasOpenedPosition = false;
                orderQty = 0;
                orderTrendDir = undefined;
                takeProfit = 0;
                hasTradedInCurrentTrend = true;
            }
        }

        const setTakeProfit = async () => {
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
                    takeProfit = previousCandleClose + takeProfitLength;
                }
                else {
                    takeProfit = previousCandleClose - takeProfitLength;
                }

                console.log('Take profit set to:', takeProfit);
            } catch (ex) {
                console.log('Take profit calculation error:', ex);
            }
        }

        const closeIfTakeProfitHit = async () => {
            if (!hasOpenedPosition || takeProfit === 0) return;

            const currentPrice = binance.getLivePrice();

            if (orderTrendDir == 'up') {
                if (currentPrice >= takeProfit) {
                    console.log('Take profit hit.');
                    await logOrderResult(PositionType.Close, 'up', currentPrice)
                }
            }
            else {
                if (currentPrice <= takeProfit) {
                    console.log('Take profit hit.');
                    await logOrderResult(PositionType.Close, 'up', currentPrice)
                }
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
                        console.log("opening a position in the direction", colorTrend(secondPreviousCandleTrend))

                        await logOrderResult(PositionType.Open, secondPreviousCandleTrend, binance.getLivePrice());

                    }

                    await closeIfTakeProfitHit(); // close if take profit hit

                    if (hasOpenedPosition && secondPreviousCandleTrend == lastTrend) {
                        // close the position normally (after 5 min candle close)
                        console.log("Closing position.")

                        await logOrderResult(PositionType.Close, 'up', binance.getLivePrice())

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