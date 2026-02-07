export interface SupertrendPoint {
    upperBand: number;
    lowerBand: number;
    supertrend: number;
    trend: 'up' | 'down' | undefined;
}