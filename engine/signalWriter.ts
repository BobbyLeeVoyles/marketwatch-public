import fs from 'fs';
import path from 'path';

const SIGNAL_FILE = path.join(process.cwd(), 'data', 'signal.json');

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

export function writeSignal(signal: EngineSignal): void {
  const dir = path.dirname(SIGNAL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmpFile = SIGNAL_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(signal, null, 2));
  fs.renameSync(tmpFile, SIGNAL_FILE);
}

export function readSignal(): EngineSignal | null {
  try {
    if (fs.existsSync(SIGNAL_FILE)) {
      return JSON.parse(fs.readFileSync(SIGNAL_FILE, 'utf-8'));
    }
  } catch {
    // File being written or corrupt
  }
  return null;
}
