// src/state/ssh.ts — SSH access to the NAM card (Settings › Wi-Fi › SSH access), in the
// app store so a change keeps running when the page unmounts.
//
// The card starts Dropbear at every boot as the unit's stored choice says: off, key
// only (allowed computers, never passwords) or no security (root, no password). The
// app reads and changes it over the USB console, one request at a time.

import { useCallback, useState } from "react";
import {
  api,
  ApiError,
  type AuthorizedKey,
  type PublicKey,
  type SshMode,
  type SshState,
  type SshView,
} from "../lib/api";
import { errorText } from "../lib/format";
import { useActivity } from "./activity";

// ── Rules ────────────────────────────────────────────────────────────────────

/** PEM, OpenSSH and PuTTY private keys: never kept, sent or logged. */
export function isPrivateKey(text: string): boolean {
  return /PRIVATE KEY-----|PuTTY-User-Key-File/.test(text);
}

/** "SHA256:q3Zt…X9eK"; the full fingerprint goes in the tooltip. */
export function shortFingerprint(fp: string): string {
  const body = fp.replace(/^SHA256:/, "");
  return body.length <= 8 ? fp : `SHA256:${body.slice(0, 4)}…${body.slice(-4)}`;
}

/** "ED25519", "RSA", "ECDSA". */
export function keyTypeLabel(type: string): string {
  if (type === "ssh-ed25519") return "ED25519";
  if (type === "ssh-rsa") return "RSA";
  return "ECDSA";
}

export function keyName(k: AuthorizedKey): string {
  return k.comment || "Computer without a name";
}

/** This Mac first, then in the order they were added. */
export function orderedKeys(
  keys: AuthorizedKey[],
  thisComputer: PublicKey | null,
): AuthorizedKey[] {
  const mine = keys.filter((k) => k.fingerprint === thisComputer?.fingerprint);
  return [...mine, ...keys.filter((k) => !mine.includes(k))];
}

