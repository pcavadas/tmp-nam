//! Physical cards: detection, safety checks, partitioning, writing and readback.
//!
//! Acceptance rules: a whole, writable, removable, physical disk in a USB reader or
//! the built-in SD slot (macOS) or on a USB/MMC bus (Linux), never the startup disk
//! and never Fender-exposed storage. On macOS the builder runs as the user and
//! `open` gets a read/write descriptor on the raw disk from authopen(1) behind an
//! administrator prompt; on Linux the desktop app runs the whole helper as root
//! through pkexec.

use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::image::{assemble_head, check_partition_layout, create_boot_fat, write_into};
use crate::release::Release;
use crate::run;
use crate::util::{
    bail, format_bytes, locate_tool, sha256_file, sha256_reader, write_all, Reporter, Result,
};

/// The error when the administrator prompt is cancelled or refused.
pub const ACCESS_DENIED: &str = "Administrator access was not granted; nothing was written";

/// The start of the error when macOS refuses this app removable-volume access
/// (System Settings › Privacy & Security › Files and Folders › Removable Volumes).
pub const VOLUMES_BLOCKED: &str = "macOS refused access to the SD card; nothing was written";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DeviceInfo {
    pub logical: String,
    pub raw: String,
    pub bytes: u64,
    pub model: String,
    pub protocol: String,
}

/// A detected disk, accepted or not (with the reason), for the target picker.
#[derive(Serialize, Clone, Debug)]
pub struct Candidate {
    pub device: String,
    pub name: String,
    pub bytes: u64,
    pub protocol: String,
    pub rejected: Option<String>,
}

fn plist(args: &[&str]) -> Result<plist::Dictionary> {
    let o = Command::new("/usr/sbin/diskutil").args(args).output()?;
    if !o.status.success() {
        return bail(format!(
            "diskutil {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&o.stderr).trim()
        ));
    }
    plist::from_bytes(&o.stdout)
        .map_err(|e| crate::util::Error::msg(format!("diskutil plist: {e}")))
}

pub fn normalize_macos_device(device: &str) -> Result<(String, String)> {
    let name = device.strip_prefix("/dev/").unwrap_or("");
    let name = name.strip_prefix('r').unwrap_or(name);
    let digits = name.strip_prefix("disk").unwrap_or("");
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return bail("macOS target must be a whole disk such as /dev/disk2");
    }
    Ok((format!("/dev/disk{digits}"), format!("/dev/rdisk{digits}")))
}

/// USB card readers, and the built-in SDXC slot of recent Macs, which reports
/// `Secure Digital` with an Internal location. The Mac's own drives report other
/// buses (`Apple Fabric`, `PCI-Express`, `SATA`) and are not removable media.
fn is_macos_card_bus(protocol: &str) -> bool {
    matches!(protocol, "USB" | "Secure Digital")
}

fn macos_device_info(device: &str) -> Result<DeviceInfo> {
    let (logical, raw) = normalize_macos_device(device)?;
    let info = plist(&["info", "-plist", &logical])?;
    let flag = |k: &str| info.get(k).and_then(|v| v.as_boolean()).unwrap_or(false);
    let text = |k: &str| {
        info.get(k)
            .and_then(|v| v.as_string())
            .unwrap_or("")
            .to_string()
    };
    if ["WholeDisk", "Removable", "RemovableMedia"]
        .iter()
        .any(|k| !flag(k))
    {
        return bail("target is not a whole removable disk");
    }
    if !flag("Writable") || !flag("WritableMedia") {
        return bail("SD card is write-protected; slide its lock switch up");
    }
    if flag("SystemImage") || text("VirtualOrPhysical") != "Physical" {
        return bail("target is not physical removable media");
    }
    if !is_macos_card_bus(&text("BusProtocol")) {
        return bail("target is not on a USB card reader or SD slot");
    }
    let root = plist(&["info", "-plist", "/"])?;
    if root.get("ParentWholeDisk").and_then(|v| v.as_string())
        == Some(text("DeviceIdentifier").as_str())
    {
        return bail("refusing the macOS startup disk");
    }
    let listing = Command::new("/usr/sbin/diskutil")
        .args(["list", &logical])
        .output()?;
    if String::from_utf8_lossy(&listing.stdout).contains("FENDER_AMP") {
        return bail("refusing Fender-exposed storage");
    }
    Ok(DeviceInfo {
        logical,
        raw,
        bytes: info
            .get("TotalSize")
            .and_then(|v| v.as_unsigned_integer())
            .unwrap_or(0),
        model: info
            .get("MediaName")
            .and_then(|v| v.as_string())
            .unwrap_or("unknown")
            .to_string(),
        protocol: info
            .get("BusProtocol")
            .and_then(|v| v.as_string())
            .unwrap_or("unknown")
            .to_string(),
    })
}

