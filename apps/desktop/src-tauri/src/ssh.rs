//! SSH access to the NAM card: public-key lines, this computer's key, and the state the
//! unit reports. The unit side is `unit_helper.py` (`ssh-*` commands) and the card's
//! `nam-ssh.sh`, which starts Dropbear at every boot as `/data/nam/ssh/state` says:
//! off, key only (`-s`: no password logins at all) or no security (`-B`: root with the
//! stock empty password). The unit stores whole `authorized_keys` lines; this module
//! is the only place that parses them. Only this computer's public key is ever sent.

use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SshMode {
    /// Allowed computers' keys only; passwords never work.
    #[default]
    Key,
    /// Anyone on the network, as root, with no key or password.
    None,
}

impl SshMode {
    pub fn arg(self) -> &'static str {
        match self {
            SshMode::Key => "key",
            SshMode::None => "none",
        }
    }
}

/// What the unit reports. `supported: false` is a card made before SSH access could
/// be switched: its SSH is always on, with no password.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SshState {
    pub supported: bool,
    pub enabled: bool,
    pub mode: SshMode,
    /// The allowed keys the app can read (other lines stay on the unit untouched).
    pub keys: Vec<PublicKey>,
}

/// The helper's answer: the same, with the raw key lines.
#[derive(Deserialize)]
pub struct UnitReport {
    supported: bool,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    mode: SshMode,
    #[serde(default)]
    keys: Vec<String>,
}

impl From<UnitReport> for SshState {
    fn from(r: UnitReport) -> Self {
        SshState {
            supported: r.supported,
            enabled: r.enabled,
            mode: r.mode,
            keys: r.keys.iter().filter_map(|l| parse_key(l)).collect(),
        }
    }
}

/// A parsed public-key line.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PublicKey {
    #[serde(rename = "type")]
    pub key_type: String,
    pub bits: Option<u32>,
    pub comment: String,
    pub fingerprint: String,
    /// The base64 field, which identifies the key on the unit (public).
    pub key: String,
    /// The normalized line sent to the unit.
    #[serde(skip)]
    pub line: String,
}

const KEY_TYPES: [(&str, Option<u32>); 5] = [
    ("ssh-ed25519", Some(256)),
    ("ssh-rsa", None),
    ("ecdsa-sha2-nistp256", Some(256)),
    ("ecdsa-sha2-nistp384", Some(384)),
    ("ecdsa-sha2-nistp521", Some(521)),
];

/// An SSH wire string at `pos`: its bytes and the position after it.
fn wire_string(blob: &[u8], pos: usize) -> Option<(&[u8], usize)> {
    let len = u32::from_be_bytes(blob.get(pos..pos + 4)?.try_into().ok()?) as usize;
    let end = pos.checked_add(4)?.checked_add(len)?;
    Some((blob.get(pos + 4..end)?, end))
}

/// `SHA256:<unpadded base64>`, as `ssh-keygen -l` prints it.
pub fn fingerprint(blob: &[u8]) -> String {
    let digest = Sha256::digest(blob);
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
    )
}

/// One `authorized_keys` line, or `None` when it isn't a supported public key.
pub fn parse_key(line: &str) -> Option<PublicKey> {
    let mut parts = line.trim().splitn(3, char::is_whitespace);
    let kind = parts.next()?;
    let data = parts.next()?;
    let comment = parts.next().unwrap_or("").trim().to_string();
    let (_, fixed_bits) = KEY_TYPES.iter().find(|(t, _)| *t == kind)?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    let (embedded, pos) = wire_string(&blob, 0)?;
    if embedded != kind.as_bytes() {
        return None;
    }
    let bits = match fixed_bits {
        Some(b) => Some(*b),
        None => {
            // ssh-rsa: e, then the modulus n.
            let (_, pos) = wire_string(&blob, pos)?;
            let (n, _) = wire_string(&blob, pos)?;
            let n = &n[n.iter().position(|b| *b != 0)?..];
            Some(n.len() as u32 * 8 - n[0].leading_zeros())
        }
    };
    let line = if comment.is_empty() {
        format!("{kind} {data}")
    } else {
        format!("{kind} {data} {comment}")
    };
    Some(PublicKey {
        key_type: kind.to_string(),
        bits,
        fingerprint: fingerprint(&blob),
        key: data.to_string(),
        comment,
        line,
    })
}

// ─── this computer's key ────────────────────────────────────────────────────────────

fn ssh_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".ssh"))
        .ok_or_else(|| "HOME isn't set".to_string())
}

/// `<user>@<computer name>`, the comment a created key gets.
fn key_comment() -> String {
    let user = std::env::var("USER").unwrap_or_else(|_| "user".into());
    let host = Command::new("hostname")
        .arg("-s")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "computer".into());
    format!("{user}@{host}")
}

/// This computer's `~/.ssh/id_ed25519.pub`; with `create`, made with `ssh-keygen`
/// (no passphrase) when missing. Only the public file is ever read.
pub fn this_computer_key(create: bool) -> Result<Option<PublicKey>, String> {
    key_in(&ssh_dir()?, create)
}

