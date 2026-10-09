import { describe, expect, it } from "vitest";
import type { AuthorizedKey, SshState } from "../lib/api";
import {
  isPrivateKey,
  keyName,
  keyProblem,
  keyTypeLabel,
  orderedKeys,
  shortFingerprint,
  sshBlockedReason,
  sshExposure,
} from "../state/ssh";

const key = (fingerprint: string, comment = "a@b"): AuthorizedKey => ({
  type: "ssh-ed25519",
  bits: 256,
  comment,
  fingerprint,
});

const state = (extra: Partial<SshState> = {}): SshState => ({
  supported: true,
  enabled: false,
  mode: "key",
  running: false,
  keys: [],
  ...extra,
});

describe("SSH access rules", () => {
  it("recognizes private keys in every common format", () => {
    for (const text of [
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==",
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN EC PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----",
      "PuTTY-User-Key-File-3: ssh-ed25519",
    ])
      expect(isPrivateKey(text), text).toBe(true);
    expect(isPrivateKey("ssh-ed25519 AAAAC3Nza me@mac")).toBe(false);
  });

  it("shortens fingerprints and names keys", () => {
    expect(
      shortFingerprint("SHA256:gnW2c+6N0FRetAkbDojHSGQN1p60SPD0Pr6927fmQ58"),
    ).toBe("SHA256:gnW2…mQ58");
    expect(keyTypeLabel("ssh-rsa")).toBe("RSA");
    expect(keyTypeLabel("ecdsa-sha2-nistp384")).toBe("ECDSA");
    expect(keyName(key("x", ""))).toBe("Computer without a name");
  });

  it("lists this Mac first, then in the order keys were added", () => {
    const keys = [key("a"), key("b"), key("mac")];
    expect(orderedKeys(keys, key("mac")).map((k) => k.fingerprint)).toEqual([
      "mac",
      "a",
      "b",
    ]);
    expect(orderedKeys(keys, null)).toEqual(keys);
  });

  it("explains what's wrong with a pasted key", () => {
    expect(keyProblem("several_lines")).toMatch(/one key at a time/);
    expect(keyProblem("duplicate")).toBe("This computer can already log in.");
    expect(keyProblem("not_a_key")).toMatch(/isn't a public key/);
  });

  it("knows when anyone can log in", () => {
    expect(sshExposure(null)).toBeNull();
    expect(sshExposure(state())).toBeNull();
    expect(sshExposure(state({ enabled: true }))).toBeNull();
    expect(sshExposure(state({ enabled: true, mode: "none" }))).toBe("none");
    expect(sshExposure(state({ enabled: false, mode: "none" }))).toBeNull();
    expect(sshExposure(state({ supported: false }))).toBe("old");
  });

  it("gives the reason SSH controls are disabled", () => {
    expect(sshBlockedReason(true, true, { kind: "turning-off" })).toBe(
      "Available when the transfer finishes",
    );
    expect(sshBlockedReason(false, true, null)).toBe(
      "Available when the Wi-Fi change finishes",
    );
    expect(sshBlockedReason(false, false, { kind: "turning-off" })).toBe(
      "Available when the SSH change finishes",
    );
    expect(sshBlockedReason(false, false, null)).toBeNull();
  });
});
