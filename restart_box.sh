#!/data/data/com.termux/files/usr/bin/bash
# Script restart server.js - chay tren TV Box
echo "[RESTART] Dang khoi dong lai server..."
cd ~/bms

# Tai server.js moi nhat tu PC
wget -q http://192.168.31.36:8000/server.js -O server_new.js && mv server_new.js server.js
echo "[RESTART] Da tai server.js moi"

# Kill node cu
pkill -9 -f "node server.js" 2>/dev/null
sleep 1

# Chay lai
nohup node server.js >> server.log 2>&1 &
sleep 3
echo "[RESTART] Done. Check port 3001..."
