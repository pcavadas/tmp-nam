// src/views/settings/SshAccess.tsx — Settings › Wi-Fi › SSH access (design/HANDOFF.md):
// the switch, Key only / No security, the log-in line and the allowed computers.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Banner,
  Button,
  KeyRow,
  NetworkList,
  Radio,
  Sheet,
  Spinner,
  StatusDot,
  Switch,
  Tag,
} from "../../ds";
import {
  api,
  ApiError,
  type AuthorizedKey,
  type PublicKey,
  type SshState,
} from "../../lib/api";
import { defer } from "../../lib/format";
import { useApp } from "../../state/context";
import {
  isPrivateKey,
  keyName,
  keyProblem,
  keyTypeLabel,
  orderedKeys,
  shortFingerprint,
  type SshStore,
} from "../../state/ssh";
import { CopyButton } from "./CopyButton";

const LOGIN = "ssh root@fmic-tm-pro.local";
const HELP = "Lets this Mac log in to the NAM card over Wi-Fi.";

/** SSH results and errors, in the page's banner slot. */
export function SshNoticeBanner() {
  const app = useApp();
  const { ssh } = app;
  const n = ssh.notice;
  if (!n) return null;
  const blocked = app.unitBusyReason;
  const act = () => {
    const a = n.action;
    switch (a?.kind) {
      case "enable":
        return void ssh.enable();
      case "disable":
        return void ssh.disable();
      case "add-this-computer":
        return void ssh.addThisComputer();
      case "set-mode":
        return void (a.mode && ssh.setMode(a.mode));
      case "remove":
        return void (a.key && ssh.removeKey(a.key));
    }
  };
  return (
    <Banner
      tone={n.tone}
      title={n.title}
      onDismiss={ssh.dismissNotice}
      actions={
        n.action
          ? [
              {
                label: n.action.label,
                onClick: act,
                disabled: blocked !== null,
                title: blocked ?? undefined,
              },
            ]
          : undefined
      }
      style={{ marginTop: 12 }}
    >
      {n.text}
    </Banner>
  );
}

