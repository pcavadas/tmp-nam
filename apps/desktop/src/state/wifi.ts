// src/state/wifi.ts — the unit's Wi-Fi for Settings › Wi-Fi.
//
// Everything goes through the audio engine (HID), which drives ConnMan. There is
// one request at a time: the backend holds the unit for each, and joining can take
// up to 45 s. The engine applies the on/off setting at every start, with or without
// the NAM card.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  SECURITY,
  type WifiJoin,
  type WifiJoinOutcome,
  type WifiNetwork,
  type WifiState,
} from "../lib/api";
import { defer, errorText } from "../lib/format";

export function securityLabel(security: number): string {
  switch (security) {
    case SECURITY.open:
      return "Open";
    case SECURITY.wep:
      return "WEP";
    case SECURITY.psk:
      return "WPA/WPA2 Personal";
    case SECURITY.enterprise:
      return "WPA/WPA2 Enterprise";
    default:
      return "WPA3 or other";
  }
}

/** Why the unit can't join a network of this security, or null. */
export function unsupportedReason(security: number): string | null {
  switch (security) {
    case SECURITY.open:
    case SECURITY.psk:
      return null;
    case SECURITY.wep:
      return "WEP is no longer secure and isn't supported.";
    case SECURITY.enterprise:
      return "Enterprise (802.1X) networks aren't supported.";
    default:
      return "The unit's firmware can't join WPA3-only networks.";
  }
}

/** A saved network joins with the password stored on the unit. */
export function needsPassword(n: WifiNetwork): boolean {
  return n.security === SECURITY.psk && !n.saved;
}

/** WPA/WPA2 Personal: 8–63 printable ASCII characters, or 64 hex digits. */
export function passphraseError(p: string): string | null {
  const hex = /^[0-9a-fA-F]{64}$/.test(p);
  const text = /^[\x20-\x7e]{8,63}$/.test(p);
  return hex || text
    ? null
    : "Use 8 to 63 characters (letters, digits, symbols, spaces), or 64 hex digits.";
}

export function ssidError(ssid: string): string | null {
  const bytes = new TextEncoder().encode(ssid).length;
  if (bytes === 0) return "Enter the network name.";
  if (bytes > 32) return "A network name is at most 32 bytes.";
  if (/\p{Cc}/u.test(ssid))
    return "The network name contains control characters.";
  return null;
}

/**
 * Networks to list: hidden ones (no name) dropped, one row per name and security
 * (the strongest access point), connected first, then saved, then by signal.
 */
export function visibleNetworks(list: WifiNetwork[]): WifiNetwork[] {
  const rows = new Map<string, WifiNetwork>();
  for (const n of list) {
    if (!n.ssid) continue;
    const key = `${String(n.security)}:${n.ssid}`;
    const had = rows.get(key);
    rows.set(
      key,
      had
        ? {
            ...had,
            saved: had.saved || n.saved,
            connected: had.connected || n.connected,
            signal: Math.max(had.signal, n.signal),
          }
        : n,
    );
  }
  const rank = (n: WifiNetwork) => (n.connected ? 0 : n.saved ? 1 : 2);
  return [...rows.values()].sort(
    (a, b) =>
      rank(a) - rank(b) || b.signal - a.signal || a.ssid.localeCompare(b.ssid),
  );
}

export type StatusTone = "ok" | "warn" | "off";

/** One line for the Status row. */
export function statusLine(s: WifiState): { tone: StatusTone; text: string } {
  if (s.radio === false || (s.radio === null && !s.status.mac))
    return { tone: "off", text: "No Wi-Fi radio found on the unit" };
  if (!s.status.enabled) return { tone: "off", text: "Off" };
  if (!s.status.connected) return { tone: "warn", text: "On · not connected" };
  const parts = [`Connected to ${s.status.ssid}`];
  if (s.status.ipv4) parts.push(s.status.ipv4);
  const signal = s.networks.find((n) => n.connected)?.signal;
  if (signal !== undefined) parts.push(`signal ${String(signal)}%`);
  return { tone: "ok", text: parts.join(" · ") };
}

export interface WifiNotice {
  tone: "ok" | "warn" | "error";
  title: string;
  text?: string;
}

