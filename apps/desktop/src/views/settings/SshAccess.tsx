// src/views/settings/SshAccess.tsx — Settings › Wi-Fi › SSH access (design/HANDOFF.md):
// the switch, Key only / No security, the log-in line and the allowed computers.

import { useEffect, useState, type ReactNode } from "react";
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
import type { AuthorizedKey, PublicKey, SshState } from "../../lib/api";
import { defer } from "../../lib/format";
import { useApp } from "../../state/context";
import {
  keyName,
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
}: {
  ssh: SshStore;
  state: SshState;
  blocked: string | null;
  onRemove: (k: AuthorizedKey) => void;
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
      {!allowed && (
        <div className="hrow">
          <Button
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => void ssh.addThisComputer()}
          >
            Add This Mac
          </Button>
        </div>
      )}
      <span className="small muted3">
        To allow another computer, log in from this Mac and add its public key
        to /data/nam/ssh/authorized_keys.
      </span>
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
    : "To allow it again, add its public key to /data/nam/ssh/authorized_keys.";
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
