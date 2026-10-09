// src/views/settings/WifiSettings.tsx — Settings › Wi-Fi: on/off, status, join and forget.

import { useState } from "react";
import {
  Banner,
  Button,
  Checkbox,
  ConnectSteps,
  Radio,
  Sheet,
  Spinner,
  StatusDot,
  Tag,
  TextField,
} from "../../ds";
import { SECURITY, type WifiNetwork } from "../../lib/api";
import { useApp } from "../../state/context";
import {
  needsPassword,
  passphraseError,
  securityLabel,
  ssidError,
  statusLine,
  unsupportedReason,
  useWifi,
  visibleNetworks,
  type WifiActivity,
  type WifiStore,
} from "../../state/wifi";

/** What the join sheet is for: a listed network, or a hidden one typed in. */
type JoinTarget = { network: WifiNetwork } | { hidden: true };

function activityText(a: WifiActivity): string {
  switch (a.kind) {
    case "loading":
      return "Reading Wi-Fi…";
    case "scanning":
      return "Scanning for networks…";
    case "switching":
      return a.on ? "Turning Wi-Fi on…" : "Turning Wi-Fi off…";
    case "joining":
      return `Joining ${a.ssid}… (up to 45 seconds)`;
    case "forgetting":
      return `Forgetting ${a.ssid}…`;
  }
}

export function WifiSettings() {
  const app = useApp();
  const wifi = useWifi(app.connected);
  const [joining, setJoining] = useState<JoinTarget | null>(null);
  const [forgetting, setForgetting] = useState<WifiNetwork | null>(null);

  if (!app.connected)
    return (
      <div className="formrow" style={{ borderBottom: 0 }}>
        <span className="lbl">Wi-Fi</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="muted" style={{ paddingTop: 5 }}>
            Shown when the unit is connected.
          </span>
          {app.unit === "missing" && <ConnectSteps />}
        </div>
      </div>
    );

  const { state, activity } = wifi;
  if (!state)
    return wifi.error ? (
      <Banner
        tone="error"
        title="Couldn't read the unit's Wi-Fi"
        actions={[
          {
            label: "Try Again",
            onClick: () => void wifi.refresh(),
            disabled: !!activity,
          },
        ]}
        style={{ marginTop: 12 }}
      >
        {wifi.error}
      </Banner>
    ) : (
      <div className="hrow" style={{ padding: "14px 0" }}>
        <Spinner label="Reading Wi-Fi" />
        <span className="muted">Reading Wi-Fi…</span>
      </div>
    );

  // A transfer holds the unit; Wi-Fi requests would wait behind it.
  const blocked = app.busyReason ?? (activity ? activityText(activity) : null);
  const status = statusLine(state);
  const noRadio = status.text.startsWith("No Wi-Fi radio");
  const savedDiffers =
    state.saved_enabled !== null &&
    state.saved_enabled !== state.status.enabled;
  const networks = visibleNetworks(state.networks);

  return (
    <>
      {wifi.notice && (
        <Banner
          tone={wifi.notice.tone}
          title={wifi.notice.title}
          onDismiss={wifi.dismissNotice}
          style={{ marginTop: 12 }}
        >
          {wifi.notice.text}
        </Banner>
      )}
      {state.fender_update && (
        <Banner
          tone="warn"
          title="Fender's update network is stored on the unit"
          style={{ marginTop: 12 }}
        >
          While Wi-Fi is on, the unit joins any network named FENDER_UPDATE by
          itself, using Fender&apos;s published password. A factory reset puts
          this profile back.
        </Banner>
      )}
      <div className="formrow">
        <span className="lbl">Wi-Fi</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Checkbox
            label="On"
            checked={state.status.enabled}
            disabled={!!blocked || noRadio}
            title={app.busyReason ?? undefined}
            onChange={(e) => void wifi.setEnabled(e.target.checked)}
          />
          <span className="small muted3">
            Saved on the unit and applied every time it starts, with or without
            the NAM card.
          </span>
        </div>
      </div>
      <div className="formrow">
        <span className="lbl">Status</span>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            paddingTop: 5,
          }}
        >
          <StatusDot tone={status.tone} label={status.text} />
          {activity && activity.kind !== "loading" && (
            <span className="hrow small muted">
              <Spinner label={activityText(activity)} />
              {activityText(activity)}
            </span>
          )}
          {savedDiffers && (
            <span className="small muted3">
              The saved setting is {state.saved_enabled ? "On" : "Off"}, so
              Wi-Fi will be {state.saved_enabled ? "on" : "off"} after the next
              start.
            </span>
          )}
        </div>
      </div>
      {state.status.enabled && (
        <div className="formrow">
          <span className="lbl">Networks</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <NetworkList
              networks={networks}
              disabled={!!blocked}
              scanning={activity?.kind === "scanning"}
              onJoin={(n) => {
                if (needsPassword(n)) setJoining({ network: n });
                else
                  void wifi.join(
                    {
                      ssid: n.ssid,
                      security: n.security,
                      hidden: false,
                      passphrase: "",
                    },
                    n.saved,
                  );
              }}
              onForget={setForgetting}
            />
            <div className="hrow">
              <Button
                disabled={!!blocked}
                title={blocked ?? undefined}
                onClick={() => void wifi.scan()}
              >
                Scan Again
              </Button>
              <Button
                disabled={!!blocked}
                title={blocked ?? undefined}
                onClick={() => {
                  setJoining({ hidden: true });
                }}
              >
                Other Network…
              </Button>
            </div>
          </div>
        </div>
      )}
      <div className="formrow">
        <span className="lbl">Stored on the unit</span>
        <span className="small muted" style={{ paddingTop: 5 }}>
          Joined networks and their passwords are kept on the unit&apos;s
          internal storage, not on the SD card, and are not encrypted. The unit
          joins them again by itself, also when it starts without the NAM card.
          Forget a network to remove it.
        </span>
      </div>
      <div className="formrow" style={{ borderBottom: 0 }}>
        <span className="lbl">On a network</span>
        <Banner tone="warn">
          Anyone on the same network can reach the NAM card&apos;s SSH login
          (root). It accepts a blank password until you add an SSH key or set a
          password. See the LAN access guide in the project&apos;s docs.
        </Banner>
      </div>
      {joining && (
        <JoinSheet
          target={joining}
          wifi={wifi}
          onClose={() => {
            setJoining(null);
          }}
        />
      )}
      {forgetting && (
        <Sheet
          alert
          title={`Forget ${forgetting.ssid}?`}
          onClose={() => {
            setForgetting(null);
          }}
          actions={[
            {
              label: "Cancel",
              onClick: () => {
                setForgetting(null);
              },
            },
            {
              label: "Forget",
              variant: "danger",
              autoFocus: true,
              onClick: () => {
                const n = forgetting;
                setForgetting(null);
                void wifi.forget(n);
              },
            },
          ]}
        >
          <p className="muted">
            The unit deletes its saved password and stops joining this network.
            {forgetting.connected && " It disconnects now."}
          </p>
        </Sheet>
      )}
    </>
  );
}