/** The SSH access card, directly under the Wi-Fi status card. */
export function SshAccess() {
  const app = useApp();
  const { ssh } = app;
  const transfer = app.op !== null;
  const { load, state } = ssh;
  const [confirmNone, setConfirmNone] = useState(false);
  const [removing, setRemoving] = useState<AuthorizedKey | null>(null);
  const [adding, setAdding] = useState(false);

  // Read once per connection: every change answers with the new state.
  const unread = state === null;
  useEffect(() => {
    if (app.connected && !transfer && unread) defer(load);
  }, [app.connected, transfer, unread, load]);

  const card = (control: ReactNode, body: ReactNode) => (
    <section
      className="tn-card"
      style={{ marginTop: 16 }}
      aria-label="SSH access"
    >
      <div className="wifi-row">
        <div className="wifi-col" style={{ flex: 1, minWidth: 0 }}>
          <span className="wifi-title">SSH access</span>
          <span className="small muted3" id="ssh-switch-help">
            {HELP}
          </span>
        </div>
        {control}
      </div>
      {body}
    </section>
  );

  if (!app.connected)
    return card(
      null,
      <div className="wifi-row">
        <span className="small muted">Shown when the unit is connected.</span>
      </div>,
    );

  if (!state)
    return card(
      null,
      <div className="wifi-row">
        {ssh.readError ? (
          <Banner
            tone="error"
            title="Couldn't read SSH access"
            style={{ flex: 1 }}
            actions={[{ label: "Try Again", onClick: () => void load() }]}
          >
            {ssh.readError}
          </Banner>
        ) : (
          <span className="hrow small muted">
            <Spinner label="Reading SSH access" />
            Reading SSH access…
          </span>
        )}
      </div>,
    );

  const blocked = app.unitBusyReason;

  if (!state.supported)
    return card(
      <Switch
        aria-label="SSH access"
        aria-describedby="ssh-switch-help"
        checked
        disabled
        title="This card is too old for SSH access settings"
      />,
      <div className="wifi-row wifi-col">
        <StatusDot
          tone="danger"
          label="Open to anyone on the network, no password"
        />
        <Banner
          tone="error"
          title="This card's SSH accepts a blank password"
          actions={[
            {
              label: "Open SD Card",
              onClick: () => {
                app.navigate("sdcard");
              },
            },
          ]}
        >
          The NAM card in this unit was made before SSH access could be switched
          off. Anyone on the same network can log in as root with no password,
          and this switch can&apos;t change that. Create a new card in SD Card
          to fix it. Until then, keep Wi-Fi off when you don&apos;t need it.
        </Banner>
      </div>,
    );

  const a = ssh.activity;
  const turningOn = a?.kind === "turning-on" ? a : null;
  const turningOff = a?.kind === "turning-off";
  const on = turningOn ? true : turningOff ? false : state.enabled;

  return card(
    <Switch
      aria-label="SSH access"
      aria-describedby="ssh-switch-help"
      checked={on}
      busy={turningOn !== null || turningOff}
      disabled={blocked !== null}
      title={blocked ?? undefined}
      onChange={(v) => void (v ? ssh.enable() : ssh.disable())}
    />,
    <>
      <div className="wifi-row wifi-col" aria-live="polite">
        <StatusLine ssh={ssh} state={state} />
      </div>
      {state.enabled && !turningOn && !turningOff && (
        <>
          <Security
            state={state}
            blocked={blocked}
            onKeyOnly={() => void ssh.setMode("key")}
            onNone={() => {
              setConfirmNone(true);
            }}
          />
          <LogIn state={state} />
          {state.mode === "key" && (
            <AllowedComputers
              ssh={ssh}
              state={state}
              blocked={blocked}
              onRemove={setRemoving}
              onAdd={() => {
                setAdding(true);
              }}
            />
          )}
        </>
      )}
      {confirmNone && (
        <Sheet
          alert
          title="Turn off SSH security?"
          onClose={() => {
            setConfirmNone(false);
          }}
          actions={[
            {
              label: "Cancel",
              autoFocus: true,
              onClick: () => {
                setConfirmNone(false);
              },
            },
            {
              label: "Allow Root Access Without a Key",
              variant: "danger",
              onClick: () => {
                setConfirmNone(false);
                void ssh.setMode("none");
              },
            },
          ]}
        >
          <div className="wifi-sheet">
            <p className="muted">
              Anyone on the same network as the unit will be able to log in to
              the NAM card as root, with no key or password, and change or erase
              anything on it.
            </p>
            <p className="small muted3">
              Use it only on a network you trust, and switch back to Key only
              when you&apos;re done. This stays on at every start until you do.
            </p>
          </div>
        </Sheet>
      )}
      {removing && (
        <RemoveSheet
          k={removing}
          state={state}
          thisComputer={ssh.thisComputer}
          onClose={() => {
            setRemoving(null);
          }}
          onRemove={() => {
            const k = removing;
            setRemoving(null);
            void ssh.removeKey(k);
          }}
        />
      )}
      {adding && (
        <AddSheet
          ssh={ssh}
          state={state}
          onClose={() => {
            setAdding(false);
          }}
        />
      )}
    </>,
  );
}

function StatusLine({ ssh, state }: { ssh: SshStore; state: SshState }) {
  const a = ssh.activity;
  if (a?.kind === "turning-on")
    return (
      <span className="hrow">
        <Spinner label="Turning on" />
        <span>
          Turning on…{" "}
          {a.step === "creating"
            ? "creating a key on this Mac"
            : "adding this Mac to the unit"}
        </span>
        <span className="small muted3">a few seconds</span>
      </span>
    );
  if (a?.kind === "turning-off")
    return (
      <span className="hrow">
        <Spinner label="Turning off" />
        <span>Turning off…</span>
        <span className="small muted3">a few seconds</span>
      </span>
    );
  if (!state.enabled)
    return (
      <>
        <StatusDot tone="off" label="Off" />
        <span className="small muted">
          Off now and at every start. Captures, Tone3000 and Wi-Fi all work over
          the USB cable without it.
        </span>
      </>
    );
  if (state.mode === "none")
    return (
      <>
        <StatusDot
          tone="danger"
          label="On · no security: anyone on the network has root access"
        />
        <span className="small muted">
          No key or password is asked. Anyone on the same network can log in as
          root and change or erase anything on the NAM card. On at every start
          with the NAM card in.
        </span>
      </>
    );
  return (
    <>
      <StatusDot tone="ok" label="On · key only" />
      <span className="small muted">
        Only the computers below can log in, and never with a password. On at
        every start with the NAM card in; without the card there&apos;s no SSH.
      </span>
    </>
  );
}