/** Why pasted text can't be added, from `ssh_check_key`'s code. */
export function keyProblem(code: string): string {
  switch (code) {
    case "several_lines":
      return "Paste one key at a time: one line, starting with ssh-ed25519, ssh-rsa or ecdsa-sha2-.";
    case "duplicate":
      return "This computer can already log in.";
    default:
      return "This isn't a public key. Paste the whole line, starting with ssh-ed25519, ssh-rsa or ecdsa-sha2-.";
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

export type SshStep = "creating" | "adding";

export type SshActivity =
  | { kind: "reading" }
  | { kind: "turning-on"; step: SshStep }
  | { kind: "turning-off" }
  | { kind: "mode"; to: SshMode }
  | { kind: "adding"; name: string }
  | { kind: "removing"; name: string };

export type SshNoticeAction =
  "enable" | "disable" | "add-this-computer" | "set-mode" | "remove";

export interface SshNotice {
  tone: "ok" | "error";
  title: string;
  text: string;
  action?: {
    label: string;
    kind: SshNoticeAction;
    mode?: SshMode;
    key?: AuthorizedKey;
  };
}

export type AddResult =
  | { ok: true }
  | { ok: false; field?: string; banner?: { title: string; text: string } };

const NO_ANSWER =
  "The unit didn't answer. Check the USB cable, then try again.";

const noAnswer = (e: unknown) =>
  !(e instanceof ApiError) || e.code === "no_answer";

const KEY_FAILED =
  "TMP NAM couldn't create or read this Mac's SSH key (~/.ssh/id_ed25519.pub). Check that the .ssh folder in your home folder isn't locked or read-only, then try again.";

/** Why a change failed, for the codes the unit or the backend answer with;
 * `otherwise` when the unit didn't answer. */
export function sshFailure(e: unknown, otherwise: string): string {
  switch (e instanceof ApiError ? e.code : "") {
    case "key_failed":
      return KEY_FAILED;
    case "card_too_old":
      return "This NAM card is too old for SSH access settings. Create a new card in SD Card.";
    case "not_applied":
      return "The unit kept the change but SSH didn't follow it. Restart the unit, or try again.";
    case "unknown_key":
      return "That computer was no longer on the list.";
    default:
      return otherwise;
  }
}

export interface SshStore {
  state: SshState | null;
  thisComputer: PublicKey | null;
  readError: string | null;
  activity: SshActivity | null;
  notice: SshNotice | null;
  dismissNotice: () => void;
  load: () => Promise<void>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  setMode: (mode: SshMode) => Promise<void>;
  addThisComputer: () => Promise<void>;
  /** For the Add Another Computer sheet: it stays open on failure. */
  addKey: (text: string, name: string) => Promise<AddResult>;
  removeKey: (k: AuthorizedKey) => Promise<void>;
  reset: () => void;
}

export function useSsh(): SshStore {
  const [state, setState] = useState<SshState | null>(null);
  const [thisComputer, setThisComputer] = useState<PublicKey | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const { activity, setActivity, exclusive } = useActivity<SshActivity>();
  const [notice, setNotice] = useState<SshNotice | null>(null);

  /** Take what the unit answered; the new state. */
  const take = useCallback((v: SshView) => {
    setState(v.ssh);
    setThisComputer(v.this_computer);
    return v.ssh;
  }, []);

  /** After a failure the unit answered, show what it now stores. */
  const refresh = useCallback(
    async (e: unknown) => {
      if (noAnswer(e) || (e instanceof ApiError && e.code === "key_failed"))
        return;
      await api.sshState().then(take, () => undefined);
    },
    [take],
  );

  const load = useCallback(async () => {
    await exclusive({ kind: "reading" }, async () => {
      try {
        take(await api.sshState());
        setReadError(null);
      } catch (e) {
        setReadError(errorText(e));
      }
    });
  }, [exclusive, take]);

  const enable = useCallback(async () => {
    await exclusive({ kind: "turning-on", step: "adding" }, async () => {
      setNotice(null);
      try {
        if (!thisComputer) {
          setActivity({ kind: "turning-on", step: "creating" });
          setThisComputer(await api.sshCreateKey());
          setActivity({ kind: "turning-on", step: "adding" });
        }
        take(await api.sshSet(true, "key"));
      } catch (e) {
        await refresh(e);
        setNotice({
          tone: "error",
          title: "SSH access is still off",
          text: sshFailure(
            e,
            "The unit didn't answer while adding this Mac. Check the USB cable, then try again.",
          ),
          action: { label: "Try Again", kind: "enable" },
        });
      }
    });
  }, [exclusive, refresh, setActivity, take, thisComputer]);

  const disable = useCallback(async () => {
    await exclusive({ kind: "turning-off" }, async () => {
      setNotice(null);
      try {
        take(await api.sshSet(false, null));
      } catch (e) {
        await refresh(e);
        setNotice({
          tone: "error",
          title: "SSH access may still be on",
          text: sshFailure(
            e,
            "The unit didn't answer. Check the USB cable, then try again. Until it confirms, treat SSH as on.",
          ),
          action: { label: "Try Again", kind: "disable" },
        });
      }
    });
  }, [exclusive, refresh, take]);

  const setMode = useCallback(
    async (mode: SshMode) => {
      await exclusive({ kind: "mode", to: mode }, async () => {
        setNotice(null);
        try {
          take(await api.sshSet(true, mode));
        } catch (e) {
          await refresh(e);
          setNotice({
            tone: "error",
            title:
              mode === "none"
                ? "SSH security is still on"
                : "SSH access still has no security",
            text: sshFailure(e, NO_ANSWER),
            action: { label: "Try Again", kind: "set-mode", mode },
          });
        }
      });
    },
    [exclusive, refresh, take],
  );

  const addThisComputer = useCallback(async () => {
    const name = thisComputer ? keyName(thisComputer) : "This Mac";
    await exclusive({ kind: "adding", name }, async () => {
      setNotice(null);
      try {
        take(await api.sshAddKey(null));
      } catch (e) {
        await refresh(e);
        setNotice({
          tone: "error",
          title: `Couldn't add ${name}`,
          text: sshFailure(e, NO_ANSWER),
          action: { label: "Try Again", kind: "add-this-computer" },
        });
      }
    });
  }, [exclusive, refresh, take, thisComputer]);

  const addKey = useCallback(
    async (text: string, name: string): Promise<AddResult> => {
      let result: AddResult = { ok: false };
      await exclusive({ kind: "adding", name }, async () => {
        setNotice(null);
        try {
          take(await api.sshAddKey(text));
          setNotice({
            tone: "ok",
            title: `${name} can log in`,
            text: "From that computer: ssh root@fmic-tm-pro.local.",
          });
          result = { ok: true };
        } catch (e) {
          result = noAnswer(e)
            ? {
                ok: false,
                banner: {
                  title: "The computer wasn't added",
                  text: NO_ANSWER,
                },
              }
            : {
                ok: false,
                field: keyProblem(e instanceof ApiError ? e.code : ""),
              };
        }
      });
      return result;
    },
    [exclusive, take],
  );

  const removeKey = useCallback(
    async (k: AuthorizedKey) => {
      const name = keyName(k);
      await exclusive({ kind: "removing", name }, async () => {
        setNotice(null);
        try {
          const s = take(await api.sshRemoveKey(k.fingerprint));
          setNotice(
            s.keys.length === 0 && s.mode === "key"
              ? {
                  tone: "ok",
                  title: "SSH access is off",
                  text: "You removed the last allowed computer, so SSH is off now and at every start.",
                }
              : {
                  tone: "ok",
                  title: `Removed ${name}`,
                  text: "It can't log in to the NAM card anymore.",
                },
          );
        } catch (e) {
          await refresh(e);
          setNotice({
            tone: "error",
            title: `Couldn't remove ${name}`,
            text: sshFailure(
              e,
              "The unit didn't answer, so it can still log in. Check the USB cable, then try again.",
            ),
            action: { label: "Try Again", kind: "remove", key: k },
          });
        }
      });
    },
    [exclusive, refresh, take],
  );

  const reset = useCallback(() => {
    setState(null);
    setReadError(null);
    setNotice(null);
  }, []);

  return {
    state,
    thisComputer,
    readError,
    activity,
    notice,
    dismissNotice: useCallback(() => {
      setNotice(null);
    }, []),
    load,
    enable,
    disable,
    setMode,
    addThisComputer,
    addKey,
    removeKey,
    reset,
  };
}

/** Who can log in without a key: "old" (card too old), "none" (No security), or null. */
export function sshExposure(s: SshState | null): "old" | "none" | null {
  if (s && !s.supported) return "old";
  if (s?.enabled && s.mode === "none") return "none";
  return null;
}
