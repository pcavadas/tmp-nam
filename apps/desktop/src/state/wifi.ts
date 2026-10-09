// src/state/wifi.ts — the unit's Wi-Fi (Settings › Wi-Fi), kept in the app store so a
// join or an on/off change keeps running, and shows in the sidebar, when the page
// unmounts.
//
// Every request goes through the audio engine (HID), which drives ConnMan. There is
// one Wi-Fi request at a time and the backend holds the unit for each: a join takes
// up to 45 s, on/off up to 30 s. The engine applies the on/off setting at every start,
// with or without the NAM card.

import { useCallback, useRef, useState } from "react";
import type { Activity, NetworkKind } from "../ds";
import {
  api,
  ApiError,
  SECURITY,
  type WifiJoin,
  type WifiJoinOutcome,
  type WifiNetwork,
  type WifiState,
} from "../lib/api";
import { errorText } from "../lib/format";

// ── Rules ────────────────────────────────────────────────────────────────────

function canJoin(security: number): boolean {
  return security === SECURITY.open || security === SECURITY.psk;
}

export function rowKind(n: WifiNetwork): NetworkKind {
  if (!canJoin(n.security)) return "unsupported";
  if (n.connected) return "connected";
  if (n.saved) return "saved";
  return n.security === SECURITY.open ? "open" : "new";
}

/** The caption under a network's name. */
export function caption(security: number): string {
  switch (security) {
    case SECURITY.open:
      return "Open · no password";
    case SECURITY.psk:
      return "WPA/WPA2 Personal";
    case SECURITY.wep:
      return "WEP · No longer secure, so not supported";
    case SECURITY.enterprise:
      return "WPA/WPA2 Enterprise · Enterprise sign-in isn't supported";
    default:
      return "WPA3 only · The unit's firmware can't join WPA3-only networks";
  }
}

export const PASSWORD_HELP = "8 to 63 characters, or 64 hex digits.";

/** WPA/WPA2 Personal: 8–63 printable ASCII characters, or exactly 64 hex digits. */
export function passphraseError(p: string): string | null {
  const hex = /^[0-9a-fA-F]{64}$/.test(p);
  const text = /^[\x20-\x7e]{8,63}$/.test(p);
  return hex || text
    ? null
    : "Use 8 to 63 characters (letters, digits, symbols, spaces), or 64 hex digits.";
}

/** A typed network name, measured in UTF-8 bytes. */
export function ssidError(ssid: string): string | null {
  const bytes = new TextEncoder().encode(ssid).length;
  if (bytes === 0) return "Enter the network name.";
  if (bytes > 32) return "Too long: a network name is at most 32 bytes.";
  if (/\p{Cc}/u.test(ssid))
    return "A network name can't contain control characters.";
  return null;
}

/** A network row's identity: one row per name and security. */
export const networkKey = (n: { ssid: string; security: number }) =>
  `${String(n.security)}:${n.ssid}`;

/**
 * Networks to list: nameless (hidden) ones dropped, one row per name and security
 * (the strongest access point), connected first, then saved, then by signal.
 */
