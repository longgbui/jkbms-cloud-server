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
const bleScanResults = new Map();

// POST /api/send-command — Queue command for device
app.post('/api/send-command', (req, res) => {
    const { device_id, cmd } = req.body;
    if (!device_id || !cmd) return res.status(400).json({ error: 'device_id and cmd required' });
    if (!commandQueue.has(device_id)) commandQueue.set(device_id, []);
    const cmdArr = Array.isArray(cmd) ? cmd : [cmd];
    for (const c of cmdArr) {
        commandQueue.get(device_id).push(c);
        if (c && c.cmd === 'scan_ble') {
            bleScanResults.delete(device_id);
        }
    }
    console.log(`[Command] Queued command for ${device_id}:`, cmd);
    res.json({ status: 'ok', message: 'Command queued' });
});

// GET & POST /api/device-commands — ESP32 polling endpoint
const handleDeviceCommands = (req, res) => {
    const deviceId = req.query.device_id || (req.body && req.body.device_id);
    if (!deviceId) return res.json([]);
    const cmds = commandQueue.get(deviceId) || [];
    commandQueue.set(deviceId, []);
    res.json(cmds);
};
app.get('/api/device-commands', handleDeviceCommands);
app.post('/api/device-commands', handleDeviceCommands);

// POST /api/ble-result — ESP32 pushes BLE scan results
app.post('/api/ble-result', (req, res) => {
    const { device_id, devices } = req.body;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    bleScanResults.set(device_id, { devices: devices || [], updatedAt: Date.now() });
    console.log(`[BLE Scan] Received ${(devices || []).length} devices from ${device_id}`);
    res.json({ status: 'ok', count: (devices || []).length });
});

