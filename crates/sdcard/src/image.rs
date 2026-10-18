//! Card layout: the FAT32 boot partition, the MBR, and the portable image file.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use fatfs::{FatType, FileSystem, FormatVolumeOptions, FsOptions};
use mbrman::{MBRPartitionEntry, BOOT_INACTIVE, CHS, MBR};
use sha2::{Digest, Sha256};

use crate::release::{Pin, Release};
use crate::rootfs::resolve_inside;
use crate::util::{assert_file, bail, hex, write_all, Error, Reporter, Result, CHUNK_BYTES};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MbrEntry {
    pub active: bool,
    pub kind: u8,
    pub start: u64,
    pub count: u64,
}

pub fn parse_mbr(raw: &[u8]) -> Result<[MbrEntry; 4]> {
    if raw.len() != 512 || raw[510..512] != [0x55, 0xaa] {
        return bail("invalid MBR signature");
    }
    let entry = |i: usize| {
        let e = &raw[446 + i * 16..446 + (i + 1) * 16];
        MbrEntry {
            active: e[0] == 0x80,
            kind: e[4],
            start: u32::from_le_bytes([e[8], e[9], e[10], e[11]]) as u64,
            count: u32::from_le_bytes([e[12], e[13], e[14], e[15]]) as u64,
        }
    };
    Ok([entry(0), entry(1), entry(2), entry(3)])
}

/// The partition table the card must carry (partition 2 may run to the card's end).
pub fn verify_partition_layout(raw_device: &Path, release: &Release) -> Result<()> {
    check_partition_layout(&mut File::open(raw_device)?, release)
}

/// `verify_partition_layout` on an open disk or image.
pub fn check_partition_layout(disk: &mut File, release: &Release) -> Result<()> {
    let mut buf = [0u8; 512];
    disk.seek(SeekFrom::Start(0))?;
    disk.read_exact(&mut buf)?;
    let e = parse_mbr(&buf)?;
    let (p1, p2) = (&release.layout.partition_1, &release.layout.partition_2);
    if e[0].kind != p1.mbr_type || e[0].start != p1.start_sector || e[0].count != p1.sector_count {
        return bail("partitioner produced unexpected MBR geometry");
    }
    if e[1].kind != p2.mbr_type || e[1].start != p2.start_sector {
        return bail("partitioner produced unexpected MBR geometry");
    }
    if e[1].count * release.layout.sector_bytes < release.ext4.bytes {
        return bail("partition 2 is too small for the generated rootfs");
    }
    Ok(())
}

pub fn partition_2_sectors(card_sectors: u64, release: &Release) -> Result<u64> {
    let l = &release.layout;
    if l.partition_1.start_sector + l.partition_1.sector_count > l.partition_2.start_sector {
        return bail("overlapping partition geometry");
    }
    if card_sectors > 0xFFFF_FFFF || card_sectors <= l.partition_2.start_sector {
        return bail("card geometry exceeds MBR limits");
    }
    let p2 = card_sectors - l.partition_2.start_sector;
    if p2 < release.ext4.bytes / l.sector_bytes {
        return bail("card is too small for the 4 GiB rootfs");
    }
    Ok(p2)
}

/// Write the card's MBR to `disk`: partition 1 (FAT32 boot) and partition 2 (the
/// rootfs, `p2_count` sectors), with a random disk identifier and the CHS fields
/// libfdisk derives from the 255-head, 63-sector geometry.
pub fn write_mbr(disk: &mut File, release: &Release, p2_count: u64) -> Result<()> {
    let l = &release.layout;
    let id = *uuid::Uuid::new_v4().as_bytes();
    let mut mbr = MBR::new_from(disk, l.sector_bytes as u32, [id[0], id[1], id[2], id[3]])
        .map_err(mbr_error)?;
    let entry = |kind: u8, start: u64, count: u64| -> Result<MBRPartitionEntry> {
        let (start, count) = match (u32::try_from(start), u32::try_from(count)) {
            (Ok(s), Ok(c)) => (s, c),
            _ => return bail("card geometry exceeds MBR limits"),
        };
        Ok(MBRPartitionEntry {
            boot: BOOT_INACTIVE,
            first_chs: chs(start),
            sys: kind,
            last_chs: chs(start + count - 1),
            starting_lba: start,
            sectors: count,
        })
    };
    mbr[1] = entry(
        l.partition_1.mbr_type,
        l.partition_1.start_sector,
        l.partition_1.sector_count,
    )?;
    mbr[2] = entry(l.partition_2.mbr_type, l.partition_2.start_sector, p2_count)?;
    disk.seek(SeekFrom::Start(0))?;
    mbr.write_into(disk).map_err(mbr_error)
}

