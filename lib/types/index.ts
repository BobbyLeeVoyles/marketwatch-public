export interface HourlyCandle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FiveMinCandle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FiveMinIndicators {
  rsi7: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbWidth: number;
  ema5: number;
  ema10: number;
  momentum1: number; // 1-candle (5-min) return %
  momentum3: number; // 3-candle (15-min) return %
  volumeRatio: number;
  atr5: number;
}

export interface Indicators {
  sma3: number;
  sma6: number;
  sma12: number;
  volatility: number;
  pricePosition: number;
  momentum3h: number;
}

export interface BTCData {
  timestamp: Date;
  price: number;
  hourlyData: HourlyCandle[];
  indicators: Indicators;
  fiveMinData?: FiveMinCandle[];
  fiveMinIndicators?: FiveMinIndicators;
  prevWindowReturn?: number; // % return of the just-completed 15-min window
}

export interface FeeStructure {
  takerFeePct: number;
  makerFeePct: number;
  settlementFeePct: number;
}

export interface Signal {
  active: boolean;
  strategy?: 'conservative' | 'aggressive' | 'fifteenMin';
  direction?: 'yes' | 'no';
  strike?: number;
  entryPrice?: number;
  estimatedProbability?: number;
  maxEntryPrice?: number;
  positionSize?: number;
  contracts?: number;
  exitStrategy?: string;
  failedCriteria?: string[];
  criteriaChecks?: CriteriaCheck[];
}

export interface CriteriaCheck {
  label: string;
  passed: boolean;
  value?: string;
}

export interface Trade {
  id: string;
  timestamp: Date;
  strategy: 'conservative' | 'aggressive' | 'fifteenMin' | 'grok15min' | 'grokHourly';
  direction: 'yes' | 'no';
  strike?: number; // Optional for 15-min markets
  entryPrice: number;
  exitPrice: number;
  exitType: 'early' | 'settlement';
  contracts: number;
  grossCost: number;
  entryFee: number;
  totalCost: number;
  grossRevenue: number;
  exitFee: number;
  netRevenue: number;
  netPnL: number;
  btcPriceAtEntry: number;
  btcPriceAtExit: number;
  won: boolean;
  exitReason?: string;
  riskAtExit?: number;
  marketTicker?: string; // Kalshi market ticker
}

export interface ActiveTrade {
  id: string;
  timestamp: Date;
  strategy: 'conservative' | 'aggressive' | 'fifteenMin';
  direction: 'yes' | 'no';
  strike: number;
  entryPrice: number;
  contracts: number;
  totalCost: number;
  btcPriceAtEntry: number;
}

export interface DailyPerformance {
  date: string;
  startingCapital: number;
  trades: Trade[];
  conservativeReturn: number;
  aggressiveReturn: number;
  fifteenMinReturn: number;
  grok15minReturn?: number;
  grokHourlyReturn?: number;
  totalReturn: number;
  totalFeesPaid: number;
  netReturn: number;
}

export interface ExitAnalysis {
  shouldExit: boolean;
  reason: string;
  expectedNetPnL: number;
  currentValue: number;
  settlementExpectedValue: number;
  feeImpact: number;
  confidence: 'high' | 'medium' | 'low';
  riskOfRuin: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
}

export interface RiskOfRuinAnalysis {
  riskOfRuin: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  reason: string;
  expectedMove: number;
  bufferNeeded: number;
}

export interface WeeklyDataPoint {
  day: string;
  date: string;
  conservative: number;
  aggressive: number;
  algo?: number;
  ai?: number;
}

export interface EngineSignal {
  command: 'STANDBY' | 'PREP' | 'BUY' | 'MONITOR' | 'SELL' | 'SETTLE';
  timestamp: string;
  strike?: number;
  direction?: 'yes' | 'no';
  orderType?: 'limit' | 'market';
  allocatePct?: number;
  maxLimitPrice?: number;
  reason?: string;
  instruction?: string;
  btcPrice?: number;
  criteriaMetCount?: number;
}

export interface EnginePosition {
  active: boolean;
  pending?: boolean;
  tradeId?: string;
  strike?: number;
  direction?: 'yes' | 'no';
  entryPrice?: number;
  contracts?: number;
  totalCost?: number;
  btcPriceAtEntry?: number;
  entryTime?: string;
  hourKey?: string;
}

export interface BotConfig {
  conservative: {
    enabled: boolean;
    capitalPerTrade: number;
    maxDailyLoss: number;
  };
  aggressive: {
    enabled: boolean;
    capitalPerTrade: number;
    maxDailyLoss: number;
  };
  fifteenMin: {
    enabled: boolean;
    capitalPerTrade: number;
    maxDailyLoss: number;
  };
  grok15min: {
    enabled: boolean;
    confidenceThreshold: number;
    capitalPerTrade: number;
    maxDailyLoss: number;
  };
  grokHourly: {
    enabled: boolean;
    confidenceThreshold: number;
    capitalPerTrade: number;
    maxDailyLoss: number;
  };
  arb: {
    enabled: boolean;
    capitalPerTrade: number;        // $ per trade per snipe
    maxDailyLoss: number;           // daily stop ($)
    momentumThreshold: number;      // % BTC move to trigger 15-min sniper (legacy)
    maxEntryPriceCents: number;     // max ¢ to pay for OTM contract
    btcProximityDollars: number;    // max $ from strike for hourly dislocation sniper (legacy)
    // Swing bot config
    velocityThresholdPerMin: number; // $/min BTC velocity to fire signal
    atmProximityDollars: number;     // max $ from window-open price to qualify
    limitDiscountCents: number;      // shave off ask by this many cents for IOC limit
    exitCaptureRate: number;         // capture rate threshold to exit (0.25 = 25%)
    maxEntryMinute15: number;        // latest minute-in-15min-window to enter
    minEntryMinute: number;          // earliest minute to enter (both window types)
  };
}
