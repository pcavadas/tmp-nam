//! The release pins (`device/release.json`), compiled into the binary.
//!
//! Every input that reaches the card is pinned here by size and SHA-256: each supported
//! official firmware with its rootfs payload, engine and boot files, the stock files the
//! builder patches, and each
//! asset under `device/`. The pins are embedded at compile time so a bundled
//! `device/` directory can never select different bytes than the binary was built for.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::util::{assert_file, Error, Result};

pub const RELEASE_JSON: &str = include_str!("../../../device/release.json");

#[derive(Deserialize, Clone, Debug)]
pub struct Pin {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Asset {
    /// Path inside `device/`.
    pub source: String,
    /// Path inside the card rootfs.
    pub target: String,
    pub bytes: u64,
    pub sha256: String,
}

impl Asset {
    pub fn pin(&self) -> Pin {
        Pin {
            bytes: self.bytes,
            sha256: self.sha256.clone(),
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Payload {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

/// One supported official firmware and the files the builder takes from it.
#[derive(Deserialize, Clone, Debug)]
pub struct Firmware {
    pub version: String,
    pub bytes: u64,
    pub sha256: String,
    pub compatible: String,
    pub payload: Payload,
    /// `home/root/tm-stomp-server` in the rootfs; `nam_dispatch.so` pins the same hash.
    pub engine_sha256: String,
    pub boot: Boot,
}

#[derive(Deserialize, Clone, Debug)]
pub struct BootFile {
    pub rootfs_path: String,
    pub fat_name: String,
    pub bytes: u64,
    pub sha256: String,
}

impl BootFile {
    pub fn pin(&self) -> Pin {
        Pin {
            bytes: self.bytes,
            sha256: self.sha256.clone(),
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Boot {
    pub image: BootFile,
    pub dtb: BootFile,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Assets {
    pub nam_dispatch: Asset,
    pub registry_helper: Asset,
    pub console_service: Asset,
    pub console_setup: Asset,
    pub dropbear: Asset,
    pub dropbearkey: Asset,
    pub dropbear_service: Asset,
    pub ssh_launcher: Asset,
    pub t3k: Asset,
}

impl Assets {
    pub fn all(&self) -> Vec<&Asset> {
        let mut v = vec![&self.nam_dispatch];
        v.extend([
            &self.registry_helper,
            &self.console_service,
            &self.console_setup,
            &self.dropbear,
            &self.dropbearkey,
            &self.dropbear_service,
            &self.ssh_launcher,
            &self.t3k,
        ]);
        v
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Partition1 {
    pub start_sector: u64,
    pub sector_count: u64,
    pub mbr_type: u8,
    pub label: String,
    pub sectors_per_cluster: u32,
    pub sectors_per_track: u32,
    pub heads: u32,
    pub hidden_sectors: u32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Partition2 {
    pub start_sector: u64,
    pub mbr_type: u8,
    pub label: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Layout {
    pub sector_bytes: u64,
    pub partition_1: Partition1,
    pub partition_2: Partition2,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Ext4 {
    pub bytes: u64,
    pub block_bytes: u64,
    pub inode_count: u64,
    pub reserved_percent: u32,
    pub features: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct PatchedFile {
    pub target: String,
    pub source: Pin,
    pub patched: Pin,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Rootfs {
    pub gadget_script: String,
    pub gadget_anchor: String,
    pub gadget_tail_anchor: String,
    pub fstab: String,
    pub console_enable_target: String,
    pub build_marker: String,
    pub nam_dropin_target: String,
    pub lan_setup_target: String,
    pub lan_service_target: String,
    pub audio_priority_script: PatchedFile,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Release {
    pub schema: String,
    pub firmwares: Vec<Firmware>,
    pub assets: Assets,
    pub layout: Layout,
    pub ext4: Ext4,
    pub rootfs: Rootfs,
    #[serde(default)]
    pub source_sha256: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub licenses_sha256: std::collections::BTreeMap<String, String>,
}

impl Release {
    pub fn embedded() -> Release {
        let r: Release = serde_json::from_str(RELEASE_JSON).expect("device/release.json is valid");
        assert_eq!(r.schema, "tmp-nam-release-v3", "unsupported release schema");
        r
    }

    /// The supported firmware with this bundle hash.
    pub fn firmware(&self, sha256: &str) -> Option<&Firmware> {
        self.firmwares.iter().find(|f| f.sha256 == sha256)
    }

    /// Whether a supported firmware has this size (checked before hashing).
    pub fn firmware_size_known(&self, bytes: u64) -> bool {
        self.firmwares.iter().any(|f| f.bytes == bytes)
    }

    /// The supported firmware versions, e.g. `1.8.58, 1.8.85`.
    pub fn firmware_versions(&self) -> String {
        let v: Vec<&str> = self.firmwares.iter().map(|f| f.version.as_str()).collect();
        v.join(", ")
    }

    /// Smallest card that holds the layout: partition 2's start plus the 4 GiB rootfs.
    pub fn minimum_card_bytes(&self) -> u64 {
        self.layout.partition_2.start_sector * self.layout.sector_bytes + self.ext4.bytes
    }
}

/// The `device/` directory holding the pinned assets.
#[derive(Clone, Debug)]
pub struct DeviceDir(pub PathBuf);

impl DeviceDir {
    pub fn path(&self, asset: &Asset) -> PathBuf {
        self.0.join(&asset.source)
    }

    /// Verify every asset against the embedded pins before anything is built.
    pub fn verify(&self, release: &Release) -> Result<()> {
        for asset in release.assets.all() {
            let p = self.path(asset);
            if p.is_symlink() {
                return Err(Error::msg(format!(
                    "release asset must be a regular file: {}",
                    asset.source
                )));
            }
            assert_file(&p, &asset.pin())?;
        }
        Ok(())
    }

    /// First existing candidate among the given roots.
    pub fn locate(candidates: &[&Path]) -> Option<DeviceDir> {
        candidates
            .iter()
            .map(|c| c.to_path_buf())
            .find(|c| c.join("release.json").is_file())
            .map(DeviceDir)
    }

    /// The repository's `device/` (development builds and tests).
    pub fn repository() -> DeviceDir {
        DeviceDir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../device"))
    }
}