/// libfdisk's CHS address: exact up to cylinder 1023, then the maximum.
fn chs(lba: u32) -> CHS {
    CHS::from_lba_exact(lba, 1023, 255, 63).unwrap_or(CHS::new(1023, 254, 63))
}

fn mbr_error(e: mbrman::Error) -> Error {
    Error::msg(format!("cannot write the partition table: {e}"))
}

/// Verify and copy the official kernel + DTB out of the rootfs.
pub fn boot_files(rootfs: &Path, release: &Release) -> Result<Vec<BootEntry>> {
    let mut out = vec![];
    for f in [&release.boot.image, &release.boot.dtb] {
        let p = resolve_inside(rootfs, &f.rootfs_path)?;
        assert_file(&p, &f.pin())?;
        out.push((p, f.fat_name.clone(), f.pin()));
    }
    Ok(out)
}

/// A boot partition file: its source, its FAT name and its pin.
pub type BootEntry = (PathBuf, String, Pin);

pub fn create_boot_fat(rootfs: &Path, output: &Path, release: &Release) -> Result<()> {
    write_boot_fat(&boot_files(rootfs, release)?, output, release)
}

/// Format partition 1 at `output` as FAT32, copy `files` in and read them back
/// against their pins.
pub fn write_boot_fat(files: &[BootEntry], output: &Path, release: &Release) -> Result<()> {
    let l = &release.layout;
    let p1 = &l.partition_1;
    let mut f = File::options()
        .read(true)
        .write(true)
        .create_new(true)
        .open(output)?;
    f.set_len(p1.sector_count * l.sector_bytes)?;
    let narrow = |v: u32| u16::try_from(v).map_err(|_| Error::msg("invalid FAT geometry"));
    let mut label = [b' '; 11];
    label[..p1.label.len()].copy_from_slice(p1.label.as_bytes());
    let id = *uuid::Uuid::new_v4().as_bytes();
    fatfs::format_volume(
        &mut f,
        FormatVolumeOptions::new()
            .fat_type(FatType::Fat32)
            .bytes_per_sector(narrow(l.sector_bytes as u32)?)
            .total_sectors(p1.sector_count as u32)
            .bytes_per_cluster(p1.sectors_per_cluster * l.sector_bytes as u32)
            .sectors_per_track(narrow(p1.sectors_per_track)?)
            .heads(narrow(p1.heads)?)
            .volume_id(u32::from_le_bytes([id[0], id[1], id[2], id[3]]))
            .volume_label(label),
    )?;
    // fatfs leaves BPB_HiddSec (offset 28) at 0; set it in the boot sector and its
    // FAT32 backup (sector 6) to partition 1's start, as mkfs tools do.
    for sector in [0, 6] {
        f.seek(SeekFrom::Start(sector * l.sector_bytes + 28))?;
        f.write_all(&p1.hidden_sectors.to_le_bytes())?;
    }
    f.seek(SeekFrom::Start(0))?;
    let fs = FileSystem::new(&mut f, FsOptions::new())?;
    for (source, fat_name, _) in files {
        let mut dest = fs.root_dir().create_file(fat_name)?;
        dest.truncate()?;
        std::io::copy(&mut File::open(source)?, &mut dest)?;
        dest.flush()?;
    }
    // Counting the free clusters records them in the FSInfo sector, which a fresh
    // fatfs volume leaves unset (fsck reports that).
    fs.stats()?;
    fs.unmount()?;
    f.seek(SeekFrom::Start(0))?;
    let fs = FileSystem::new(&mut f, FsOptions::new())?;
    for (_, fat_name, pin) in files {
        let mut file = fs.root_dir().open_file(fat_name)?;
        let (mut hasher, mut bytes, mut buf) = (Sha256::new(), 0u64, vec![0u8; CHUNK_BYTES]);
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            bytes += n as u64;
        }
        if bytes != pin.bytes || hex(&hasher.finalize()) != pin.sha256 {
            return bail(format!("boot partition readback mismatch for {fat_name}"));
        }
    }
    Ok(())
}

/// Copy `source` into `destination` at `offset`, reporting progress under `label`.
pub fn write_into(
    source: &Path,
    destination: &mut File,
    offset: u64,
    progress: Option<(&dyn Reporter, &str)>,
) -> Result<()> {
    let total = std::fs::metadata(source)?.len();
    let mut src = File::open(source)?;
    destination.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut copied = 0u64;
    let interval = 256 * 1024 * 1024;
    let mut next = 0;
    if let Some((r, label)) = progress {
        r.progress(label, 0, total);
    }
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        write_all(destination, &buf[..n])?;
        copied += n as u64;
        if copied >= next || copied == total {
            if let Some((r, label)) = progress {
                r.progress(label, copied, total);
            }
            next = copied + interval;
        }
    }
}