fn lsblk(device: Option<&str>) -> Result<serde_json::Value> {
    let lsblk = locate_tool("lsblk")?;
    let mut cmd = Command::new(lsblk);
    cmd.args([
        "-J",
        "-b",
        "-o",
        "PATH,TYPE,SIZE,RM,RO,TRAN,MODEL,MOUNTPOINTS",
    ]);
    if let Some(d) = device {
        cmd.arg(d);
    }
    let o = cmd.output()?;
    if !o.status.success() {
        return bail(format!(
            "lsblk failed: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ));
    }
    Ok(serde_json::from_slice(&o.stdout)?)
}

fn int(v: &serde_json::Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .or_else(|| v.as_bool().map(u64::from))
        .unwrap_or(0)
}

fn is_linux_whole(device: &str) -> bool {
    let name = device.strip_prefix("/dev/").unwrap_or("");
    let sd = name
        .strip_prefix("sd")
        .is_some_and(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_lowercase()));
    let mmc = name
        .strip_prefix("mmcblk")
        .is_some_and(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_digit()));
    let nvme = name
        .strip_prefix("nvme")
        .and_then(|r| r.split_once('n'))
        .is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.is_empty()
                && a.chars().all(|c| c.is_ascii_digit())
                && b.chars().all(|c| c.is_ascii_digit())
        });
    sd || mmc || nvme
}

