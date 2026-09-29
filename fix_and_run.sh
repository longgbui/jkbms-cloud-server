#!/data/data/com.termux/files/usr/bin/bash
echo "=========================================================="
echo "🚀 CẬP NHẬT HỆ THỐNG TÀI KHOẢN & KHỞI ĐỘNG SERVER JK BMS"
echo "=========================================================="

cd ~/bms || mkdir -p ~/bms && cd ~/bms

# 1. Dừng tiến trình cũ
pkill -9 -f "node server.js" 2>/dev/null
sleep 1

# 2. Tải server.js mới nhất (Đã tích hợp Hệ Thống Tài Khoản Khách Hàng)
echo "[1/4] Đang tải mã nguồn server.js từ máy tính..."
curl -fsSL http://192.168.31.36:8000/server.js -o ~/bms/server.js || wget -q http://192.168.31.36:8000/server.js -O ~/bms/server.js

# Tải users.json nếu chưa có
if [ ! -f ~/bms/users.json ]; then
  curl -fsSL http://192.168.31.36:8000/users.json -o ~/bms/users.json 2>/dev/null || true
fi

# 3. Kiểm tra tính toàn vẹn và cú pháp
SIZE=$(wc -c < ~/bms/server.js 2>/dev/null || echo 0)
echo "[2/4] Kích thước file: $SIZE bytes"

if [ "$SIZE" -lt 300000 ]; then
  echo "[LỖI] File tải về không đủ kích thước ($SIZE bytes)! Vui lòng kiểm tra kết nối với máy tính."
  exit 1
fi

echo "[3/4] Kiểm tra cú pháp Node.js..."
if ! node --check ~/bms/server.js; then
  echo "[LỖI] Cú pháp server.js không hợp lệ!"
  exit 1
fi
echo "✅ Cú pháp Node.js hợp lệ 100%!"

# 4. Khởi động tiến trình Node.js với vòng lặp tự phục hồi 24/7
echo "[4/4] Khởi động JK BMS Server..."
(
  while true; do
    echo "[$(date)] Starting JK BMS Server..." >> ~/bms/server.log
    node ~/bms/server.js >> ~/bms/server.log 2>&1
    sleep 2
  done
) &

sleep 3

if ss -tlnp 2>/dev/null | grep -q ":3001" || netstat -tlnp 2>/dev/null | grep -q ":3001" || pgrep -f "node ~/bms/server.js" >/dev/null 2>&1 || pgrep -f "node server.js" >/dev/null 2>&1; then
  echo "=========================================================="
  echo "🎉 THÀNH CÔNG! SERVER ĐANG CHẠY ỔN ĐỊNH TRÊN CỔNG 3001!"
  echo "   - Cổng Đăng Nhập & Quản Lý: https://bms.lha.io.vn/"
  echo "   - Cổng Khách Hàng:          https://bms.lha.io.vn/my-devices"
  echo "   - Cổng Quản Trị Admin:      https://bms.lha.io.vn/admin"
  echo "   - Tab 'Quản Lý Khách':      Đã sẵn sàng trên Dashboard!"
  echo "=========================================================="
else
  echo "⚠️ Đang kiểm tra log khởi động (5 dòng cuối):"
  tail -n 10 ~/bms/server.log 2>/dev/null || true
fi
