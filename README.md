# TMP NAM

Neural amp model (NAM) playback for the owner's Fender Tone Master Pro
(firmware **1.8.58** only), and the **TMP NAM** desktop app that runs it:

- **Captures** — list the NAM captures on the unit, add `.nam` files, remove them,
  pick the A2 network size (Feather … Full) and output gain per capture.
- **Tone3000** — sign in with your own key and install your bookmarked and created
  tones; choose which variants are allowed (A1 standard/lite/feather/nano,
  A2 full/feather/nano).
- **SD Card** — build the bootable card from the official Fender firmware: NAM
  player, USB root console and Wi-Fi SSH. The internal firmware is never modified;
  remove the card to boot stock.

The app runs on **macOS and Linux** (Windows is not supported) and talks to the unit
over the stock USB-C cable (the card's USB root console), so the pedal needs no Wi-Fi.
Signed macOS builds and Linux packages are on the
[Releases](https://github.com/pcavadas/tmp-nam/releases) page (see [Download](#download)). Its design (spec, tokens, screens) is in
`apps/desktop/design/`.

> Owner hardware only. While the card is booted, the USB console is an
> unauthenticated root shell. Back up the unit (Pro Control) before first use; you
> use this entirely at your own risk.

## Download

Get the file for your computer from the latest
[release](https://github.com/pcavadas/tmp-nam/releases/latest):

| Your computer | File |
|---|---|
| Mac with Apple silicon (M1 or later) | `TMP-NAM_<version>_macos_apple-silicon.dmg` |
| Mac with an Intel processor | `TMP-NAM_<version>_macos_intel.dmg` |
| Linux: Debian, Ubuntu and derivatives | `TMP-NAM_<version>_linux_amd64.deb` |
| Linux: Fedora, openSUSE and other RPM distributions | `TMP-NAM_<version>_linux_x86_64.rpm` |
| Linux: any other distribution | `TMP-NAM_<version>_linux_amd64.AppImage` |

On a Mac, Apple menu › About This Mac shows the chip ("Apple M…" or "Intel") and the
macOS version, which must be 12 (Monterey) or later. The Linux packages are for 64-bit
Intel/AMD PCs. Ignore the "Source code" archives unless you build the app yourself.

## Repository layout

| Path | What lives there |
|---|---|
| `apps/desktop/` | TMP NAM app — Tauri 2 (Rust) + React/TypeScript |
| `crates/sdcard/` | Card builder library + `tmp-sdcard` CLI |
| `device/` | Everything that lands on the card: prebuilt ARM binaries, systemd units, helpers, licenses, and `release.json` (all pins) |
| `player/` | NAM player C++ source and its ARM cross-build |
| `tools/release/` | Maintainer scripts: rebuild the ARM binaries, publish them into `device/` |
| `docs/` | Card guide, device notes (USB console, Wi-Fi/SSH), player design |
| `scripts/check.sh` | Repository checks |

## Quick start

```sh
cd apps/desktop
bun install
bun run tauri dev        # TMP_NAM_SIM=1 bun run tauri dev  → simulated unit, no hardware
```

Card building needs `brew install squashfs e2fsprogs mtools util-linux` and the
official `ToneMasterPro_v1_8_58.img`. Headless:

```sh
cargo run --release -p tmp-sdcard -- image ~/Downloads/ToneMasterPro_v1_8_58.img build/card.img
```

## Documentation

- [docs/sd-card.md](docs/sd-card.md) — create the card, first boot, checks, troubleshooting
- [docs/device/usb-console.md](docs/device/usb-console.md) — how the root console and SD boot work
- [docs/device/lan-access.md](docs/device/lan-access.md) — Wi-Fi, SSH, on-device Tone3000 sync
- [docs/nam-player.md](docs/nam-player.md) — NAM player scope, `player.json`, limits
- [BUILDING.md](BUILDING.md) — development, release pins, rebuilding the ARM binaries

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Not affiliated with Fender; this repository contains no Fender firmware —
see [NOTICE](NOTICE). Third-party licenses for the shipped binaries are in
[device/licenses/](device/licenses/).
