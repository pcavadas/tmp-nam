#!/bin/bash
# Build the e2fsprogs tools the card builder runs (mke2fs, debugfs, e2fsck) as Tauri
# sidecars for one Rust target triple, from the pinned upstream release.
#
# Usage: tools/e2fsprogs/build.sh [target-triple]   (default: the host's)
#
# Output, in apps/desktop/src-tauri/binaries/ (Tauri's sidecar naming,
# https://v2.tauri.app/develop/sidecar/):
#   tmp-nam-{mke2fs,debugfs,e2fsck}-<triple>   bundled by tauri.e2fsprogs.conf.json
#   licenses/e2fsprogs/                        license notices and SOURCE
#   e2fsprogs-<version>.tar.xz                 the verified source, published with
#                                              each release (GPLv2 section 3)
#
# The e2fsprogs libraries are linked statically (their default), so the tools only
# need the OS C library. macOS builds cross-compile with clang -arch; Linux builds
# only for the host.
set -euo pipefail

VERSION=1.47.4
URL="https://mirrors.edge.kernel.org/pub/linux/kernel/people/tytso/e2fsprogs/v$VERSION/e2fsprogs-$VERSION.tar.xz"
SHA256=fd5bf388cbdbe006a3d3b318d983b2948382440acc85a87f1e7d108653e8db0b
TOOLS="misc/mke2fs debugfs/debugfs e2fsck/e2fsck"
# Private uuid/blkid copies (no system library), only what the card builder runs.
CONFIGURE_FLAGS="--enable-libuuid --enable-libblkid --disable-nls --disable-fuse2fs \
--disable-uuidd --disable-defrag --disable-imager --disable-resizer --without-libarchive"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/apps/desktop/src-tauri/binaries"
TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"

case "$TRIPLE" in
  aarch64-apple-darwin) ARCH=arm64 ;;
  x86_64-apple-darwin) ARCH=x86_64 ;;
  "$(uname -m)-unknown-linux-gnu") ARCH= ;;
  *)
    echo "unsupported target on this host: $TRIPLE" >&2
    exit 2
    ;;
esac

WORK="$(mktemp -d)"
# On failure, show the end of the build logs before they are removed.
trap 'tail -40 "$WORK/build/configure.log" "$WORK/build/make.log" 2>/dev/null || true' ERR
trap 'rm -rf "$WORK"' EXIT
curl -fsSL --retry 3 -o "$WORK/src.tar.xz" "$URL"
if command -v sha256sum >/dev/null; then
  echo "$SHA256  $WORK/src.tar.xz" | sha256sum -c -
else
  echo "$SHA256  $WORK/src.tar.xz" | shasum -a 256 -c -
fi
tar -xJf "$WORK/src.tar.xz" -C "$WORK"
SRC="$WORK/e2fsprogs-$VERSION"

mkdir -p "$WORK/build"
cd "$WORK/build"
# Keep the random work path out of the binaries.
export CFLAGS="-g -O2 -ffile-prefix-map=$WORK=."
if [ -n "$ARCH" ]; then
  # The app's macOS floor (tauri.conf.json minimumSystemVersion).
  export MACOSX_DEPLOYMENT_TARGET=12.0
  export CC="clang -arch $ARCH"
  # shellcheck disable=SC2086
  "$SRC/configure" --host="$ARCH-apple-darwin" $CONFIGURE_FLAGS >configure.log 2>&1
else
  # shellcheck disable=SC2086
  "$SRC/configure" $CONFIGURE_FLAGS >configure.log 2>&1
fi
JOBS="$(getconf _NPROCESSORS_ONLN)"
make -j"$JOBS" libs >make.log 2>&1
for t in $TOOLS; do
  make -j"$JOBS" -C "$(dirname "$t")" "$(basename "$t")" >>make.log 2>&1
done

LICENSES="$OUT/licenses/e2fsprogs"
mkdir -p "$LICENSES"
for t in $TOOLS; do
  install -m 755 "$t" "$OUT/tmp-nam-$(basename "$t")-$TRIPLE"
done
install -m 644 "$WORK/src.tar.xz" "$OUT/e2fsprogs-$VERSION.tar.xz"
# NOTICE: the GPL/LGPL terms; then the libuuid (BSD), libss and libet (MIT-style) notices.
install -m 644 "$SRC/NOTICE" "$LICENSES/NOTICE"
install -m 644 "$SRC/lib/uuid/COPYING" "$LICENSES/uuid-COPYING"
install -m 644 "$SRC/lib/ss/mit-sipb-copyright.h" "$LICENSES/ss-COPYRIGHT"
sed -n '1,/\*\//p' "$SRC/lib/et/com_err.c" >"$LICENSES/et-COPYRIGHT"
COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo main)"
cat >"$LICENSES/SOURCE" <<END
mke2fs, debugfs and e2fsck are e2fsprogs $VERSION, unmodified, built from
e2fsprogs-$VERSION.tar.xz (SHA-256 $SHA256),
published with every TMP NAM release at https://github.com/pcavadas/tmp-nam/releases
and upstream at $URL
with: configure $CONFIGURE_FLAGS
by tools/e2fsprogs/build.sh at https://github.com/pcavadas/tmp-nam/tree/$COMMIT
END
chmod 644 "$LICENSES/et-COPYRIGHT" "$LICENSES/SOURCE"

# Smoke test (macOS runs the other architecture through Rosetta): the tools build,
# check and read a small ext4 image the way the card builder runs them.
mkdir -p "$WORK/smoke/etc"
echo ok >"$WORK/smoke/etc/probe"
export MKE2FS_CONFIG="$WORK/missing.conf" E2FSCK_CONFIG="$WORK/missing.conf"
"$OUT/tmp-nam-mke2fs-$TRIPLE" -q -t ext4 -F -b 4096 -N 64 -O ^orphan_file \
  -d "$WORK/smoke" "$WORK/smoke.ext4" 4096
"$OUT/tmp-nam-e2fsck-$TRIPLE" -fn "$WORK/smoke.ext4" >/dev/null
[ "$("$OUT/tmp-nam-debugfs-$TRIPLE" -R 'cat /etc/probe' "$WORK/smoke.ext4" 2>/dev/null)" = ok ]
ls -l "$OUT"/tmp-nam-*-"$TRIPLE"
