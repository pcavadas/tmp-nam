//! Wi-Fi over the engine's HID channel: `FenderMessageTMS.wifiMessage` (field 9).
//!
//! The engine drives ConnMan itself: it maps an SSID and security value to a ConnMan
//! service, answers ConnMan's passphrase request from its own agent, and keeps
//! `/data/settings.json` `wifiEnabled` and ConnMan's `Powered` in step. Nothing here
//! restarts a service, and the passphrase only ever travels inside one HID message.
//!
//! Replies carry no request id, so each operation sends one request and waits for the
//! message types that answer it:
//! - status (10) → `wifiStatusChanged` (9); list (6) and scan (8) → list (7).
//! - enable (3) has no reply: a status broadcast follows when the radio changes, an
//!   error 1/2 when ConnMan refuses. It acts only when the request differs from the
//!   stored `wifiEnabled` (read through `SettingsMessage` 59 → 60).
//! - connect (1) has no success reply: a status broadcast with `isConnected` follows,
//!   or error 3 (not found / failed) or 4 (wrong passphrase: the engine then deletes
//!   that network's saved profile).
//! - forget (4) → `wifiNetworkForgotten` (5), or error 6.
//!
//! The engine waits on ConnMan (up to libdbus's 25 s) for most requests, so the
//! timeouts below allow for that.

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::hid::{
    bytes_field, get_bytes, get_varint, nested, parse, varint_field, HidSession, Val, SETTINGS,
};

const WIFI: u32 = 9;

const CONNECT: u32 = 1;
const ENABLE: u32 = 3;
const FORGET: u32 = 4;
const FORGOTTEN: u32 = 5;
const LIST_REQUEST: u32 = 6;
const LIST: u32 = 7;
const SCAN: u32 = 8;
const STATUS: u32 = 9;
const STATUS_REQUEST: u32 = 10;
const ERROR: u32 = 11;

const SETTINGS_WIFI_REQUEST: u32 = 59;
const SETTINGS_WIFI_RESPONSE: u32 = 60;

/// ConnMan security as the engine encodes it.
pub const SECURITY_UNSUPPORTED: u32 = 0;
pub const SECURITY_OPEN: u32 = 1;
pub const SECURITY_WEP: u32 = 2;
pub const SECURITY_PSK: u32 = 3;
pub const SECURITY_ENTERPRISE: u32 = 4;

/// Error codes of `wifiError`.
const ERR_ENABLE: u64 = 1;
const ERR_DISABLE: u64 = 2;
const ERR_CONNECT: u64 = 3;
const ERR_INVALID_KEY: u64 = 4;
const ERR_FORGET: u64 = 6;

/// A ConnMan call blocks the engine for up to 25 s; leave room around it.
const REPLY: Duration = Duration::from_secs(30);
const SCAN_WAIT: Duration = Duration::from_secs(30);
/// An enable that leaves the radio as it is: only the engine's read of `Powered`.
const UNCHANGED_WAIT: Duration = Duration::from_secs(3);
/// The D-Bus window plus association and DHCP.
const JOIN_WAIT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct WifiStatus {
    /// ConnMan's `Powered`; also false when ConnMan or the radio is unavailable.
    pub enabled: bool,
    pub connected: bool,
    /// Empty when the engine found no `wlan0` at start.
    pub mac: String,
    pub ipv4: String,
    pub ssid: String,
    pub security: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Network {
    pub ssid: String,
    pub security: u32,
    pub saved: bool,
    pub connected: bool,
    /// 0–100.
    pub signal: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WifiEvent {
    Status(WifiStatus),
    List(Vec<Network>),
    Forgotten { ssid: String, security: u32 },
    Error(u64),
}

/// A network to join. `Debug` leaves the passphrase out.
#[derive(Clone, Deserialize)]
pub struct Join {
    pub ssid: String,
    pub security: u32,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub passphrase: String,
}

impl fmt::Debug for Join {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Join")
            .field("security", &self.security)
            .field("hidden", &self.hidden)
            .field(
                "passphrase",
                &if self.passphrase.is_empty() {
                    ""
                } else {
                    "…"
                },
            )
            .finish_non_exhaustive()
    }
}

/// How a join ended.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinOutcome {
    Connected,
    /// ConnMan rejected the key; the engine deleted that network's saved profile.
    WrongPassword,
    /// Not found, or ConnMan failed to associate or get an address.
    Failed,
    /// Neither a status nor an error within `JOIN_WAIT`.
    NoResponse,
}

