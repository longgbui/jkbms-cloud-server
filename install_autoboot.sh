#!/data/data/com.termux/files/usr/bin/bash
echo "=========================================================="
echo "⚡ CÀI ĐẶT TỰ ĐỘNG KHỞI ĐỘNG (AUTO-BOOT) CHO TERMUX"
echo "=========================================================="

# 1. Tạo thư mục cấu hình boot của Termux
mkdir -p ~/.termux/boot

# 2. Tạo script tự chạy khi khởi động nguồn
cat << 'EOF' > ~/.termux/boot/start-bms.sh
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
echo "[$(date)] Auto-booting BMS Server..." >> ~/bms/server.log
if [ -f ~/bms/start.sh ]; then
    ~/bms/start.sh
else
    cd ~/bms && nohup node server.js >> server.log 2>&1 &
fi
EOF
chmod +x ~/.termux/boot/start-bms.sh
echo "[OK] Đã tạo file khởi động: ~/.termux/boot/start-bms.sh"

# 3. Đảm bảo .bashrc cũng tự chạy start.sh nếu mở Termux thủ công
if ! grep -q "start.sh" ~/.bashrc 2>/dev/null; then
    echo "if [ -f ~/bms/start.sh ]; then ~/bms/start.sh; fi" >> ~/.bashrc
    echo "[OK] Đã cấu hình ~/.bashrc"
fi

# 4. Tải ứng dụng Termux:Boot (Bản chuẩn 743 KB)
echo "[...] Đang tải ứng dụng Termux:Boot APK từ máy tính..."
mkdir -p /sdcard/Download 2>/dev/null
curl -fsSL http://192.168.31.36:8000/termux-boot.apk -o /sdcard/Download/termux-boot.apk 2>/dev/null || \
curl -fsSL http://192.168.31.36:8000/termux-boot.apk -o ~/termux-boot.apk

# 5. Cài đặt ứng dụng Termux:Boot
echo "[...] Đang tiến hành cài đặt Termux:Boot..."
INSTALLED=0

# Thử cài bằng quyền Root (nếu TV Box đã root)
if command -v su >/dev/null 2>&1; then
    if su -c "pm install -r /sdcard/Download/termux-boot.apk" 2>/dev/null; then
        echo "✅ Cài đặt Termux:Boot thành công qua quyền Root!"
        INSTALLED=1
    fi
fi

# Nếu chưa root, mở bảng cài đặt Android để người dùng bấm Cài Đặt trên TV
if [ "$INSTALLED" -eq 0 ]; then
    echo "[INFO] Đang mở trình cài đặt Android trên màn hình TV..."
    if command -v termux-open >/dev/null 2>&1; then
        termux-open /sdcard/Download/termux-boot.apk 2>/dev/null || termux-open ~/termux-boot.apk 2>/dev/null
    else
        am start -a android.intent.action.VIEW -d "file:///sdcard/Download/termux-boot.apk" -t "application/vnd.android.package-archive" 2>/dev/null || true
    fi
    echo "👉 Vui lòng nhìn màn hình TV và bấm 'Cài đặt' (Install) bằng điều khiển."
fi

# 6. Kích hoạt mở Termux:Boot một lần để Android đăng ký quyền khởi động
sleep 2
am start -n com.termux.boot/.BootActivity 2>/dev/null || true

echo "=========================================================="
echo "🎉 HOÀN TẤT THIẾT LẬP AUTO-BOOT!"
echo "Từ bây giờ, mỗi khi mất nguồn bật lại:"
echo "1. Android TV tự chạy ứng dụng Termux:Boot ngầm."
echo "2. Termux:Boot tự động chạy Node Server, Watchdog và Cloudflare Tunnel."
echo "=========================================================="
