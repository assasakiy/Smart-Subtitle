#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JSON_PATH="$DIR/com.aisubtitle.updater.json"
SH_PATH="$DIR/host.sh"

chmod +x "$SH_PATH"

cat <<EOF > "$JSON_PATH"
{
  "name": "com.aisubtitle.updater",
  "description": "Smart Subtitle Native Updater Host",
  "path": "$SH_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://*/*"
  ]
}
EOF

# Linux Chrome & Chromium target
TARGET_DIRS=(
  "$HOME/.config/google-chrome/NativeMessagingHosts"
  "$HOME/.config/chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
)

for T_DIR in "${TARGET_DIRS[@]}"; do
  PARENT="$(dirname "$T_DIR")"
  if [ -d "$PARENT" ]; then
    mkdir -p "$T_DIR"
    cp "$JSON_PATH" "$T_DIR/com.aisubtitle.updater.json"
    echo "Tersambung ke: $T_DIR"
  fi
done

echo "[SUKSES] Native Messaging Host berhasil didaftarkan untuk Linux/macOS!"
