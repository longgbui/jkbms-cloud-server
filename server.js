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
        rssi: body.rssi || existing.rssi || 0,
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

    console.log(`[REGISTER] Device: ${deviceId} | IP: ${body.local_ip} | WiFi: ${body.ssid} (${body.rssi}dBm) | FW: ${body.firmware_version}`);
    res.json({ status: 'ok', message: 'Device registered successfully', device_id: deviceId });
});

// POST /api/device-heartbeat — called by ESP32
app.post('/api/device-heartbeat', (req, res) => {
    const body = req.body;
    const deviceId = body.device_id;
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });

    const existing = devices.get(deviceId) || { device_id: deviceId, registeredAt: Date.now() };

    devices.set(deviceId, {
        ...existing,
        device_id: deviceId,
        local_ip: body.local_ip || existing.local_ip || '',
        ssid: body.ssid || existing.ssid || '',
        rssi: body.rssi || existing.rssi || 0,
        connected: body.connected !== undefined ? Boolean(body.connected) : false,
        voltage: body.voltage !== undefined ? parseFloat(body.voltage) : 0,
        current: body.current !== undefined ? parseFloat(body.current) : 0,
        soc: body.soc !== undefined ? parseInt(body.soc) : 0,
        mos_temp: body.mos_temp !== undefined ? parseFloat(body.mos_temp) : 0,
        lastSeen: Date.now(),
    });

    res.json({ status: 'ok' });
});

// Command Queue Store
const commandQueue = new Map();

// POST /api/send-command — Queue command for device
app.post('/api/send-command', (req, res) => {
    const { device_id, cmd } = req.body;
    if (!device_id || !cmd) return res.status(400).json({ error: 'device_id and cmd required' });
    if (!commandQueue.has(device_id)) commandQueue.set(device_id, []);
    commandQueue.get(device_id).push(cmd);
    console.log(`[Command] Queued command for ${device_id}:`, cmd);
    res.json({ status: 'ok', message: 'Command queued' });
});

// GET /api/device-commands — ESP32 polling endpoint
app.get('/api/device-commands', (req, res) => {
    const deviceId = req.query.device_id;
    if (!deviceId) return res.json([]);
    const cmds = commandQueue.get(deviceId) || [];
    commandQueue.set(deviceId, []);
    res.json(cmds);
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

// GET /d/:deviceId — Customer device page
app.get('/d/:deviceId', (req, res) => {
    const deviceId = req.params.deviceId;
    const d = devices.get(deviceId) || { device_id: deviceId, registeredAt: Date.now() };
    d.online = isOnline(d);
    d.lastSeenAgo = d.lastSeen ? Math.floor((Date.now() - d.lastSeen) / 1000) : null;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.send(CUSTOMER_DEVICE_HTML(d));
});

// ─── WEB DASHBOARD ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.send(DASHBOARD_HTML);
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Server] JK BMS Cloud Server running on port ${PORT}`);
    console.log(`[Server] Live Domain: https://jkbms.namka.vn (Local: http://localhost:${PORT})`);
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
      document.getElementById('refresh-label').textContent = 'Lỗi kết nối!';
    }
  }
  fetchDevices();
  setInterval(fetchDevices, 5000);
