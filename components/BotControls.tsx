'use client';

import { useState, useEffect } from 'react';

interface BotStatus {
  running: boolean;
  startedAt?: string;
  dailyPnL: number;
  tradesCount: number;
  lastError?: string;
}

interface GrokDecisionEntry {
  timestamp: string;
  decision: string;
  confidence: number;
  reason: string;
  suggestedRisk: string;
  ticker?: string;
}

interface GrokBotStatus extends BotStatus {
  lastDecisions?: GrokDecisionEntry[];
  hasPosition?: boolean;
}

interface ArbScannerStatus {
  running: boolean;
  dailyPnL: number;
  tradesCount: number;
  hasFifteenMinPosition: boolean;
  hasHourlyPosition: boolean;
  lastTriggerDetail?: string;
  lastError?: string;
}

interface StandardBotConfig {
  enabled: boolean;
  capitalPerTrade: number;
  maxDailyLoss: number;
}

interface GrokBotConfig {
  enabled: boolean;
  capitalPerTrade: number;
  confidenceThreshold: number;
  maxDailyLoss: number;
}

interface ArbConfig {
  enabled: boolean;
  capitalPerTrade: number;
  maxDailyLoss: number;
  momentumThreshold: number;
  maxEntryPriceCents: number;
  btcProximityDollars: number;
}

// ─── Standard Bot Card (conservative / aggressive / fifteenMin) ──────────────

interface StandardBotProps {
  bot: 'conservative' | 'aggressive' | 'fifteenMin';
  label: string;
}

