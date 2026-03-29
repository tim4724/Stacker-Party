#!/bin/bash
# Build an AirConsole-ready ZIP package for upload to airconsole.com/developers
#
# AirConsole expects screen.html and controller.html at the root of the ZIP,
# with all assets referenced via relative paths.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build/airconsole"
ZIP_FILE="$PROJECT_DIR/build/airconsole.zip"

echo "Building AirConsole package..."

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Copy public files (shared, display, controller assets)
cp -r "$PROJECT_DIR/public/shared" "$BUILD_DIR/shared"
cp -r "$PROJECT_DIR/public/display" "$BUILD_DIR/display"
cp -r "$PROJECT_DIR/public/controller" "$BUILD_DIR/controller"
cp "$PROJECT_DIR/public/favicon.svg" "$BUILD_DIR/" 2>/dev/null || true

# Copy engine modules (from server/ to engine/ for browser access)
mkdir -p "$BUILD_DIR/engine"
for f in constants.js Game.js GarbageManager.js Piece.js PlayerBoard.js Randomizer.js; do
  cp "$PROJECT_DIR/server/$f" "$BUILD_DIR/engine/$f"
done

# Copy AirConsole entry points to root
cp "$BUILD_DIR/display/screen.html" "$BUILD_DIR/screen.html"
cp "$BUILD_DIR/controller/controller.html" "$BUILD_DIR/controller.html"

# Remove standalone-only entry points and duplicate AirConsole HTML from subdirs
rm -f "$BUILD_DIR/display/index.html"
rm -f "$BUILD_DIR/controller/index.html"
rm -f "$BUILD_DIR/display/screen.html"
rm -f "$BUILD_DIR/controller/controller.html"

# Create ZIP
cd "$BUILD_DIR"
rm -f "$ZIP_FILE"
zip -r "$ZIP_FILE" . -x '*.DS_Store'

echo ""
echo "AirConsole package built: $ZIP_FILE"
echo "Upload to: https://www.airconsole.com/developers"
