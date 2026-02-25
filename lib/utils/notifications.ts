const PERM_KEY = 'btc-terminal-notif-enabled';

let swRegistration: ServiceWorkerRegistration | null = null;

export function isNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function isNotificationsEnabled(): boolean {
  if (!isNotificationsSupported()) return false;
  return Notification.permission === 'granted' && localStorage.getItem(PERM_KEY) === 'true';
}

export async function registerServiceWorker(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  } catch {
    // SW registration failed
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!isNotificationsSupported()) return false;

  // Ensure SW is registered
  await registerServiceWorker();

  if (Notification.permission === 'granted') {
    localStorage.setItem(PERM_KEY, 'true');
    return true;
  }

  if (Notification.permission === 'denied') return false;

  const result = await Notification.requestPermission();
  if (result === 'granted') {
    localStorage.setItem(PERM_KEY, 'true');
    return true;
  }
  return false;
}

export function disableNotifications(): void {
  localStorage.setItem(PERM_KEY, 'false');
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (swRegistration) return swRegistration;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.ready;
    return swRegistration;
  } catch {
    return null;
  }
}

export async function notify(title: string, body: string, tag?: string): Promise<void> {
  if (!isNotificationsEnabled()) return;

  // Try service worker notification first (works on iOS PWA + background)
  const reg = await getRegistration();
  if (reg) {
    try {
      await reg.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: tag ?? title,
      });
      return;
    } catch {
      // Fall through to Notification API
    }
  }

  // Fallback: basic Notification API
  try {
    new Notification(title, {
      body,
      icon: '/icon-192.png',
      tag: tag ?? title,
    });
  } catch {
    // Notification API not available
  }
}

export function notifyTradeEntry(strategy: string, strike: number, contracts: number, entryPrice: number): void {
  notify(
    `AUTO-ENTER ${strategy.toUpperCase()}`,
    `Strike $${strike.toLocaleString()} | ${contracts} contracts @ ${(entryPrice * 100).toFixed(0)}\u00A2`,
    `entry-${Date.now()}`
  );
}

export function notifyTradeExit(strategy: string, exitType: string, pnl: number): void {
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  notify(
    `AUTO-EXIT ${strategy.toUpperCase()}`,
    `${exitType.toUpperCase()} | P&L: ${pnlStr}`,
    `exit-${Date.now()}`
  );
}