fn linux_device_info(device: &str) -> Result<DeviceInfo> {
    if !is_linux_whole(device) {
        return bail("Linux target must be an explicit whole block device");
    }
    let payload = lsblk(Some(device))?;
    let list = payload["blockdevices"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if list.len() != 1 {
        return bail("cannot resolve Linux block device");
    }
    let info = &list[0];
    if info["type"] != "disk" || int(&info["rm"]) != 1 || int(&info["ro"]) != 0 {
        return bail("target is not a writable removable whole disk");
    }
    let tran = info["tran"].as_str().unwrap_or("");
    let is_mmc = device.starts_with("/dev/mmcblk");
    if tran != "usb" && tran != "mmc" && !is_mmc {
        return bail("target transport is not USB/MMC removable media");
    }
    let root = run!(locate_tool("findmnt")?, "-no", "SOURCE", "/")?.stdout;
    if root.trim().starts_with(device) {
        return bail("refusing the Linux startup disk");
    }
    Ok(DeviceInfo {
        logical: device.into(),
        raw: device.into(),
        bytes: int(&info["size"]),
        model: info["model"]
            .as_str()
            .unwrap_or("unknown")
            .trim()
            .to_string(),
        protocol: if tran.is_empty() {
            "unknown".into()
        } else {
            tran.into()
        },
    })
}

pub fn device_info(device: &str) -> Result<DeviceInfo> {
    if cfg!(target_os = "macos") {
        macos_device_info(device)
    } else if cfg!(target_os = "linux") {
        linux_device_info(device)
    } else {
        bail("direct card writing is supported only on macOS and Linux")
    }
}

/// Every removable disk with the reason it would be refused, for a picker UI.
pub fn candidates() -> Result<Vec<Candidate>> {
    let whole: Vec<String> = if cfg!(target_os = "macos") {
        let listing = plist(&["list", "-plist", "physical"])?;
        listing
            .get("WholeDisks")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_string())
                    .map(|s| format!("/dev/{s}"))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        lsblk(None)?["blockdevices"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter(|d| d["type"] == "disk" && int(&d["rm"]) == 1)
            .filter_map(|d| d["path"].as_str().map(str::to_string))
            .collect()
    };
    let mut out = vec![];
    for dev in whole {
        let (name, bytes, protocol, removable) = if cfg!(target_os = "macos") {
            let Ok(info) = plist(&["info", "-plist", &dev]) else {
                continue;
            };
            let flag = |k: &str| info.get(k).and_then(|v| v.as_boolean()).unwrap_or(false);
            (
                info.get("MediaName")
                    .and_then(|v| v.as_string())
                    .unwrap_or("")
                    .to_string(),
                info.get("TotalSize")
                    .and_then(|v| v.as_unsigned_integer())
                    .unwrap_or(0),
                info.get("BusProtocol")
                    .and_then(|v| v.as_string())
                    .unwrap_or("")
                    .to_string(),
                flag("Removable") || flag("RemovableMedia") || flag("Ejectable"),
            )
        } else {
            (String::new(), 0, String::new(), true)
        };
        if !removable {
            continue;
        }
        match device_info(&dev) {
            Ok(i) => out.push(Candidate {
                device: dev,
                name: i.model,
                bytes: i.bytes,
                protocol: i.protocol,
                rejected: None,
            }),
            Err(e) => out.push(Candidate {
                device: dev,
                name,
                bytes,
                protocol,
                rejected: Some(e.0),
            }),
        }
    }
    Ok(out)
}

pub fn validate_capacity(info: &DeviceInfo, release: &Release) -> Result<()> {
    let required = release.minimum_card_bytes();
    if info.bytes < required {
        return bail(format!(
            "SD card is too small: {} available, {} required",
            format_bytes(info.bytes),
            format_bytes(required)
        ));
    }
    if !info.bytes.is_multiple_of(release.layout.sector_bytes) {
        return bail("SD card size is not a whole number of 512-byte sectors");
    }
    if info.bytes / release.layout.sector_bytes > 0xFFFF_FFFF {
        return bail("SD card is larger than 2 TiB, which an MBR card layout cannot address");
    }
    Ok(())
}

fn unmount(info: &DeviceInfo) -> Result<()> {
    if cfg!(target_os = "macos") {
        // Force: Spotlight dissents plain unmounts and macOS remounts ejected cards.
        let mut last = String::new();
        for _ in 0..6 {
            let o = Command::new("/usr/sbin/diskutil")
                .args(["unmountDisk", "force", &info.logical])
                .output()?;
            if o.status.success() {
                return Ok(());
            }
            last = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
        return bail(format!(
            "command failed: diskutil unmountDisk force {}\n{}",
            info.logical,
            last.trim_end()
        ));
    }
    let payload = lsblk(Some(&info.logical))?;
    let mut paths = vec![];
    fn collect(node: &serde_json::Value, paths: &mut Vec<String>) {
        if node["mountpoints"]
            .as_array()
            .is_some_and(|m| m.iter().any(|v| v.as_str().is_some_and(|s| !s.is_empty())))
        {
            if let Some(p) = node["path"].as_str() {
                paths.push(p.to_string());
            }
        }
        for c in node["children"].as_array().into_iter().flatten() {
            collect(c, paths);
        }
    }
    for root in payload["blockdevices"].as_array().into_iter().flatten() {
        collect(root, &mut paths);
    }
    for p in paths.iter().rev() {
        run!(locate_tool("umount")?, p)?;
    }
    Ok(())
}

/// A read/write descriptor on the whole raw disk, from authopen(1): it asks for the
/// `sys.openfile.readwrite.<device>` right (the administrator prompt) and sends the
/// open descriptor back over a socket (`-stdoutpipe`, SCM_RIGHTS), so the builder
/// never runs as root. macOS checks removable-volume access against the responsible
/// app, which authopen passes through and a root process from
/// `do shell script … with administrator privileges` does not have. The card must
/// be unmounted first: a read/write open of a disk with mounted volumes fails.
#[cfg(target_os = "macos")]
fn authopen(raw: &str) -> Result<File> {
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    use std::process::Stdio;
    let (ours, theirs) = UnixStream::pair()?;
    let mut cmd = Command::new("/usr/libexec/authopen");
    cmd.args(["-stdoutpipe", "-o", &libc::O_RDWR.to_string(), raw])
        .stdin(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(theirs)))
        .stderr(Stdio::piped());
    let child = cmd.spawn()?;
    // The command holds a copy of authopen's end; drop it so a failed authopen
    // closes the socket instead of leaving `receive_fd` waiting.
    drop(cmd);
    let (fd, sent) = receive_fd(&ours);
    let out = child.wait_with_output()?;
    if let Some(fd) = fd {
        return Ok(File::from(fd));
    }
    let said = format!("{sent} {}", String::from_utf8_lossy(&out.stderr))
        .trim()
        .to_string();
    if said.contains("AuthorizationCopyRights failed") {
        return bail(ACCESS_DENIED);
    }
    if said.contains("Operation not permitted") {
        return bail(format!(
            "{VOLUMES_BLOCKED}. Allow this app in System Settings › Privacy & Security › \
             Files and Folders › Removable Volumes, then try again. ({said})"
        ));
    }
    bail(format!(
        "authopen couldn't open {raw} ({}{}{said})",
        out.status,
        if said.is_empty() { "" } else { ": " }
    ))
}

/// Read authopen's socket until it sends a descriptor (SCM_RIGHTS) or closes it;
/// returns the descriptor, or the text it wrote instead.
#[cfg(target_os = "macos")]
fn receive_fd(socket: &std::os::unix::net::UnixStream) -> (Option<std::os::fd::OwnedFd>, String) {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let mut text = Vec::new();
    loop {
        let mut data = [0u8; 256];
        let mut iov = libc::iovec {
            iov_base: data.as_mut_ptr().cast(),
            iov_len: data.len(),
        };
        // u64 keeps the control buffer aligned for `cmsghdr`.
        let mut control = [0u64; 8];
        // SAFETY: a zeroed msghdr is valid; every pointer set below outlives recvmsg.
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = control.as_mut_ptr().cast();
        msg.msg_controllen = std::mem::size_of_val(&control) as libc::socklen_t;
        // SAFETY: `msg` points at live buffers of the sizes it states.
        let n = unsafe { libc::recvmsg(socket.as_raw_fd(), &mut msg, 0) };
        if n < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        // SAFETY: the CMSG_* macros walk the control buffer recvmsg filled; an
        // SCM_RIGHTS message carries a file descriptor now owned by this process.
        unsafe {
            let cmsg = libc::CMSG_FIRSTHDR(&msg);
            if !cmsg.is_null()
                && (*cmsg).cmsg_level == libc::SOL_SOCKET
                && (*cmsg).cmsg_type == libc::SCM_RIGHTS
            {
                let fd = std::ptr::read_unaligned(libc::CMSG_DATA(cmsg).cast::<libc::c_int>());
                return (Some(OwnedFd::from_raw_fd(fd)), String::new());
            }
        }
        if n == 0 {
            break;
        }
        text.extend_from_slice(&data[..n as usize]);
    }
    (None, String::from_utf8_lossy(&text).trim().to_string())
}

/// The unmounted whole card, opened read/write before the build so a refusal costs
/// nothing and the long build runs unattended: on macOS the raw disk through the
/// administrator prompt; on Linux (the helper runs as root) exclusively, so nothing
/// mounts its partitions while the card is written.
pub fn open(target: &DeviceInfo) -> Result<File> {
    unmount(target)?;
    #[cfg(target_os = "macos")]
    {
        authopen(&target.raw)
    }
    #[cfg(not(target_os = "macos"))]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        let disk = File::options()
            .read(true)
            .write(true)
            .custom_flags(libc::O_EXCL)
            .open(&target.raw)
            .map_err(|e| match e.raw_os_error() {
                Some(libc::EBUSY) => crate::util::Error::msg(
                    "The SD card is in use by another program; nothing was written",
                ),
                _ => e.into(),
            })?;
        // systemd's block device locking: udev doesn't probe a disk locked this way,
        // so it doesn't read the card while it is being written.
        if unsafe { libc::flock(disk.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(disk)
    }
}

/// Make the next reads of `disk` come from the card. macOS raw disks bypass the OS
/// cache (and reject `sync_all`, F_FULLFSYNC); a Linux block device is flushed and
/// its cached pages dropped.
fn flush_for_readback(disk: &File) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        disk.sync_all()?;
        let rc = unsafe { libc::posix_fadvise(disk.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
        if rc != 0 {
            return Err(std::io::Error::from_raw_os_error(rc).into());
        }
    }
    let _ = disk;
    Ok(())
}

/// The whole card through one raw descriptor: the MBR and boot partition as the
/// portable image lays them out, then the rootfs, each read back.
fn prepare(
    target: &DeviceInfo,
    mut disk: File,
    rootfs: &Path,
    image: &Path,
    sha: &str,
    release: &Release,
    r: &dyn Reporter,
) -> Result<()> {
    let l = &release.layout;
    r.progress("Preparing partitions", 0, 1);
    let boot_fat = image.with_file_name("boot.fat");
    create_boot_fat(rootfs, &boot_fat, release)?;
    let head = image.with_file_name("card-head.img");
    assemble_head(&head, &boot_fat, target.bytes / l.sector_bytes, release)?;
    let head_bytes = l.partition_2.start_sector * l.sector_bytes;
    File::options()
        .write(true)
        .open(&head)?
        .set_len(head_bytes)?;
    if cfg!(target_os = "macos") {
        unmount(target)?;
    }
    // A card that held GPT keeps a backup header in its last sectors; clear them.
    let tail = 1024 * 1024;
    disk.seek(SeekFrom::Start(target.bytes - tail))?;
    write_all(&mut disk, &vec![0u8; tail as usize])?;
    write_into(&head, &mut disk, 0, None)?;
    flush_for_readback(&disk)?;
    check_partition_layout(&mut disk, release)?;
    if sha256_reader(&mut disk, Some(head_bytes), 0, None)? != sha256_file(&head, None, 0, None)? {
        return bail("boot partition readback hash mismatch");
    }
    r.progress("Preparing partitions", 1, 1);
    write_into(
        image,
        &mut disk,
        head_bytes,
        Some((r, "Writing rootfs partition")),
    )?;
    flush_for_readback(&disk)?;
    let len = std::fs::metadata(image)?.len();
    if sha256_reader(
        &mut disk,
        Some(len),
        head_bytes,
        Some((r, "Verifying rootfs")),
    )? != sha
    {
        return bail("rootfs partition readback hash mismatch");
    }
    drop(disk);
    if cfg!(target_os = "macos") {
        // Closing the disk brings its partitions back and macOS mounts BOOT, so the
        // eject can be refused (Spotlight); the card is complete either way.
        if run!("/usr/sbin/diskutil", "eject", target.logical).is_ok() {
            r.status("Card verified and ejected — ready to boot");
        } else {
            r.status("Card verified — eject it in Finder before removing it");
        }
    } else {
        // Closing the disk makes udev re-read the new partitions, and desktop
        // automounters may then mount them; eject(1) unmounts them and ejects the card,
        // as `diskutil eject` does. The card is complete either way.
        let ejected = locate_tool("udevadm")
            .and_then(|u| run!(u, "settle"))
            .and_then(|_| locate_tool("eject"))
            .and_then(|e| run!(e, target.logical));
        if ejected.is_ok() {
            r.status("Card verified and ejected — ready to boot");
        } else {
            r.status("Card verified — eject it in your file manager before removing it");
        }
    }
    Ok(())
}

/// Write an already-built rootfs to a card through `disk` from `open`. `expect` is
/// the identity the user confirmed; the card is re-validated and must still match it.
pub fn write_prepared(
    device: &str,
    expect: Option<&DeviceInfo>,
    disk: File,
    built: &crate::Prepared,
    release: &Release,
    r: &dyn Reporter,
) -> Result<()> {
    let (rootfs, rootfs_image, rootfs_sha256) = (&built.rootfs, &built.image, &built.sha256);
    let target = device_info(device)?;
    if let Some(e) = expect {
        if e.logical != target.logical || e.bytes != target.bytes || e.model != target.model {
            return bail("SD card changed since it was confirmed; nothing was written");
        }
    }
    validate_capacity(&target, release)?;
    prepare(
        &target,
        disk,
        rootfs,
        rootfs_image,
        rootfs_sha256,
        release,
        r,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_device_names() {
        assert_eq!(
            normalize_macos_device("/dev/rdisk4").unwrap(),
            ("/dev/disk4".into(), "/dev/rdisk4".into())
        );
        assert!(normalize_macos_device("/dev/disk4s1").is_err());
        assert!(normalize_macos_device("disk4").is_err());
    }

    #[test]
    fn macos_card_buses() {
        assert!(is_macos_card_bus("USB"));
        assert!(is_macos_card_bus("Secure Digital"));
        for internal in ["Apple Fabric", "PCI-Express", "SATA", "Thunderbolt", ""] {
            assert!(!is_macos_card_bus(internal), "{internal}");
        }
    }

    /// What authopen does with `-stdoutpipe`: one byte carrying the descriptor.
    #[cfg(target_os = "macos")]
    #[test]
    fn receives_a_descriptor_or_the_text_sent_instead() {
        use std::io::{Read, Seek, Write};
        use std::os::fd::AsRawFd;
        use std::os::unix::net::UnixStream;

        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"card").unwrap();
        let (ours, theirs) = UnixStream::pair().unwrap();
        let mut byte = [0u8; 1];
        let mut iov = libc::iovec {
            iov_base: byte.as_mut_ptr().cast(),
            iov_len: 1,
        };
        let mut control = [0u64; 8];
        // SAFETY: test-only sendmsg of one SCM_RIGHTS descriptor over live buffers.
        unsafe {
            let mut msg: libc::msghdr = std::mem::zeroed();
            msg.msg_iov = &mut iov;
            msg.msg_iovlen = 1;
            msg.msg_control = control.as_mut_ptr().cast();
            msg.msg_controllen = libc::CMSG_SPACE(4) as libc::socklen_t;
            let cmsg = libc::CMSG_FIRSTHDR(&msg);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = libc::SCM_RIGHTS;
            (*cmsg).cmsg_len = libc::CMSG_LEN(4) as libc::socklen_t;
            std::ptr::write_unaligned(libc::CMSG_DATA(cmsg).cast(), file.as_raw_fd());
            assert_eq!(libc::sendmsg(theirs.as_raw_fd(), &msg, 0), 1);
        }
        let (fd, text) = receive_fd(&ours);
        let mut received = File::from(fd.expect("descriptor"));
        received.rewind().unwrap();
        let mut back = String::new();
        received.read_to_string(&mut back).unwrap();
        assert_eq!((back.as_str(), text.as_str()), ("card", ""));

        let (ours, mut theirs) = UnixStream::pair().unwrap();
        theirs.write_all(b"couldn't open /dev/rdisk9\n").unwrap();
        drop(theirs);
        let (fd, text) = receive_fd(&ours);
        assert!(fd.is_none());
        assert_eq!(text, "couldn't open /dev/rdisk9");
    }

    #[test]
    fn linux_names() {
        assert!(is_linux_whole("/dev/sdb"));
        assert!(is_linux_whole("/dev/mmcblk0"));
        assert!(is_linux_whole("/dev/nvme0n1"));
        assert!(!is_linux_whole("/dev/sdb1"));
    }
}
