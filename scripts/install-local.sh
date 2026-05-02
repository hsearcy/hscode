#!/usr/bin/env bash
# Builds the Linux AppImage and installs it as ~/Applications/dpcode/.
# The previous install is moved to ~/Applications/dpcode.bak (any earlier
# backup is removed first).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${HOME}/Applications/dpcode"
BACKUP_DIR="${INSTALL_DIR}.bak"
EXTRACT_DIR="$(mktemp -d -t dpcode-extract.XXXXXX)"
trap 'rm -rf "${EXTRACT_DIR}"' EXIT

cd "${REPO_ROOT}"

echo "==> Building Linux AppImage"
bun run dist:desktop:linux

APPIMAGE="$(ls -1t "${REPO_ROOT}"/release/*.AppImage | head -1)"
if [[ -z "${APPIMAGE}" || ! -f "${APPIMAGE}" ]]; then
  echo "No AppImage produced in ${REPO_ROOT}/release/" >&2
  exit 1
fi
echo "==> Built: ${APPIMAGE}"

chmod +x "${APPIMAGE}"

echo "==> Extracting AppImage"
( cd "${EXTRACT_DIR}" && "${APPIMAGE}" --appimage-extract >/dev/null )

if [[ ! -x "${EXTRACT_DIR}/squashfs-root/AppRun" ]]; then
  echo "Extraction did not produce squashfs-root/AppRun" >&2
  exit 1
fi

mkdir -p "$(dirname "${INSTALL_DIR}")"

if [[ -d "${BACKUP_DIR}" ]]; then
  echo "==> Removing previous backup ${BACKUP_DIR}"
  rm -rf "${BACKUP_DIR}"
fi

if [[ -d "${INSTALL_DIR}" ]]; then
  echo "==> Backing up current install -> ${BACKUP_DIR}"
  mv "${INSTALL_DIR}" "${BACKUP_DIR}"
fi

echo "==> Installing to ${INSTALL_DIR}"
mv "${EXTRACT_DIR}/squashfs-root" "${INSTALL_DIR}"

echo "==> Done. Launch with your existing 'dpcode' alias."
echo "    To roll back: rm -rf '${INSTALL_DIR}' && mv '${BACKUP_DIR}' '${INSTALL_DIR}'"
