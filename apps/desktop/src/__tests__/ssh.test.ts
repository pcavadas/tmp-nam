import { describe, expect, it } from "vitest";
import { ApiError, type AuthorizedKey, type SshState } from "../lib/api";
import {
  keyName,
  keyTypeLabel,
  orderedKeys,
  shortFingerprint,
  sshExposure,
  sshFailure,
} from "../state/ssh";

const key = (fingerprint: string, comment = "a@b"): AuthorizedKey => ({
  type: "ssh-ed25519",
  bits: 256,
  comment,
  fingerprint,
  key: `key-${fingerprint}`,
});

const state = (extra: Partial<SshState> = {}): SshState => ({
  supported: true,
  enabled: false,
  mode: "key",
  keys: [],
  ...extra,
});

describe("SSH access rules", () => {
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

  it("knows when anyone can log in", () => {
    expect(sshExposure(null)).toBeNull();
    expect(sshExposure(state())).toBeNull();
    expect(sshExposure(state({ enabled: true }))).toBeNull();
    expect(sshExposure(state({ enabled: true, mode: "none" }))).toBe("none");
    expect(sshExposure(state({ enabled: false, mode: "none" }))).toBeNull();
    expect(sshExposure(state({ supported: false }))).toBe("old");
  });

  it("says why a change failed, not just that the unit didn't answer", () => {
    const fallback = "The unit didn't answer.";
    expect(sshFailure(new ApiError("key_failed", "x"), fallback)).toMatch(
      /this Mac's SSH key/,
    );
    expect(sshFailure(new ApiError("card_too_old", "x"), fallback)).toMatch(
      /too old/,
    );
    expect(sshFailure(new ApiError("not_applied", "x"), fallback)).toMatch(
      /Restart the unit/,
    );
    expect(sshFailure(new ApiError("no_answer", "x"), fallback)).toBe(fallback);
    expect(sshFailure(new Error("boom"), fallback)).toBe(fallback);
  });
});
