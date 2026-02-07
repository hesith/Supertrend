interface BinanceBalance {
  available: string;
  onOrder: string;
}

export type BinanceBalances = Record<string, BinanceBalance>;