/// Everything the Settings page shows.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct WifiState {
    pub status: WifiStatus,
    /// The preference the engine applies at every start; `None` if it didn't answer.
    pub saved_enabled: Option<bool>,
    /// Networks ConnMan currently knows (from the last scan).
    pub networks: Vec<Network>,
    /// Whether the unit has a Wi-Fi interface; `None` when unknown.
    pub radio: Option<bool>,
    /// Fender's `FENDER_UPDATE` provisioning file is in ConnMan's storage.
    pub fender_update: bool,
}

/// Why a join request is refused before anything is sent, or `None`.
pub fn check_join(j: &Join) -> Option<String> {
    let n = j.ssid.len();
    if n == 0 || n > 32 {
        return Some("A network name is 1 to 32 bytes.".into());
    }
    if j.ssid.chars().any(char::is_control) {
        return Some("The network name contains control characters.".into());
    }
    match j.security {
        SECURITY_OPEN if !j.passphrase.is_empty() => {
            Some("An open network takes no password.".into())
        }
        SECURITY_OPEN => None,
        // Empty: a saved network, joined with the password the unit already has.
        SECURITY_PSK if j.passphrase.is_empty() && !j.hidden => None,
        SECURITY_PSK => passphrase_error(&j.passphrase),
        SECURITY_WEP => Some("WEP networks can't be joined: WEP is no longer secure.".into()),
        _ => Some("Only open and WPA/WPA2 Personal networks can be joined.".into()),
    }
}

/// WPA/WPA2 Personal: 8–63 printable ASCII characters, or 64 hex digits.
pub fn passphrase_error(p: &str) -> Option<String> {
    let hex = p.len() == 64 && p.bytes().all(|b| b.is_ascii_hexdigit());
    let text = (8..=63).contains(&p.len()) && p.bytes().all(|b| (0x20..0x7f).contains(&b));
    (!hex && !text).then(|| {
        "A WPA/WPA2 password is 8 to 63 characters (letters, digits, symbols, spaces), or 64 hex digits."
            .into()
    })
}

// ─── messages ───────────────────────────────────────────────────────────────────────

fn wifi(kind: u32, inner: &[u8]) -> Vec<u8> {
    nested(WIFI, &nested(kind, inner))
}

fn status_request() -> Vec<u8> {
    wifi(STATUS_REQUEST, &[])
}

fn list_request() -> Vec<u8> {
    wifi(LIST_REQUEST, &[])
}

fn scan_request() -> Vec<u8> {
    wifi(SCAN, &[])
}

fn enable(on: bool) -> Vec<u8> {
    let mut inner = Vec::new();
    if on {
        varint_field(&mut inner, 1, 1);
    }
    wifi(ENABLE, &inner)
}

fn network_fields(ssid: &str, security: u32) -> Vec<u8> {
    let mut inner = Vec::new();
    bytes_field(&mut inner, 1, ssid.as_bytes());
    if security != 0 {
        varint_field(&mut inner, 2, u64::from(security));
    }
    inner
}

fn connect(j: &Join) -> Vec<u8> {
    let mut inner = network_fields(&j.ssid, j.security);
    if j.hidden {
        varint_field(&mut inner, 3, 1);
    }
    if !j.passphrase.is_empty() {
        bytes_field(&mut inner, 4, j.passphrase.as_bytes());
    }
    wifi(CONNECT, &inner)
}