function Security({
  state,
  blocked,
  onKeyOnly,
  onNone,
}: {
  state: SshState;
  blocked: string | null;
  onKeyOnly: () => void;
  onNone: () => void;
}) {
  return (
    <div className="wifi-row wifi-col">
      <span className="lbl">Security</span>
      <div role="radiogroup" aria-label="Security" className="wifi-col">
        <Radio
          name="ssh-security"
          label="Key only"
          detail="Only the allowed computers can log in. Passwords never work."
          checked={state.mode === "key"}
          disabled={blocked !== null}
          onChange={onKeyOnly}
        />
        <Radio
          name="ssh-security"
          label="No security"
          detail="Anyone on the network can log in as root, with no key or password."
          checked={state.mode === "none"}
          disabled={blocked !== null}
          onChange={onNone}
        />
      </div>
    </div>
  );
}

function LogIn({ state }: { state: SshState }) {
  const { wifi } = useApp();
  const status = wifi.state?.status;
  let hint: ReactNode = null;
  if (status && !status.enabled)
    hint = (
      <Banner tone="note">
        Wi-Fi is off, so nothing can log in yet. SSH works as soon as the unit
        joins a network.
      </Banner>
    );
  else if (status && !status.connected)
    hint = (
      <Banner tone="note">
        The unit isn&apos;t on a network yet. Join one below, then log in.
      </Banner>
    );
  else if (status?.ipv4)
    hint = (
      <span className="small muted3">
        Or ssh root@{status.ipv4} if the name doesn&apos;t work on your network.
      </span>
    );
  return (
    <div className="wifi-row wifi-col">
      <span className="lbl">Log in</span>
      <span className="hrow">
        <span className="mono">{LOGIN}</span>
        <CopyButton text={LOGIN} />
      </span>
      {state.mode === "none" && (
        <span className="small muted">
          From any computer on the same network. No password is asked.
        </span>
      )}
      {hint}
    </div>
  );
}

function AllowedComputers({
  ssh,
  state,
  blocked,
  onRemove,
  onAdd,
}: {
  ssh: SshStore;
  state: SshState;
  blocked: string | null;
  onRemove: (k: AuthorizedKey) => void;
  onAdd: () => void;
}) {
  const mine = ssh.thisComputer?.fingerprint;
  const keys = orderedKeys(state.keys, ssh.thisComputer);
  const allowed = keys.some((k) => k.fingerprint === mine);
  return (
    <div className="wifi-row wifi-col" style={{ alignItems: "stretch" }}>
      <span className="lbl">Allowed computers</span>
      {keys.length > 0 && (
        <NetworkList state="rows" label="Allowed computers">
          {keys.map((k) => (
            <KeyRow
              key={k.fingerprint}
              name={keyName(k)}
              type={keyTypeLabel(k.type)}
              shortFingerprint={shortFingerprint(k.fingerprint)}
              fingerprint={k.fingerprint}
              tag={
                k.fingerprint === mine ? (
                  <Tag tone="accent">This Mac</Tag>
                ) : undefined
              }
              disabledReason={blocked ?? undefined}
              onRemove={() => {
                onRemove(k);
              }}
            />
          ))}
        </NetworkList>
      )}
      <div className="hrow">
        {!allowed && (
          <Button
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => void ssh.addThisComputer()}
          >
            Add This Mac
          </Button>
        )}
        <Button
          disabled={blocked !== null}
          title={blocked ?? undefined}
          onClick={onAdd}
        >
          Add Another Computer…
        </Button>
      </div>
    </div>
  );
}

function RemoveSheet({
  k,
  state,
  thisComputer,
  onClose,
  onRemove,
}: {
  k: AuthorizedKey;
  state: SshState;
  thisComputer: PublicKey | null;
  onClose: () => void;
  onRemove: () => void;
}) {
  const name = keyName(k);
  const mac = k.fingerprint === thisComputer?.fingerprint;
  const last = state.keys.length === 1 && state.mode === "key";
  let small = mac
    ? "Add This Mac puts it back."
    : "To allow it again, add its public key with Add Another Computer….";
  if (last && mac) small = "Turn SSH access on again to add this Mac back.";
  return (
    <Sheet
      alert
      title={`Remove “${name}”?`}
      onClose={onClose}
      actions={[
        { label: "Cancel", autoFocus: true, onClick: onClose },
        {
          label: last ? "Remove and Turn Off" : "Remove",
          variant: "danger",
          onClick: onRemove,
        },
      ]}
    >
      <div className="wifi-sheet">
        <p className="muted">
          {mac
            ? "This Mac won't be able to log in to the NAM card anymore."
            : "It won't be able to log in to the NAM card anymore."}
          {last &&
            " It's the last allowed computer, so SSH access turns off too, now and at every start."}
        </p>
        <p className="small muted3">{small}</p>
      </div>
    </Sheet>
  );
}

