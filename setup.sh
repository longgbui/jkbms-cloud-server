#!/data/data/com.termux/files/usr/bin/bash

echo "=========================================================="
echo "🚀 CÀI ĐẶT SERVER & CLOUDFLARE TUNNEL CỐ ĐỊNH CHO TV BOX"
echo "Tên miền: bms.lha.io.vn | Cổng: 3001"
echo "=========================================================="

# 1. Giữ TV Box luôn thức 24/7 không bị Android tắt ngầm
termux-wake-lock

# 2. Cài đặt openssl, cloudflared, nodejs-lts và openssh
echo "[1/4] Cập nhật thư viện..."
pkg install -y openssl cloudflared nodejs-lts openssh
sshd 2>/dev/null

# 3. Tạo thư mục làm việc ~/bms
echo "[2/4] Thiết lập thư mục ~/bms..."
mkdir -p ~/bms
cd ~/bms

# 4. Tải file server.js mới nhất
echo "[3/4] Cập nhật mã nguồn server.js..."
wget -q http://192.168.31.36:8000/server.js -O server.js || wget -q http://192.168.102.34:8000/server.js -O server.js

# 5. Cài express và cors nếu chưa có
echo "[4/4] Cài đặt express & cors..."
npm install express cors

# 6. Tạo file khởi động start.sh để chạy 24/24 tự động cập nhật
TOKEN="eyJhIjoiMDI3OTliYzI0YWEyZTY0ODJkY2U5ZWM4ZjY0NTlhMGIiLCJ0IjoiOTdmMjUwYzQtNWIyZS00ODgzLWEwZGItOTA0ODFkMWFiNmVlIiwicyI6InBBRXpUZHQ2ZmhUa3VtT1dQV21ZM0pWWllJN2Y5VHg3UkFHUlRkZDZrYjRtT2JJS09uaVRFcFlhVG9EVHBCcmt5T0xEb1BnVTdKQWZiQW5mUVZuUHd3PT0ifQ=="

cat << 'EOF' > ~/bms/start.sh
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd ~/bms

# Khởi động SSH server (cổng 8022) để máy tính có thể điều khiển từ xa
sshd 2>/dev/null

pkill -9 -f "node server.js" 2>/dev/null
pkill -9 -f "cloudflared" 2>/dev/null
sleep 1

# Vòng lặp tự động chạy lại Node.js khi khởi động lại hoặc khi có code mới
(
  while true; do
    echo "[$(date)] Starting JK BMS Node Server..." >> server.log
    node server.js >> server.log 2>&1
    sleep 2
  done
) &

# TIẾN TRÌNH TỰ ĐỘNG ĐỒNG BỘ (WATCHDOG AUTO-SYNC 15S):
# Tự động kiểm tra file server.js trên máy tính (192.168.31.36:8000). 
# Nếu phát hiện máy tính đã sửa code mới, TV Box tự tải về và khởi động lại ngay lập tức!
(
  while true; do
    sleep 15
    TARGET_DIR="$HOME/bms"
    mkdir -p "$TARGET_DIR"
    NEW_FILE="$TARGET_DIR/server.new.js"
    CURR_FILE="$TARGET_DIR/server.js"
    if curl -s --connect-timeout 2 http://192.168.31.36:8000/server.js -o "$NEW_FILE" 2>/dev/null; then
      if [ -s "$NEW_FILE" ]; then
        NEEDS_UPDATE=0
        if [ ! -f "$CURR_FILE" ]; then
          NEEDS_UPDATE=1
        elif command -v cmp >/dev/null 2>&1; then
          if ! cmp -s "$NEW_FILE" "$CURR_FILE"; then NEEDS_UPDATE=1; fi
        elif command -v md5sum >/dev/null 2>&1; then
          if [ "$(md5sum "$NEW_FILE" | cut -d' ' -f1)" != "$(md5sum "$CURR_FILE" | cut -d' ' -f1)" ]; then NEEDS_UPDATE=1; fi
        else
          NEEDS_UPDATE=1
        fi

        if [ "$NEEDS_UPDATE" -eq 1 ]; then
          echo "[$(date)] [Auto-Sync] Phát hiện code mới trên máy tính! Đang tự động cập nhật..." >> "$TARGET_DIR/server.log"
          cp "$NEW_FILE" "$CURR_FILE"
          pkill -f "node server.js" 2>/dev/null
        fi
      fi
    fi
  done
) &


sleep 2
echo "Server Node.js đang chạy trên cổng 3001..."
TOKEN="eyJhIjoiMDI3OTliYzI0YWEyZTY0ODJkY2U5ZWM4ZjY0NTlhMGIiLCJ0IjoiOTdmMjUwYzQtNWIyZS00ODgzLWEwZGItOTA0ODFkMWFiNmVlIiwicyI6InBBRXpUZHQ2ZmhUa3VtT1dQV21ZM0pWWllJN2Y5VHg3UkFHUlRkZDZrYjRtT2JJS09uaVRFcFlhVG9EVHBCcmt5T0xEb1BnVTdKQWZiQW5mUVZuUHd3PT0ifQ=="
cloudflared tunnel --protocol http2 run --token $TOKEN
EOF
chmod +x ~/bms/start.sh

# Cấu hình để mỗi khi mở Termux là tự chạy server và tunnel
if ! grep -q "start.sh" ~/.bashrc 2>/dev/null; then
    echo "~/bms/start.sh" >> ~/.bashrc
fi

echo ""
echo "=========================================================="
echo "✅ HOÀN TẤT CÀI ĐẶT! HỆ THỐNG ĐÃ CÓ TỰ ĐỘNG ĐỒNG BỘ 24/24!"
echo "=========================================================="
~/bms/start.sh