fn forget(ssid: &str, security: u32) -> Vec<u8> {
    wifi(FORGET, &network_fields(ssid, security))
}

/// `SettingsMessage.wifiSettingsRequest`.
fn settings_request() -> Vec<u8> {
    nested(SETTINGS, &nested(SETTINGS_WIFI_REQUEST, &[]))
}

fn text(fields: &[(u32, Val)], field: u32) -> String {
    get_bytes(fields, field)
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default()
}

fn flag(fields: &[(u32, Val)], field: u32) -> bool {
    get_varint(fields, field).is_some_and(|v| v != 0)
}

fn number(fields: &[(u32, Val)], field: u32) -> u32 {
    get_varint(fields, field).map_or(0, |v| u32::try_from(v).unwrap_or(u32::MAX))
}

/// The `WifiMessage` event in one reassembled `FenderMessageTMS`, if it is one.
fn wifi_event(msg: &[u8]) -> Option<WifiEvent> {
    let w = parse(get_bytes(&parse(msg), WIFI)?);
    let (kind, body) = w.into_iter().find_map(|(f, v)| match v {
        Val::Bytes(b) => Some((f, b)),
        _ => None,
    })?;
    let m = parse(&body);
    Some(match kind {
        STATUS => WifiEvent::Status(WifiStatus {
            enabled: flag(&m, 1),
            connected: flag(&m, 2),
            mac: text(&m, 3),
            ipv4: text(&m, 4),
            ssid: text(&m, 5),
            security: number(&m, 6),
        }),
        LIST => WifiEvent::List(
            m.iter()
                .filter_map(|(f, v)| match v {
                    Val::Bytes(r) if *f == 2 => {
                        let r = parse(r);
                        Some(Network {
                            ssid: text(&r, 1),
                            security: number(&r, 2),
                            saved: flag(&r, 3),
                            connected: flag(&r, 4),
                            signal: number(&r, 5).min(100),
                        })
                    }
                    _ => None,
                })
                .collect(),
        ),
        FORGOTTEN => WifiEvent::Forgotten {
            ssid: text(&m, 1),
            security: number(&m, 2),
        },
        ERROR => WifiEvent::Error(get_varint(&m, 1).unwrap_or(0)),
        _ => return None,
    })
}

/// `SettingsMessage.wifiSettingsResponse{ wifiEnabled{ value } }`.
fn saved_enabled(msg: &[u8]) -> Option<bool> {
    let s = parse(get_bytes(&parse(msg), SETTINGS)?);
    let r = parse(get_bytes(&s, SETTINGS_WIFI_RESPONSE)?);
    Some(get_bytes(&r, 1).is_some_and(|v| flag(&parse(v), 1)))
}

// ─── operations ─────────────────────────────────────────────────────────────────────

fn no_answer(what: &str) -> String {
    format!("The audio engine didn't answer the Wi-Fi {what} request.")
}

/// Send `msg` and wait up to `d` for a Wi-Fi event `want` accepts.
fn exchange<T>(
    h: &mut HidSession,
    msg: &[u8],
    d: Duration,
    mut want: impl FnMut(WifiEvent) -> Option<T>,
) -> Result<Option<T>, String> {
    h.exchange(msg, d, |m| wifi_event(m).and_then(&mut want))
}

pub fn status(h: &mut HidSession) -> Result<WifiStatus, String> {
    exchange(h, &status_request(), REPLY, |e| match e {
        WifiEvent::Status(s) => Some(s),
        _ => None,
    })?
    .ok_or_else(|| no_answer("status"))
}

/// The stored preference, `None` when the engine doesn't answer.
pub fn saved(h: &mut HidSession) -> Result<Option<bool>, String> {
    h.exchange(&settings_request(), Duration::from_secs(5), saved_enabled)
}

/// The networks ConnMan already knows, without a new scan.
pub fn networks(h: &mut HidSession) -> Result<Vec<Network>, String> {
    exchange(h, &list_request(), REPLY, list)?.ok_or_else(|| no_answer("list"))
}

