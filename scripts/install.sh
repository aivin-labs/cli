#!/bin/sh
# Aivin CLI installer for macOS (Intel, Apple Silicon) and Linux (x64, arm64; glibc or musl/Alpine) - no Node.js required.
#
#   curl -fsSL https://get.aivin.vn/install.sh | sh
#
# Install, then connect this computer to Aivin right away (Aivin prints this command in
# chat box -> Browser menu -> Add this computer):
#
#   curl -fsSL https://get.aivin.vn/install.sh | sh -s -- --code ABCD-EFGH
#
# Options: --code <pairing code> --server <server the code belongs to> --dir <folder the agent may use> --version <e.g. v1.1.0>
# Environment: AIVIN_DOWNLOAD_ROOT (versioned site: <root>/latest.txt + <root>/<version>/<asset>, default https://get.aivin.vn),
#              AIVIN_DOWNLOAD_BASE (one folder holding every asset, e.g. a GitHub release - overrides the root),
#              AIVIN_INSTALL_DIR (default: ~/.local/bin).
set -eu

CODE=""; SERVER=""; DIR=""; VERSION="${AIVIN_VERSION:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --code) CODE="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    *) echo "  Ignoring unknown option: $1" >&2; shift ;;
  esac
done

say() { printf '  \033[36m%s\033[0m\n' "$1"; }
fail() { printf '  \033[31m%s\033[0m\n' "$1" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "$(uname -s) is not supported. On Windows use install.ps1." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) fail "CPU architecture $(uname -m) is not supported." ;;
esac
# A shell running under Rosetta on Apple Silicon reports x86_64 - install the native build anyway.
if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; fi
LIBC=""
# musl (Alpine...): the glibc build cannot start there.
if [ "$OS" = linux ]; then
  if ls /lib/ld-musl-* >/dev/null 2>&1 || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then LIBC="-musl"; fi
fi
ASSET="aivin-$OS-$ARCH$LIBC"

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else fail "curl or wget is required."; fi
}

if [ -n "${AIVIN_DOWNLOAD_BASE:-}" ]; then
  BASE="${AIVIN_DOWNLOAD_BASE%/}"
else
  # Resolve "latest" to a concrete version first, then download from that version's folder: the CDN may cache
  # files, and a versioned folder never mixes a new checksum list with an old binary.
  ROOT="${AIVIN_DOWNLOAD_ROOT:-https://get.aivin.vn}"; ROOT="${ROOT%/}"
  if [ -z "$VERSION" ]; then
    LATEST_TMP="$(mktemp)"
    download "$ROOT/latest.txt" "$LATEST_TMP" || fail "Could not reach $ROOT."
    VERSION="$(tr -d ' \r\n' < "$LATEST_TMP")"; rm -f "$LATEST_TMP"
    case "$VERSION" in v[0-9]*.[0-9]*.[0-9]*) ;; *) fail "Could not read the latest version from $ROOT/latest.txt." ;; esac
  fi
  BASE="$ROOT/$VERSION"
fi
INSTALL_DIR="${AIVIN_INSTALL_DIR:-$HOME/.local/bin}"
TARGET="$INSTALL_DIR/aivin"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

echo ""
echo "  Aivin - installing the computer connector"
say "Downloading $ASSET ..."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
download "$BASE/$ASSET.gz" "$TMP/$ASSET.gz" || fail "Could not download $ASSET from $BASE - check the network, or this platform may not be published yet."
download "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || fail "Could not download the checksum list from $BASE."

# Integrity: the download must match the checksum published with the same release.
EXPECTED="$(awk -v f="$ASSET.gz" '{ n = $2; sub(/^\*/, "", n); if (n == f) { print $1; exit } }' "$TMP/SHA256SUMS")"
[ -n "$EXPECTED" ] || fail "No checksum for $ASSET.gz in SHA256SUMS."
[ "$(sha256 "$TMP/$ASSET.gz")" = "$EXPECTED" ] || fail "Downloaded file does not match its checksum - install stopped for safety. Please try again later."
gunzip -c "$TMP/$ASSET.gz" > "$TMP/$ASSET"

# The musl builds link libstdc++/libgcc dynamically; a bare Alpine image ships neither.
if [ -n "$LIBC" ] && [ ! -e /usr/lib/libstdc++.so.6 ] && [ ! -e /lib/libstdc++.so.6 ]; then
  if command -v apk >/dev/null 2>&1; then
    say "Installing libstdc++ and libgcc (needed on Alpine) ..."
    if [ "$(id -u)" = 0 ]; then apk add --no-cache libstdc++ libgcc >/dev/null || fail "Could not install libstdc++ libgcc - run: apk add libstdc++ libgcc"
    elif command -v sudo >/dev/null 2>&1; then sudo apk add --no-cache libstdc++ libgcc >/dev/null || fail "Could not install libstdc++ libgcc - run: sudo apk add libstdc++ libgcc"
    elif command -v doas >/dev/null 2>&1; then doas apk add --no-cache libstdc++ libgcc >/dev/null || fail "Could not install libstdc++ libgcc - run: doas apk add libstdc++ libgcc"
    else fail "Aivin needs libstdc++ and libgcc. Ask an administrator to run: apk add libstdc++ libgcc"; fi
  else
    fail "Aivin needs libstdc++ and libgcc on this musl system - install them with your package manager, then run this again."
  fi
fi

mkdir -p "$INSTALL_DIR"
# Write the new file, then rename over the old one: a running copy keeps its old inode and is not corrupted.
cp "$TMP/$ASSET" "$TARGET.new"
chmod 755 "$TARGET.new"
if [ "$OS" = darwin ]; then xattr -d com.apple.quarantine "$TARGET.new" 2>/dev/null || true; fi
# Make sure the new build actually starts on this machine before replacing a working one.
INSTALLED_VERSION="$("$TARGET.new" --version 2>/dev/null)" || { rm -f "$TARGET.new"; fail "The $ASSET build does not start on this machine ($(uname -s) $(uname -m)). Please report this to Aivin."; }
mv -f "$TARGET.new" "$TARGET"

say "Installed aivin $INSTALLED_VERSION to $INSTALL_DIR"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "  $INSTALL_DIR is not on your PATH - add this line to ~/.zshrc or ~/.bashrc to type 'aivin' anywhere:"
     echo "    export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

if [ -n "$CODE" ]; then
  set -- remote start --code "$CODE"
  if [ -n "$SERVER" ]; then set -- "$@" --server "$SERVER"; fi
  if [ -n "$DIR" ]; then set -- "$@" --dir "$DIR"; fi
  say "Connecting this computer to Aivin - keep this window open so the AI can work here."
  echo ""
  # Run from `curl | sh`: stdin is the pipe - give the keyboard back to the program (so Ctrl+C works).
  # Test by actually opening /dev/tty: without a controlling terminal (CI, `docker run` without -t) it
  # exists and looks readable but fails to open.
  if (: < /dev/tty) 2>/dev/null; then exec "$TARGET" "$@" < /dev/tty; else exec "$TARGET" "$@" < /dev/null; fi
else
  echo ""
  echo "  Next: create a code in Aivin (chat box -> Browser menu -> Add this computer), then run:"
  echo "    aivin remote start --code <code>"
fi
