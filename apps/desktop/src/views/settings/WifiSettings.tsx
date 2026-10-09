// src/views/settings/WifiSettings.tsx — Settings › Wi-Fi (design/HANDOFF.md › Settings › Wi-Fi):
// result banner, status card, FENDER_UPDATE warning, networks, and the facts about it.

import { useEffect, useState, type ReactNode } from "react";
import {
  Banner,
  Button,
  Checkbox,
  ConnectSteps,
  NetworkList,
  NetworkRow,
  Radio,
  Sheet,
  SignalStrength,
  Spinner,
  StatusDot,
  Switch,
  TextField,
} from "../../ds";
import {
  SECURITY,
  type WifiJoin,
  type WifiNetwork,
  type WifiState,
} from "../../lib/api";
import { copyText, defer } from "../../lib/format";
import { useApp } from "../../state/context";
import { sshExposure } from "../../state/ssh";
import { SshAccess, SshNoticeBanner } from "./SshAccess";
import {
  caption,
  networkKey,
  elapsed,
  noRadio,
  PASSWORD_HELP,
  passphraseError,
  rowKind,
  ssidError,
  visibleNetworks,
  type WifiActivity,
  type WifiStore,
} from "../../state/wifi";

type SheetState =
  | { kind: "join"; network: WifiNetwork; password: string }
  | { kind: "open"; network: WifiNetwork }
  | { kind: "other"; ssid: string; security: number; password: string }
  | { kind: "forget"; network: WifiNetwork };

const TRANSFER = "Available when the transfer finishes";

/** Why Wi-Fi controls are disabled, or null. */
function blockedReason(
  a: WifiActivity | null,
  transfer: boolean,
  working: boolean,
  sshBusy: boolean,
): string | null {
  if (transfer) return TRANSFER;
  // A remove or a size/gain change holds the unit too.
  if (working) return "Available when the unit is ready";
  if (sshBusy) return "Available when the SSH change finishes";
  switch (a?.kind) {
    case undefined:
      return null;
    case "joining":
      return "Available when joining finishes";
    case "switching":
      return a.on
        ? "Available when Wi-Fi has turned on"
        : "Available when Wi-Fi has turned off";
    case "scanning":
      return "Available when the scan finishes";
    case "reading":
      return "Available when the unit's Wi-Fi has been read";
    case "forgetting":
      return "Available when forgetting finishes";
  }
}

/** "0:12 · up to 45 seconds", ticking. */
function Elapsed({ since, limit }: { since: number; limit: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);
  return (
    <span className="small muted3">
      {elapsed(now - since)} · {limit}
    </span>
  );
}