fn key_in(dir: &Path, create: bool) -> Result<Option<PublicKey>, String> {
    let public = dir.join("id_ed25519.pub");
    if !public.exists() {
        if !create {
            return Ok(None);
        }
        let private = dir.join("id_ed25519");
        if private.exists() {
            // Never overwrite a private key, even one whose .pub is missing.
            return Err(format!(
                "{} exists without its .pub; run `ssh-keygen -y -f {} > {}`",
                private.display(),
                private.display(),
                public.display()
            ));
        }
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let out = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", &key_comment(), "-f"])
            .arg(&private)
            .output()
            .map_err(|e| format!("ssh-keygen: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "ssh-keygen failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }
    let text =
        std::fs::read_to_string(&public).map_err(|e| format!("{}: {e}", public.display()))?;
    parse_key(&text)
        .map(Some)
        .ok_or_else(|| format!("{} isn't a public key", public.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Throwaway keys and the fingerprints `ssh-keygen -l` prints for them (also in
    /// `apps/desktop/tests/test_unit_helper.py`).
    const KEYS: [(&str, u32, &str); 5] = [
        (
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILi8KzRrtyJmUSNagtW73E1WgHF2YdXmSwVpuHnQjg6t test@ed25519",
            256,
            "SHA256:gnW2c+6N0FRetAkbDojHSGQN1p60SPD0Pr6927fmQ58",
        ),
        (
            "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDofZY6iL6EyvMEN8ro15zdsRPMcISlY7le01PZ52gdvLmD9S3WU3gHWuxH+qYfQdLZjjMAhmsWSX8tu5aoCRTZr4rok3nr1OfuqlQMID19wEM6YMYTbki+UescGFe16bz0LBtmSnDFAF/piXMADfNG34eyVbssyJ0DxWQ0zHroZLgo22YxyWj9ORgkinH2wme6JuWAltWZR4pfmVUNmeEaJQX/HvnTj/FARINCmpFzBZqkpC/LHNbZGBmxCAMZtZQbrWwo/8+LXgB4o0IK8qGKhkPoYDhXd5AtCvAcjtGRDfhKhDpG6NoaTFZIfqK7UaHV79ho8m1TinWHaLPGku/F test@rsa",
            2048,
            "SHA256:SpD9/hvo2c053TtXZAuy4SYBY+SnnW9yHPlC4g6J4lY",
        ),
        (
            "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBDenZRcqGdjLSIZuWCtazk44QdTa3uKbMzi4m58hYn0YTvZCG1UJAMHr1pdI08bzhic7WqnAZLb/gIdjBFEwie0= test@ecdsa256",
            256,
            "SHA256:aHnvOzLfJynV+4avLS/KACuOSGC3LsCGYUmBwcV9kj0",
        ),
        (
            "ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBGLJ06uOIFJu7SoxTODJYmkilTvRLjBlFygOk7Gza1EfIUk2IT9dbwf9ySZQJDNnLVUIaZBTSWcqO2OaYqYvBXRjVc8jBrmOsG5NXl+L/bGTR7LbfDZVcT9TY5QiHQUe5Q== test@ecdsa384",
            384,
            "SHA256:8aGm1gOIsMhl2vtUFb61W/3DsPtnl5kA0YfC+yQ0m74",
        ),
        (
            "ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBAHQG9j4GL1oPubuw2Drk2K9OTI//6gSWYP79VRe/X1x4SN6vr820aSsGxVblwq+DGha+S8tRByhC9rk6SjBv3Fu4wH3TO5Ruk9bccAz6SGeWZG3STTelCtjoBnkTTJ1MFqDj+dHWht1XkZvGXLbZ+7dNFTJi5O6bgXHGaNNENXhlLshTQ== test@ecdsa521",
            521,
            "SHA256:7I/ZL18u6Hd9zi50MF5CYiZEyXl5es3Q6RAY7dMGbQs",
        ),
    ];

    #[test]
    fn parses_every_supported_type_like_ssh_keygen() {
        for (line, bits, fp) in KEYS {
            let key = parse_key(&format!("  {line}  ")).unwrap();
            assert_eq!((key.bits, key.fingerprint.as_str()), (Some(bits), fp));
            assert!(key.comment.starts_with("test@"));
            assert_eq!(key.line, line);
            assert_eq!(key.key, line.split(' ').nth(1).unwrap());
        }
    }

    #[test]
    fn refuses_what_is_not_a_public_key() {
        let blob = KEYS[0].0.split(' ').nth(1).unwrap();
        for bad in [
            "",
            "hello",
            "ssh-ed25519",
            &format!("ssh-dss {blob}"),
            &format!("ssh-rsa {blob}"), // embedded type is ed25519
            "ssh-ed25519 not base64!",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
        ] {
            assert_eq!(parse_key(bad), None, "{bad}");
        }
    }

    #[test]
    fn reads_and_creates_this_computers_key() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".ssh");
        assert_eq!(key_in(&dir, false), Ok(None));
        let created = key_in(&dir, true);
        let again = key_in(&dir, false);
        // A private key without its .pub is never overwritten.
        std::fs::remove_file(dir.join("id_ed25519.pub")).unwrap();
        let orphan = key_in(&dir, true);
        let created = created.unwrap().unwrap();
        assert_eq!(created.key_type, "ssh-ed25519");
        assert!(created.comment.contains('@'));
        assert_eq!(again.unwrap().unwrap().fingerprint, created.fingerprint);
        assert!(orphan.is_err());
        let mode = std::fs::metadata(&dir).unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(mode.permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn reads_the_units_report() {
        let old =
            SshState::from(serde_json::from_str::<UnitReport>(r#"{"supported": false}"#).unwrap());
        assert!(!old.supported && !old.enabled && old.keys.is_empty());
        let report = format!(
            r#"{{"supported": true, "enabled": true, "mode": "none",
                 "keys": ["{}", "not a key the app reads"]}}"#,
            KEYS[0].0
        );
        let on = SshState::from(serde_json::from_str::<UnitReport>(&report).unwrap());
        assert_eq!((on.mode, on.keys.len()), (SshMode::None, 1));
        assert_eq!(on.keys[0].fingerprint, KEYS[0].2);
    }
}
