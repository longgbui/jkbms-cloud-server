const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// In-memory device store: { device_id -> deviceInfo }
const devices = new Map();

// Mark device offline if no heartbeat for 3 minutes
const OFFLINE_THRESHOLD_MS = 3 * 60 * 1000;

function isOnline(device) {
    return device.lastSeen && (Date.now() - device.lastSeen) < OFFLINE_THRESHOLD_MS;
}

// ─── API ROUTES ──────────────────────────────────────────────────────────────

// POST /api/register-device — called by ESP32 on first WiFi connect
app.post('/api/register-device', (req, res) => {
    const body = req.body;
    const deviceId = body.device_id;
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });

    const existing = devices.get(deviceId) || {};
    const now = Date.now();

    devices.set(deviceId, {
        ...existing,
        device_id: deviceId,
        mac: body.mac || existing.mac || '',
        local_ip: body.local_ip || existing.local_ip || '',
        ssid: body.ssid || existing.ssid || '',
        hostname: body.hostname || existing.hostname || '',
        firmware_version: body.firmware_version || existing.firmware_version || '',
        active_bms_mac: body.active_bms_mac || existing.active_bms_mac || '',
        active_bms_name: body.active_bms_name || existing.active_bms_name || '',
        registeredAt: existing.registeredAt || now,
        lastSeen: now,
        firstConnectedSsid: existing.firstConnectedSsid || body.ssid || '',
        // BMS data (empty until heartbeat)
        connected: existing.connected || false,
        voltage: existing.voltage || 0,
        current: existing.current || 0,
        soc: existing.soc || 0,
        mos_temp: existing.mos_temp || 0,
    });

    console.log(`[REGISTER] Device: ${deviceId} | IP: ${body.local_ip} | WiFi: ${body.ssid} | FW: ${body.firmware_version}`);
    res.json({ status: 'ok', message: 'Device registered successfully', device_id: deviceId });
});

// POST /api/device-heartbeat — called by ESP32 every 60 seconds
app.post('/api/device-heartbeat', (req, res) => {
    const body = req.body;
    const deviceId = body.device_id;
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });

    const existing = devices.get(deviceId) || { device_id: deviceId, registeredAt: Date.now() };

    devices.set(deviceId, {
        ...existing,
        device_id: deviceId,
        local_ip: body.local_ip || existing.local_ip || '',
        firmware_version: body.firmware || existing.firmware_version || '',
        connected: body.connected || false,
        voltage: body.voltage || 0,
        current: body.current || 0,
        soc: body.soc || 0,
        mos_temp: body.mos_temp || 0,
        lastSeen: Date.now(),
    });

    res.json({ status: 'ok' });
});

// GET /api/devices — return all devices (for dashboard)
app.get('/api/devices', (req, res) => {
    const list = Array.from(devices.values()).map(d => ({
        ...d,
        online: isOnline(d),
        lastSeenAgo: d.lastSeen ? Math.floor((Date.now() - d.lastSeen) / 1000) : null,
    }));
    list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    res.json(list);
});

// ─── WEB DASHBOARD ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.send(DASHBOARD_HTML);
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Server] JK BMS Cloud Server running on port ${PORT}`);
    console.log(`[Server] Dashboard: http://localhost:${PORT}`);
});

