# LAN access on an SD-booted NAM card (Wi-Fi, SSH, TONE3000)

Card creation and boot checks are in [the SD-card guide](../sd-card.md). The **TMP NAM** desktop app manages captures and Tone3000 sync over the USB cable and needs none of this; Wi-Fi + SSH is the computer-free path (an SSH app on a phone works). Maintainer compilation and publication are described in [BUILDING.md](../../BUILDING.md).

Stock 1.8.58 has ConnMan and an RTL8822CU Wi-Fi/Bluetooth radio but no SSH daemon. The normal device UI has no Wi-Fi screen. Avahi advertises `_ssh._tcp` even without a daemon listening.

The card adds Dropbear SSH under internal `/data` and TONE3000 downloads into the User IR store. Joining a network is a separate step.

## 1. Join a network

Use **TMP NAM → Settings → Wi-Fi** with the unit connected over USB: turn Wi-Fi on, pick a network and enter its password. The app sends these requests to the audio engine over the USB HID channel (`WifiMessage`), and the engine drives ConnMan; nothing restarts. It lists open and WPA/WPA2 Personal networks as joinable; WEP, WPA/WPA2 Enterprise and WPA3-only networks are not supported by the firmware's Wi-Fi code. A hidden network is joined with **Other Network…** while it is in range.

Without the app, the factory-test UI has a Wi-Fi Test screen: hold the top-left footswitch (and nothing else) while powering on (startup button mask `1`).

Joining writes `/var/lib/connman/wifi_*_managed_*/settings` on internal eMMC `/data` (`Favorite=true`, `AutoConnect=true`, the passphrase in plain text), and turning Wi-Fi on sets `/data/settings.json` `wifiEnabled: true`. A wrong password makes the engine delete that network's saved entry. **Forget** in the app deletes it too; it works only while the network is in range.

## 2. Wi-Fi at boot

The engine applies `/data/settings.json` `wifiEnabled` every time it starts, with or without the card: `true` powers the radio and ConnMan joins saved networks by itself, `false` (the default) powers it off. The app's on/off switch writes that setting.

Saved networks and the setting live on internal `/data`, so the unit also rejoins them when it boots the stock firmware without the card.

`/var/lib/connman/fenderupdate.config`, which a factory reset copies into `/data`, makes the unit join any WPA2 network named `FENDER_UPDATE` with Fender's published passphrase while Wi-Fi is on. The app mentions it under "About Wi-Fi on the unit" when it is present; it matters only while SSH access is set to No security, or on a card too old for the SSH access switch.

Check association from the USB console:

```sh
dbus-send --system --print-reply --dest=net.connman / net.connman.Manager.GetServices
```

## 3. SSH access

SSH is **off by default** and is switched in **TMP NAM → Settings → Wi-Fi → SSH access**, over the USB cable. The choice is stored on internal storage (`/data/nam/ssh/state`) and applied at every start with the card, by `/usr/local/bin/nam-ssh.sh` (`dropbear-nam.service`):

- **Off** (`enabled=0`, or no file): Dropbear doesn't run.
- **Key only** (`mode=key`): only allowed public keys log in; Dropbear runs with `-s`, so password logins are refused, including root's empty one. Turning SSH on starts here and allows this computer: the app reads `~/.ssh/id_ed25519.pub`, creating it with `ssh-keygen` when missing; the private key is never read.
- **No security** (`mode=none`): anyone on the network logs in as root with no key or password (Dropbear `-B`; stock root has an empty password). The app asks for confirmation and warns while it is on. Useful for an SSH app on a phone.

Allowed keys live in `/data/nam/ssh/authorized_keys` (root's `~/.ssh/authorized_keys` on the card points there), so they survive new cards. To allow another computer in Key only, log in from this one and append that computer's public key line to the file; the app lists every key it can read and can remove it. Removing the last allowed computer in Key only turns SSH off. A factory reset that clears `/data` removes the setting, the keys and the host key: SSH is then off until it is turned on again, and clients see a new host key.

A card made before this switch runs SSH with a blank root password at every boot; the app shows it as too old and offers to create a new card.

## 4. SSH and helper installation

The distributed release supplies `dropbear` and `dropbearkey`, built from pinned Dropbear 2024.86 sources as static, stripped AArch64/musl binaries. Their current hashes are pinned in `device/release.json`. Card writing does not compile them.

On every boot, `nam-lan-install.service` installs each packaged file atomically at its persistent destination, replacing an older copy when necessary:

```text
/data/nam/bin/dropbear
/data/nam/bin/dropbearkey
/data/nam/t3k_sync.py
/data/nam/register_nam_ir.py
```

`dropbear-nam.service` requires successful installer completion before it starts. Existing SSH host keys, NAM captures, player settings, network settings and TONE3000 tokens are retained. A missing host key is generated on-device at `/data/nam/ssh/ed25519`. The service configuration lives on the SD root; `/data/nam` persists across card changes.

Check a new card from its USB console before relying on network access:

```sh
systemctl status nam-lan-install.service dropbear-nam.service
cat /etc/sd-root-build-id
sha256sum /data/nam/bin/dropbear /data/nam/bin/dropbearkey
sha256sum /data/nam/t3k_sync.py /data/nam/register_nam_ir.py
cat /data/nam/ssh/state
```

Compare the active files with that card's manifest and build ID. If installation failed, inspect `journalctl -u nam-lan-install.service` and fix the failed installation before starting SSH. Package checks alone do not establish remote network access.

Connect with `ssh root@fmic-tm-pro.local` (or the unit's address) once SSH access is on, and do not forward port 22 beyond the LAN. OpenSSH `scp` defaults to SFTP, but this image has no `sftp-server`. Transfer a model with:

```sh
ssh root@fmic-tm-pro.local 'cat > /data/userIRs/My_Model.nam.wav' < My_Model.nam
```

Register it using `python3 /data/nam/register_nam_ir.py` and restart `tm-stomp-server` when ready to reload the picker.

## 5. TONE3000

The installer supplies the Python helpers. TONE3000 configuration and tokens remain under `/data/nam`:

```text
/data/nam/t3k_pub          # publishable t3k_pub_… key, mode 600
/data/nam/t3k_tokens.json  # OAuth credentials; keep private
```

On the pedal, run:

```sh
python3 /data/nam/t3k_sync.py
```

The first run uses LAN-relay OAuth: open the printed URL on a phone on the same Wi-Fi. Later runs refresh the saved token. The site UI calls the collection **Bookmarks**; its API endpoint is `/tones/favorited`.

The helper picks one model per tone: A2 if published (one file holding its sizes; TONE3000 lists A2 with no size), else A1 Feather, then A1 Nano; it skips A1 Standard/Lite. It asks the API for A2 and A1 separately, since a request without `architecture` never returns A2. These labels are a download filter, not proof that a capture fits the approximately 725 µs IR-slot deadline; validate its actual configuration on the unit. After a download the script restarts `tm-stomp-server` so the User IR picker reloads (`--no-restart` skips that restart). Bypass the Fender amp block when auditioning an amp-and-cab NAM capture.
