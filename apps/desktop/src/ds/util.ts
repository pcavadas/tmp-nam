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

export type SignalLevel = "Weak" | "Fair" | "Good" | "Excellent";

/** Wi-Fi signal 0–100: under 25 Weak, under 50 Fair, under 75 Good, else Excellent. */
export function signalLevel(percent: number): SignalLevel {
  if (percent < 25) return "Weak";
  if (percent < 50) return "Fair";
  if (percent < 75) return "Good";
  return "Excellent";
}