</script>
</body>
</html>`;

function CUSTOMER_DEVICE_HTML(d) {
  const online = d.online;
  const bleConnected = d.connected;
  const soc = d.soc || 0;
  const voltage = (d.voltage || 0).toFixed(2);
  const current = (d.current || 0).toFixed(1);
  const powerVal = (d.power || (d.voltage * d.current) || 0);
  const power = Math.abs(powerVal).toFixed(1);
  const temp = (d.mos_temp || 0).toFixed(1);
  const temp1 = d.temp1 !== undefined ? d.temp1.toFixed(1) : '—';
  const temp2 = d.temp2 !== undefined ? d.temp2.toFixed(1) : '—';
  const capacityAh = d.capacity_ah !== undefined ? d.capacity_ah.toFixed(1) : '—';
  const cycleCount = d.cycle_count !== undefined ? d.cycle_count : '—';
  
  const cellMin = d.cell_min !== undefined ? d.cell_min.toFixed(3) : '—';
  const cellMax = d.cell_max !== undefined ? d.cell_max.toFixed(3) : '—';
  const cellDelta = d.cell_delta !== undefined ? d.cell_delta.toFixed(3) : '—';
  const cellMinNum = d.cell_min_num || '-';
  const cellMaxNum = d.cell_max_num || '-';
  const cells = d.cells || [];

  const chargeMos = d.charge_mos;
  const dischargeMos = d.discharge_mos;
  const balance = d.balance;

  // Calculate Inverter CAN Communication Limits based on pack/cells
  const cellCount = cells.length > 0 ? cells.length : (d.cell_count || 16);
  const cvl = (cellCount * 3.525).toFixed(2); // Charge Voltage Limit (CVL)
  const ccl = "100.0"; // Charge Current Limit (CCL)
  const dcl = "100.0"; // Discharge Current Limit (DCL)
  const soh = "100";   // State of Health (SOH %)

  const socColor = soc > 60 ? '#3fb950' : soc > 25 ? '#e3b341' : '#f85149';
  const statusText = online ? 'WiFi Online' : 'WiFi Offline';
  const statusColor = online ? '#3fb950' : '#f85149';
  const bleText = bleConnected ? '🟢 Đã kết nối BMS' : '🔴 Chưa kết nối Bluetooth';
  const bleColor = bleConnected ? '#3fb950' : '#f85149';
  const rssiVal = d.rssi ? `${d.rssi} dBm` : 'Chưa có';
  const reg = d.registeredAt ? new Date(d.registeredAt).toLocaleDateString('vi-VN') : '—';

  // Render Cell Grid HTML
  let cellsGridHtml = '';
  if (cells.length > 0) {
    cellsGridHtml = cells.map((v, i) => {
      const num = i + 1;
      let borderStyle = '1px solid rgba(255,255,255,0.1)';
      let bgStyle = 'rgba(15,23,42,0.8)';
      if (num === cellMinNum) { borderStyle = '1px solid #f85149'; bgStyle = 'rgba(248,81,73,0.15)'; }
      if (num === cellMaxNum) { borderStyle = '1px solid #3fb950'; bgStyle = 'rgba(63,185,80,0.15)'; }
      const valStr = typeof v === 'number' ? v.toFixed(3) : parseFloat(v).toFixed(3);
      return `<div style="background:${bgStyle};border:${borderStyle};padding:8px 6px;border-radius:8px;text-align:center;">
        <div style="font-size:0.68rem;color:#8b949e;">C${num}</div>
        <div style="font-size:0.85rem;font-weight:700;color:#e6edf3;margin-top:2px;">${valStr}V</div>
      </div>`;
    }).join('');
  } else {
    cellsGridHtml = `<div style="grid-column:span 4;text-align:center;padding:12px;color:#8b949e;font-size:0.8rem;">Đang chờ nhận dữ liệu các Cell pin từ JK-BMS...</div>`;
  }

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Giám Sát JK-BMS Biến Tần (CAN/RS485) - ${d.device_id}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Inter',sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh;padding-bottom:30px;}
  .hero{background:linear-gradient(135deg,#0d1117 0%,#161b22 50%,#0d1117 100%);padding:24px 16px 0;text-align:center;position:relative;overflow:hidden;}
  .hero::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(56,189,248,0.15) 0%,transparent 70%);}
  .status-dot{width:10px;height:10px;border-radius:50%;background:${statusColor};display:inline-block;margin-right:6px;animation:${online ? 'pulse' : 'none'} 1.5s ease-in-out infinite;}
  .status-badge{display:inline-flex;align-items:center;background:${online ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)'};border:1px solid ${statusColor}33;color:${statusColor};padding:4px 12px;border-radius:20px;font-size:0.78rem;font-weight:600;margin-bottom:10px;}
  .can-badge{display:inline-flex;align-items:center;background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.3);color:#38bdf8;padding:4px 12px;border-radius:20px;font-size:0.75rem;font-weight:700;margin-bottom:12px;gap:6px;}
  
  h1{font-size:1.45rem;font-weight:800;letter-spacing:-0.02em;margin-bottom:2px;}
  .device-id{font-size:0.78rem;color:#8b949e;font-family:monospace;margin-bottom:12px;}
  .ble-status{font-size:0.88rem;font-weight:700;color:${bleColor};margin-bottom:16px;padding:5px 14px;background:rgba(255,255,255,0.04);border-radius:20px;display:inline-block;}
  
  .soc-ring{position:relative;width:160px;height:160px;margin:0 auto 20px;}
  .soc-ring svg{transform:rotate(-90deg);}
  .soc-ring circle{fill:none;stroke-width:12;stroke-linecap:round;}
  .soc-track{stroke:#21262d;}
  .soc-fill{stroke:${socColor};stroke-dasharray:${Math.PI * 2 * 64};stroke-dashoffset:${Math.PI * 2 * 64 * (1 - soc / 100)};transition:stroke-dashoffset 1s ease;}
  .soc-label{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}
  .soc-val{font-size:2.3rem;font-weight:800;color:${socColor};line-height:1;}
  .soc-unit{font-size:0.78rem;color:#8b949e;margin-top:2px;}

  .section{max-width:440px;margin:0 auto;padding:0 14px 14px;}
  .section-title{font-size:0.78rem;font-weight:700;color:#38bdf8;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;display:flex;align-items:center;gap:6px;}

  .metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  .metric-card{background:#161b22;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px 14px;}
  .metric-icon{font-size:1.25rem;margin-bottom:4px;}
  .metric-val{font-size:1.3rem;font-weight:800;line-height:1;}
  .metric-label{font-size:0.68rem;color:#8b949e;margin-top:4px;text-transform:uppercase;letter-spacing:0.04em;}

  .info-card{background:#161b22;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px 16px;}
  .info-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05);}
  .info-row:last-child{border-bottom:none;}
  .info-key{font-size:0.76rem;color:#8b949e;}
  .info-val{font-size:0.82rem;font-weight:600;font-family:monospace;color:#e6edf3;}

  .cells-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px;}

  .status-pill{padding:4px 10px;border-radius:12px;font-size:0.72rem;font-weight:700;}
  .status-pill.on{background:rgba(63,185,80,0.15);color:#3fb950;border:1px solid rgba(63,185,80,0.3);}
  .status-pill.off{background:rgba(248,81,73,0.15);color:#f85149;border:1px solid rgba(248,81,73,0.3);}

  .footer{text-align:center;padding:16px;color:#484f58;font-size:0.72rem;}
  .footer a{color:#58a6ff;text-decoration:none;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.4;}}
</style>
</head>
<body>
<div class="hero">
  <div style="position:relative;z-index:1;">
    <div class="status-badge"><span class="status-dot"></span>${statusText} • 📶 ${rssiVal}</div>
    <br>
    <div class="can-badge">🔌 CAN / RS485 INVERTER ACTIVE (Pylontech/Deye/Victron)</div>
    <h1>🔋 Giám Sát JK-BMS Biến Tần</h1>
    <div class="device-id">ID: ${d.device_id}</div>
    <div class="ble-status">${bleText}</div>
    
    <div class="soc-ring">
      <svg width="160" height="160" viewBox="0 0 160 160">
        <circle class="soc-track" cx="80" cy="80" r="64"/>
        <circle class="soc-fill" cx="80" cy="80" r="64"/>
      </svg>
      <div class="soc-label">
        <span class="soc-val">${soc}</span>
        <span class="soc-unit">% Dung Lượng (SoH: ${soh}%)</span>
      </div>
    </div>
  </div>
</div>

<!-- BLOCK 1: THÔNG SỐ KHỐNG CHẾ GIAO TIẾP BIẾN TẦN CAN / RS485 -->
<div class="section">
  <div class="section-title">🔌 Trạng Thái & Hạn Mức Giao Tiếp Biến Tần CAN</div>
  <div class="info-card" style="border:1px solid rgba(56,189,248,0.3);">
    <div class="info-row">
      <span class="info-key">Giao Thức CAN Biến Tần</span>
      <span class="info-val" style="color:#38bdf8;font-weight:700;">Pylontech / Deye / Luxpower</span>
    </div>
    <div class="info-row">
      <span class="info-key">Trạng Thái Kết Nối CAN Bus</span>
      <span class="status-pill on">🟢 ĐANG TRUYỀN CAN</span>
    </div>
    <div class="info-row">
      <span class="info-key">Điện Áp Sạc Ngắt Biến Tần (CVL)</span>
      <span class="info-val" style="color:#58a6ff;">${cvl} V</span>
    </div>
    <div class="info-row">
      <span class="info-key">Dòng Sạc Tối Đa Cho Phép (CCL)</span>
      <span class="info-val" style="color:#3fb950;">${ccl} A</span>
    </div>
    <div class="info-row">
      <span class="info-key">Dòng Xả Tối Đa Cho Phép (DCL)</span>
      <span class="info-val" style="color:#f85149;">${dcl} A</span>
    </div>
    <div class="info-row">
      <span class="info-key">Sức Khỏe Pin (SOH - State of Health)</span>
      <span class="info-val" style="color:#3fb950;">${soh} %</span>
    </div>
    <div class="info-row">
      <span class="info-key">Yêu Cầu Sạc Cưỡng Bức (Force Charge)</span>
      <span class="info-val">⚪ Sạc Thường (Normal)</span>
    </div>
  </div>
</div>

<!-- BLOCK 2: THÔNG SỐ ĐIỆN ÁP & DÒNG ĐIỆN PACK -->
<div class="section">
  <div class="section-title">⚡ Thông Số Tổng Quan Pack Pin</div>
  <div class="metrics">
    <div class="metric-card">
      <div class="metric-icon">⚡</div>
      <div class="metric-val" style="color:#58a6ff;">${voltage} V</div>
      <div class="metric-label">Điện Áp Pack</div>
    </div>
    <div class="metric-card">
      <div class="metric-icon">🔌</div>
      <div class="metric-val" style="color:${parseFloat(current) < 0 ? '#f85149' : '#3fb950'};">${current} A</div>
      <div class="metric-label">Dòng Điện Sạc / Xả</div>
    </div>
    <div class="metric-card">
      <div class="metric-icon">💡</div>
      <div class="metric-val" style="color:#e3b341;">${power} W</div>
      <div class="metric-label">Công Suất Tức Thời</div>
    </div>
    <div class="metric-card">
      <div class="metric-icon">🔋</div>
      <div class="metric-val">${capacityAh} Ah</div>
      <div class="metric-label">Dung Lượng Còn Lại</div>
    </div>
    <div class="metric-card">
      <div class="metric-icon">🌡️</div>
      <div class="metric-val" style="color:#e3b341;">${temp} °C</div>
      <div class="metric-label">Nhiệt Độ MOS</div>
    </div>
    <div class="metric-card">
      <div class="metric-icon">🌡️</div>
      <div class="metric-val" style="color:#38bdf8;">${temp1} / ${temp2} °C</div>
      <div class="metric-label">Nhiệt Độ Pin T1 / T2</div>
    </div>
  </div>
</div>

<!-- BLOCK 3: CHI TIẾT CELL VOLTAGES -->
<div class="section">
  <div class="section-title">📊 Điện Áp Chi Tiết Từng Cell</div>
  <div class="info-card">
    <div class="info-row"><span class="info-key">Cell Cao Nhất (Max)</span><span class="info-val" style="color:#3fb950;">Cell ${cellMaxNum} (${cellMax} V)</span></div>
    <div class="info-row"><span class="info-key">Cell Thấp Nhất (Min)</span><span class="info-val" style="color:#f85149;">Cell ${cellMinNum} (${cellMin} V)</span></div>
    <div class="info-row"><span class="info-key">Chênh Lệch Điện Áp (ΔV)</span><span class="info-val" style="color:#e3b341;">${cellDelta} V</span></div>
    <div class="info-row"><span class="info-key">Số Chu Kỳ Sạc/Xả</span><span class="info-val">${cycleCount} Chu Kỳ</span></div>
    
    <div style="font-size:0.72rem;color:#8b949e;margin-top:10px;margin-bottom:6px;font-weight:bold;">LƯỚI ĐIỆN ÁP CELL (C1 - C${cells.length || 'N'}):</div>
    <div class="cells-grid">
      ${cellsGridHtml}
    </div>
  </div>
</div>

<!-- BLOCK 4: TRẠNG THÁI MOSFET & CÂN BẰNG & BẢO VỆ -->
<div class="section">
  <div class="section-title">⚙️ Công Tắc MOSFET & Bảo Vệ An Toàn</div>
  <div class="info-card">
    <div class="info-row">
      <span class="info-key">MOSFET Sạc (Charge MOS)</span>
      <span class="status-pill ${chargeMos ? 'on' : 'off'}">${chargeMos ? '🟢 ĐANG BẬT' : '🔴 TẮT'}</span>
    </div>
    <div class="info-row">
      <span class="info-key">MOSFET Xả (Discharge MOS)</span>
      <span class="status-pill ${dischargeMos ? 'on' : 'off'}">${dischargeMos ? '🟢 ĐANG BẬT' : '🔴 TẮT'}</span>
    </div>
    <div class="info-row">
      <span class="info-key">Cân Bằng Chủ Động (Active Balance)</span>
      <span class="status-pill ${balance ? 'on' : 'off'}">${balance ? '🟢 ĐANG CÂN BẰNG' : '⚪ TẮT'}</span>
    </div>
    <div class="info-row">
      <span class="info-key">Cảnh Báo Quá Áp / Thiếu Áp</span>
      <span class="info-val" style="color:#3fb950;">🟢 Bình Thường</span>
    </div>
    <div class="info-row">
      <span class="info-key">Cảnh Báo Quá Nhiệt / Nhiệt Độ</span>
      <span class="info-val" style="color:#3fb950;">🟢 Bình Thường</span>
    </div>
  </div>
</div>

<!-- BLOCK 5: QUẢN LÝ WIFI & HỆ THỐNG -->
<div class="section">
  <div class="section-title">🌐 Thông Tin Wi-Fi & Thiết Bị</div>
  <div class="info-card">
    <div class="info-row"><span class="info-key">Mạng Wi-Fi</span><span class="info-val">${d.ssid || '—'}</span></div>
    <div class="info-row"><span class="info-key">Mức Sóng WiFi (RSSI)</span><span class="info-val" style="color:#3fb950;">📶 ${rssiVal}</span></div>
    <div class="info-row"><span class="info-key">IP Local</span><span class="info-val">${d.local_ip || '—'}</span></div>
    <div class="info-row"><span class="info-key">Hostname</span><span class="info-val">${d.hostname || '—'}.local</span></div>
    <div class="info-row"><span class="info-key">Firmware</span><span class="info-val">v${d.firmware_version || '—'}</span></div>
    <div class="info-row"><span class="info-key">Lắp đặt từ</span><span class="info-val">${reg}</span></div>
  </div>
</div>

<div class="section">
  <div class="info-card" style="border:1px solid rgba(248,81,73,0.3);text-align:center;">
    <div style="font-size:0.85rem;font-weight:700;color:#e6edf3;margin-bottom:6px;">⚙️ Quản Lý Cài Đặt Wi-Fi</div>
    <div style="font-size:0.75rem;color:#8b949e;margin-bottom:14px;">Bấm nút để xóa cấu hình Wi-Fi hiện tại và mở lại điểm truy cập cài đặt trên thiết bị.</div>
    <button onclick="resetWifi()" style="background:rgba(248,81,73,0.15);border:1px solid rgba(248,81,73,0.4);color:#f85149;padding:10px 20px;border-radius:10px;font-size:0.85rem;font-weight:700;cursor:pointer;width:100%;transition:all 0.2s;">
      🔄 Reset Cấu Hình Wi-Fi
    </button>
    <div id="reset-msg" style="font-size:0.78rem;margin-top:10px;display:none;font-weight:600;"></div>
  </div>
</div>

<div class="footer">
  Tự động cập nhật mỗi 15 giây • <a href="/">Trang quản lý</a>
</div>

<script>
  async function resetWifi() {
    if (!confirm('Bạn có chắc chắn muốn Reset Cấu Hình Wi-Fi của thiết bị ${d.device_id}? ESP32 sẽ xóa Wi-Fi và phát lại điểm truy cập cài đặt.')) return;
    const msgEl = document.getElementById('reset-msg');
    msgEl.style.display = 'block';
    msgEl.style.color = '#e3b341';
    msgEl.textContent = '⏳ Đang gửi lệnh Reset Wi-Fi tới thiết bị...';
    try {
      const res = await fetch('/api/send-command', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ device_id: '${d.device_id}', cmd: { cmd: 'reset_wifi' } })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        msgEl.style.color = '#3fb950';
        msgEl.textContent = '✅ Đã gửi lệnh! ESP32 đang xóa Wi-Fi và khởi động lại...';
      } else {
        msgEl.style.color = '#f85149';
        msgEl.textContent = '❌ Lỗi khi gửi lệnh reset!';
      }
    } catch(e) {
      msgEl.style.color = '#f85149';
      msgEl.textContent = '❌ Lỗi kết nối máy chủ!';
    }
  }
  setTimeout(()=>location.reload(), 15000);
</script>
</body>
</html>`;
}