export function WifiSettings() {
  const app = useApp();
  const { wifi } = app;
  const transfer = app.op !== null;
  const { open } = wifi;
  const [sheet, setSheet] = useState<SheetState | null>(null);

  // Read when the page opens, when the unit comes back, and after a transfer.
  useEffect(() => {
    if (app.connected && !transfer) defer(open);
  }, [app.connected, transfer, open]);

  if (!app.connected)
    return (
      <div className="tn-card" style={{ marginTop: 12 }}>
        <div className="wifi-row">
          <span className="wifi-title">Wi-Fi</span>
        </div>
        <div className="wifi-row wifi-col">
          <StatusDot tone="off" label="Unit not connected" />
          <span className="small muted">
            The unit&apos;s Wi-Fi is set up over the USB cable, so this needs
            the unit.
          </span>
          {app.unit === "missing" && <ConnectSteps />}
          <span className="small muted3">
            It&apos;s detected automatically.
          </span>
        </div>
      </div>
    );

  const { state } = wifi;
  if (!state) {
    if (transfer)
      return (
        <>
          <TransferBanner />
          <p className="small muted" style={{ marginTop: 12 }}>
            The unit&apos;s Wi-Fi is read when the transfer finishes.
          </p>
        </>
      );
    if (wifi.readError)
      return wifi.readError.held ? (
        <Banner
          tone="warn"
          title="Another app is using the unit"
          actions={[{ label: "Try Again", onClick: () => void open() }]}
          style={{ marginTop: 12 }}
        >
          Pro Control or TMP Companion is connected to the Tone Master Pro, so
          TMP NAM can&apos;t read its Wi-Fi. Quit that app, wait about a minute,
          then try again.
        </Banner>
      ) : (
        <Banner
          tone="error"
          title="Couldn't read the unit's Wi-Fi"
          actions={[{ label: "Try Again", onClick: () => void open() }]}
          style={{ marginTop: 12 }}
        >
          {wifi.readError.message}
        </Banner>
      );
    return (
      <div className="tn-card" style={{ marginTop: 12 }}>
        <div className="wifi-row">
          <Spinner label="Reading the unit's Wi-Fi" />
          <span className="muted">Reading the unit&apos;s Wi-Fi…</span>
        </div>
      </div>
    );
  }

  const exposure = sshExposure(app.ssh.state);
  const blocked = blockedReason(
    wifi.activity,
    transfer,
    app.working,
    app.ssh.activity !== null,
  );
  const showList =
    state.status.enabled &&
    !noRadio(state) &&
    !(wifi.activity?.kind === "switching" && !wifi.activity.on);

  const onNotice = () => {
    const action = wifi.notice?.action;
    const last = wifi.lastJoin;
    if (!action) return;
    switch (action.kind) {
      case "scan":
        void wifi.scan();
        return;
      case "toggle":
        void wifi.setEnabled(action.on ?? true);
        return;
      case "retry":
        if (last) void wifi.join(last.join, last.saved);
        return;
      case "join-again":
      case "retry-sheet": {
        if (!last) return;
        const password =
          action.kind === "retry-sheet" ? last.join.passphrase : "";
        const { ssid, security } = last.join;
        const network = {
          ssid,
          security,
          saved: false,
          connected: false,
          signal: 0,
        };
        setSheet(
          last.join.hidden
            ? { kind: "other", ssid, security, password }
            : security === SECURITY.open
              ? { kind: "open", network }
              : { kind: "join", network, password },
        );
      }
    }
  };

  const closeSheet = () => {
    setSheet(null);
    wifi.forgetPassword();
  };

  return (
    <>
      {transfer ? (
        <TransferBanner />
      ) : (
        wifi.notice && (
          <Banner
            tone={wifi.notice.tone}
            title={wifi.notice.title}
            onDismiss={wifi.dismissNotice}
            actions={
              wifi.notice.action
                ? [
                    {
                      label: wifi.notice.action.label,
                      onClick: onNotice,
                      disabled: blocked !== null,
                      title: blocked ?? undefined,
                    },
                  ]
                : undefined
            }
            style={{ marginTop: 12 }}
          >
            {wifi.notice.text}
          </Banner>
        )
      )}
      {!transfer && <SshNoticeBanner />}
      <StatusCard wifi={wifi} state={state} blocked={blocked} />
      {!noRadio(state) && <SshAccess />}
      {showList && (
        <Networks
          wifi={wifi}
          state={state}
          blocked={blocked}
          onSheet={setSheet}
        />
      )}
      <section className="wifi-about">
        <h3 className="lbl">About Wi-Fi on the unit</h3>
        <ul className="small muted">
          <li>
            Networks you join, and their passwords, are saved on the unit&apos;s
            internal storage, unencrypted. They aren&apos;t on the SD card.
          </li>
          <li>
            The unit rejoins them by itself whenever Wi-Fi is on, also when it
            starts without the NAM card.
          </li>
          <li>Forget removes a network and its password from the unit.</li>
          {state.fender_update && (
            <li>
              <strong>Fender&apos;s update network.</strong>{" "}
              {exposure === "old"
                ? "While Wi-Fi is on, the unit can also join a network named FENDER_UPDATE by itself. With this card's open SSH, that's one more reason to create a new card."
                : exposure === "none"
                  ? "While Wi-Fi is on, the unit can also join a network named FENDER_UPDATE by itself, a Fender setting. With SSH set to No security, that's one more reason to switch back to Key only."
                  : "While Wi-Fi is on, the unit can also join a network named FENDER_UPDATE by itself, a Fender setting. That's harmless while SSH access is off or key-only."}
            </li>
          )}
        </ul>
      </section>
      {sheet && (
        <WifiSheet
          sheet={sheet}
          onClose={closeSheet}
          onJoin={(j) => {
            setSheet(null);
            void wifi.join(j, false);
          }}
          onForget={(n) => {
            setSheet(null);
            void wifi.forget(n);
          }}
        />
      )}
    </>
  );
}

