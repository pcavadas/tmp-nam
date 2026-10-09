// src/ds/Wifi.tsx — signal strength, the network list and its rows (Settings › Wi-Fi).

import type { ReactNode } from "react";
import { Button, Spinner, Tag } from "./Button";
import { cx, signalBars, signalLevel } from "./util";

/** A Wi-Fi fan with four levels; the percentage is only in the accessible name and tooltip. */
export function SignalStrength({
  percent,
  muted,
  showLabel,
}: {
  /** 0–100. */
  percent: number;
  /** Greyed, for networks the unit can't join. */
  muted?: boolean;
  /** Print the level next to the glyph ("Good"). */
  showLabel?: boolean;
}) {
  const level = signalLevel(percent);
  const lit = signalBars(percent);
  const name = `Signal: ${level}, ${String(Math.round(percent))} %`;
  const arc = (i: number) => cx("tn-signal-bar", i <= lit && "is-lit");
  return (
    <span
      className={cx("tn-signal", muted && "is-muted")}
      role="img"
      aria-label={name}
      title={name}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <circle className={arc(0)} cx="8" cy="12.5" r="1.3" />
        <path className={arc(1)} d="M5.6 10.1a3.4 3.4 0 0 1 4.8 0" />
        <path className={arc(2)} d="M3.5 8a6.4 6.4 0 0 1 9 0" />
        <path className={arc(3)} d="M1.4 5.9a9.4 9.4 0 0 1 13.2 0" />
      </svg>
      {showLabel && <span>{level}</span>}
    </span>
  );
}

export type NetworkKind =
  "connected" | "saved" | "new" | "open" | "unsupported";

/** One network: glyph, name over caption, marks and actions by kind. */
export function NetworkRow({
  name,
  caption,
  signal,
  kind,
  joining,
  disabledReason,
  onJoin,
  onForget,
}: {
  name: string;
  caption: string;
  signal: number;
  kind: NetworkKind;
  /** This network is being joined. */
  joining?: boolean;
  /** Set while actions are unavailable; shown as their tooltip. */
  disabledReason?: string;
  onJoin?: () => void;
  onForget?: () => void;
}) {
  const muted = kind === "unsupported";
  const disabled = disabledReason !== undefined;
  const title = disabledReason;
  let actions: ReactNode;
  if (joining)
    actions = (
      <span className="tn-net-joining">
        <Spinner label={`Joining ${name}`} />
        Joining…
      </span>
    );
  else if (kind === "unsupported")
    actions = <span className="tn-net-note">Not supported</span>;
  else
    actions = (
      <>
        {kind === "connected" && <Tag tone="ok">Connected</Tag>}
        {kind === "saved" && <Tag>Saved</Tag>}
        {kind !== "connected" && (
          <Button
            size="sm"
            disabled={disabled}
            title={title}
            aria-label={`Join ${name}`}
            onClick={onJoin}
          >
            {kind === "saved" ? "Join" : "Join…"}
          </Button>
        )}
        {(kind === "connected" || kind === "saved") && (
          <Button
            size="sm"
            destructiveText
            disabled={disabled}
            title={title}
            aria-label={`Forget ${name}`}
            onClick={onForget}
          >
            Forget…
          </Button>
        )}
      </>
    );
  return (
    <li className={cx("tn-net", muted && "is-muted")} aria-label={name}>
      <SignalStrength percent={signal} muted={muted} />
      <span className="tn-net-text">
        <span className="tn-net-name" title={name}>
          {name}
        </span>
        <span className="tn-net-caption" title={caption}>
          {caption}
        </span>
      </span>
      <span className="tn-net-actions">{actions}</span>
    </li>
  );
}

/** The grouped network card: rows, a first scan in progress, or nothing found. */
export function NetworkList({
  state,
  empty,
  children,
}: {
  state: "rows" | "scanning" | "empty";
  /** What to say when nothing was found. */
  empty?: ReactNode;
  /** `NetworkRow`s. */
  children?: ReactNode;
}) {
  if (state === "scanning")
    return (
      <div className="tn-card tn-netlist tn-netlist-msg" aria-live="polite">
        <Spinner label="Looking for networks" />
        <span>Looking for networks…</span>
      </div>
    );
  if (state === "empty")
    return (
      <div
        className="tn-card tn-netlist tn-netlist-msg is-empty"
        aria-live="polite"
      >
        {empty}
      </div>
    );
  return (
    <ul className="tn-card tn-netlist" aria-label="Networks">
      {children}
    </ul>
  );
}