export function visibleNetworks(
  list: WifiNetwork[],
  removed: readonly string[] = [],
): WifiNetwork[] {
  const rows = new Map<string, WifiNetwork>();
  for (const n of list) {
    if (!n.ssid || removed.includes(networkKey(n))) continue;
    const had = rows.get(networkKey(n));
    rows.set(
      networkKey(n),
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

/** The unit reports no Wi-Fi radio. */
export function noRadio(s: WifiState): boolean {
  return s.radio === false || (s.radio === null && !s.status.mac);
}

/** "0:12". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, "0")}`;
}

// ── Results ──────────────────────────────────────────────────────────────────

/** A join as sent, kept for Try Again (the password only until it succeeds). */
export interface LastJoin {
  join: WifiJoin;
  /** It was a saved network (joined with the password on the unit). */
  saved: boolean;
}

export type NoticeAction =
  /** Open the join (or Other Network) sheet, empty password. */
  | "join-again"
  /** Join again at once (saved and open networks). */
  | "retry"
  /** Open the sheet with the last values, password kept. */
  | "retry-sheet"
  | "scan"
  | "toggle";

export interface WifiNotice {
  tone: "ok" | "error";
  title: string;
  text: string;
  /** `on`: the state a failed "toggle" asked for. */
  action?: { label: string; kind: NoticeAction; on?: boolean };
}

export function joinNotice(
  outcome: WifiJoinOutcome,
  last: LastJoin,
  ipv4: string,
): WifiNotice {
  const { ssid, hidden, security } = last.join;
  const sheet = hidden || (security === SECURITY.psk && !last.saved);
  switch (outcome) {
    case "connected":
      return {
        tone: "ok",
        title: `Connected to ${ssid}`,
        text: `${ipv4 ? `Address ${ipv4}. ` : ""}The unit rejoins this network by itself whenever Wi-Fi is on.`,
      };
    case "wrong_password":
      return last.saved
        ? {
            tone: "error",
            title: `The password for ${ssid} has changed`,
            text: "The network rejected the password saved on the unit, so the unit forgot it. Join again with the current password.",
            action: { label: "Join Again…", kind: "join-again" },
          }
        : {
            tone: "error",
            title: `Wrong password for ${ssid}`,
            text: "The unit couldn't join and didn't keep the network. Check the password, then join again.",
            action: { label: "Join Again…", kind: "join-again" },
          };
    case "failed":
      return {
        tone: "error",
        title: `Couldn't join ${ssid}`,
        text: hidden
          ? "The unit didn't find a network with that name and security, or didn't get an address from it. Check that the router is on and in range, then try again."
          : "The unit didn't find the network or didn't get an address from it. Check that the router is on and in range, then try again.",
        action: sheet
          ? { label: "Try Again…", kind: "retry-sheet" }
          : { label: "Try Again", kind: "retry" },
      };
    case "no_response":
      return {
        tone: "error",
        title: "The unit didn't answer in time",
        text: `It didn't say within 45 seconds whether it joined ${ssid}. Scan again to see if it's connected.`,
        action: { label: "Scan Again", kind: "scan" },
      };
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

export type WifiActivity =
  | { kind: "reading" }
  | { kind: "scanning" }
  | { kind: "switching"; on: boolean; startedAt: number }
  | { kind: "joining"; ssid: string; startedAt: number }
  | { kind: "forgetting"; ssid: string };

export interface WifiStore {
  state: WifiState | null;
  /** Why the state couldn't be read; `held` when another app holds the unit. */
  readError: { message: string; held: boolean } | null;
  activity: WifiActivity | null;
  /** A scan finished since the page opened: tells "Looking…" from "No networks found". */
  scanned: boolean;
  notice: WifiNotice | null;
  dismissNotice: () => void;
  /** The last join, for Try Again; its password is kept until a join succeeds. */
  lastJoin: LastJoin | null;
  /** Drop the kept password (a sheet was closed without joining). */
  forgetPassword: () => void;
  /** Rows taken out of the list until the next scan (forget failed: out of range). */
  removed: readonly string[];
  /** Read the state and, when Wi-Fi is on, scan: when the page opens or the unit returns. */
  open: () => Promise<void>;
  scan: () => Promise<void>;
  setEnabled: (on: boolean) => Promise<void>;
  join: (j: WifiJoin, saved: boolean) => Promise<void>;
  forget: (n: WifiNetwork) => Promise<void>;
  /** Forget the state when the unit goes away. */
  reset: () => void;
}

const scanFailed = (e: unknown): WifiNotice => ({
  tone: "error",
  title: "Couldn't scan for networks",
  text: errorText(e),
  action: { label: "Scan Again", kind: "scan" },
});

const readFailure = (e: unknown) => ({
  message: errorText(e),
  held: e instanceof ApiError && e.code === "channel_held",
});

export function useWifi(): WifiStore {
  const [state, setState] = useState<WifiState | null>(null);
  const [readError, setReadError] = useState<WifiStore["readError"]>(null);
  const [activity, setActivity] = useState<WifiActivity | null>(null);
  const [scanned, setScanned] = useState(false);
  const [notice, setNotice] = useState<WifiNotice | null>(null);
  const [lastJoin, setLastJoin] = useState<LastJoin | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const running = useRef(false);

  /** One request at a time: ignored while another one runs. */
  const exclusive = useCallback(
    async (what: WifiActivity, f: () => Promise<void>) => {
      if (running.current) return;
      running.current = true;
      setActivity(what);
      try {
        await f();
      } finally {
        running.current = false;
        setActivity(null);
      }
    },
    [],
  );

  /** Take a state read; a failed one is shown in place of the page. */
  const take = useCallback(async (read: Promise<WifiState>) => {
    try {
      const s = await read;
      setState(s);
      setReadError(null);
      return s;
    } catch (e) {
      setReadError(readFailure(e));
      return null;
    }
  }, []);

  const scanNow = useCallback(async () => {
    setActivity({ kind: "scanning" });
    const networks = await api.wifiScan();
    setState((s) => (s ? { ...s, networks } : s));
    setScanned(true);
    setRemoved([]);
  }, []);

  /** Scan when Wi-Fi is on, after a read that skipped the networks. */
  const scanIfOn = useCallback(
    async (s: WifiState | null) => {
      setScanned(false);
      if (!s?.status.enabled || noRadio(s)) return;
      try {
        await scanNow();
      } catch (e) {
        setNotice(scanFailed(e));
      }
    },
    [scanNow],
  );

  const open = useCallback(async () => {
    await exclusive({ kind: "reading" }, async () => {
      await scanIfOn(await take(api.wifiState(false)));
    });
  }, [exclusive, take, scanIfOn]);

  const scan = useCallback(async () => {
    await exclusive({ kind: "scanning" }, async () => {
      try {
        await scanNow();
      } catch (e) {
        setNotice(scanFailed(e));
      }
    });
  }, [exclusive, scanNow]);

  const setEnabled = useCallback(
    async (on: boolean) => {
      await exclusive(
        { kind: "switching", on, startedAt: Date.now() },
        async () => {
          setNotice(null);
          let s: WifiState | null = null;
          try {
            s = await api.wifiSetEnabled(on);
            setState(s);
          } catch {
            setNotice({
              tone: "error",
              title: on ? "Wi-Fi didn't turn on" : "Wi-Fi didn't turn off",
              text: "The unit didn't confirm the change. Try again.",
              action: { label: "Try Again", kind: "toggle", on },
            });
          }
          // After a failure the switch returns to the real state.
          await scanIfOn(s ?? (await take(api.wifiState(false))));
        },
      );
    },
    [exclusive, take, scanIfOn],
  );

  const join = useCallback(
    async (j: WifiJoin, saved: boolean) => {
      const last = { join: j, saved };
      await exclusive(
        { kind: "joining", ssid: j.ssid, startedAt: Date.now() },
        async () => {
          setNotice(null);
          setLastJoin(last);
          let out: WifiJoinOutcome;
          try {
            out = await api.wifiJoin(j);
          } catch (e) {
            setNotice({
              tone: "error",
              title: `Couldn't join ${j.ssid}`,
              text: errorText(e),
            });
            return;
          }
          // The list too: saved and connected marks changed.
          const s = await take(api.wifiState(true));
          setNotice(joinNotice(out, last, s?.status.ipv4 ?? ""));
          if (out === "connected") setLastJoin(null);
        },
      );
    },
    [exclusive, take],
  );

  const forget = useCallback(
    async (n: WifiNetwork) => {
      await exclusive({ kind: "forgetting", ssid: n.ssid }, async () => {
        setNotice(null);
        try {
          const out = await api.wifiForget(n.ssid, n.security);
          if (out === "out_of_range") setRemoved((r) => [...r, networkKey(n)]);
          setNotice(
            out === "forgotten"
              ? {
                  tone: "ok",
                  title: `Forgot ${n.ssid}`,
                  text: "The unit deleted its saved password and won't join it again.",
                }
              : {
                  tone: "error",
                  title: `Couldn't forget ${n.ssid}`,
                  text: "The unit can only forget a network that's in range, and this one is out of reach now. When it shows in the list again, forget it then.",
                  action: { label: "Scan Again", kind: "scan" },
                },
          );
        } catch (e) {
          setNotice({
            tone: "error",
            title: `Couldn't forget ${n.ssid}`,
            text: errorText(e),
          });
        }
        await take(api.wifiState(true));
      });
    },
    [exclusive, take],
  );

  const reset = useCallback(() => {
    setState(null);
    setReadError(null);
    setScanned(false);
    setRemoved([]);
    setNotice(null);
    setLastJoin(null);
  }, []);

  return {
    state,
    readError,
    activity,
    scanned,
    notice,
    dismissNotice: useCallback(() => {
      setNotice(null);
      setLastJoin(null);
    }, []),
    lastJoin,
    forgetPassword: useCallback(() => {
      setLastJoin((l) =>
        l ? { ...l, join: { ...l.join, passphrase: "" } } : l,
      );
    }, []),
    removed,
    open,
    scan,
    setEnabled,
    join,
    forget,
    reset,
  };
}

/** The sidebar activity card for a Wi-Fi change, or null. */
export function wifiActivityCard(a: WifiActivity | null): Activity | null {
  if (a?.kind === "joining")
    return { title: "Joining Wi-Fi", detail: `${a.ssid} · up to 45 s` };
  if (a?.kind === "switching")
    return {
      title: a.on ? "Turning Wi-Fi on" : "Turning Wi-Fi off",
      detail: "Up to 30 seconds",
    };
  return null;
}