function TransferBanner() {
  return (
    <Banner tone="info" title={TRANSFER} style={{ marginTop: 12 }}>
      Captures are being sent over the same USB connection. Wi-Fi settings
      can&apos;t change until that&apos;s done.
    </Banner>
  );
}

function StatusCard({
  wifi,
  state,
  blocked,
}: {
  wifi: WifiStore;
  state: WifiState;
  blocked: string | null;
}) {
  const { status } = state;
  const exposure = sshExposure(useApp().ssh.state);
  const a = wifi.activity;
  const radioMissing = noRadio(state);
  const switching = a?.kind === "switching" ? a : null;
  const joining = a?.kind === "joining" ? a : null;
  const [copied, setCopied] = useState(false);
  const connectedRow = state.networks.find((n) => n.connected);
  const name = status.ssid || "a hidden network";
  const differs =
    !radioMissing &&
    state.saved_enabled !== null &&
    state.saved_enabled !== status.enabled;

  let line: ReactNode;
  if (radioMissing)
    line = (
      <>
        <StatusDot tone="off" label="No Wi-Fi radio" />
        <span className="small muted">
          This unit doesn&apos;t report a Wi-Fi radio, so its Wi-Fi can&apos;t
          be set up here.
        </span>
      </>
    );
  else if (switching)
    line = (
      <span className="hrow">
        <Spinner label={switching.on ? "Turning on" : "Turning off"} />
        <span>{switching.on ? "Turning on…" : "Turning off…"}</span>
        <Elapsed since={switching.startedAt} limit="up to 30 seconds" />
      </span>
    );
  else if (joining)
    line = (
      <span className="hrow">
        <Spinner label={`Joining ${joining.ssid}`} />
        <span>Joining {joining.ssid}…</span>
        <Elapsed since={joining.startedAt} limit="up to 45 seconds" />
      </span>
    );
  else if (!status.enabled) line = <StatusDot tone="off" label="Off" />;
  else if (status.connected)
    line = (
      <StatusDot
        tone="ok"
        label={
          <span>
            Connected to <strong>{name}</strong>
          </span>
        }
      />
    );
  else line = <StatusDot tone="off" label="On · not connected to a network" />;

  return (
    <div className="tn-card" style={{ marginTop: 12 }}>
      <div className="wifi-row">
        <div className="wifi-col" style={{ flex: 1, minWidth: 0 }}>
          <span className="wifi-title" id="wifi-switch-label">
            Wi-Fi
          </span>
          <span className="small muted3" id="wifi-switch-help">
            Applies every time the unit starts, with or without the NAM card.
          </span>
        </div>
        <Switch
          aria-label="Wi-Fi"
          aria-describedby="wifi-switch-help"
          checked={switching ? switching.on : status.enabled}
          busy={switching !== null}
          disabled={radioMissing || blocked !== null}
          title={
            radioMissing
              ? "This unit has no Wi-Fi radio"
              : (blocked ?? undefined)
          }
          onChange={(on) => void wifi.setEnabled(on)}
        />
      </div>
      <div className="wifi-row wifi-col" aria-live="polite">
        {line}
      </div>
      {status.enabled && status.connected && !switching && (
        <>
          <dl className="wifi-facts">
            <dt>Address</dt>
            <dd className="hrow">
              <span className="mono">{status.ipv4 || "—"}</span>
              {status.ipv4 && (
                <Button
                  size="sm"
                  onClick={() =>
                    void copyText(status.ipv4).then((err) => {
                      setCopied(err === null);
                    })
                  }
                >
                  Copy
                </Button>
              )}
              {copied && <span className="small muted3">Copied</span>}
            </dd>
            {connectedRow && (
              <>
                <dt>Signal</dt>
                <dd>
                  <SignalStrength percent={connectedRow.signal} showLabel />
                </dd>
              </>
            )}
            <dt>MAC address</dt>
            <dd className="mono">{status.mac || "—"}</dd>
          </dl>
          {exposure && (
            <div className="wifi-row wifi-danger" role="note">
              <span>
                {exposure === "old" ? (
                  <>
                    <strong>
                      Anyone on {name} can log in to the NAM card with no
                      password.
                    </strong>{" "}
                    This card is too old for SSH access settings. See SSH access
                    below.
                  </>
                ) : (
                  <>
                    <strong>
                      Anyone on {name} has root access to the NAM card, with no
                      password.
                    </strong>{" "}
                    SSH access is set to No security. See SSH access below.
                  </>
                )}
              </span>
            </div>
          )}
        </>
      )}
      {differs && !switching && (
        <div className="wifi-row">
          <Banner
            tone="note"
            style={{ flex: 1 }}
            actions={[
              {
                label: status.enabled ? "Keep It On" : "Keep It Off",
                onClick: () => void wifi.setEnabled(status.enabled),
                disabled: blocked !== null,
                title: blocked ?? undefined,
              },
            ]}
          >
            {status.enabled
              ? "Wi-Fi is on now, but the unit's saved setting is Off, so Wi-Fi will be off after the next start."
              : "Wi-Fi is off now, but the unit's saved setting is On, so Wi-Fi will be on after the next start."}
          </Banner>
        </div>
      )}
    </div>
  );
}

