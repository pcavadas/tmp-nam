import { describe, expect, it } from "vitest";
import { signalLevel } from "../ds";
import { SECURITY, type WifiNetwork, type WifiState } from "../lib/api";
import {
  caption,
  elapsed,
  joinNotice,
  noRadio,
  passphraseError,
  rowKind,
  ssidError,
  visibleNetworks,
  wifiActivityCard,
  type LastJoin,
} from "../state/wifi";

const net = (
  ssid: string,
  signal: number,
  extra: Partial<WifiNetwork> = {},
): WifiNetwork => ({
  ssid,
  security: SECURITY.psk,
  saved: false,
  connected: false,
  signal,
  ...extra,
});

const last = (extra: Partial<LastJoin["join"]> = {}, saved = false) => ({
  join: {
    ssid: "Home",
    security: SECURITY.psk,
    hidden: false,
    passphrase: "secret123",
    ...extra,
  },
  saved,
});

describe("Wi-Fi rules", () => {
  it("picks row actions by network type", () => {
    expect(rowKind(net("A", 50, { connected: true, saved: true }))).toBe(
      "connected",
    );
    expect(rowKind(net("A", 50, { saved: true }))).toBe("saved");
    expect(rowKind(net("A", 50))).toBe("new");
    expect(rowKind(net("A", 50, { security: SECURITY.open }))).toBe("open");
    for (const s of [SECURITY.wep, SECURITY.enterprise, SECURITY.unsupported])
      expect(rowKind(net("A", 50, { security: s, saved: true }))).toBe(
        "unsupported",
      );
  });

  it("captions say why a network can't be joined", () => {
    expect(caption(SECURITY.psk)).toBe("WPA/WPA2 Personal");
    expect(caption(SECURITY.open)).toBe("Open · no password");
    expect(caption(SECURITY.wep)).toMatch(/not supported/);
    expect(caption(SECURITY.enterprise)).toMatch(/isn't supported/);
    expect(caption(SECURITY.unsupported)).toMatch(/WPA3/);
  });

  it("checks WPA/WPA2 passwords like the backend", () => {
    expect(passphraseError("12345678")).toBeNull();
    expect(passphraseError("a".repeat(63))).toBeNull();
    expect(passphraseError("a".repeat(64))).toBeNull(); // 64 hex digits
    expect(passphraseError("1234567")).not.toBeNull();
    expect(passphraseError("g".repeat(64))).not.toBeNull();
    expect(passphraseError("pässword")).not.toBeNull();
  });

  it("checks typed network names in UTF-8 bytes", () => {
    expect(ssidError("Back Room")).toBeNull();
    expect(ssidError("")).toBe("Enter the network name.");
    expect(ssidError("é".repeat(16))).toBeNull(); // 32 bytes
    expect(ssidError("é".repeat(17))).toMatch(/Too long/); // 34 bytes
    expect(ssidError("a\tb")).not.toBeNull();
  });

  it("orders connected, saved, then by signal; one row per network", () => {
    const rows = visibleNetworks([
      net("Weak", 20),
      net("", 90), // hidden
      net("Strong", 80),
      net("Home", 30, { saved: true }),
      net("Strong", 85),
      net("Here", 10, { connected: true, saved: true }),
    ]);
    expect(rows.map((n) => [n.ssid, n.signal])).toEqual([
      ["Here", 10],
      ["Home", 30],
      ["Strong", 85],
      ["Weak", 20],
    ]);
    expect(
      visibleNetworks([net("Gone", 40, { saved: true })], [`3:Gone`]),
    ).toEqual([]);
  });

  it("maps signal to four levels", () => {
    expect([0, 24, 25, 49, 50, 74, 75, 100].map(signalLevel)).toEqual([
      "Weak",
      "Weak",
      "Fair",
      "Fair",
      "Good",
      "Good",
      "Excellent",
      "Excellent",
    ]);
  });

  it("reads the unit's reports", () => {
    const s = (radio: boolean | null, mac: string): WifiState => ({
      status: {
        enabled: false,
        connected: false,
        mac,
        ipv4: "",
        ssid: "",
        security: 0,
      },
      saved_enabled: false,
      networks: [],
      radio,
      fender_update: false,
    });
    expect(noRadio(s(false, "aa"))).toBe(true);
    expect(noRadio(s(null, ""))).toBe(true);
    expect(noRadio(s(true, ""))).toBe(false);
    expect(elapsed(72_500)).toBe("1:12");
  });
});

describe("Wi-Fi results", () => {
  it("tells a wrong password on a new network from a saved one", () => {
    const fresh = joinNotice("wrong_password", last(), "");
    expect(fresh.title).toBe("Wrong password for Home");
    expect(fresh.action?.kind).toBe("join-again");
    const saved = joinNotice(
      "wrong_password",
      last({ passphrase: "" }, true),
      "",
    );
    expect(saved.title).toBe("The password for Home has changed");
    expect(saved.text).toMatch(/forgot it/);
  });

  it("retries a failed join with a sheet only when a password is needed", () => {
    expect(joinNotice("failed", last(), "").action).toEqual({
      label: "Try Again…",
      kind: "retry-sheet",
    });
    expect(
      joinNotice("failed", last({ passphrase: "" }, true), "").action?.kind,
    ).toBe("retry");
    expect(
      joinNotice(
        "failed",
        last({ security: SECURITY.open, passphrase: "" }),
        "",
      ).action?.kind,
    ).toBe("retry");
    const hidden = joinNotice("failed", last({ hidden: true }), "");
    expect(hidden.action?.kind).toBe("retry-sheet");
    expect(hidden.text).toMatch(/with that name and security/);
  });

  it("reports success and silence", () => {
    expect(joinNotice("connected", last(), "192.168.1.9").text).toMatch(
      /^Address 192\.168\.1\.9\./,
    );
    expect(joinNotice("no_response", last(), "").action?.kind).toBe("scan");
  });

  it("shows long Wi-Fi changes in the sidebar", () => {
    expect(
      wifiActivityCard({ kind: "joining", ssid: "Home", startedAt: 0 }),
    ).toEqual({ title: "Joining Wi-Fi", detail: "Home · up to 45 s" });
    expect(
      wifiActivityCard({ kind: "switching", on: true, startedAt: 0 }),
    ).toEqual({ title: "Turning Wi-Fi on", detail: "Up to 30 seconds" });
    expect(wifiActivityCard({ kind: "scanning" })).toBeNull();
  });
});
