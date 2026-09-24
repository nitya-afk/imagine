#!/usr/bin/env bash
# Builds imagine-engine: Ollama 0.32.5 (the last release with image generation) compiled from
# source with the patches in ./patches, packaged with the MLX libraries from the official release.
#
# Needs: macOS on Apple silicon, git, Go 1.26+, Xcode Command Line Tools.
# Output: engine/dist/imagine-engine-<version>-darwin-arm64.tar.gz and its .sha256
set -euo pipefail

OLLAMA_VERSION=0.32.5
ENGINE_VERSION="${OLLAMA_VERSION}-imagine.1"
# From https://github.com/ollama/ollama/releases/download/v0.32.5/sha256sum.txt
OLLAMA_TARBALL_SHA256=5789dd037a86adb328c72c11fc45e6c558452d07e5b50814a8bdb7b0fbdbcd81

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HERE/.build}"
OUT="${OUT:-$HERE/dist}"
SRC="$WORK/ollama"
mkdir -p "$WORK" "$OUT"

echo "==> Ollama v$OLLAMA_VERSION source"
if [ ! -d "$SRC" ]; then
  git clone --quiet --depth 1 --branch "v$OLLAMA_VERSION" https://github.com/ollama/ollama.git "$SRC"
fi

echo "==> Patches"
for patch in "$HERE"/patches/*.patch; do
  if git -C "$SRC" apply --reverse --check "$patch" 2>/dev/null; then
    echo "    already applied: $(basename "$patch")"
  else
    git -C "$SRC" apply "$patch"
    echo "    applied: $(basename "$patch")"
  fi
done

echo "==> Build"
(cd "$SRC" && CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 go build -trimpath \
  -ldflags "-s -w -X github.com/ollama/ollama/version.Version=$ENGINE_VERSION" \
  -o "$WORK/imagine-engine" .)

echo "==> Official MLX libraries"
TARBALL="$WORK/ollama-darwin.tgz"
if [ ! -f "$TARBALL" ]; then
  curl -fsSL -o "$TARBALL" "https://github.com/ollama/ollama/releases/download/v$OLLAMA_VERSION/ollama-darwin.tgz"
fi
echo "$OLLAMA_TARBALL_SHA256  $TARBALL" | shasum -a 256 -c - >/dev/null
rm -rf "$WORK/official" && mkdir -p "$WORK/official"
tar -xzf "$TARBALL" -C "$WORK/official"

echo "==> Package"
PKG="$WORK/pkg/imagine-engine"
rm -rf "$WORK/pkg" && mkdir -p "$PKG/licenses"
cp "$WORK/imagine-engine" "$PKG/"
cp -R "$WORK/official/mlx_metal_v3" "$WORK/official/mlx_metal_v4" "$PKG/"
cp "$HERE/NOTICE.md" "$PKG/"
cp "$SRC/LICENSE" "$PKG/licenses/OLLAMA_LICENSE"
curl -fsSL -o "$PKG/licenses/MLX_LICENSE" "https://raw.githubusercontent.com/ml-explore/mlx/$(cat "$SRC/MLX_VERSION")/LICENSE"
curl -fsSL -o "$PKG/licenses/MLX_C_LICENSE" "https://raw.githubusercontent.com/ml-explore/mlx-c/$(cat "$SRC/MLX_C_VERSION")/LICENSE"

NAME="imagine-engine-$ENGINE_VERSION-darwin-arm64.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$OUT/$NAME" -C "$WORK/pkg" imagine-engine
(cd "$OUT" && shasum -a 256 "$NAME" > "$NAME.sha256" && cat "$NAME.sha256")
