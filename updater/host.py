import sys
import os
import json
import struct
import urllib.request
import zipfile
import io
import shutil

REPO = "assasakiy/Smart-Subtitle"

def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    length = struct.unpack('<I', raw_length)[0]
    message_bytes = sys.stdin.buffer.read(length)
    if not message_bytes:
        return None
    return json.loads(message_bytes.decode('utf-8'))

def send_message(msg):
    content = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(content)))
    sys.stdout.buffer.write(content)
    sys.stdout.buffer.flush()

def handle_update(download_url=None):
    try:
        # Base dir is parent of updater directory
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        
        # If no url provided, fetch latest release
        if not download_url:
            api_url = f"https://api.github.com/repos/{REPO}/releases/latest"
            req = urllib.request.Request(api_url, headers={"User-Agent": "Smart-Subtitle-Updater"})
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                download_url = data.get("zipball_url")
                if not download_url:
                    assets = data.get("assets", [])
                    for a in assets:
                        if a.get("name", "").endswith(".zip"):
                            download_url = a.get("browser_download_url")
                            break

        if not download_url:
            download_url = f"https://github.com/{REPO}/archive/refs/heads/main.zip"

        req = urllib.request.Request(download_url, headers={"User-Agent": "Smart-Subtitle-Updater"})
        with urllib.request.urlopen(req) as resp:
            zip_bytes = io.BytesIO(resp.read())

        with zipfile.ZipFile(zip_bytes) as z:
            root_folder = z.namelist()[0].split('/')[0] if z.namelist() else ""
            for member in z.infolist():
                filename = member.filename
                # Strip leading archive root if present
                if root_folder and filename.startswith(root_folder + '/'):
                    rel_path = filename[len(root_folder) + 1:]
                else:
                    rel_path = filename

                if not rel_path or rel_path.endswith('/'):
                    continue

                dest_path = os.path.join(base_dir, rel_path)
                os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                with z.open(member) as src, open(dest_path, "wb") as dst:
                    shutil.copyfileobj(src, dst)

        return {"success": True, "message": "Pembaruan berhasil diterapkan."}
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    while True:
        msg = read_message()
        if msg is None:
            break
        action = msg.get("action")
        if action == "ping":
            send_message({"success": True, "status": "connected"})
        elif action == "update":
            res = handle_update(msg.get("downloadUrl"))
            send_message(res)
        else:
            send_message({"success": False, "error": "Aksi tidak diizinkan."})

if __name__ == '__main__':
    main()