// GET /api/scanned-ble — Web queries scan results
app.get('/api/scanned-ble', (req, res) => {
    const deviceId = req.query.device_id;
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });
    const r = bleScanResults.get(deviceId) || { devices: [], updatedAt: 0 };
    res.json(r);
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
  const bleConnected = d.connected && d.voltage > 0;
  
  const soc = bleConnected ? (d.soc !== undefined ? d.soc : '—') : '—';
  const voltage = bleConnected ? (d.voltage ? d.voltage.toFixed(2) : '—') : '—';
  const current = bleConnected ? (d.current !== undefined ? d.current.toFixed(2) : '—') : '—';
  const power = bleConnected ? (d.power !== undefined ? Math.abs(d.power).toFixed(1) : (d.voltage && d.current ? Math.abs(d.voltage * d.current).toFixed(1) : '—')) : '—';
  const mosTemp = bleConnected ? (d.mos_temp !== undefined ? d.mos_temp.toFixed(1) : '—') : '—';
  const temp1 = bleConnected ? (d.temp1 !== undefined ? d.temp1.toFixed(1) : '—') : '—';
  const temp2 = bleConnected ? (d.temp2 !== undefined ? d.temp2.toFixed(1) : '—') : '—';
  const temp4 = '—';
  const temp5 = '—';
  const capacityAh = bleConnected ? (d.capacity_ah !== undefined ? d.capacity_ah.toFixed(1) : '—') : '—';
  const totalCapacity = bleConnected ? (d.total_capacity !== undefined ? d.total_capacity.toFixed(1) : '—') : '—';
  const cycleCount = bleConnected ? (d.cycle_count !== undefined ? d.cycle_count : '—') : '—';
  const cycleCapacity = bleConnected ? (d.cycle_capacity !== undefined ? d.cycle_capacity.toFixed(1) : '—') : '—';
  
  const cellMin = bleConnected ? (d.cell_min !== undefined ? d.cell_min.toFixed(3) : '—') : '—';
  const cellMax = bleConnected ? (d.cell_max !== undefined ? d.cell_max.toFixed(3) : '—') : '—';
  const cellDelta = bleConnected ? (d.cell_delta !== undefined ? d.cell_delta.toFixed(3) : '—') : '—';
  const aveCellVolt = bleConnected && d.voltage && d.cells && d.cells.length > 0 ? (d.voltage / d.cells.length).toFixed(3) : '—';
  const cellMinNum = d.cell_min_num || '—';
  const cellMaxNum = d.cell_max_num || '—';
  const cells = d.cells || [];
  const wireRes = d.wire_res || [];

  const chargeMos = bleConnected ? (d.charge_mos !== undefined ? d.charge_mos : false) : false;
  const dischargeMos = bleConnected ? (d.discharge_mos !== undefined ? d.discharge_mos : false) : false;
  const balance = bleConnected ? (d.balance !== undefined ? d.balance : false) : false;

  const statusText = online ? 'WiFi Online' : 'WiFi Offline';
  const statusColor = online ? '#3fb950' : '#f85149';
  const bleText = bleConnected ? '🟢 Bluetooth Đã Kết Nối' : '🔴 Bluetooth Chưa Kết Nối BMS';
  const bleColor = bleConnected ? '#3fb950' : '#f85149';
  const rssiVal = d.rssi ? `${d.rssi} dBm` : 'Chưa có';
  const reg = d.registeredAt ? new Date(d.registeredAt).toLocaleDateString('vi-VN') : '—';

  // Render Cell Voltage Items
  let cellItemsHtml = '';
  if (bleConnected && cells.length > 0) {
    cellItemsHtml = cells.map((v, i) => {
      const num = (i + 1).toString().padStart(2, '0');
      let color = '#3fb950';
      if (i + 1 === cellMinNum) color = '#f85149';
      const valStr = (typeof v === 'number' ? v : parseFloat(v)).toFixed(3);
      return `<div class="cell-box"><span class="c-num">${num}</span><span class="c-val" style="color:${color};">${valStr}<sup>V</sup></span></div>`;
    }).join('');
  } else {
    cellItemsHtml = '<div style="grid-column:1/-1;text-align:center;padding:16px;color:#8b949e;font-size:0.8rem;background:#081312;border-radius:8px;">⏳ Đang chờ kết nối Bluetooth để đọc dữ liệu Cell...</div>';
  }

  // Render Wire Resistance Items
  let wireItemsHtml = '';
  if (bleConnected && wireRes.length > 0) {
    wireItemsHtml = wireRes.map((r, i) => {
      const num = (i + 1).toString().padStart(2, '0');
      return `<div class="cell-box"><span class="c-num">${num}</span><span class="c-val" style="color:#3fb950;">${r.toFixed(3)}<sup>Ω</sup></span></div>`;
    }).join('');
  } else {
    wireItemsHtml = '<div style="grid-column:1/-1;text-align:center;padding:16px;color:#8b949e;font-size:0.8rem;background:#081312;border-radius:8px;">⏳ Đang chờ kết nối Bluetooth để đo điện trở cáp...</div>';
  }

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>JK-BMS Monitoring System - ${d.device_id}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Inter',sans-serif;background:#0d1414;color:#e6edf3;min-height:100vh;padding-bottom:70px;}
  
  .header-bar{background:#081010;border-bottom:1px solid #162624;padding:8px 14px;display:flex;align-items:center;justify-content:space-between;font-size:0.75rem;color:#8b949e;font-weight:600;}
  .header-switches{display:flex;gap:12px;color:#3fb950;font-family:monospace;}
  .header-switches span{display:inline-flex;align-items:center;gap:4px;}

  .hero-panel{background:linear-gradient(180deg,#0a1615 0%,#0d1c1a 100%);padding:18px 16px 14px;border-bottom:1px solid #19332e;text-align:center;}
  .hero-main{display:flex;justify-content:space-around;align-items:baseline;max-width:380px;margin:0 auto 10px;}
  .hero-val-v{font-family:'Share Tech Mono',monospace;font-size:2.8rem;font-weight:700;color:#3fb950;letter-spacing:-1px;}
  .hero-val-v sup{font-size:1.2rem;top:-1em;}
  .hero-val-a{font-family:'Share Tech Mono',monospace;font-size:2.8rem;font-weight:700;color:#3fb950;letter-spacing:-1px;}
  .hero-val-a sup{font-size:1.2rem;top:-1em;}

  .nav-tabs{display:flex;background:#060d0d;border-bottom:1px solid #162624;position:sticky;top:0;z-index:100;}
  .tab-btn{flex:1;padding:12px 0;text-align:center;font-size:0.82rem;font-weight:700;color:#8b949e;border:none;background:none;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.2s;}
  .tab-btn.active{color:#3fb950;border-bottom-color:#3fb950;background:rgba(63,185,80,0.06);}

  .tab-content{display:none;max-width:440px;margin:0 auto;padding:14px;}
  .tab-content.active{display:block;}

  .data-list{background:#0a1615;border:1px solid #162a26;border-radius:12px;padding:6px 14px;margin-bottom:14px;}
  .data-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.82rem;}
  .data-row:last-child{border-bottom:none;}
  .data-key{color:#94a3b8;font-weight:500;}
  .data-val{font-family:'Share Tech Mono',monospace;color:#3fb950;font-weight:700;}

  .section-header{font-size:0.85rem;font-weight:800;color:#38bdf8;text-align:center;margin:16px 0 10px;text-transform:uppercase;letter-spacing:0.05em;}

  .cells-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;}
  .cell-box{background:#081312;border:1px solid #152b27;border-radius:8px;padding:7px 8px;display:flex;align-items:center;justify-content:space-between;}
  .c-num{font-size:0.75rem;font-weight:700;color:#38bdf8;background:rgba(56,189,248,0.12);padding:2px 6px;border-radius:4px;font-family:monospace;}
  .c-val{font-family:'Share Tech Mono',monospace;font-size:0.88rem;font-weight:700;}
  .c-val sup{font-size:0.65rem;}

  .setting-group-title{font-size:0.8rem;font-weight:800;color:#38bdf8;text-align:center;margin:12px 0 8px;text-transform:uppercase;}
  .setting-row{display:flex;justify-content:space-between;align-items:center;background:#0a1615;border:1px solid #162a26;border-radius:8px;padding:8px 12px;margin-bottom:6px;font-size:0.8rem;}
  .setting-key{color:#94a3b8;}
  .setting-box{display:flex;align-items:center;gap:6px;}
  .setting-val{background:#060e0d;border:1px solid #1b3833;border-radius:6px;padding:4px 10px;color:#3fb950;font-family:monospace;font-weight:700;min-width:70px;text-align:right;}
  .setting-ok{font-size:0.68rem;color:#3fb950;border:1px solid rgba(63,185,80,0.4);padding:3px 6px;border-radius:4px;}

  .btn-reset{background:rgba(248,81,73,0.15);border:1px solid rgba(248,81,73,0.4);color:#f85149;padding:12px;border-radius:10px;font-size:0.85rem;font-weight:700;cursor:pointer;width:100%;transition:all 0.2s;}

  .footer-nav{position:fixed;bottom:0;left:0;right:0;background:#060d0d;border-top:1px solid #162624;display:flex;justify-content:space-around;padding:8px 0;z-index:200;}
  .f-btn{display:flex;flex-direction:column;align-items:center;color:#8b949e;font-size:0.68rem;font-weight:600;text-decoration:none;cursor:pointer;border:none;background:none;}
  .f-btn.active{color:#3fb950;}
  .f-icon{font-size:1.2rem;margin-bottom:2px;}
</style>
</head>
<body>

<div class="header-bar">
  <div class="header-switches">
    <span>Charge: <strong style="color:${chargeMos?'#3fb950':'#f85149'}">${chargeMos?'ON':'OFF'}</strong></span>
    <span>Discharge: <strong style="color:${dischargeMos?'#3fb950':'#f85149'}">${dischargeMos?'ON':'OFF'}</strong></span>
    <span>Balance: <strong style="color:${balance?'#3fb950':'#f85149'}">${balance?'ON':'OFF'}</strong></span>
  </div>
  <div style="font-family:monospace;font-size:0.7rem;color:#38bdf8;">TIME: 1Y229D14H17M</div>
</div>

<div class="hero-panel">
  <div class="hero-main">
    <div class="hero-val-v">${voltage}<sup>V</sup></div>
    <div class="hero-val-a">${current}<sup>A</sup></div>
  </div>
  <div style="font-size:0.75rem;color:#8b949e;display:flex;justify-content:center;gap:14px;font-weight:600;">
    <span>📶 WiFi: <strong style="color:#3fb950;">${statusText}</strong></span>
    <span>ID: <strong style="color:#e6edf3;">${d.device_id}</strong></span>
    <span>RSSI: <strong style="color:#38bdf8;">${rssiVal}</strong></span>
  </div>
</div>

<!-- TABS NAVIGATION -->
<div class="nav-tabs">
  <button class="tab-btn active" onclick="showTab('status')">📊 Status</button>
  <button class="tab-btn" onclick="showTab('settings')">⚙️ Settings</button>
  <button class="tab-btn" onclick="showTab('control')">🎛️ Control</button>
</div>

<!-- TAB 1: STATUS -->
<div id="tab-status" class="tab-content active">
  <div class="data-list">
    <div class="data-row"><span class="data-key">Battery Power:</span><span class="data-val">${power} W</span></div>
    <div class="data-row"><span class="data-key">Ave. Cell Volt.:</span><span class="data-val">${aveCellVolt} V</span></div>
    <div class="data-row"><span class="data-key">Battery Capacity:</span><span class="data-val">${totalCapacity} Ah</span></div>
    <div class="data-row"><span class="data-key">Cell Volt. Diff.:</span><span class="data-val" style="color:#e3b341;">${cellDelta} V</span></div>
    <div class="data-row"><span class="data-key">Remain Capacity:</span><span class="data-val">${capacityAh} Ah</span></div>
    <div class="data-row"><span class="data-key">Balance Curr.:</span><span class="data-val">-1.703 A</span></div>
    <div class="data-row"><span class="data-key">Remain Battery:</span><span class="data-val" style="color:#3fb950;">${soc} %</span></div>
    <div class="data-row"><span class="data-key">MOS Temp.:</span><span class="data-val" style="color:#e3b341;">${mosTemp} °C</span></div>
    <div class="data-row"><span class="data-key">Cycle Count:</span><span class="data-val">${cycleCount}</span></div>
    <div class="data-row"><span class="data-key">Cycle Capacity:</span><span class="data-val">${cycleCapacity} Ah</span></div>
    <div class="data-row"><span class="data-key">Battery T1:</span><span class="data-val" style="color:#38bdf8;">${temp1} °C</span></div>
    <div class="data-row"><span class="data-key">Battery T2:</span><span class="data-val" style="color:#38bdf8;">${temp2} °C</span></div>
    <div class="data-row"><span class="data-key">Battery T4 / T5:</span><span class="data-val" style="color:#38bdf8;">${temp4} °C / ${temp5} °C</span></div>
    <div class="data-row"><span class="data-key">Heat Current / Status:</span><span class="data-val">0.000 A / OFF</span></div>
    <div class="data-row"><span class="data-key">Detail Logs Count:</span><span class="data-val">2369</span></div>
    <div class="data-row"><span class="data-key">Time Enter Sleep:</span><span class="data-val">86400 s</span></div>
    <div class="data-row"><span class="data-key">Cell Type:</span><span class="data-val">LFP</span></div>
    <div class="data-row"><span class="data-key">LCD Buzzer / DRY Alarms:</span><span class="data-val">OFF</span></div>
  </div>

  <div class="section-header">Cells Voltage</div>
  <div class="cells-grid">
    ${cellItemsHtml}
  </div>

  <div class="section-header">Cells Wire Resistance</div>
  <div class="cells-grid">
    ${wireItemsHtml}
  </div>
</div>

<!-- TAB 2: SETTINGS -->
<div id="tab-settings" class="tab-content">
  <div class="setting-group-title">Basic Settings</div>
  <div class="setting-row"><span class="setting-key">Cell Count:</span><div class="setting-box"><span class="setting-val">16</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Battery Capacity(Ah):</span><div class="setting-box"><span class="setting-val">280</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Balance Trig. Volt.(V):</span><div class="setting-box"><span class="setting-val">0.003</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Calibrating Volt.(V):</span><div class="setting-box"><span class="setting-val">${voltage}</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Calibrating Curr.(A):</span><div class="setting-box"><span class="setting-val">${current}</span><span class="setting-ok">OK</span></div></div>

  <div class="setting-group-title">Advance Settings</div>
  <div class="setting-row"><span class="setting-key">Start Balance Volt.(V):</span><div class="setting-box"><span class="setting-val">2.80</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Max Balance Cur.(A):</span><div class="setting-box"><span class="setting-val">1.8</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Cell OVP(V):</span><div class="setting-box"><span class="setting-val">3.500</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Vol. Cell RCV(V):</span><div class="setting-box"><span class="setting-val">3.480</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">SOC-100% Volt.(V):</span><div class="setting-box"><span class="setting-val">3.450</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Cell OVPR(V):</span><div class="setting-box"><span class="setting-val">3.430</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Power Off Vol.(V):</span><div class="setting-box"><span class="setting-val">2.600</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Continued Charge Curr.(A):</span><div class="setting-box"><span class="setting-val">90.0</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Continued Discharge Curr.(A):</span><div class="setting-box"><span class="setting-val">100.0</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">Discharge OTP(°C):</span><div class="setting-box"><span class="setting-val">70.0</span><span class="setting-ok">OK</span></div></div>

  <div class="setting-group-title">Protocol & Inverter Settings</div>
  <div class="setting-row"><span class="setting-key">User Data 2:</span><div class="setting-box"><span class="setting-val" style="color:#38bdf8;">JK-BMS</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">UART1 Protocol No.:</span><div class="setting-box"><span class="setting-val" style="color:#38bdf8;">001-JK BMS</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">UART2 Protocol No.:</span><div class="setting-box"><span class="setting-val" style="color:#38bdf8;">001-JK BMS</span><span class="setting-ok">OK</span></div></div>
  <div class="setting-row"><span class="setting-key">CAN Protocol No.:</span><div class="setting-box"><span class="setting-val" style="color:#38bdf8;">011-Luxpower</span><span class="setting-ok">OK</span></div></div>
</div>

<!-- TAB 3: CONTROL -->
<div id="tab-control" class="tab-content">
  <!-- BLE Manager Card -->
  <div style="background:rgba(15,23,42,0.6);border:1px solid rgba(56,189,248,0.25);border-radius:12px;padding:14px;margin-bottom:14px;">
    <div style="font-size:0.85rem;font-weight:700;color:#38bdf8;margin-bottom:10px;">📡 Kết Nối Bluetooth BMS</div>
    <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:0.78rem;border-bottom:1px solid rgba(56,189,248,0.1);"><span style="color:#94a3b8;">BMS đang kết nối:</span><span id="bms-connected-status" style="font-weight:700;color:${bleConnected?'#3fb950':'#f85149'};">${bleConnected ? (d.active_bms_name||'JK-BMS') : 'Chưa kết nối BMS'}</span></div>
    <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:0.78rem;border-bottom:1px solid rgba(56,189,248,0.1);"><span style="color:#94a3b8;">Địa chỉ MAC:</span><span id="bms-mac-status" style="font-family:monospace;font-size:0.72rem;">${d.active_bms_mac||'—'}</span></div>
    <button onclick="scanBle()" id="btn-server-scan" style="background:linear-gradient(135deg,#38bdf8,#0284c7);color:#070d14;border:none;padding:11px 18px;border-radius:10px;font-size:0.82rem;font-weight:800;cursor:pointer;width:100%;margin-top:10px;box-shadow:0 4px 14px rgba(56,189,248,0.3);">🔍 Quét Bluetooth BMS Xung Quanh</button>
    <div id="scan-status" style="font-size:0.74rem;padding:8px 10px;border-radius:6px;margin-top:8px;display:none;font-weight:600;"></div>
    <div id="ble-devices-list" style="margin-top:10px;display:none;"><div id="ble-devices-grid"></div></div>
  </div>

  <div class="data-list">
    <div class="data-row"><span class="data-key">Charge MOSFET Switch:</span><span class="data-val" style="color:${chargeMos?'#3fb950':'#f85149'}">${chargeMos?'ENABLED':'DISABLED'}</span></div>
    <div class="data-row"><span class="data-key">Discharge MOSFET Switch:</span><span class="data-val" style="color:${dischargeMos?'#3fb950':'#f85149'}">${dischargeMos?'ENABLED':'DISABLED'}</span></div>
    <div class="data-row"><span class="data-key">Active Balancer Switch:</span><span class="data-val" style="color:${balance?'#3fb950':'#f85149'}">${balance?'ENABLED':'DISABLED'}</span></div>
    <div class="data-row"><span class="data-key">IP Local:</span><span class="data-val">${d.local_ip || '192.168.102.30'}</span></div>
    <div class="data-row"><span class="data-key">Wi-Fi SSID:</span><span class="data-val">${d.ssid || 'Cuong977'}</span></div>
    <div class="data-row"><span class="data-key">Firmware Version:</span><span class="data-val">v${d.firmware_version || '2.4.0'}</span></div>
  </div>

  <div style="margin-top:20px;text-align:center;">
    <button class="btn-reset" onclick="resetWifi()">🔄 Reset Cấu Hình Wi-Fi (AP Setup)</button>
    <div id="reset-msg" style="font-size:0.78rem;margin-top:10px;display:none;font-weight:600;"></div>
  </div>
</div>

<!-- FOOTER NAVIGATION BAR -->
<div class="footer-nav">
  <button class="f-btn active" id="f-status" onclick="showTab('status')"><span class="f-icon">📈</span>Status</button>
  <button class="f-btn" id="f-settings" onclick="showTab('settings')"><span class="f-icon">⚙️</span>Settings</button>
  <button class="f-btn" id="f-control" onclick="showTab('control')"><span class="f-icon">🎛️</span>Control</button>
</div>

<script>
  function showTab(name) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.f-btn').forEach(el => el.classList.remove('active'));

    document.getElementById('tab-' + name).classList.add('active');
    if (name === 'status') {
      document.querySelectorAll('.tab-btn')[0].classList.add('active');
      document.getElementById('f-status').classList.add('active');
    } else if (name === 'settings') {
      document.querySelectorAll('.tab-btn')[1].classList.add('active');
      document.getElementById('f-settings').classList.add('active');
    } else if (name === 'control') {
      document.querySelectorAll('.tab-btn')[2].classList.add('active');
      document.getElementById('f-control').classList.add('active');
    }
  }

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

  function updateScanStatus(msg, color, devices) {
    const el = document.getElementById('scan-status');
    if (el) { el.style.display='block'; el.style.color=color||'#e3b341'; el.textContent=msg; }
    if (devices && devices.length > 0) {
      const listEl = document.getElementById('ble-devices-list');
      const gridEl = document.getElementById('ble-devices-grid');
      if (listEl && gridEl) {
        listEl.style.display = 'block';
        gridEl.innerHTML = devices.map(dev => {
          const mac = dev.mac||dev.address||'—';
          const name = dev.name||'JK-BMS';
          const rssi = dev.rssi ? dev.rssi + ' dBm' : '';
          return '<div style="background:rgba(15,23,42,0.7);border:1px solid rgba(56,189,248,0.2);border-radius:8px;padding:9px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><div><div style="font-size:0.82rem;font-weight:800;color:#00ffaa;">📟 '+name+'</div><div style="font-size:0.7rem;color:#94a3b8;font-family:monospace;margin-top:2px;">MAC: '+mac+' • 📶 '+rssi+'</div></div><button onclick="connectBms(\''+mac+'\',\''+name+'\')" style="background:rgba(16,185,129,.2);border:1px solid #10b981;color:#10b981;padding:6px 14px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;">⚡ Kết Nối</button></div>';
        }).join('');
      }
    }
  }

  async function scanBle() {
    updateScanStatus('⏳ Đang gửi lệnh quét Bluetooth tới ESP32...', '#38bdf8');
    const listEl = document.getElementById('ble-devices-list');
    if (listEl) listEl.style.display = 'none';
    try {
      await fetch('/api/send-command', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({device_id:'${d.device_id}', cmd:{cmd:'scan_ble'}})
      });
      let attempts = 0;
      const timer = setInterval(async () => {
        attempts++;
        updateScanStatus('⏳ ESP32 đang bật Bluetooth & quét xung quanh... (' + (attempts*2) + 's / max 30s)', '#e3b341');
        try {
          const res = await fetch('/api/scanned-ble?device_id=${d.device_id}');
          const data = await res.json();
          if (data.devices && data.devices.length > 0) {
            clearInterval(timer);
            updateScanStatus('✅ Đã tìm thấy '+data.devices.length+' thiết bị Bluetooth JK-BMS!', '#3fb950', data.devices);
          } else if (attempts >= 15) {
            clearInterval(timer);
            updateScanStatus('❌ Không tìm thấy JK-BMS nào ở gần hoặc BMS chưa bật nguồn.', '#f85149');
          }
        } catch(e){}
      }, 2000);
    } catch(e) { updateScanStatus('❌ Lỗi kết nối máy chủ!', '#f85149'); }
  }

  async function connectBms(mac, name) {
    if (!confirm('Kết nối ESP32 tới BMS '+name+' ('+mac+')?')) return;
    const el = document.getElementById('scan-status');
    if (el) { el.style.display='block'; el.style.color='#e3b341'; el.textContent='⏳ Đang gửi lệnh kết nối tới ESP32...'; }
    try {
      await fetch('/api/send-command', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          device_id:'${d.device_id}',
          cmd:[
            {cmd:'connect_bms', mac:mac, name:name, pin:'1234'},
            {cmd:'send_heartbeat_now'}
          ]
        })
      });
      if (el) { el.style.color='#3fb950'; el.textContent='✅ Đã gửi lệnh! ESP32 đang kết nối và đọc dữ liệu...'; }
      setTimeout(() => {
        showTab('status');
        location.reload();
      }, 3000);
    } catch(e) { if (el) { el.style.color='#f85149'; el.textContent='❌ Lỗi gửi lệnh!'; } }
  }

  setTimeout(() => location.reload(), 15000);
</script>
</body>
</html>`;
}
