import { describe, expect, it } from "vitest";
import { SECURITY, type WifiNetwork, type WifiState } from "../lib/api";
import {
  joinNotice,
  needsPassword,
  passphraseError,
  ssidError,
  statusLine,
  unsupportedReason,
  visibleNetworks,
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

const state = (extra: Partial<WifiState["status"]> = {}): WifiState => ({
  status: {
    enabled: true,
    connected: false,
    mac: "aa:bb:cc:00:11:22",
    ipv4: "",
    ssid: "",
    security: 0,
    ...extra,
  },
  saved_enabled: true,
  networks: [net("Home", 64, { connected: extra.connected ?? false })],
  radio: true,
  fender_update: false,
});

describe("Wi-Fi rules", () => {
  it("checks WPA/WPA2 passwords like the backend", () => {
    expect(passphraseError("12345678")).toBeNull();
    expect(passphraseError("a".repeat(63))).toBeNull();
    expect(passphraseError("0123456789abcdef".repeat(4))).toBeNull();
    expect(passphraseError("1234567")).not.toBeNull();
    expect(passphraseError("a".repeat(64))).toBeNull();
    expect(passphraseError("g".repeat(64))).not.toBeNull();
    expect(passphraseError("pässword")).not.toBeNull();
  });

  it("checks typed network names in bytes", () => {
    expect(ssidError("Back Room")).toBeNull();
    expect(ssidError("")).not.toBeNull();
    expect(ssidError("é".repeat(17))).not.toBeNull(); // 34 bytes
    expect(ssidError("a\tb")).not.toBeNull();
  });

  it("joins saved networks with the unit's password", () => {
    expect(needsPassword(net("Home", 50))).toBe(true);
    expect(needsPassword(net("Home", 50, { saved: true }))).toBe(false);
    expect(needsPassword(net("Cafe", 50, { security: SECURITY.open }))).toBe(
      false,
    );
  });

  it("names what the unit can't join", () => {
    expect(unsupportedReason(SECURITY.psk)).toBeNull();
    expect(unsupportedReason(SECURITY.open)).toBeNull();
    expect(unsupportedReason(SECURITY.wep)).toMatch(/WEP/);
    expect(unsupportedReason(SECURITY.enterprise)).toMatch(/Enterprise/);
    expect(unsupportedReason(SECURITY.unsupported)).toMatch(/WPA3/);
  });

  it("lists one row per network: connected, saved, then by signal", () => {
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
  });

  it("describes the status", () => {
    expect(statusLine(state({ enabled: false })).text).toBe("Off");
    expect(statusLine(state()).text).toBe("On · not connected");
    expect(
      statusLine(state({ connected: true, ssid: "Home", ipv4: "192.168.1.9" })),
    ).toEqual({
      tone: "ok",
      text: "Connected to Home · 192.168.1.9 · signal 64%",
    });
    expect(
      statusLine({ ...state({ enabled: false, mac: "" }), radio: null }).text,
    ).toMatch(/No Wi-Fi radio/);
  });

  it("says a rejected saved password made the unit forget the network", () => {
    expect(joinNotice("wrong_password", "Home", true).text).toMatch(
      /forgot this network/,
    );
    expect(joinNotice("wrong_password", "Home", false).text).not.toMatch(
      /forgot/,
    );
    expect(joinNotice("connected", "Home", false).tone).toBe("ok");
  });
});