function StandardBotRow({ bot, label }: StandardBotProps) {
  const [status, setStatus] = useState<BotStatus>({ running: false, dailyPnL: 0, tradesCount: 0 });
  const [config, setConfig] = useState<StandardBotConfig>({
    enabled: false,
    capitalPerTrade: bot === 'conservative' ? 30 : bot === 'aggressive' ? 20 : 15,
    maxDailyLoss: bot === 'conservative' ? 100 : bot === 'aggressive' ? 80 : 60,
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/bot/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot }),
    })
      .then(res => res.json())
      .then(data => { if (data.config) setConfig(data.config); })
      .catch(() => {});
  }, [bot]);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/bot/status');
        const data = await res.json();
        if (data[bot]) setStatus(data[bot]);
      } catch { /* ignore */ }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [bot]);

  const toggleBot = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/bot/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot, enabled: !status.running }),
      });
      if (!res.ok) {
        const data = await res.json();
        if (data.error) setStatus(prev => ({ ...prev, lastError: data.error }));
        return;
      }
      const data = await res.json();
      if (data.status) setStatus(data.status);
    } catch {
      setStatus(prev => ({ ...prev, lastError: 'Failed to connect to server' }));
    } finally {
      setLoading(false);
    }
  };

  const updateConfig = async (updates: Partial<StandardBotConfig>) => {
    try {
      const res = await fetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot, ...updates }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.config) setConfig(data.config);
      }
    } catch { /* ignore */ }
  };

  return (
    <div className="border-b border-terminal-dim pb-3 mb-3 last:border-0">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-bold text-terminal-green">{label}</span>
          <button
            onClick={toggleBot}
            disabled={loading}
            className={`px-3 py-1 text-[10px] font-bold rounded transition-colors ${
              status.running
                ? 'bg-terminal-green text-black hover:bg-terminal-green/80'
                : 'bg-terminal-dim text-terminal-muted hover:bg-terminal-dim/80'
            } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {loading ? '...' : status.running ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <div>
          <label className="text-terminal-muted">Capital per trade:</label>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-terminal-muted">$</span>
            <input
              type="number"
              value={config.capitalPerTrade}
              onChange={(e) => { const v = parseInt(e.target.value); if (v > 0) setConfig({ ...config, capitalPerTrade: v }); }}
              onBlur={() => updateConfig({ capitalPerTrade: config.capitalPerTrade })}
              className="bg-black border border-terminal-dim px-2 py-1 w-16 text-terminal-green"
              min="1"
            />
          </div>
        </div>
        <div>
          <label className="text-terminal-muted">Max daily loss:</label>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-terminal-muted">$</span>
            <input
              type="number"
              value={config.maxDailyLoss}
              onChange={(e) => { const v = parseInt(e.target.value); if (v > 0) setConfig({ ...config, maxDailyLoss: v }); }}
              onBlur={() => updateConfig({ maxDailyLoss: config.maxDailyLoss })}
              className="bg-black border border-terminal-dim px-2 py-1 w-16 text-terminal-green"
              min="1"
            />
          </div>
        </div>
      </div>

      <div className="mt-2 text-[10px]">
        {status.running ? (
          <div className="flex items-center gap-2 text-terminal-green">
            <span>✓ Running</span>
            <span className="text-terminal-muted">|</span>
            <span>{status.tradesCount} trades</span>
            <span className="text-terminal-muted">|</span>
            <span className={status.dailyPnL >= 0 ? 'text-terminal-green' : 'text-terminal-red'}>
              {status.dailyPnL >= 0 ? '+' : ''}${status.dailyPnL.toFixed(2)} P&L
            </span>
          </div>
        ) : (
          <div className="text-terminal-muted">⏸ Stopped</div>
        )}
        {status.lastError && (
          <div className="text-terminal-yellow mt-1 text-[9px]">⚠ {status.lastError}</div>
        )}
      </div>
    </div>
  );
}

// ─── Grok AI Bot Card ────────────────────────────────────────────────────────

interface GrokBotRowProps {
  bot: 'grok15min' | 'grokHourly';
  label: string;
}

function GrokBotRow({ bot, label }: GrokBotRowProps) {
  const [status, setStatus] = useState<GrokBotStatus>({ running: false, dailyPnL: 0, tradesCount: 0, lastDecisions: [] });
  const [config, setConfig] = useState<GrokBotConfig>({ enabled: false, capitalPerTrade: 3, confidenceThreshold: 57, maxDailyLoss: 0 });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/bot/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot }),
    })
      .then(res => res.json())
      .then(data => { if (data.config) setConfig(data.config); })
      .catch(() => {});
  }, [bot]);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/bot/status');
        const data = await res.json();
        if (data[bot]) setStatus(data[bot]);
      } catch { /* ignore */ }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [bot]);

  const toggleBot = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/bot/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot, enabled: !status.running }),
      });
      if (!res.ok) {
        const data = await res.json();
        if (data.error) setStatus(prev => ({ ...prev, lastError: data.error }));
        return;
      }
      const data = await res.json();
      if (data.status) setStatus(data.status);
    } catch {
      setStatus(prev => ({ ...prev, lastError: 'Failed to connect to server' }));
    } finally {
      setLoading(false);
    }
  };

  const updateConfig = async (updates: Partial<GrokBotConfig>) => {
    try {
      const res = await fetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot, ...updates }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.config) setConfig(data.config);
      }
    } catch { /* ignore */ }
  };

  const decisionColor = (d: string) =>
    d === 'YES' ? 'text-terminal-green' : d === 'NO' ? 'text-terminal-red' : 'text-terminal-muted';

  return (
    <div className="border-b border-terminal-dim pb-3 mb-3 last:border-0">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-bold text-terminal-green">{label}</span>
          <span className="text-[9px] text-terminal-muted bg-terminal-dim px-1 rounded">AI</span>
          <button
            onClick={toggleBot}
            disabled={loading}
            className={`px-3 py-1 text-[10px] font-bold rounded transition-colors ${
              status.running
                ? 'bg-terminal-green text-black hover:bg-terminal-green/80'
                : 'bg-terminal-dim text-terminal-muted hover:bg-terminal-dim/80'
            } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {loading ? '...' : status.running ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <div>
          <label className="text-terminal-muted">Capital per trade:</label>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-terminal-muted">$</span>
            <input
              type="number"
              value={config.capitalPerTrade}
              onChange={(e) => { const v = parseInt(e.target.value); if (v > 0) setConfig({ ...config, capitalPerTrade: v }); }}
              onBlur={() => updateConfig({ capitalPerTrade: config.capitalPerTrade })}
              className="bg-black border border-terminal-dim px-2 py-1 w-16 text-terminal-green"
              min="1"
            />
          </div>
        </div>
        <div>
          <label className="text-terminal-muted">Min confidence:</label>
          <div className="flex items-center gap-1 mt-1">
            <input
              type="number"
              value={config.confidenceThreshold}
              onChange={(e) => { const v = parseInt(e.target.value); if (v >= 0 && v <= 100) setConfig({ ...config, confidenceThreshold: v }); }}
              onBlur={() => updateConfig({ confidenceThreshold: config.confidenceThreshold })}
              className="bg-black border border-terminal-dim px-2 py-1 w-16 text-terminal-green"
              min="0"
              max="100"
            />
            <span className="text-terminal-muted">%</span>
          </div>
        </div>
        <div>
          <label className="text-terminal-muted">Max daily loss:</label>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-terminal-muted">$</span>
            <input
              type="number"
              value={config.maxDailyLoss}
              onChange={(e) => { const v = parseInt(e.target.value); if (v >= 0) setConfig({ ...config, maxDailyLoss: v }); }}
              onBlur={() => updateConfig({ maxDailyLoss: config.maxDailyLoss })}
              className="bg-black border border-terminal-dim px-2 py-1 w-16 text-terminal-green"
              min="0"
            />
          </div>
        </div>
      </div>

      <div className="mt-2 text-[10px]">
        {status.running ? (
          <div className="flex items-center gap-2 text-terminal-green">
            <span>✓ Running</span>
            <span className="text-terminal-muted">|</span>
            <span>{status.tradesCount} trades</span>
            <span className="text-terminal-muted">|</span>
            <span className={status.dailyPnL >= 0 ? 'text-terminal-green' : 'text-terminal-red'}>
              {status.dailyPnL >= 0 ? '+' : ''}${status.dailyPnL.toFixed(2)} P&L
            </span>
            {status.hasPosition && (
              <>
                <span className="text-terminal-muted">|</span>
                <span className="text-terminal-yellow">● IN TRADE</span>
              </>
            )}
          </div>
        ) : (
          <div className="text-terminal-muted">⏸ Stopped</div>
        )}
        {status.lastError && (
          <div className="text-terminal-yellow mt-1 text-[9px]">⚠ {status.lastError}</div>
        )}
      </div>

      {/* Last 5 Grok decisions */}
      {status.lastDecisions && status.lastDecisions.length > 0 && (
        <div className="mt-2 text-[9px]">
          <div className="text-terminal-muted mb-1">Recent decisions:</div>
          {status.lastDecisions.slice(0, 5).map((d, i) => (
            <div key={i} className="flex items-center gap-1 text-terminal-muted">
              <span className="text-terminal-dim">{new Date(d.timestamp).toISOString().substr(11, 5)}</span>
              <span className={`font-bold ${decisionColor(d.decision)}`}>{d.decision}</span>
              <span className="text-terminal-dim">{d.confidence}%</span>
              <span className="truncate max-w-[140px]">{d.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Strike Sniper Card ───────────────────────────────────────────────────────

function StrikeSniperRow() {
  const [status, setStatus] = useState<ArbScannerStatus>({
    running: false,
    dailyPnL: 0,
    tradesCount: 0,
    hasFifteenMinPosition: false,
    hasHourlyPosition: false,
  });
  const [config, setConfig] = useState<ArbConfig>({
    enabled: false,
    capitalPerTrade: 5,
    maxDailyLoss: 20,
    momentumThreshold: 0.5,
    maxEntryPriceCents: 20,
    btcProximityDollars: 300,
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/bot/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: 'arb' }),
    })
      .then(res => res.json())
      .then(data => { if (data.config) setConfig(data.config); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/bot/status');
        const data = await res.json();
        if (data.arb) setStatus(data.arb);
      } catch { /* ignore */ }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  const toggleSniper = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/bot/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot: 'arb', enabled: !status.running }),
      });
      if (!res.ok) {
        const data = await res.json();
        if (data.error) setStatus(prev => ({ ...prev, lastError: data.error }));
        return;
      }
      const data = await res.json();
      if (data.status) setStatus(data.status);
    } catch {
      setStatus(prev => ({ ...prev, lastError: 'Failed to connect to server' }));
    } finally {
      setLoading(false);
    }
  };

  const updateConfig = async (updates: Partial<ArbConfig>) => {
    try {
      const res = await fetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot: 'arb', ...updates }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.config) setConfig(data.config);
      }
    } catch { /* ignore */ }
  };

  return (
    <div className="border-b border-terminal-dim pb-3 mb-3 last:border-0">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-bold text-terminal-green">Strike Sniper</span>
          <span className="text-[9px] text-terminal-yellow bg-terminal-dim px-1 rounded">OTM</span>
          <button
            onClick={toggleSniper}
            disabled={loading}
            className={`px-3 py-1 text-[10px] font-bold rounded transition-colors ${
              status.running
                ? 'bg-terminal-green text-black hover:bg-terminal-green/80'
                : 'bg-terminal-dim text-terminal-muted hover:bg-terminal-dim/80'
            } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {loading ? '...' : status.running ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[10px] mb-2">
        <div>
          <label className="text-terminal-muted">Capital/trade:</label>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-terminal-muted">$</span>
            <input
              type="number"
              value={config.capitalPerTrade}
              onChange={(e) => { const v = parseFloat(e.target.value); if (v > 0) setConfig({ ...config, capitalPerTrade: v }); }}
              onBlur={() => updateConfig({ capitalPerTrade: config.capitalPerTrade })}
              className="bg-black border border-terminal-dim px-2 py-1 w-14 text-terminal-green"
              min="1"
              step="1"
            />
          </div>
        </div>
        <div>
          <label className="text-terminal-muted">Max daily loss:</label>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-terminal-muted">$</span>
            <input
              type="number"
              value={config.maxDailyLoss}
              onChange={(e) => { const v = parseFloat(e.target.value); if (v > 0) setConfig({ ...config, maxDailyLoss: v }); }}
              onBlur={() => updateConfig({ maxDailyLoss: config.maxDailyLoss })}
              className="bg-black border border-terminal-dim px-2 py-1 w-14 text-terminal-green"
              min="1"
            />
          </div>
        </div>
        <div>
          <label className="text-terminal-muted">Momentum:</label>
          <div className="flex items-center gap-1 mt-1">
            <input
              type="number"
              value={config.momentumThreshold}
              onChange={(e) => { const v = parseFloat(e.target.value); if (v > 0) setConfig({ ...config, momentumThreshold: v }); }}
              onBlur={() => updateConfig({ momentumThreshold: config.momentumThreshold })}
              className="bg-black border border-terminal-dim px-2 py-1 w-14 text-terminal-green"
              min="0.1"
              step="0.1"
            />
            <span className="text-terminal-muted">%</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <div>
          <label className="text-terminal-muted">Max entry price:</label>
          <div className="flex items-center gap-1 mt-1">
            <input
              type="number"
              value={config.maxEntryPriceCents}
              onChange={(e) => { const v = parseInt(e.target.value); if (v > 0) setConfig({ ...config, maxEntryPriceCents: v }); }}
              onBlur={() => updateConfig({ maxEntryPriceCents: config.maxEntryPriceCents })}
              className="bg-black border border-terminal-dim px-2 py-1 w-14 text-terminal-green"
              min="1"
            />
            <span className="text-terminal-muted">¢</span>
          </div>
        </div>
        <div>
          <label className="text-terminal-muted">BTC proximity:</label>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-terminal-muted">$</span>
            <input
              type="number"
              value={config.btcProximityDollars}
              onChange={(e) => { const v = parseInt(e.target.value); if (v > 0) setConfig({ ...config, btcProximityDollars: v }); }}
              onBlur={() => updateConfig({ btcProximityDollars: config.btcProximityDollars })}
              className="bg-black border border-terminal-dim px-2 py-1 w-16 text-terminal-green"
              min="50"
              step="50"
            />
          </div>
        </div>
      </div>

      <div className="mt-2 text-[10px]">
        {status.running ? (
          <div className="flex flex-wrap items-center gap-2 text-terminal-green">
            <span>✓ Running</span>
            <span className="text-terminal-muted">|</span>
            <span>{status.tradesCount} trades</span>
            <span className="text-terminal-muted">|</span>
            <span className={status.dailyPnL >= 0 ? 'text-terminal-green' : 'text-terminal-red'}>
              {status.dailyPnL >= 0 ? '+' : ''}${status.dailyPnL.toFixed(2)} P&L
            </span>
            {status.hasFifteenMinPosition && (
              <>
                <span className="text-terminal-muted">|</span>
                <span className="text-terminal-yellow">● 15M IN TRADE</span>
              </>
            )}
            {status.hasHourlyPosition && (
              <>
                <span className="text-terminal-muted">|</span>
                <span className="text-terminal-yellow">● HRLY IN TRADE</span>
              </>
            )}
          </div>
        ) : (
          <div className="text-terminal-muted">⏸ Stopped</div>
        )}
        {status.lastTriggerDetail && (
          <div className="text-terminal-muted mt-1 text-[9px]">
            Last: {status.lastTriggerDetail}
          </div>
        )}
        {status.lastError && (
          <div className="text-terminal-yellow mt-1 text-[9px]">⚠ {status.lastError}</div>
        )}
      </div>
    </div>
  );
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export default function BotControls() {
  return (
    <div className="terminal-panel">
      <div className="terminal-header">BOT CONTROLS</div>
      <div className="p-4">
        <StandardBotRow bot="conservative" label="Conservative Hourly Bot" />
        <StandardBotRow bot="aggressive" label="Aggressive Hourly Bot" />
        <StandardBotRow bot="fifteenMin" label="15-Minute Bot" />
        <GrokBotRow bot="grok15min" label="Grok 15-Min AI" />
        <GrokBotRow bot="grokHourly" label="Grok Hourly AI" />
        <StrikeSniperRow />
      </div>
    </div>
  );
}