function Networks({
  wifi,
  state,
  blocked,
  onSheet,
}: {
  wifi: WifiStore;
  state: WifiState;
  blocked: string | null;
  onSheet: (s: SheetState) => void;
}) {
  const a = wifi.activity;
  const scanning = a?.kind === "scanning" || a?.kind === "reading";
  const rows = visibleNetworks(state.networks, wifi.removed);
  const listState =
    !wifi.scanned && scanning ? "scanning" : rows.length ? "rows" : "empty";
  const joiningSsid = a?.kind === "joining" ? a.ssid : null;

  return (
    <section style={{ marginTop: 20 }}>
      <div className="wifi-head">
        <h3 className="lbl">Networks</h3>
        {scanning ? (
          <span className="hrow small muted">
            <Spinner label="Scanning" />
            Scanning…
          </span>
        ) : (
          <Button
            size="sm"
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => void wifi.scan()}
          >
            Scan Again
          </Button>
        )}
      </div>
      <NetworkList
        state={listState}
        empty={
          wifi.scanned ? (
            <>
              <span style={{ color: "var(--text)" }}>No networks found</span>
              <span className="small muted">
                Move the unit closer to the router, then scan again. A network
                that hides its name doesn&apos;t show here; join it with Other
                Network…
              </span>
            </>
          ) : (
            // The scan failed; its banner says why.
            <span className="small muted">Not scanned yet.</span>
          )
        }
      >
        {rows.map((n) => {
          const kind = rowKind(n);
          return (
            <NetworkRow
              key={networkKey(n)}
              name={n.ssid}
              caption={caption(n.security)}
              signal={n.signal}
              kind={kind}
              joining={joiningSsid === n.ssid}
              disabledReason={blocked ?? undefined}
              onJoin={() => {
                if (kind === "saved")
                  void wifi.join(
                    {
                      ssid: n.ssid,
                      security: n.security,
                      hidden: false,
                      passphrase: "",
                    },
                    true,
                  );
                else if (kind === "open") onSheet({ kind: "open", network: n });
                else onSheet({ kind: "join", network: n, password: "" });
              }}
              onForget={() => {
                onSheet({ kind: "forget", network: n });
              }}
            />
          );
        })}
      </NetworkList>
      <div className="hrow" style={{ marginTop: 10 }}>
        <Button
          disabled={blocked !== null}
          title={blocked ?? undefined}
          onClick={() => {
            onSheet({
              kind: "other",
              ssid: "",
              security: SECURITY.psk,
              password: "",
            });
          }}
        >
          Other Network…
        </Button>
        <span className="small muted3">For a network that hides its name.</span>
      </div>
    </section>
  );
}

