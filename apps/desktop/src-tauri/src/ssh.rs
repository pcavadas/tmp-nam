//! SSH access to the NAM card: public-key lines, this computer's key, and the state the
//! unit reports. The unit side is `unit_helper.py` (`ssh-*` commands) and the card's
//! `nam-ssh.sh`, which starts Dropbear at every boot as `/data/nam/ssh/state` says:
//! off, key only (`-s`: no password logins at all) or no security (`-B`: root with the
//! stock empty password). Public keys aren't secret, so they travel over the console;
//! private keys are refused and never stored.

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

/// A key the unit allows, as it reports it (never the key itself).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthorizedKey {
    #[serde(rename = "type")]
    pub key_type: String,
    pub bits: Option<u32>,
    pub comment: String,
    pub fingerprint: String,
}

/// What the unit reports. `supported: false` is a card made before SSH access could
/// be switched: its SSH is always on, with no password.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SshState {
    pub supported: bool,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub mode: SshMode,
    #[serde(default)]
    pub keys: Vec<AuthorizedKey>,
}

/// A parsed public-key line.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PublicKey {
    #[serde(rename = "type")]
    pub key_type: String,
    pub bits: Option<u32>,
    pub comment: String,
    pub fingerprint: String,
    /// The normalized line sent to the unit.
    #[serde(skip)]
    pub line: String,
}

/// Why pasted text isn't one public key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyProblem {
    NotAKey,
    SeveralLines,
    Private,
}

impl KeyProblem {
    pub fn code(self) -> &'static str {
        match self {
            KeyProblem::NotAKey => "not_a_key",
            KeyProblem::SeveralLines => "several_lines",
            KeyProblem::Private => "private_key",
        }
    }
}

const KEY_TYPES: [(&str, Option<u32>); 5] = [
    ("ssh-ed25519", Some(256)),
    ("ssh-rsa", None),
    ("ecdsa-sha2-nistp256", Some(256)),
    ("ecdsa-sha2-nistp384", Some(384)),
    ("ecdsa-sha2-nistp521", Some(521)),
];

/// PEM, OpenSSH and PuTTY private keys.
pub fn is_private_key(text: &str) -> bool {
    text.contains("PRIVATE KEY-----") || text.contains("PuTTY-User-Key-File")
}

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

fn parse_line(line: &str) -> Option<PublicKey> {
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
        comment,
        line,
    })
}

/// One public-key line, as pasted (surrounding blank lines are fine).
pub fn parse_key_text(text: &str) -> Result<PublicKey, KeyProblem> {
    if is_private_key(text) {
        return Err(KeyProblem::Private);
    }
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    match lines.as_slice() {
        [line] => parse_line(line).ok_or(KeyProblem::NotAKey),
        [] => Err(KeyProblem::NotAKey),
        _ if lines.iter().all(|l| parse_line(l).is_some()) => Err(KeyProblem::SeveralLines),
        _ => Err(KeyProblem::NotAKey),
    }
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
    parse_key_text(&text)
        .map(Some)
        .map_err(|_| format!("{} isn't a public key", public.display()))
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
            let key = parse_key_text(&format!("\n  {line}  \n")).unwrap();
            assert_eq!((key.bits, key.fingerprint.as_str()), (Some(bits), fp));
            assert!(key.comment.starts_with("test@"));
            assert_eq!(key.line, line);
        }
    }

    #[test]
    fn explains_what_is_wrong_with_pasted_text() {
        let (ed, _, _) = KEYS[0];
        let blob = ed.split(' ').nth(1).unwrap();
        assert_eq!(
            parse_key_text(&format!("{ed}\n{}", KEYS[1].0)),
            Err(KeyProblem::SeveralLines)
        );
        for bad in [
            "",
            "hello",
            "ssh-ed25519",
            &format!("ssh-dss {blob}"),
            &format!("ssh-rsa {blob}"), // embedded type is ed25519
            "ssh-ed25519 not base64!",
        ] {
            assert_eq!(parse_key_text(bad), Err(KeyProblem::NotAKey), "{bad}");
        }
        for private in [
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==\n-----END OPENSSH PRIVATE KEY-----",
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n",
            "-----BEGIN PRIVATE KEY-----",
            "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none",
        ] {
            assert_eq!(parse_key_text(private), Err(KeyProblem::Private));
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
        let old: SshState = serde_json::from_str(r#"{"supported": false}"#).unwrap();
        assert!(!old.supported && !old.enabled && old.keys.is_empty());
        let on: SshState = serde_json::from_str(
            r#"{"supported": true, "enabled": true, "mode": "none",
                "keys": [{"type": "ssh-ed25519", "bits": 256, "comment": "a@b",
                          "fingerprint": "SHA256:x"}]}"#,
        )
        .unwrap();
        assert_eq!((on.mode, on.keys.len()), (SshMode::None, 1));
    }
}