pub fn scan(h: &mut HidSession) -> Result<Vec<Network>, String> {
    exchange(h, &scan_request(), SCAN_WAIT, list)?.ok_or_else(|| no_answer("scan"))
}

fn list(e: WifiEvent) -> Option<Vec<Network>> {
    match e {
        WifiEvent::List(l) => Some(l),
        _ => None,
    }
}

/// Status, stored preference and known networks.
pub fn state(h: &mut HidSession) -> Result<WifiState, String> {
    let status = status(h)?;
    let saved_enabled = saved(h)?;
    let networks = if status.enabled {
        networks(h)?
    } else {
        Vec::new()
    };
    Ok(WifiState {
        status,
        saved_enabled,
        networks,
        ..WifiState::default()
    })
}

/// The `WifiEnable` requests that bring the radio and the stored preference to `on`.
/// The engine acts only when a request differs from the stored value, and then
/// switches the radio only if it isn't already in that state; so when the stored
/// value already matches but the radio doesn't, store the opposite first (the radio
/// stays as it is), then the target.
fn enable_plan(on: bool, saved: Option<bool>, live: bool) -> Vec<bool> {
    match saved {
        Some(s) if s == on && live == on => vec![],
        Some(s) if s == on => vec![!on, on],
        _ => vec![on],
    }
}

pub fn set_enabled(h: &mut HidSession, on: bool) -> Result<(), String> {
    let mut live = status(h)?.enabled;
    for step in enable_plan(on, saved(h)?, live) {
        let failed = if step { ERR_ENABLE } else { ERR_DISABLE };
        // Success has no reply. When the radio changes a status broadcast follows;
        // when it is already there only an error can come, and quickly.
        let wait = if live == step { UNCHANGED_WAIT } else { REPLY };
        let answer = exchange(h, &enable(step), wait, |e| match e {
            WifiEvent::Error(c) if c == failed => Some(Err(())),
            WifiEvent::Status(s) if s.enabled == step => Some(Ok(())),
            _ => None,
        })?;
        live = step;
        if answer == Some(Err(())) {
            return Err(if on {
                "The unit couldn't turn Wi-Fi on.".into()
            } else {
                "The unit couldn't turn Wi-Fi off.".into()
            });
        }
    }
    // A request that left the radio as it was sends nothing: confirm both values.
    let (live, stored) = (status(h)?.enabled, saved(h)?);
    if live != on || stored.is_some_and(|s| s != on) {
        return Err(if on {
            "Wi-Fi didn't turn on. Try again.".into()
        } else {
            "Wi-Fi didn't turn off. Try again.".into()
        });
    }
    Ok(())
}

pub fn join(h: &mut HidSession, j: &Join) -> Result<JoinOutcome, String> {
    if let Some(e) = check_join(j) {
        return Err(e);
    }
    let outcome = exchange(h, &connect(j), JOIN_WAIT, |e| match e {
        WifiEvent::Error(ERR_INVALID_KEY) => Some(JoinOutcome::WrongPassword),
        WifiEvent::Error(ERR_CONNECT) => Some(JoinOutcome::Failed),
        WifiEvent::Status(s) if s.connected && s.ssid == j.ssid => Some(JoinOutcome::Connected),
        _ => None,
    })?;
    if let Some(o) = outcome {
        return Ok(o);
    }
    // The broadcast can be missed (e.g. already connected to it): ask once.
    let s = status(h)?;
    Ok(if s.connected && s.ssid == j.ssid {
        JoinOutcome::Connected
    } else {
        JoinOutcome::NoResponse
    })
}

