//! Release integrity: `device/release.json` must describe the checkout exactly.
//!
//! * every pinned asset under `device/` matches its size + SHA-256;
//! * `source_sha256` lists exactly the player's compiled inputs and their current
//!   hashes — editing a compiled input makes this fail until the binaries are rebuilt
//!   and republished (`tools/release/`);
//! * every bundled license matches `licenses_sha256`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tmp_sdcard::{DeviceDir, Release};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn sha(p: &Path) -> String {
    let digest =
        Sha256::digest(std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display())));
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The player's compiled inputs, shared with tools/release/*.py.
const COMPILED_INPUTS: &str = include_str!("../../../tools/release/compiled_inputs.json");

#[test]
fn device_assets_match_pins() {
    let release = Release::embedded();
    DeviceDir::repository().verify(&release).unwrap();
}

#[test]
fn compiled_inputs_match_release() {
    let root = repo();
    let release = Release::embedded();
    let spec: serde_json::Value = serde_json::from_str(COMPILED_INPUTS).unwrap();
    let list = |k: &str| -> Vec<String> {
        spec[k]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    };
    let mut names = list("files");
    for pattern in list("patterns") {
        for p in glob::glob(root.join(&pattern).to_str().unwrap())
            .unwrap()
            .flatten()
        {
            names.push(
                p.strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    names.sort();
    names.dedup();
    let current: BTreeMap<String, String> = names
        .into_iter()
        .map(|n| (n.clone(), sha(&root.join(&n))))
        .collect();
    assert_eq!(
        current, release.source_sha256,
        "player sources differ from device/release.json: rebuild and republish the binaries"
    );
}

#[test]
fn licenses_match_release() {
    let release = Release::embedded();
    let dir = repo().join("device/licenses");
    for (name, want) in &release.licenses_sha256 {
        assert_eq!(&sha(&dir.join(name)), want, "license {name}");
    }
}

#[test]
fn dispatcher_knows_every_pinned_engine() {
    let release = Release::embedded();
    let stub = std::fs::read_to_string(repo().join("player/stubs/nam_dispatch.cpp")).unwrap();
    assert!(!release.firmwares.is_empty());
    for fw in &release.firmwares {
        let row = format!("{{\"{}\", \"{}\",", fw.version, fw.engine_sha256);
        assert!(
            stub.contains(&row),
            "nam_dispatch.cpp has no kEngines row for firmware {} (engine {})",
            fw.version,
            fw.engine_sha256
        );
    }
}

#[test]
fn firmware_pins_are_distinct() {
    let release = Release::embedded();
    let mut seen = std::collections::BTreeSet::new();
    for fw in &release.firmwares {
        assert!(seen.insert(fw.version.clone()), "duplicate {}", fw.version);
        assert!(seen.insert(fw.sha256.clone()), "duplicate firmware hash");
        assert!(
            seen.insert(fw.engine_sha256.clone()),
            "duplicate engine hash"
        );
    }
}
