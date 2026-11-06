#!/usr/bin/env bash
# ==============================================================================
# package-shareable-zip.sh
# Packages PR Review Hub & my-review skill into a clean, portable .zip archive
# without any personal configuration or local rule overrides.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_REVIEWS_DIR="${HOME}/Ubitransport/projects/artifacts/reviews"
OUTPUT_ZIP="${1:-${DEFAULT_REVIEWS_DIR}/pr-review-hub-shareable.zip}"

STAGE_ROOT="$(mktemp -d)"
PACKAGE_DIR="${STAGE_ROOT}/pr-review-hub"
mkdir -p "${PACKAGE_DIR}/my-review"

cleanup() {
  rm -rf "${STAGE_ROOT}"
}
trap cleanup EXIT

echo "Staging portable files from ${SKILL_DIR} ..."

rsync -a \
  --exclude '.git' \
  --exclude 'config.json' \
  --exclude 'references/*.local.md' \
  --exclude 'references/*.local.json' \
  --exclude 'references/reviewer-dna.md' \
  --exclude 'references/false-positives.md' \
  --exclude 'references/changelog.md' \
  --exclude '.DS_Store' \
  --exclude 'node_modules' \
  "${SKILL_DIR}/" "${PACKAGE_DIR}/my-review/"

cp "${SKILL_DIR}/install.sh" "${PACKAGE_DIR}/install.sh"
cp "${SKILL_DIR}/README.md" "${PACKAGE_DIR}/README.md"
cp "${SKILL_DIR}/CHANGELOG.md" "${PACKAGE_DIR}/CHANGELOG.md"
cp "${SKILL_DIR}/VERSION" "${PACKAGE_DIR}/VERSION"
chmod +x "${PACKAGE_DIR}/install.sh" "${PACKAGE_DIR}/my-review/install.sh" "${PACKAGE_DIR}/my-review/scripts/"*.sh

mkdir -p "$(dirname "${OUTPUT_ZIP}")"
rm -f "${OUTPUT_ZIP}"

(
  cd "${STAGE_ROOT}"
  zip -r -q "${OUTPUT_ZIP}" pr-review-hub
)

echo "Portable archive created: ${OUTPUT_ZIP}"
unzip -l "${OUTPUT_ZIP}"