fn copy_into(source: &Path, destination: &Path, offset: u64) -> Result<()> {
    let mut dst = std::fs::OpenOptions::new().write(true).open(destination)?;
    write_into(source, &mut dst, offset, None)
}

/// The start of a card of `card_sectors` up to partition 2: the MBR and the boot
/// partition. `output` is sparse at the card's full size.
pub fn assemble_head(
    output: &Path,
    boot_fat: &Path,
    card_sectors: u64,
    release: &Release,
) -> Result<()> {
    let l = &release.layout;
    let p2 = partition_2_sectors(card_sectors, release)?;
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = File::create(output)?;
    f.set_len(card_sectors * l.sector_bytes)?;
    write_mbr(&mut f, release, p2)?;
    drop(f);
    copy_into(
        boot_fat,
        output,
        l.partition_1.start_sector * l.sector_bytes,
    )
}

pub fn assemble(
    output: &Path,
    boot_fat: &Path,
    rootfs_image: &Path,
    card_sectors: u64,
    release: &Release,
) -> Result<()> {
    let l = &release.layout;
    assemble_head(output, boot_fat, card_sectors, release)?;
    copy_into(
        rootfs_image,
        output,
        l.partition_2.start_sector * l.sector_bytes,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mbr_round_trip() {
        let mut raw = [0u8; 512];
        raw[510] = 0x55;
        raw[511] = 0xaa;
        let e = &mut raw[446..462];
        e[4] = 0x0b;
        e[8..12].copy_from_slice(&2048u32.to_le_bytes());
        e[12..16].copy_from_slice(&1_000_000u32.to_le_bytes());
        let p = parse_mbr(&raw).unwrap();
        assert_eq!(
            p[0],
            MbrEntry {
                active: false,
                kind: 11,
                start: 2048,
                count: 1_000_000
            }
        );
        assert!(parse_mbr(&raw[..511]).is_err());
    }

    #[test]
    fn mbr_matches_layout() {
        let r = Release::embedded();
        let min = r.minimum_card_bytes() / 512;
        let p2 = partition_2_sectors(min, &r).unwrap();
        assert_eq!(p2 * 512, r.ext4.bytes);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("card.img");
        let mut f = File::create(&path).unwrap();
        f.set_len(min * 512).unwrap();
        write_mbr(&mut f, &r, p2).unwrap();
        drop(f);
        verify_partition_layout(&path, &r).unwrap();
        let mut raw = [0u8; 512];
        File::open(&path).unwrap().read_exact(&mut raw).unwrap();
        // The CHS fields sfdisk writes for this layout.
        assert_eq!(raw[446..462], hex("00202100 0b5f213e 00080000 40420f00"));
        assert_eq!(raw[462..470], hex("0076393e 07a19948"));
        assert_eq!(parse_mbr(&raw).unwrap()[1].count, p2);
        // Past cylinder 1023 the end address is the maximum.
        assert_eq!(chs(20_000_000), CHS::new(1023, 254, 63));
    }

    #[test]
    fn boot_fat_layout_and_files() {
        let r = Release::embedded();
        let dir = tempfile::tempdir().unwrap();
        let mut files = vec![];
        for (name, data) in [
            ("Image", vec![7u8; 300_000]),
            ("fmic-tm-stomp.dtb", vec![3u8; 999]),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, &data).unwrap();
            let pin = Pin {
                bytes: data.len() as u64,
                sha256: crate::util::hex(&Sha256::digest(&data)),
            };
            files.push((path, name.to_string(), pin));
        }
        let fat = dir.path().join("boot.fat");
        write_boot_fat(&files, &fat, &r).unwrap();
        let raw = std::fs::read(&fat).unwrap();
        let p1 = &r.layout.partition_1;
        assert_eq!(raw.len() as u64, p1.sector_count * 512);
        let le32 = |o: usize| u32::from_le_bytes(raw[o..o + 4].try_into().unwrap());
        // BPB_HiddSec in the boot sector and its backup, the FSInfo free count, the label.
        assert_eq!(le32(28), p1.hidden_sectors);
        assert_eq!(le32(6 * 512 + 28), p1.hidden_sectors);
        assert_ne!(le32(512 + 488), 0xFFFF_FFFF);
        assert_eq!(&raw[71..82], format!("{:<11}", p1.label).as_bytes());
        assert_eq!(raw[13] as u32, p1.sectors_per_cluster);
        // A wrong pin fails the readback.
        files[1].2.bytes += 1;
        let again = dir.path().join("again.fat");
        assert!(write_boot_fat(&files, &again, &r).is_err());
    }

    fn hex(s: &str) -> Vec<u8> {
        let s: String = s.split_whitespace().collect();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
}
