'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

const WS_URLS = [
  'wss://stream.binance.us:9443/ws/btcusdt@trade',
  'wss://stream.binance.com:9443/ws/btcusdt@trade',
];
const RECONNECT_DELAY = 3000;
const STALE_TIMEOUT = 30_000; // Force reconnect if no message in 30s

export function useBinancePrice() {
  const [price, setPrice] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const urlIndexRef = useRef(0);
  // Throttle: buffer the latest price and flush at most every 500ms
  const latestPriceRef = useRef<number | null>(null);
  const throttleRef = useRef<NodeJS.Timeout | null>(null);
  const lastMessageRef = useRef<number>(Date.now());
  const staleCheckRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    // Clean up any existing stale-check timer
    if (staleCheckRef.current) {
      clearInterval(staleCheckRef.current);
      staleCheckRef.current = null;
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }

    const wsUrl = WS_URLS[urlIndexRef.current % WS_URLS.length];

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setConnected(true);
        lastMessageRef.current = Date.now();

        // Start stale connection monitor
        staleCheckRef.current = setInterval(() => {
          if (Date.now() - lastMessageRef.current > STALE_TIMEOUT) {
            console.warn('[WS] Connection stale — forcing reconnect');
            ws.close();
          }
        }, 10_000);
      };

      ws.onmessage = (event) => {
        lastMessageRef.current = Date.now();
        try {
          const data = JSON.parse(event.data);
          if (data.p) {
            latestPriceRef.current = parseFloat(data.p);
            // Only push state update at most every 500ms to avoid
            // re-rendering hundreds of times per second
            if (!throttleRef.current) {
              throttleRef.current = setTimeout(() => {
                if (latestPriceRef.current !== null) {
                  setPrice(latestPriceRef.current);
                }
                throttleRef.current = null;
              }, 500);
            }
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (staleCheckRef.current) {
          clearInterval(staleCheckRef.current);
          staleCheckRef.current = null;
        }
        // Try next URL on reconnect
        urlIndexRef.current = (urlIndexRef.current + 1) % WS_URLS.length;
        reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY);
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    } catch {
      // WebSocket not available, will retry
      reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY);
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (staleCheckRef.current) {
        clearInterval(staleCheckRef.current);
      }
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { price, connected };
}
