// src/ds/util.ts — non-component helpers shared by the design-system components.

/** Join truthy class names. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export const CONNECT_STEPS = [
  "Insert the NAM SD card and power the unit on.",
  "Wait for the preset screen.",
  "Plug the unit's USB-C cable into this computer.",
];

const SIGNAL_LEVELS = ["Weak", "Fair", "Good", "Excellent"] as const;

/** Wi-Fi signal 0–100 as 0–3 lit bars: under 25, under 50, under 75, else. */
export function signalBars(percent: number): number {
  return Math.min(3, Math.max(0, Math.floor(percent / 25)));
}

/** Weak, Fair, Good or Excellent. */
export function signalLevel(percent: number): string {
  return SIGNAL_LEVELS[signalBars(percent)] ?? "Weak";
}