const PASTE_HELP =
  "One line that starts with ssh-ed25519, ssh-rsa or ecdsa-sha2-.";

function AddSheet({
  ssh,
  state,
  onClose,
}: {
  ssh: SshStore;
  state: SshState;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  // A new field after a private key is pasted, so the browser's undo can't bring it back.
  const [field, setField] = useState(0);
  const [refused, setRefused] = useState(false);
  const [preview, setPreview] = useState<PublicKey | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    title: string;
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const checking = useRef(0);

  const change = (value: string) => {
    setFailure(null);
    setPreview(null);
    setProblem(null);
    if (isPrivateKey(value)) {
      // Never kept: not in state, not sent, not logged.
      setText("");
      setField((f) => f + 1);
      setRefused(true);
      return;
    }
    setText(value);
    if (!value.trim()) return;
    setRefused(false);
    const ticket = ++checking.current;
    api.sshCheckKey(value).then(
      (key) => {
        if (ticket !== checking.current) return;
        if (state.keys.some((k) => k.fingerprint === key.fingerprint))
          setProblem(keyProblem("duplicate"));
        else setPreview(key);
      },
      (e: unknown) => {
        if (ticket !== checking.current) return;
        setProblem(keyProblem(e instanceof ApiError ? e.code : ""));
      },
    );
  };

  const submit = async () => {
    if (!preview || busy) return;
    setBusy(true);
    const r = await ssh.addKey(text, keyName(preview));
    setBusy(false);
    if (r.ok) onClose();
    else if (r.banner) setFailure(r.banner);
    else if (r.field) {
      setPreview(null);
      setProblem(r.field);
    }
  };

  return (
    <Sheet
      title="Add another computer"
      width={520}
      onClose={onClose}
      note="It can log in as soon as it's added"
      actions={[
        { label: "Cancel", onClick: onClose },
        {
          label: busy ? "Adding…" : "Add Computer",
          variant: "primary",
          disabled: !preview || busy,
          onClick: () => void submit(),
        },
      ]}
    >
      <div className="wifi-sheet">
        {refused && (
          <Banner
            tone="error"
            title="That was a private key, so it wasn't kept"
          >
            A private key is what proves a computer is yours: never paste it
            anywhere. Paste the public key instead, the line from the file
            ending in .pub (for example id_ed25519.pub).
          </Banner>
        )}
        {failure && (
          <Banner tone="error" title={failure.title}>
            {failure.text}
          </Banner>
        )}
        <p className="small muted">
          Paste the public key of the computer that should log in. On that
          computer, open Terminal, run this and copy the line it prints:
        </p>
        <span className="hrow">
          <span className="mono">cat ~/.ssh/id_ed25519.pub</span>
          <CopyButton text="cat ~/.ssh/id_ed25519.pub" />
        </span>
        <div className="tn-field">
          <label className="tn-field-label" htmlFor="ssh-public-key">
            Public key
          </label>
          <textarea
            key={field}
            id="ssh-public-key"
            className={`tn-input is-mono ssh-key-field${problem ? " is-error" : ""}`}
            rows={3}
            spellCheck={false}
            autoComplete="off"
            placeholder="ssh-ed25519 AAAA… name@computer"
            value={text}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => {
              change(e.target.value);
            }}
          />
          {problem ? (
            <span className="tn-error">{problem}</span>
          ) : (
            <span className="tn-help">{PASTE_HELP}</span>
          )}
        </div>
        {preview && (
          <NetworkList state="rows" label="Key to add">
            <KeyRow
              name={keyName(preview)}
              type={keyTypeLabel(preview.type)}
              shortFingerprint={shortFingerprint(preview.fingerprint)}
              fingerprint={preview.fingerprint}
              tag={<Tag tone="ok">Valid key</Tag>}
            />
          </NetworkList>
        )}
      </div>
    </Sheet>
  );
}
