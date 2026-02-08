

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
        await fetch("https://supertrend-u6g0.onrender.com");
        console.log("🔔 Self-ping successful");
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

        const capital = 100
        const leverage = 2;
        const position = capital * leverage;
        const orderFee = capital * (0.04 / 100);

        let lastTrend: 'up' | 'down' | undefined = undefined;
        let hasOpenedPosition = false;

        // logging
        let orderQty: number;
        let orderTrendDir: 'up' | 'down' | undefined | null;

        const logOrderResult = (openOrClose: PositionType, orderTrendDirection: 'up' | 'down' | undefined, assetPrice: number) => {
            if (orderTrendDirection == undefined) return;

            console.log(new Date().toLocaleTimeString())

            if (openOrClose == PositionType.Open) {
                orderQty = position / assetPrice;

                orderTrendDir = orderTrendDirection;
                console.log('Opening position', getPostionType(orderTrendDirection), '. Current Price', assetPrice);
            } else {
                const closingOrderValue = orderQty * assetPrice;
                if (orderTrendDir == 'up') {
                    console.log('Closing position. Current Price', assetPrice, 'Profit', closingOrderValue - position - (orderFee * 2));
                } else if (orderTrendDir == 'down') {
                    console.log('Closing position. Current Price', assetPrice, 'Profit', position - closingOrderValue - (orderFee * 2));
                }

                orderQty = 0;
                orderTrendDir = undefined;
            }
        }

        while (true) {
            try {
                const candles = await binance.getCandlesByPublicEndpoint('ETHUSDT', '5m', 150);
                const st = binance.calculateSupertrend(candles);

                // st.forEach((point, idx) => {
                //     console.log(
                //         `Candle ${idx + 1}: Supertrend=${point.supertrend.toFixed(2)}, Trend=${colorTrend(point.trend)}`
                //     );
                // });

                const currentCandleTrend = st[st.length - 1]?.trend;

                const previousCandleTrend = st[st.length - 2]?.trend;
                const secondPreviousCandleTrend = st[st.length - 3]?.trend;

                const thirdPreviousCandleTrend = st[st.length - 4]?.trend;

                if (!lastTrend) {
                    // if trend not set, set here (possibly at the beginning)
                    lastTrend = currentCandleTrend;
                    console.log(new Date().toLocaleTimeString())
                    console.log('Setting trend', colorTrend(lastTrend))

                } else {
                    if (currentCandleTrend != lastTrend) {
                        // pre identify trend change
                        console.log(`Trend reversing ${colorTrend(lastTrend) + ' ==>> ' + colorTrend(currentCandleTrend)}`)
                    }


                    if (previousCandleTrend != secondPreviousCandleTrend && !hasOpenedPosition) {
                        // confirm trend change
                        console.log("Trend reveresed to", colorTrend(previousCandleTrend))
                        lastTrend = previousCandleTrend;

                        // Open a position here
                        console.log("opening a position in the direction", colorTrend(secondPreviousCandleTrend))

                        logOrderResult(PositionType.Open, secondPreviousCandleTrend, await binance.getPrice('ETHUSDT'));

                        hasOpenedPosition = true;
                    }

                    if (hasOpenedPosition && secondPreviousCandleTrend == lastTrend) {
                        // close the position
                        console.log("Closing position.")

                        logOrderResult(PositionType.Close, 'up', await binance.getPrice('ETHUSDT'))

                        hasOpenedPosition = false;
                    }
                }

            } catch (err) {
                console.error('Error:', err);
            }

            // ⏱ wait 2 seconds
            await sleep(2000);
        }


    })()
};