/// Forget a saved network. ConnMan must currently list it (in range).
pub fn forget_network(h: &mut HidSession, ssid: &str, security: u32) -> Result<(), String> {
    let answer = exchange(h, &forget(ssid, security), REPLY, |e| match e {
        WifiEvent::Forgotten { ssid: s, .. } if s == ssid => Some(true),
        WifiEvent::Error(ERR_FORGET) => Some(false),
        _ => None,
    })?;
    match answer {
        Some(true) => Ok(()),
        Some(false) => Err(
            "The unit couldn't forget this network. It can only forget a network that's in range."
                .into(),
        ),
        None => Err(no_answer("forget")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        s.split_whitespace()
            .map(|b| u8::from_str_radix(b, 16).unwrap())
            .collect()
    }

    fn join(ssid: &str, security: u32, hidden: bool, passphrase: &str) -> Join {
        Join {
            ssid: ssid.into(),
            security,
            hidden,
            passphrase: passphrase.into(),
        }
    }

    #[test]
    fn requests_match_the_engine_schema() {
        assert_eq!(status_request(), hex("4a 02 52 00"));
        assert_eq!(list_request(), hex("4a 02 32 00"));
        assert_eq!(scan_request(), hex("4a 02 42 00"));
        assert_eq!(enable(true), hex("4a 04 1a 02 08 01"));
        assert_eq!(enable(false), hex("4a 02 1a 00"));
        assert_eq!(settings_request(), hex("1a 03 da 03 00"));
        assert_eq!(
            connect(&join("HomeNet", SECURITY_PSK, false, "correct horse")),
            hex("4a 1c 0a 1a 0a 07 48 6f 6d 65 4e 65 74 10 03 22 0d 63 6f 72 72 65 63 74 20 68 6f 72 73 65")
        );
        assert_eq!(
            connect(&join("Cafe", SECURITY_OPEN, false, "")),
            hex("4a 0a 0a 08 0a 04 43 61 66 65 10 01")
        );
        assert_eq!(
            connect(&join("Hidden", SECURITY_PSK, true, "12345678")),
            hex("4a 18 0a 16 0a 06 48 69 64 64 65 6e 10 03 18 01 22 08 31 32 33 34 35 36 37 38")
        );
        assert_eq!(
            forget("HomeNet", SECURITY_PSK),
            hex("4a 0d 22 0b 0a 07 48 6f 6d 65 4e 65 74 10 03")
        );
    }

    #[test]
    fn parses_engine_replies() {
        assert_eq!(
            wifi_event(&hex(
                "4a 32 4a 30 08 01 10 01 1a 11 61 61 3a 62 62 3a 63 63 3a 64 64 3a 65 65 3a 66 66
                 22 0c 31 39 32 2e 31 36 38 2e 31 2e 34 32 2a 07 48 6f 6d 65 4e 65 74 30 03"
            )),
            Some(WifiEvent::Status(WifiStatus {
                enabled: true,
                connected: true,
                mac: "aa:bb:cc:dd:ee:ff".into(),
                ipv4: "192.168.1.42".into(),
                ssid: "HomeNet".into(),
                security: SECURITY_PSK,
            }))
        );
        assert_eq!(
            wifi_event(&hex(
                "4a 15 4a 13 1a 11 61 61 3a 62 62 3a 63 63 3a 64 64 3a 65 65 3a 66 66"
            )),
            Some(WifiEvent::Status(WifiStatus {
                mac: "aa:bb:cc:dd:ee:ff".into(),
                ..WifiStatus::default()
            }))
        );
        assert_eq!(
            wifi_event(&hex(
                "4a 21 3a 1f 12 11 0a 07 48 6f 6d 65 4e 65 74 10 03 18 01 20 01 28 48
                 12 0a 0a 04 43 61 66 65 10 01 28 28"
            )),
            Some(WifiEvent::List(vec![
                Network {
                    ssid: "HomeNet".into(),
                    security: SECURITY_PSK,
                    saved: true,
                    connected: true,
                    signal: 72,
                },
                Network {
                    ssid: "Cafe".into(),
                    security: SECURITY_OPEN,
                    saved: false,
                    connected: false,
                    signal: 40,
                },
            ]))
        );
        assert_eq!(
            wifi_event(&hex("4a 04 5a 02 08 04")),
            Some(WifiEvent::Error(4))
        );
        assert_eq!(
            wifi_event(&hex("4a 0d 2a 0b 0a 07 48 6f 6d 65 4e 65 74 10 03")),
            Some(WifiEvent::Forgotten {
                ssid: "HomeNet".into(),
                security: SECURITY_PSK
            })
        );
        // An empty list, a request echoed back and another family are not events.
        assert_eq!(
            wifi_event(&hex("4a 02 3a 00")),
            Some(WifiEvent::List(vec![]))
        );
        assert_eq!(wifi_event(&hex("4a 02 52 00")), None);
        assert_eq!(wifi_event(&hex("22 04 22 02 08 01")), None);
    }

    #[test]
    fn parses_the_stored_preference() {
        // SettingsMessage 60 { wifiEnabled 1 { value 1 } }
        assert_eq!(
            saved_enabled(&hex("1a 07 e2 03 04 0a 02 08 01")),
            Some(true)
        );
        assert_eq!(saved_enabled(&hex("1a 05 e2 03 02 0a 00")), Some(false));
        assert_eq!(saved_enabled(&hex("1a 03 e2 03 00")), Some(false));
        assert_eq!(saved_enabled(&hex("4a 02 52 00")), None);
    }

    #[test]
    fn enable_plan_covers_every_mismatch() {
        // Stored differs: one request; the engine leaves a radio already there alone.
        assert_eq!(enable_plan(true, Some(false), false), [true]);
        assert_eq!(enable_plan(true, Some(false), true), [true]);
        assert_eq!(enable_plan(false, Some(true), true), [false]);
        // Already there.
        assert!(enable_plan(true, Some(true), true).is_empty());
        assert!(enable_plan(false, Some(false), false).is_empty());
        // Stored matches but the radio doesn't: store the opposite, then the target.
        assert_eq!(enable_plan(true, Some(true), false), [false, true]);
        assert_eq!(enable_plan(false, Some(false), true), [true, false]);
        // Unknown preference: just ask.
        assert_eq!(enable_plan(true, None, false), [true]);
    }

    #[test]
    fn join_checks() {
        assert!(check_join(&join("Home", SECURITY_PSK, false, "12345678")).is_none());
        assert!(check_join(&join("Home", SECURITY_PSK, false, &"a".repeat(64))).is_none());
        assert!(check_join(&join("Home", SECURITY_PSK, false, &"g".repeat(64))).is_some());
        assert!(check_join(&join("Home", SECURITY_PSK, false, "1234567")).is_some());
        assert!(check_join(&join("Home", SECURITY_PSK, false, &"a".repeat(65))).is_some());
        assert!(check_join(&join("Home", SECURITY_PSK, false, "pässword")).is_some());
        // A saved network joins with the unit's password; a hidden one needs it.
        assert!(check_join(&join("Home", SECURITY_PSK, false, "")).is_none());
        assert!(check_join(&join("Home", SECURITY_PSK, true, "")).is_some());
        assert!(check_join(&join("Cafe", SECURITY_OPEN, false, "")).is_none());
        assert!(check_join(&join("Cafe", SECURITY_OPEN, false, "x")).is_some());
        assert!(check_join(&join("", SECURITY_OPEN, false, "")).is_some());
        assert!(check_join(&join(&"n".repeat(33), SECURITY_OPEN, false, "")).is_some());
        assert!(check_join(&join("a\nb", SECURITY_OPEN, false, "")).is_some());
        for s in [SECURITY_UNSUPPORTED, SECURITY_WEP, SECURITY_ENTERPRISE] {
            assert!(check_join(&join("Office", s, false, "12345678")).is_some());
        }
    }

    #[test]
    fn debug_hides_the_passphrase() {
        let shown = format!(
            "{:?}",
            join("HomeNet", SECURITY_PSK, false, "hunter2hunter2")
        );
        assert!(!shown.contains("hunter2"));
        assert!(!shown.contains("HomeNet"));
    }
}