// ─── EMBEDDED DASHBOARD HTML ─────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>JK BMS Cloud - Quản Lý Thiết Bị</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --border: rgba(255,255,255,0.08);
    --primary: #3fb950;
    --primary-dim: rgba(63,185,80,0.15);
    --danger: #f85149;
    --danger-dim: rgba(248,81,73,0.15);
    --warning: #e3b341;
    --warning-dim: rgba(227,179,65,0.15);
    --text: #e6edf3;
    --subtext: #8b949e;
    --accent: #58a6ff;
  }

  * { margin:0; padding:0; box-sizing:border-box; }

  body {
    font-family: 'Inter', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }

  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
    backdrop-filter: blur(12px);
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .logo-icon {
    width: 36px; height: 36px;
    background: linear-gradient(135deg, var(--primary), #1a7f37);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px;
  }

  .logo h1 { font-size: 1.1rem; font-weight: 700; }
  .logo span { font-size: 0.75rem; color: var(--subtext); }

  .header-right { display: flex; align-items: center; gap: 12px; }

  .refresh-badge {
    font-size: 0.75rem;
    color: var(--subtext);
    background: var(--surface2);
    padding: 4px 10px;
    border-radius: 20px;
    border: 1px solid var(--border);
  }

  .stats-bar {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    padding: 20px 24px;
    max-width: 1200px;
    margin: 0 auto;
  }

  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 20px;
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .stat-icon {
    width: 44px; height: 44px;
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }

  .stat-icon.green { background: var(--primary-dim); }
  .stat-icon.red { background: var(--danger-dim); }
  .stat-icon.blue { background: rgba(88,166,255,0.15); }

  .stat-val { font-size: 1.6rem; font-weight: 700; line-height: 1; }
  .stat-label { font-size: 0.78rem; color: var(--subtext); margin-top: 2px; }

  .content { max-width: 1200px; margin: 0 auto; padding: 0 24px 32px; }

  .section-title {
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--subtext);
    margin-bottom: 12px;
  }

  .device-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 16px;
  }

  .device-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px 20px;
    transition: border-color 0.2s, transform 0.15s;
    position: relative;
    overflow: hidden;
  }

  .device-card:hover { border-color: var(--accent); transform: translateY(-2px); }
  .device-card.online { border-left: 3px solid var(--primary); }
  .device-card.offline { border-left: 3px solid var(--danger); opacity: 0.65; }

  .device-card::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at top left, rgba(63,185,80,0.04) 0%, transparent 60%);
    pointer-events: none;
  }

  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 14px;
  }

  .device-name {
    font-weight: 600;
    font-size: 1rem;
  }

  .device-sub {
    font-size: 0.75rem;
    color: var(--subtext);
    margin-top: 2px;
    font-family: monospace;
  }

  .badge {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 20px;
    white-space: nowrap;
  }

  .badge-online { background: var(--primary-dim); color: var(--primary); border: 1px solid rgba(63,185,80,0.3); }
  .badge-offline { background: var(--danger-dim); color: var(--danger); border: 1px solid rgba(248,81,73,0.3); }

  .metrics {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 14px;
  }

  .metric {
    background: var(--surface2);
    border-radius: 8px;
    padding: 10px 12px;
  }

  .metric-val {
    font-size: 1.15rem;
    font-weight: 700;
    line-height: 1;
  }

  .metric-val.green { color: var(--primary); }
  .metric-val.blue { color: var(--accent); }
  .metric-val.warning { color: var(--warning); }

  .metric-label {
    font-size: 0.7rem;
    color: var(--subtext);
    margin-top: 3px;
  }

  .device-info {
    border-top: 1px solid var(--border);
    padding-top: 12px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  .info-row {
    display: flex;
    flex-direction: column;
  }

  .info-key {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--subtext);
  }

  .info-val {
    font-size: 0.8rem;
    font-weight: 500;
    font-family: monospace;
    margin-top: 1px;
  }

  .no-devices {
    grid-column: 1/-1;
    text-align: center;
    padding: 60px 20px;
    color: var(--subtext);
  }

  .no-devices .icon { font-size: 3rem; margin-bottom: 12px; }
  .no-devices h3 { font-size: 1rem; font-weight: 600; margin-bottom: 6px; color: var(--text); }
  .no-devices p { font-size: 0.85rem; line-height: 1.6; }

  .last-seen {
    font-size: 0.7rem;
    color: var(--subtext);
    margin-top: 8px;
    text-align: right;
  }

  .bms-indicator {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.72rem;
    padding: 2px 7px;
    border-radius: 20px;
    font-weight: 500;
  }

  .bms-connected { background: var(--primary-dim); color: var(--primary); }
  .bms-disconnected { background: var(--warning-dim); color: var(--warning); }

  .pulse {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  @media (max-width: 600px) {
    .stats-bar { grid-template-columns: 1fr; padding: 16px; }
    .device-grid { grid-template-columns: 1fr; }
    .content { padding: 0 16px 24px; }
  }
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-icon">🔋</div>
    <div>
      <h1>JK BMS Cloud</h1>
      <span>Quản lý thiết bị tập trung</span>
    </div>
  </div>
  <div class="header-right">
    <span class="refresh-badge" id="refresh-label">Đang tải...</span>
  </div>
</header>

<div class="stats-bar">
  <div class="stat-card">
    <div class="stat-icon green">📡</div>
    <div>
      <div class="stat-val" id="stat-online">—</div>
      <div class="stat-label">Thiết bị Online</div>
    </div>
  </div>
  <div class="stat-card">
    <div class="stat-icon red">⚠️</div>
    <div>
      <div class="stat-val" id="stat-offline">—</div>
      <div class="stat-label">Thiết bị Offline</div>
    </div>
  </div>
  <div class="stat-card">
    <div class="stat-icon blue">🔩</div>
    <div>
      <div class="stat-val" id="stat-total">—</div>
      <div class="stat-label">Tổng Thiết Bị</div>
    </div>
  </div>
</div>

<div class="content">
  <div class="section-title" style="margin-bottom:14px;">📋 Danh sách thiết bị</div>
  <div class="device-grid" id="device-grid">
    <div class="no-devices">
      <div class="icon">⏳</div>
      <h3>Đang tải dữ liệu...</h3>
    </div>
  </div>
</div>

<script>
  function timeSince(seconds) {
    if (seconds === null || seconds === undefined) return 'Chưa rõ';
    if (seconds < 60) return seconds + 's trước';
    if (seconds < 3600) return Math.floor(seconds/60) + ' phút trước';
    return Math.floor(seconds/3600) + ' giờ trước';
  }

  function formatUptime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN');
  }

  async function fetchDevices() {
    try {
      const res = await fetch('/api/devices');
      const devices = await res.json();

      const online = devices.filter(d => d.online).length;
      const offline = devices.length - online;

      document.getElementById('stat-online').textContent = online;
      document.getElementById('stat-offline').textContent = offline;
      document.getElementById('stat-total').textContent = devices.length;

      const now = new Date();
      document.getElementById('refresh-label').textContent = 'Cập nhật: ' + now.toLocaleTimeString('vi-VN');

      const grid = document.getElementById('device-grid');

      if (devices.length === 0) {
        grid.innerHTML = \`<div class="no-devices">
          <div class="icon">📡</div>
          <h3>Chưa có thiết bị nào đăng ký</h3>
          <p>Các thiết bị ESP32-C3 JK-BMS sẽ tự động xuất hiện tại đây<br>khi kết nối Wi-Fi thành công lần đầu.</p>
        </div>\`;
        return;
      }

      grid.innerHTML = devices.map(d => {
        const statusClass = d.online ? 'online' : 'offline';
        const badge = d.online
          ? '<span class="badge badge-online"><span class="pulse"></span> Online</span>'
          : '<span class="badge badge-offline">Offline</span>';

        const bmsStatus = d.connected
          ? '<span class="bms-indicator bms-connected"><span class="pulse"></span> BMS kết nối</span>'
          : '<span class="bms-indicator bms-disconnected">⚡ BMS chờ</span>';

        const voltage = (d.voltage || 0).toFixed(1);
        const current = (d.current || 0).toFixed(1);
        const soc = d.soc || 0;
        const temp = (d.mos_temp || 0).toFixed(1);

        const socColor = soc > 50 ? 'green' : soc > 20 ? 'warning' : 'danger';

        return \`<div class="device-card \${statusClass}">
          <div class="card-header">
            <div>
              <div class="device-name">📟 \${d.device_id}</div>
              <div class="device-sub">MAC: \${d.mac || '—'}</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;">
              \${badge}
              \${bmsStatus}
            </div>
          </div>

          <div class="metrics">
            <div class="metric">
              <div class="metric-val blue">\${voltage} V</div>
              <div class="metric-label">Điện áp Pack</div>
            </div>
            <div class="metric">
              <div class="metric-val \${socColor}">\${soc} %</div>
              <div class="metric-label">SoC Pin</div>
            </div>
            <div class="metric">
              <div class="metric-val">\${current} A</div>
              <div class="metric-label">Dòng điện</div>
            </div>
            <div class="metric">
              <div class="metric-val warning">\${temp} °C</div>
              <div class="metric-label">Nhiệt độ MOS</div>
            </div>
          </div>

          <div class="device-info">
            <div class="info-row">
              <span class="info-key">IP Local</span>
              <span class="info-val">\${d.local_ip || '—'}</span>
            </div>
            <div class="info-row">
              <span class="info-key">Wi-Fi</span>
              <span class="info-val">\${d.ssid || '—'}</span>
            </div>
            <div class="info-row">
              <span class="info-key">Hostname</span>
              <span class="info-val">\${d.hostname || '—'}.local</span>
            </div>
            <div class="info-row">
              <span class="info-key">Firmware</span>
              <span class="info-val">v\${d.firmware_version || '—'}</span>
            </div>
          </div>

          <div class="last-seen">🕐 \${d.online ? 'Hoạt động ' : 'Offline từ '}\${timeSince(d.lastSeenAgo)}</div>
        </div>\`;
      }).join('');

    } catch(e) {
      document.getElementById('refresh-label').textContent = 'Lỗi kết nối server!';
    }
  }

  fetchDevices();
  setInterval(fetchDevices, 10000);
</script>

</body>
</html>`;