function NetworkList({
  networks,
  disabled,
  scanning,
  onJoin,
  onForget,
}: {
  networks: WifiNetwork[];
  disabled: boolean;
  scanning: boolean;
  onJoin: (n: WifiNetwork) => void;
  onForget: (n: WifiNetwork) => void;
}) {
  if (networks.length === 0)
    return (
      <span className="muted" style={{ paddingTop: 5 }}>
        {scanning ? "Scanning…" : "No networks found."}
      </span>
    );
  return (
    <ul className="wifi-list" aria-label="Networks">
      {networks.map((n) => {
        const reason = unsupportedReason(n.security);
        return (
          <li key={`${String(n.security)}:${n.ssid}`} className="wifi-row">
            <div className="wifi-name">
              <span>{n.ssid}</span>
              <span className="small muted3">
                {securityLabel(n.security)} · signal {String(n.signal)}%
              </span>
            </div>
            <div className="hrow" style={{ justifyContent: "flex-end" }}>
              {n.connected ? (
                <Tag tone="ok">Connected</Tag>
              ) : (
                n.saved && <Tag>Saved</Tag>
              )}
              {reason ? (
                <span className="small muted3" title={reason}>
                  Not supported
                </span>
              ) : (
                !n.connected && (
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() => {
                      onJoin(n);
                    }}
                  >
                    {needsPassword(n) ? "Join…" : "Join"}
                  </Button>
                )
              )}
              {n.saved && (
                <Button
                  size="sm"
                  destructiveText
                  disabled={disabled}
                  onClick={() => {
                    onForget(n);
                  }}
                >
                  Forget…
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function JoinSheet({
  target,
  wifi,
  onClose,
}: {
  target: JoinTarget;
  wifi: WifiStore;
  onClose: () => void;
}) {
  const hidden = "hidden" in target;
  const [ssid, setSsid] = useState(hidden ? "" : target.network.ssid);
  const [security, setSecurity] = useState<number>(
    hidden ? SECURITY.psk : target.network.security,
  );
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const needs = security === SECURITY.psk;
  const nameError = hidden ? ssidError(ssid) : null;
  const passError = needs ? passphraseError(password) : null;
  const ready = !nameError && !passError;

  const submit = () => {
    if (!ready) return;
    const j = {
      ssid: hidden ? ssid : target.network.ssid,
      security,
      hidden,
      passphrase: needs ? password : "",
    };
    onClose();
    void wifi.join(j, false);
  };

  return (
    <Sheet
      title={hidden ? "Join Other Network" : `Join ${target.network.ssid}`}
      onClose={onClose}
      actions={[
        { label: "Cancel", onClick: onClose },
        {
          label: "Join",
          variant: "primary",
          disabled: !ready,
          onClick: submit,
        },
      ]}
    >
      <form
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {hidden && (
          <>
            <p className="small muted">
              For a network that doesn&apos;t broadcast its name. It must be in
              range.
            </p>
            <TextField
              label="Network name"
              value={ssid}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              error={ssid ? (nameError ?? undefined) : undefined}
              onChange={(e) => {
                setSsid(e.target.value);
              }}
            />
            <div role="radiogroup" aria-label="Security">
              <span className="tn-field-label">Security</span>
              <Radio
                name="security"
                label="WPA/WPA2 Personal"
                checked={security === SECURITY.psk}
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
            </div>
          </>
        )}
        {needs && (
          <>
            <TextField
              label="Password"
              type={show ? "text" : "password"}
              value={password}
              autoFocus={!hidden}
              autoComplete="off"
              spellCheck={false}
              error={password ? (passError ?? undefined) : undefined}
              onChange={(e) => {
                setPassword(e.target.value);
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
        )}
        {needs && (
          <p className="small muted3">
            The password goes to the unit over USB and is saved there.
          </p>
        )}
        {/* Enter submits the form. */}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