/** Only when SSH lets anyone in: a card too old, or No security. */
function SshDanger({ name }: { name: string }) {
  const exposure = sshExposure(useApp().ssh.state);
  if (!exposure) return null;
  return (
    <Banner
      tone="error"
      title={
        name === "it"
          ? "Anyone on that network could log in as root"
          : `Anyone on ${name} could log in as root`
      }
    >
      {exposure === "old"
        ? "This card's SSH accepts a blank password. Create a new card in SD Card first, or join only networks you trust."
        : "SSH access is set to No security. Switch it to Key only first, or join only networks you trust."}
    </Banner>
  );
}

function PasswordField({
  value,
  onChange,
  error,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Shown in place of the help. */
  error: string | null;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <>
      <TextField
        label="Password"
        type={show ? "text" : "password"}
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        error={error ?? undefined}
        help={error ? undefined : PASSWORD_HELP}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
      <Checkbox
        label="Show password"
        checked={show}
        onChange={(e) => {
          setShow(e.target.checked);
        }}
      />
    </>
  );
}

function WifiSheet({
  sheet,
  onClose,
  onJoin,
  onForget,
}: {
  sheet: SheetState;
  onClose: () => void;
  onJoin: (j: WifiJoin) => void;
  onForget: (n: WifiNetwork) => void;
}) {
  switch (sheet.kind) {
    case "join":
      return <JoinSheet sheet={sheet} onClose={onClose} onJoin={onJoin} />;
    case "other":
      return <OtherSheet sheet={sheet} onClose={onClose} onJoin={onJoin} />;
    case "open": {
      const { ssid, security } = sheet.network;
      return (
        <Sheet
          title={`Join “${ssid}”?`}
          onClose={onClose}
          actions={[
            { label: "Cancel", onClick: onClose, autoFocus: true },
            {
              label: "Join",
              variant: "primary",
              onClick: () => {
                onJoin({ ssid, security, hidden: false, passphrase: "" });
              },
            },
          ]}
        >
          <div className="wifi-sheet">
            <p className="muted">
              {ssid} is open: it has no password, so anyone nearby can join it.
            </p>
            <SshDanger name={ssid} />
            <p className="small muted3">
              The unit saves the network and rejoins it by itself whenever Wi-Fi
              is on. Joining can take up to 45 seconds.
            </p>
          </div>
        </Sheet>
      );
    }
    case "forget": {
      const n = sheet.network;
      return (
        <Sheet
          alert
          title={`Forget “${n.ssid}”?`}
          onClose={onClose}
          actions={[
            { label: "Cancel", onClick: onClose, autoFocus: true },
            {
              label: "Forget",
              variant: "danger",
              onClick: () => {
                onForget(n);
              },
            },
          ]}
        >
          <p className="muted">
            The unit deletes the saved password and stops joining this network.
            {n.connected && ` It disconnects from ${n.ssid} now.`} To use it
            again, join it with its password.
          </p>
        </Sheet>
      );
    }
  }
}

