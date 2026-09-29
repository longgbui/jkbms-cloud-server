#!/data/data/com.termux/files/usr/bin/bash
# ========================================================
# 🚀 CHẠY SERVER JK BMS & TỰ ĐỘNG KHỞI ĐỘNG KHI BẬT NGUỒN
# ========================================================

echo "=========================================================="
echo "🚀 ĐANG KHỞI ĐỘNG HỆ THỐNG JK BMS TRÊN TV BOX..."
echo "=========================================================="

termux-wake-lock 2>/dev/null

# 1. Dừng các tiến trình cũ
pkill -9 -f "node server.js" 2>/dev/null
pkill -9 -f "cloudflared" 2>/dev/null
sleep 1

# 2. Vào thư mục ~/bms
mkdir -p ~/bms
cd ~/bms

# 3. Tải server.js bản mới nhất (có đầy đủ Hệ Thống Tài Khoản, Quản Lý Khách, Đổi MK)
echo "[1/4] Đang tải mã nguồn server.js từ máy tính..."
curl -fsSL http://192.168.31.36:8000/server.js -o server.new.js

if [ -s server.new.js ] && [ $(wc -c < server.new.js) -gt 300000 ]; then
    mv server.new.js server.js
    echo "  -> Đã cập nhật server.js thành công ($(wc -c < server.js) bytes)!"
else
    echo "  [CẢNH BÁO] Không tải được từ 192.168.31.36, giữ nguyên file cũ."
    rm -f server.new.js
fi

# Tải users.json nếu chưa có
if [ ! -f users.json ]; then
    curl -fsSL http://192.168.31.36:8000/users.json -o users.json 2>/dev/null || true
fi

# 4. Kiểm tra cú pháp Node.js
echo "[2/4] Kiểm tra cú pháp server.js..."
if ! node --check server.js; then
    echo "❌ Lỗi cú pháp Node.js! Vui lòng kiểm tra lại."
    exit 1
fi
echo "  -> Cú pháp hợp lệ 100%!"

# 5. Khởi động Node.js trong nền
echo "[3/4] Khởi động Server Node.js trên cổng 3001..."
(
    while true; do
        node server.js >> server.log 2>&1
        sleep 2
    done
) &

sleep 3

# Kiểm tra cổng 3001
if curl -s -m 2 http://127.0.0.1:3001/ >/dev/null 2>&1; then
    echo "  -> ✅ Server Node.js ĐÃ CHẠY THÀNH CÔNG TRÊN CỔNG 3001!"
else
    echo "  -> Đang kiểm tra log khởi động..."
    tail -n 10 server.log
fi

# 6. Cấu hình tự khởi động khi tắt nguồn bật lại
echo "[4/4] Cấu hình tự động chạy khi bật nguồn..."
mkdir -p ~/.termux/boot
cat << 'BOOT_EOF' > ~/.termux/boot/start-bms.sh
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
sshd 2>/dev/null
bash ~/bms/start.sh
BOOT_EOF
chmod +x ~/.termux/boot/start-bms.sh

# Cập nhật ~/bms/start.sh
cat << 'START_EOF' > ~/bms/start.sh
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd ~/bms
sshd 2>/dev/null

pkill -9 -f "node server.js" 2>/dev/null
pkill -9 -f "cloudflared" 2>/dev/null
sleep 1

# Vòng lặp chạy Node.js
(
  while true; do
    node server.js >> server.log 2>&1
    sleep 2
  done
) &

# Watchdog tự động cập nhật code mới từ PC
(
  while true; do
    sleep 15
    if curl -s -f -m 5 http://192.168.31.36:8000/server.js -o server.new.js 2>/dev/null; then
      if [ -s server.new.js ] && [ $(wc -c < server.new.js) -gt 300000 ]; then
        if ! cmp -s server.new.js server.js 2>/dev/null; then
          mv server.new.js server.js
          pkill -f "node server.js" 2>/dev/null
        else
          rm -f server.new.js
        fi
      else
        rm -f server.new.js
      fi
    fi
  done
) &

sleep 2
TOKEN="eyJhIjoiMDI3OTliYzI0YWEyZTY0ODJkY2U5ZWM4ZjY0NTlhMGIiLCJ0IjoiOTdmMjUwYzQtNWIyZS00ODgzLWEwZGItOTA0ODFkMWFiNmVlIiwicyI6InBBRXpUZHQ2ZmhUa3VtT1dQV21ZM0pWWllJN2Y5VHg3UkFHUlRkZDZrYjRtT2JJS09uaVRFcFlhVG9EVHBCcmt5T0xEb1BnVTdKQWZiQW5mUVZuUHd3PT0ifQ=="
cloudflared tunnel --protocol http2 run --token $TOKEN
START_EOF
chmod +x ~/bms/start.sh

# Ghi vào ~/.bashrc nếu chưa có
if ! grep -q "start.sh" ~/.bashrc 2>/dev/null; then
    echo "bash ~/bms/start.sh" >> ~/.bashrc
fi

echo ""
echo "=========================================================="
echo "🎉 HOÀN TẤT! ĐANG KẾT NỐI CLOUDFLARE TUNNEL..."
echo "Tên miền: https://bms.lha.io.vn/"
echo "=========================================================="
echo ""

TOKEN="eyJhIjoiMDI3OTliYzI0YWEyZTY0ODJkY2U5ZWM4ZjY0NTlhMGIiLCJ0IjoiOTdmMjUwYzQtNWIyZS00ODgzLWEwZGItOTA0ODFkMWFiNmVlIiwicyI6InBBRXpUZHQ2ZmhUa3VtT1dQV21ZM0pWWllJN2Y5VHg3UkFHUlRkZDZrYjRtT2JJS09uaVRFcFlhVG9EVHBCcmt5T0xEb1BnVTdKQWZiQW5mUVZuUHd3PT0ifQ=="
cloudflared tunnel --protocol http2 run --token $TOKEN