export function joinNotice(
  outcome: WifiJoinOutcome,
  ssid: string,
  saved: boolean,
): WifiNotice {
  switch (outcome) {
    case "connected":
      return { tone: "ok", title: `Connected to ${ssid}` };
    case "wrong_password":
      return {
        tone: "error",
        title: `Wrong password for ${ssid}`,
        text: saved
          ? "The unit rejected the password it had saved, so it forgot this network. Join it again with the current password."
          : "Check the password and join again.",
      };
    case "failed":
      return {
        tone: "error",
        title: `Couldn't join ${ssid}`,
        text: "The unit couldn't find the network or get an address from it. Check that it's in range and on, then try again.",
      };
    case "no_response":
      return {
        tone: "error",
        title: `No answer while joining ${ssid}`,
        text: "The unit didn't report a result within 45 seconds. Check the network, then try again.",
      };
  }
}

export type WifiActivity =
  | { kind: "loading" }
  | { kind: "scanning" }
  | { kind: "switching"; on: boolean }
  | { kind: "joining"; ssid: string }
  | { kind: "forgetting"; ssid: string };

export interface WifiStore {
  state: WifiState | null;
  /** Why the state couldn't be read, e.g. another app holds the HID channel. */
  error: string | null;
  activity: WifiActivity | null;
  notice: WifiNotice | null;
  dismissNotice: () => void;
  refresh: () => Promise<void>;
  scan: () => Promise<void>;
  setEnabled: (on: boolean) => Promise<void>;
  join: (j: WifiJoin, saved: boolean) => Promise<WifiJoinOutcome | null>;
  forget: (n: WifiNetwork) => Promise<void>;
}

/** Wi-Fi state while `connected`; it is read again whenever the unit reconnects. */
export function useWifi(connected: boolean): WifiStore {
  const [state, setState] = useState<WifiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<WifiActivity | null>(null);
  const [notice, setNotice] = useState<WifiNotice | null>(null);
  const running = useRef(false);

  /** Run one request at a time; the state is read again afterwards. */
  const task = useCallback(
    async <T>(
      what: WifiActivity,
      f: () => Promise<T>,
      reread = true,
    ): Promise<T | null> => {
      if (running.current) return null;
      running.current = true;
      setActivity(what);
      try {
        const out = await f();
        if (reread) {
          setState(await api.wifiState());
          setError(null);
        }
        return out;
      } catch (e) {
        setNotice({ tone: "error", title: errorText(e) });
        return null;
      } finally {
        running.current = false;
        setActivity(null);
      }
    },
    [],
  );

  const load = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setActivity({ kind: "loading" });
    try {
      let s = await api.wifiState();
      setState(s);
      setError(null);
      if (s.status.enabled) {
        // Like the unit's own Wi-Fi screen: scan whenever the page opens.
        setActivity({ kind: "scanning" });
        const networks = await api.wifiScan();
        s = { ...s, networks };
        setState(s);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      running.current = false;
      setActivity(null);
    }
  }, []);

  useEffect(() => {
    if (connected) defer(load);
  }, [connected, load]);

  const refresh = useCallback(() => load(), [load]);

  const scan = useCallback(async () => {
    await task(
      { kind: "scanning" },
      async () => {
        const networks = await api.wifiScan();
        setState((s) => (s ? { ...s, networks } : s));
      },
      false,
    );
  }, [task]);

  const setEnabled = useCallback(
    async (on: boolean) => {
      setNotice(null);
      await task({ kind: "switching", on }, () => api.wifiSetEnabled(on));
      if (on) await scan();
    },
    [task, scan],
  );

  const join = useCallback(
    async (j: WifiJoin, saved: boolean) => {
      setNotice(null);
      const out = await task({ kind: "joining", ssid: j.ssid }, () =>
        api.wifiJoin(j),
      );
      if (out) setNotice(joinNotice(out, j.ssid, saved));
      return out;
    },
    [task],
  );

  const forget = useCallback(
    async (n: WifiNetwork) => {
      setNotice(null);
      const done = await task(
        { kind: "forgetting", ssid: n.ssid },
        async () => {
          await api.wifiForget(n.ssid, n.security);
          return true;
        },
      );
      if (done) setNotice({ tone: "ok", title: `Forgot ${n.ssid}` });
    },
    [task],
  );

  return {
    state: connected ? state : null,
    error: connected ? error : null,
    activity,
    notice,
    dismissNotice: useCallback(() => {
      setNotice(null);
    }, []),
    refresh,
    scan,
    setEnabled,
    join,
    forget,
  };
}