function JoinSheet({
  sheet,
  onClose,
  onJoin,
}: {
  sheet: Extract<SheetState, { kind: "join" }>;
  onClose: () => void;
  onJoin: (j: WifiJoin) => void;
}) {
  const { ssid, security } = sheet.network;
  const [password, setPassword] = useState(sheet.password);
  const [tried, setTried] = useState(false);
  const invalid = passphraseError(password);
  const submit = () => {
    if (invalid) {
      setTried(true);
      return;
    }
    onJoin({ ssid, security, hidden: false, passphrase: password });
  };
  return (
    <Sheet
      title={`Join “${ssid}”`}
      onClose={onClose}
      actions={[
        { label: "Cancel", onClick: onClose },
        {
          label: "Join",
          variant: "primary",
          disabled: !!invalid,
          onClick: submit,
        },
      ]}
    >
      <form
        className="wifi-sheet"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <PasswordField
          value={password}
          autoFocus
          error={tried ? invalid : null}
          onChange={(v) => {
            setPassword(v);
            setTried(false);
          }}
        />
        <SshDanger name={ssid} />
        <p className="small muted3">
          The password goes to the unit over USB and is saved there,
          unencrypted. Joining can take up to 45 seconds.
        </p>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

function OtherSheet({
  sheet,
  onClose,
  onJoin,
}: {
  sheet: Extract<SheetState, { kind: "other" }>;
  onClose: () => void;
  onJoin: (j: WifiJoin) => void;
}) {
  const [ssid, setSsid] = useState(sheet.ssid);
  const [security, setSecurity] = useState(sheet.security);
  const [password, setPassword] = useState(sheet.password);
  const [tried, setTried] = useState(false);
  const wpa = security === SECURITY.psk;
  const nameError = ssidError(ssid);
  const passError = wpa ? passphraseError(password) : null;
  // "Too long" shows as soon as it's true; "Enter the name" after a try.
  const shownNameError =
    nameError && (tried || new TextEncoder().encode(ssid).length > 32)
      ? nameError
      : null;
  const submit = () => {
    if (nameError || passError) {
      setTried(true);
      return;
    }
    onJoin({ ssid, security, hidden: true, passphrase: wpa ? password : "" });
  };
  return (
    <Sheet
      title="Join a hidden network"
      onClose={onClose}
      note="Up to 45 seconds"
      actions={[
        { label: "Cancel", onClick: onClose },
        {
          label: "Join",
          variant: "primary",
          disabled: !!nameError || !!passError,
          onClick: submit,
        },
      ]}
    >
      <form
        className="wifi-sheet"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="small muted">
          For a network that doesn&apos;t broadcast its name. It has to be in
          range.
        </p>
        <TextField
          label="Network name"
          value={ssid}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          error={shownNameError ?? undefined}
          help={
            shownNameError
              ? undefined
              : "Exactly as set on the router, up to 32 bytes."
          }
          onChange={(e) => {
            setSsid(e.target.value);
          }}
        />
        <div role="radiogroup" aria-label="Security" className="wifi-col">
          <span className="tn-field-label">Security</span>
          <Radio
            name="security"
            label="WPA/WPA2 Personal"
            checked={wpa}
            onChange={() => {
              setSecurity(SECURITY.psk);
            }}
          />
          <Radio
            name="security"
            label="None (open)"
            checked={security === SECURITY.open}
            onChange={() => {
              setSecurity(SECURITY.open);
            }}
          />
          <span className="small muted3">
            The unit can&apos;t join WEP, Enterprise or WPA3-only networks.
          </span>
        </div>
        {wpa && (
          <PasswordField
            value={password}
            error={tried ? passError : null}
            onChange={(v) => {
              setPassword(v);
              setTried(false);
            }}
          />
        )}
        <SshDanger name="it" />
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
