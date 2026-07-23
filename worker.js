const OFFLINE_MS = 3 * 60 * 1000; // 3 minutes
const MEMORY_DEVICE_INDEX = new Set(['JKBMS-F89C', 'JKBMS-249D']);
const MEMORY_DEVICE_CACHE = new Map();
const MEMORY_COMMANDS_MAP = new Map();
const MEMORY_BLE_RESULTS_MAP = new Map();

function isOnline(device) {
  return device.lastSeen && (Date.now() - device.lastSeen) < OFFLINE_MS;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── POST /api/upload-firmware ──────────────────────────────
    if (method === 'POST' && path === '/api/upload-firmware') {
      try {
        const binBuffer = await request.arrayBuffer();
        if (!binBuffer || binBuffer.byteLength < 1000) {
          return jsonResponse({ error: 'Invalid firmware binary' }, 400, corsHeaders);
        }
        await env.DEVICES.put('__latest_firmware_bin__', binBuffer);
        return jsonResponse({ status: 'ok', size: binBuffer.byteLength }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── GET /firmware/latest.bin ───────────────────────────────
    if (method === 'GET' && (path === '/firmware/latest.bin' || path === '/firmware/latest.bin/')) {
      try {
        const bin = await env.DEVICES.get('__latest_firmware_bin__', { type: 'arrayBuffer' });
        if (!bin) return new Response('Firmware not found', { status: 404 });
        return new Response(bin, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="firmware.bin"',
            ...corsHeaders
          }
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/send-command ────────────────────────────────
    if (method === 'POST' && path === '/api/send-command') {
      try {
        const body = await request.json();
        const { device_id, cmd } = body;
        if (!device_id || !cmd) {
          return jsonResponse({ error: 'Missing device_id or cmd' }, 400, corsHeaders);
        }
        const cmdArr = Array.isArray(cmd) ? cmd : [cmd];
        MEMORY_COMMANDS_MAP.set(device_id, cmdArr);

        try { await env.DEVICES.put(`cmd:${device_id}`, JSON.stringify(cmdArr)); } catch(e){}
        return jsonResponse({ status: 'ok', device_id, cmd: cmdArr }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/device-commands & /api/pending-command ───────
    if (method === 'GET' && (path === '/api/device-commands' || path === '/api/pending-command')) {
      const deviceId = url.searchParams.get('device_id');
      if (!deviceId) return new Response('[]', { headers: { 'Content-Type': 'application/json', ...corsHeaders } });

      let cmdArr = null;
      if (MEMORY_COMMANDS_MAP.has(deviceId)) {
        cmdArr = MEMORY_COMMANDS_MAP.get(deviceId);
        MEMORY_COMMANDS_MAP.delete(deviceId);
      }

      if (!cmdArr) {
        const key = `cmd:${deviceId}`;
        try {
          const rawCmd = await env.DEVICES.get(key);
          if (rawCmd) {
            cmdArr = JSON.parse(rawCmd);
            if (!Array.isArray(cmdArr)) cmdArr = [cmdArr];
            try { await env.DEVICES.delete(key); } catch(e){}
          }
        } catch(e){}
      }

      if (cmdArr && cmdArr.length > 0) {
        return new Response(JSON.stringify(cmdArr), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      return new Response('[]', { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // ── POST /api/ble-result ───────────────────────────────────
    if (method === 'POST' && path === '/api/ble-result') {
      try {
        const body = await request.json();
        const deviceId = body.device_id;
        if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

        const devicesList = body.devices || [];
        const resultObj = { devices: devicesList, updatedAt: Date.now() };
        MEMORY_BLE_RESULTS_MAP.set(deviceId, resultObj);

        try { await env.DEVICES.put(`scanned_ble:${deviceId}`, JSON.stringify(resultObj)); } catch(e){}
        return jsonResponse({ status: 'ok', count: devicesList.length }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ status: 'ok', count: 0 }, 200, corsHeaders);
      }
    }

    // ── GET /api/scanned-ble?device_id=XXX ─────────────────────
    if (method === 'GET' && path === '/api/scanned-ble') {
      const deviceId = url.searchParams.get('device_id');
      if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

      if (MEMORY_BLE_RESULTS_MAP.has(deviceId)) {
        return jsonResponse(MEMORY_BLE_RESULTS_MAP.get(deviceId), 200, corsHeaders);
      }

      try {
        const raw = await env.DEVICES.get(`scanned_ble:${deviceId}`);
        if (raw) return new Response(raw, { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch(e){}

      return new Response('{"devices":[],"updatedAt":0}', { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // ── POST /api/telemetry & /api/device-heartbeat ─────────────
    if (method === 'POST' && (path === '/api/telemetry' || path === '/api/device-heartbeat')) {
      try {
        const body = await request.json();
        const deviceId = body.device_id;
        if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

        let existingRaw = null;
        try { existingRaw = await env.DEVICES.get(`device:${deviceId}`); } catch(e){}
        const existing = existingRaw ? JSON.parse(existingRaw) : (MEMORY_DEVICE_CACHE.get(deviceId) || {});

        const nowMs = Date.now();
        const activatedDateStr = existing.activatedAtStr || new Date(nowMs).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

        const updated = {
          ...existing,
          ...body,
          device_id: deviceId,
          lastSeen: nowMs,
          registeredAt: existing.registeredAt || nowMs,
          activatedAtStr: activatedDateStr,
          activationMac: existing.activationMac || body.mac || '—',
          activationIp: existing.activationIp || body.local_ip || '—',
          activationSsid: existing.activationSsid || body.ssid || '—',
          activationFirmware: existing.activationFirmware || body.firmware_version || 'v2.4.0'
        };

        MEMORY_DEVICE_INDEX.add(deviceId);
        MEMORY_DEVICE_CACHE.set(deviceId, updated);

        try { await env.DEVICES.put(`device:${deviceId}`, JSON.stringify(updated)); } catch(e){}

        try {
          const listRaw = await env.DEVICES.get('__device_index__');
          const deviceList = listRaw ? JSON.parse(listRaw) : Array.from(MEMORY_DEVICE_INDEX);
          if (!deviceList.includes(deviceId)) {
            deviceList.push(deviceId);
            await env.DEVICES.put('__device_index__', JSON.stringify(deviceList));
          }
        } catch(e){}

        return jsonResponse({ status: 'ok', device_id: deviceId }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ status: 'ok', device_id: 'unknown' }, 200, corsHeaders);
      }
    }

    // ── POST /api/register-device ──────────────────────────────
    if (method === 'POST' && (path === '/api/register-device' || path.startsWith('/api/register-device'))) {
      try {
        let body = {};
        try { body = await request.json(); } catch(e){}
        const deviceId = (body.device_id || '').trim();
        if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

        MEMORY_DEVICE_INDEX.add(deviceId);

        let listRaw = null;
        try { listRaw = await env.DEVICES.get('__device_index__'); } catch(e){}
        let deviceList = listRaw ? JSON.parse(listRaw) : Array.from(MEMORY_DEVICE_INDEX);
        if (!deviceList.includes(deviceId)) {
          deviceList.push(deviceId);
          try { await env.DEVICES.put('__device_index__', JSON.stringify(deviceList)); } catch(e){}
        }

        const nowMs = Date.now();
        let existingRaw = null;
        try { existingRaw = await env.DEVICES.get(`device:${deviceId}`); } catch(e){}
        let existing = existingRaw ? JSON.parse(existingRaw) : MEMORY_DEVICE_CACHE.get(deviceId);
        
        if (!existing) {
          existing = {
            device_id: deviceId,
            registeredAt: nowMs,
            activatedAtStr: new Date(nowMs).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
            lastSeen: 0,
            connected: false
          };
          MEMORY_DEVICE_CACHE.set(deviceId, existing);
          try { await env.DEVICES.put(`device:${deviceId}`, JSON.stringify(existing)); } catch(e){}
        }

        return jsonResponse({ status: 'ok', device_id: deviceId, total: MEMORY_DEVICE_INDEX.size }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ status: 'ok', message: e.message }, 200, corsHeaders);
      }
    }

    // ── POST /api/delete-device ────────────────────────────────
    if (method === 'POST' && path === '/api/delete-device') {
      try {
        const body = await request.json();
        const deviceId = (body.device_id || '').trim();
        if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

        MEMORY_DEVICE_INDEX.delete(deviceId);
        MEMORY_DEVICE_CACHE.delete(deviceId);

        let listRaw = null;
        try { listRaw = await env.DEVICES.get('__device_index__'); } catch(e){}
        let deviceList = listRaw ? JSON.parse(listRaw) : Array.from(MEMORY_DEVICE_INDEX);
        deviceList = deviceList.filter(id => id !== deviceId);

        try { await env.DEVICES.put('__device_index__', JSON.stringify(deviceList)); } catch(e){}
        try { await env.DEVICES.delete(`device:${deviceId}`); } catch(e){}

        return jsonResponse({ status: 'ok', device_id: deviceId }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ status: 'ok', message: e.message }, 200, corsHeaders);
      }
    }

    // ── GET /api/devices ───────────────────────────────────────
    if (method === 'GET' && path === '/api/devices') {
      try {
        const allDeviceIds = new Set();

        MEMORY_DEVICE_INDEX.forEach(id => allDeviceIds.add(id));
        MEMORY_DEVICE_CACHE.forEach((v, k) => allDeviceIds.add(k));

        try {
          const listRaw = await env.DEVICES.get('__device_index__');
          if (listRaw) {
            const arr = JSON.parse(listRaw);
            arr.forEach(id => allDeviceIds.add(id));
          }
        } catch(e){}

        try {
          const kvList = await env.DEVICES.list({ prefix: 'device:' });
          if (kvList && kvList.keys) {
            kvList.keys.forEach(k => {
              const devId = k.name.replace('device:', '');
              if (devId) allDeviceIds.add(devId);
            });
          }
        } catch(e){}

        const devices = [];

        for (const id of allDeviceIds) {
          try {
            let dev = null;
            try {
              const raw = await env.DEVICES.get(`device:${id}`);
              if (raw) dev = JSON.parse(raw);
            } catch(e){}

            if (!dev && MEMORY_DEVICE_CACHE.has(id)) {
              dev = MEMORY_DEVICE_CACHE.get(id);
            }

            if (dev) {
              dev.online = isOnline(dev);
              dev.lastSeenAgo = dev.lastSeen ? Math.round((Date.now() - dev.lastSeen) / 1000) : null;
              if (!dev.activatedAtStr && dev.registeredAt) {
                dev.activatedAtStr = new Date(dev.registeredAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
              }
              devices.push(dev);
            } else {
              devices.push({
                device_id: id,
                connected: false,
                online: false,
                voltage: 0,
                soc: 0,
                mos_temp: 0,
                activatedAtStr: 'Chưa kích hoạt',
                lastSeenAgo: null
              });
            }
          } catch(e) {
            devices.push({ device_id: id, connected: false, online: false, voltage: 0, soc: 0, mos_temp: 0, activatedAtStr: 'Chưa kích hoạt', lastSeenAgo: null });
          }
        }

        return jsonResponse(devices, 200, corsHeaders);
      } catch (e) {
        return jsonResponse([], 200, corsHeaders);
      }
    }

    // ── GET /d/:deviceId (Customer Monitoring UI) ─────────────
    if (method === 'GET' && path.startsWith('/d/')) {
      const deviceId = path.substring(3).trim();
      if (deviceId) {
        let dev = null;
        try {
          const raw = await env.DEVICES.get(`device:${deviceId}`);
          if (raw) dev = JSON.parse(raw);
        } catch(e){}

        if (!dev && MEMORY_DEVICE_CACHE.has(deviceId)) {
          dev = MEMORY_DEVICE_CACHE.get(deviceId);
        }

        if (!dev) {
          dev = { device_id: deviceId, connected: false };
        }

        dev.online = isOnline(dev);

        return new Response(CUSTOMER_DEVICE_HTML(dev), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders }
        });
      }
    }

    // ── GET / (Admin Management Dashboard) ────────────────────
    if (method === 'GET' && (path === '/' || path === '')) {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders }
      });
    }

    return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
  }
};

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

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
    --bg:#0d1117;--surface:#161b22;--surface2:#21262d;--border:rgba(255,255,255,0.08);
    --primary:#3fb950;--primary-dim:rgba(63,185,80,0.15);--danger:#f85149;--danger-dim:rgba(248,81,73,0.15);
    --warning:#e3b341;--warning-dim:rgba(227,179,65,0.15);--text:#e6edf3;--subtext:#8b949e;--accent:#58a6ff;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:24px 16px;}
  .container{max-width:1100px;margin:0 auto;}
  header{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid var(--border);}
  .logo-area{display:flex;align-items:center;gap:12px;}
  .logo-icon{width:40px;height:40px;background:linear-gradient(135deg,#238636,#2ea043);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.3rem;}
  h1{font-size:1.4rem;font-weight:700;letter-spacing:-0.02em;}
  .sub{font-size:0.8rem;color:var(--subtext);}
  .stats-bar{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:28px;}
  .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;display:flex;flex-direction:column;}
  .stat-val{font-size:1.8rem;font-weight:700;margin-top:4px;}
  .stat-val.green{color:var(--primary);}
  .stat-val.red{color:var(--danger);}
  .stat-val.blue{color:var(--accent);}
  .stat-label{font-size:0.78rem;color:var(--subtext);text-transform:uppercase;letter-spacing:0.04em;}
  .device-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;}
  .device-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;transition:all 0.2s;}
  .device-card.online{border-left:4px solid var(--primary);}
  .device-card.offline{border-left:4px solid var(--danger);opacity:0.75;}
  .card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;}
  .device-name{font-size:1.05rem;font-weight:700;}
  .device-sub{font-size:0.75rem;color:var(--subtext);font-family:monospace;}
  .badge{font-size:0.72rem;padding:3px 8px;border-radius:20px;font-weight:600;display:inline-flex;align-items:center;gap:4px;}
  .badge-online{background:var(--primary-dim);color:var(--primary);}
  .badge-offline{background:var(--danger-dim);color:var(--danger);}
  .metrics{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;background:var(--surface2);padding:10px;border-radius:8px;}
  .metric{text-align:center;}
  .metric-val{font-size:1.1rem;font-weight:700;font-family:monospace;}
  .metric-val.green{color:var(--primary);}
  .metric-val.warning{color:var(--warning);}
  .metric-val.blue{color:var(--accent);}
  .metric-label{font-size:0.68rem;color:var(--subtext);margin-top:2px;}
  .device-info{display:flex;flex-direction:column;gap:5px;font-size:0.78rem;margin-bottom:14px;}
  .info-row{display:flex;justify-content:space-between;}
  .info-key{color:var(--subtext);}
  .info-val{font-family:monospace;}
  .last-seen{font-size:0.72rem;color:var(--subtext);margin-top:8px;text-align:right;}
  .no-devices{grid-column:1/-1;text-align:center;padding:48px;background:var(--surface);border-radius:12px;color:var(--subtext);}
  .no-devices .icon{font-size:3rem;margin-bottom:12px;}
  .pulse{width:6px;height:6px;border-radius:50%;background:var(--primary);display:inline-block;animation:pulse 1.5s infinite;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.3;}}
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo-area">
      <div class="logo-icon">🔋</div>
      <div>
        <h1>JK BMS Cloud Monitor</h1>
        <div class="sub">Hệ thống Giám sát & Quản lý BMS qua Internet</div>
      </div>
    </div>
    <div style="font-size:0.8rem;color:var(--subtext);" id="refresh-label">Cập nhật tự động</div>
  </header>

  <div class="stats-bar">
    <div class="stat-card"><span class="stat-label">Tổng số thiết bị</span><span class="stat-val blue" id="stat-total">0</span></div>
    <div class="stat-card"><span class="stat-label">Trực tuyến (Online)</span><span class="stat-val green" id="stat-online">0</span></div>
    <div class="stat-card"><span class="stat-label">Ngoại tuyến (Offline)</span><span class="stat-val red" id="stat-offline">0</span></div>
  </div>

  <!-- QUICK LINK GENERATOR & PERMANENT DEVICE SAVER -->
  <div style="background:var(--surface);border:1px solid rgba(88,166,255,0.3);border-radius:12px;padding:16px;margin-bottom:24px;">
    <div style="font-weight:700;font-size:0.9rem;color:var(--accent);margin-bottom:10px;display:flex;align-items:center;gap:6px;">
      <span>💾 Quản Lý & Lưu Vĩnh Viễn Danh Sách Thiết Bị</span>
      <span style="font-size:0.75rem;color:var(--subtext);font-weight:400;">(Nhập Device ID để lưu vĩnh viễn vào Cloud)</span>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <input type="text" id="quick-dev-id" placeholder="Nhập ID bo mạch (Ví dụ: JKBMS-F89C)" value="JKBMS-F89C" style="flex:1;min-width:200px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:9px 14px;border-radius:8px;font-family:monospace;font-size:0.88rem;outline:none;">
      <button onclick="registerDevice()" style="background:rgba(63,185,80,0.2);border:1px solid #3fb950;color:#3fb950;padding:9px 16px;border-radius:8px;font-size:0.8rem;font-weight:700;cursor:pointer;">💾 Lưu Vĩnh Viễn</button>
      <button onclick="openQuickLink()" style="background:var(--accent);color:#0d1117;border:none;padding:9px 16px;border-radius:8px;font-size:0.8rem;font-weight:700;cursor:pointer;">🔗 Mở Giao Diện</button>
      <button onclick="copyQuickLink()" style="background:var(--primary-dim);border:1px solid var(--primary);color:var(--primary);padding:9px 16px;border-radius:8px;font-size:0.8rem;font-weight:700;cursor:pointer;">📋 Copy Link</button>
    </div>
    <div id="quick-msg" style="font-size:0.78rem;color:var(--primary);margin-top:8px;display:none;font-weight:600;"></div>
  </div>

  <div class="device-grid" id="device-grid"><div class="no-devices"><div class="icon">⏳</div><h3>Đang tải danh sách...</h3></div></div>
</div>
<script>
  function timeSince(s){if(!s&&s!==0)return'Chưa rõ';if(s<60)return s+'s trước';if(s<3600)return Math.floor(s/60)+' phút trước';return Math.floor(s/3600)+' giờ trước';}
  
  async function registerDevice() {
    const id = document.getElementById('quick-dev-id').value.trim();
    if (!id) return alert('Vui lòng nhập Device ID!');
    try {
      const res = await fetch('/api/register-device', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ device_id: id })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        const msg = document.getElementById('quick-msg');
        msg.style.display = 'block';
        msg.style.color = '#3fb950';
        msg.textContent = '✅ Đã lưu vĩnh viễn thiết bị ' + id + ' vào danh sách cloud!';
        setTimeout(function() { msg.style.display = 'none'; }, 4000);
        fetchDevices();
      }
    } catch(e) { alert('Lỗi lưu thiết bị!'); }
  }

  function openQuickLink() {
    const id = document.getElementById('quick-dev-id').value.trim();
    if (!id) return alert('Vui lòng nhập Device ID!');
    window.open('/d/' + id, '_blank');
  }

  function copyQuickLink() {
    const id = document.getElementById('quick-dev-id').value.trim();
    if (!id) return alert('Vui lòng nhập Device ID!');
    const url = window.location.origin + '/d/' + id;
    navigator.clipboard.writeText(url).then(function() {
      const msg = document.getElementById('quick-msg');
      msg.style.display = 'block';
      msg.textContent = '✅ Đã chép link: ' + url;
      setTimeout(function() { msg.style.display = 'none'; }, 4000);
    });
  }

  function copyMonitorLink(id, btn){
    const url = window.location.origin + '/d/' + id;
    navigator.clipboard.writeText(url).then(() => {
      const oldText = btn.textContent;
      btn.textContent = '✅ Đã Chép!';
      btn.style.background = '#3fb950';
      btn.style.color = '#0d1117';
      setTimeout(() => {
        btn.textContent = oldText;
        btn.style.background = '';
        btn.style.color = '';
      }, 2000);
    });
  }

  async function deleteDevice(id) {
    if (!confirm('Bạn có chắc chắn muốn XÓA THIẾT BỊ ' + id + ' khỏi danh sách Cloud?')) return;
    try {
      const res = await fetch('/api/delete-device', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ device_id: id })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        fetchDevices();
      }
    } catch(e){ alert('Lỗi khi xóa thiết bị!'); }
  }

  async function fetchDevices(){
    const grid = document.getElementById('device-grid');
    try{
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const devices = await res.json();
      
      document.getElementById('stat-online').textContent = devices.filter(function(d){ return d.online; }).length;
      document.getElementById('stat-offline').textContent = devices.filter(function(d){ return !d.online; }).length;
      document.getElementById('stat-total').textContent = devices.length;
      document.getElementById('refresh-label').textContent = 'Cập nhật: ' + new Date().toLocaleTimeString('vi-VN');
      
      if(!devices || !devices.length){
        grid.innerHTML = '<div class="no-devices"><div class="icon">📡</div><h3>Chưa có thiết bị</h3><p>Nhập ID ở trên để lưu hoặc bật bo ESP32 kết nối Wi-Fi.</p></div>';
        return;
      }
      
      var htmlArr = [];
      for(var i = 0; i < devices.length; i++) {
        var d = devices[i];
        var socColor = d.soc > 50 ? 'green' : d.soc > 20 ? 'warning' : 'danger';
        var voltStr = (d.voltage || 0).toFixed(1);
        var tempStr = (d.mos_temp || 0).toFixed(1);
        var localIp = d.local_ip || '—';
        var ssidName = d.ssid || '—';
        var hostName = d.hostname || '—';
        var fwVer = d.firmware_version || '—';
        var activatedStr = d.activatedAtStr || 'Chưa kích hoạt';
        var statusBadge = d.online ? '<span class="badge badge-online"><span class="pulse"></span> Online</span>' : '<span class="badge badge-offline">Offline</span>';
        var statusText = d.online ? 'Hoạt động ' : 'Offline từ ';
        
        htmlArr.push(
          '<div class="device-card ' + (d.online ? 'online' : 'offline') + '">' +
            '<div class="card-header">' +
              '<div><div class="device-name">📟 ' + d.device_id + '</div><div class="device-sub">' + (d.mac || '') + '</div></div>' +
              statusBadge +
            '</div>' +
            '<div class="metrics">' +
              '<div class="metric"><div class="metric-val blue">' + voltStr + ' V</div><div class="metric-label">Điện áp Pack</div></div>' +
              '<div class="metric"><div class="metric-val ' + socColor + '">' + (d.soc || 0) + ' %</div><div class="metric-label">SoC Pin</div></div>' +
              '<div class="metric"><div class="metric-val warning">' + tempStr + ' °C</div><div class="metric-label">Nhiệt độ MOS</div></div>' +
            '</div>' +
            '<div class="device-info">' +
              '<div class="info-row"><span class="info-key">Ngày Kích Hoạt</span><span class="info-val" style="color:var(--primary);font-weight:700;">' + activatedStr + '</span></div>' +
              '<div class="info-row"><span class="info-key">IP Local</span><span class="info-val">' + localIp + '</span></div>' +
              '<div class="info-row"><span class="info-key">Wi-Fi</span><span class="info-val">' + ssidName + '</span></div>' +
              '<div class="info-row"><span class="info-key">Hostname</span><span class="info-val">' + hostName + '</span></div>' +
              '<div class="info-row"><span class="info-key">Firmware</span><span class="info-val">v' + fwVer + '</span></div>' +
            '</div>' +
            '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;gap:6px;align-items:center;">' +
              '<a href="/d/' + d.device_id + '" target="_blank" style="flex:1;background:var(--surface2);border:1px solid var(--accent);color:var(--accent);padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;text-decoration:none;text-align:center;">' +
                '🔗 Mở Link' +
              '</a>' +
              '<button data-id="' + d.device_id + '" onclick="copyMonitorLink(this.getAttribute(\\'data-id\\'), this)" style="background:var(--primary-dim);border:1px solid var(--primary);color:var(--primary);padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;cursor:pointer;">' +
                '📋 Copy' +
              '</button>' +
              '<button data-id="' + d.device_id + '" onclick="deleteDevice(this.getAttribute(\\'data-id\\'))" style="background:rgba(248,81,73,0.15);border:1px solid #f85149;color:#f85149;padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;cursor:pointer;">' +
                '🗑️ Xóa' +
              '</button>' +
            '</div>' +
            '<div class="last-seen">🕐 ' + statusText + timeSince(d.lastSeenAgo) + '</div>' +
          '</div>'
        );
      }
      grid.innerHTML = htmlArr.join('');
    }catch(e){
      console.error(e);
      document.getElementById('refresh-label').textContent = 'Đang tự động kết nối...';
      grid.innerHTML = '<div class="no-devices"><div class="icon">📡</div><h3>Đang kết nối Cloud</h3><p>Sử dụng thanh công cụ ở trên để tạo link khách hàng hoặc lưu thiết bị vĩnh viễn.</p></div>';
    }
  }

  fetchDevices();
  setInterval(fetchDevices, 10000);
</script>
</body>
</html>`;

function CUSTOMER_DEVICE_HTML(d) {
  const online = d.online;
  const bleConnected = d.connected && d.voltage > 0;

  const soc      = bleConnected ? (d.soc !== undefined ? d.soc : 0) : 0;
  const voltage  = bleConnected ? (d.voltage  ? d.voltage.toFixed(2)  : '—') : '—';
  const current  = bleConnected ? (d.current  !== undefined ? d.current.toFixed(2)  : '0.00') : '—';
  const power    = bleConnected ? (d.power    !== undefined ? Math.abs(d.power).toFixed(1) : '0.0') : '—';
  const mosTemp  = bleConnected ? (d.mos_temp !== undefined ? d.mos_temp.toFixed(1) : '—') : '—';
  const temp1    = bleConnected && d.temp1 && d.temp1 > 0 ? d.temp1.toFixed(1) : null;
  const temp2    = bleConnected && d.temp2 && d.temp2 > 0 ? d.temp2.toFixed(1) : null;
  const capAh    = bleConnected ? (d.capacity_ah !== undefined ? d.capacity_ah.toFixed(1) : '30.0') : '—';
  const remCap   = bleConnected ? (d.remain_capacity_ah !== undefined ? d.remain_capacity_ah.toFixed(1) : '—') : '—';
  const balCurr  = bleConnected ? (d.balance_current !== undefined ? d.balance_current.toFixed(3) : '0.000') : '—';
  const cycleCap = bleConnected ? (d.cycle_capacity_ah !== undefined ? d.cycle_capacity_ah.toFixed(1) : '—') : '—';
  const cycles   = bleConnected ? (d.cycle_count !== undefined ? d.cycle_count : 0) : '—';
  const detailLogs = bleConnected ? (d.detail_logs_count !== undefined ? d.detail_logs_count : '—') : '—';
  const chargeMos   = d.charge_mos;
  const dischargeMos= d.discharge_mos;
  const balance     = d.balance_active;
  const aveCellVolt = bleConnected && d.min_cell_voltage && d.max_cell_voltage
    ? (((d.min_cell_voltage||0) + (d.max_cell_voltage||0)) / 2).toFixed(3) : '—';
  const cellDelta = bleConnected ? (d.delta_cell_voltage !== undefined ? d.delta_cell_voltage.toFixed(3) : '—') : '—';
  const statusColor = online ? '#3fb950' : '#f85149';
  const statusText  = online ? 'Online' : 'Offline';
  const rssiVal     = d.rssi ? d.rssi + ' dBm' : '—';
  const reg = d.activatedAtStr || '—';

  // Cell voltages
  const cells = Array.isArray(d.cell_voltages) ? d.cell_voltages : [];
  const cellMinNum = d.min_cell_num || 0;
  const cellMaxNum = d.max_cell_num || 0;
  let cellItemsHtml = '';
  for (let i = 0; i < 24; i++) {
    const num = (i + 1).toString().padStart(2, '0');
    if (bleConnected && i < cells.length) {
      const v = cells[i];
      let color = '#3fb950';
      if (i + 1 === cellMinNum) color = '#e3b341';
      if (i + 1 === cellMaxNum) color = '#f85149';
      const valStr = (typeof v === 'number' ? v : parseFloat(v)).toFixed(3);
      cellItemsHtml += `<div class="cell-box"><span class="c-num">${num}</span><span class="c-val" style="color:${color};">${valStr}<sup>V</sup></span></div>`;
    } else {
      cellItemsHtml += `<div class="cell-box"><span class="c-num">${num}</span><span class="c-val" style="color:#2a3530;">--</span></div>`;
    }
  }

  // SOC ring angle
  const socNum = parseInt(soc) || 0;
  const ringDash = Math.round(socNum * 2.513); // circumference ~251.3 for r=40

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>JK-BMS Monitor - ${d.device_id}</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Inter',sans-serif;background:#060e0c;color:#c9d1d9;min-height:100vh;padding-bottom:64px;-webkit-tap-highlight-color:transparent;}

  /* ── TOP STATUS BAR ── */
  .top-bar{background:#0a1512;border-bottom:1px solid #122520;padding:8px 14px;display:flex;align-items:center;justify-content:space-between;}
  .top-bar-id{font-family:'Share Tech Mono',monospace;font-size:0.78rem;color:#38bdf8;letter-spacing:0.08em;}
  .top-bar-switches{display:flex;gap:10px;font-size:0.72rem;font-weight:700;}
  .sw{display:inline-flex;align-items:center;gap:3px;color:#8b949e;}
  .sw-on{color:#3fb950;}  .sw-off{color:#f85149;}

  /* ── SOC HERO PANEL ── */
  .hero{background:linear-gradient(180deg,#0a1512 0%,#071010 100%);padding:18px 16px 14px;text-align:center;}
  .soc-ring-wrap{position:relative;width:200px;height:200px;margin:0 auto 8px;}
  .soc-ring-wrap svg{transform:rotate(-220deg);}
  .soc-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}
  .soc-pct{font-family:'Share Tech Mono',monospace;font-size:3.2rem;font-weight:700;color:#3fb950;line-height:1;}
  .soc-label{font-size:0.65rem;color:#8b949e;font-weight:600;letter-spacing:0.1em;margin-top:2px;}
  .volt-curr-row{display:flex;justify-content:center;gap:0;margin-top:2px;}
  .vc-item{flex:1;max-width:160px;padding:8px 10px;background:#081312;border-radius:10px;margin:0 4px;}
  .vc-val{font-family:'Share Tech Mono',monospace;font-size:1.6rem;font-weight:700;color:#3fb950;}
  .vc-unit{font-size:0.7rem;color:#3fb950;vertical-align:super;}
  .vc-label{font-size:0.62rem;color:#8b949e;font-weight:600;margin-top:2px;letter-spacing:0.06em;}

  /* ── STATUS BANNER ── */
  .status-banner{background:#081a14;border:1px solid #1a3d2c;border-radius:8px;margin:10px 12px 0;padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:0.8rem;font-weight:600;color:#3fb950;}
  .status-banner.offline{border-color:#3d1a1a;color:#f85149;background:#180808;}

  /* ── DATA GRID 4-COL ── */
  .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#122520;border:1px solid #122520;border-radius:10px;overflow:hidden;margin:10px 12px;}
  .g4-item{background:#081312;padding:10px 4px;text-align:center;}
  .g4-val{font-family:'Share Tech Mono',monospace;font-size:1.05rem;font-weight:700;color:#3fb950;line-height:1.1;}
  .g4-val.blue{color:#38bdf8;}
  .g4-val.red{color:#f85149;}
  .g4-val.yellow{color:#e3b341;}
  .g4-label{font-size:0.58rem;color:#8b949e;margin-top:3px;line-height:1.2;}

  /* ── NAV TABS ── */
  .nav-tabs{display:flex;background:#060e0c;border-bottom:2px solid #0f2520;position:sticky;top:0;z-index:100;}
  .tab-btn{flex:1;padding:11px 0;font-size:0.78rem;font-weight:700;color:#8b949e;border:none;background:none;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .2s;}
  .tab-btn.active{color:#3fb950;border-bottom-color:#3fb950;}

  .tab-content{display:none;padding:12px;}
  .tab-content.active{display:block;}

  /* ── REALTIME DATA LIST ── */
  .rt-label{font-size:0.78rem;font-weight:700;color:#3fb950;margin:6px 0 6px 2px;display:flex;align-items:center;gap:6px;}
  .rt-label::before{content:'';width:8px;height:8px;border-radius:50%;background:#3fb950;animation:pulse 1.4s infinite;}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.5;transform:scale(1.3);}}

  .rt-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#0d2420;border:1px solid #0d2420;border-radius:8px;overflow:hidden;margin-bottom:12px;}
  .rt-row{display:flex;justify-content:space-between;align-items:center;background:#060e0c;padding:6px 10px;font-size:0.75rem;}
  .rt-key{color:#8b949e;font-weight:500;}
  .rt-val{font-family:'Share Tech Mono',monospace;color:#3fb950;font-weight:700;}
  .rt-val.blue{color:#38bdf8;} .rt-val.yellow{color:#e3b341;} .rt-val.red{color:#f85149;}

  /* ── CURRENT BAR ── */
  .curr-bar-wrap{background:#081312;border:1px solid #0d2420;border-radius:8px;padding:10px 12px;margin-bottom:12px;}
  .curr-bar-row{display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:6px;}
  .curr-label{color:#8b949e;font-weight:500;}
  .curr-val-green{font-family:'Share Tech Mono',monospace;color:#3fb950;font-weight:700;}
  .bar-track{height:6px;background:#122520;border-radius:3px;overflow:hidden;}
  .bar-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#3fb950,#38bdf8);transition:width .5s;}
  .curr-status-row{display:flex;justify-content:space-between;margin-top:6px;font-size:0.72rem;}

  /* ── CELLS ── */
  .section-hdr{font-size:0.75rem;font-weight:800;color:#3fb950;margin:10px 0 8px;display:flex;align-items:center;gap:6px;}
  .section-hdr::after{content:'';flex:1;height:1px;background:#122520;}
  .cells-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px;}
  .cell-box{background:#081312;border:1px solid #0d2420;border-radius:7px;padding:6px 8px;display:flex;align-items:center;justify-content:space-between;}
  .c-num{font-size:0.7rem;font-weight:700;color:#38bdf8;background:rgba(56,189,248,.12);padding:2px 5px;border-radius:4px;font-family:monospace;}
  .c-val{font-family:'Share Tech Mono',monospace;font-size:0.82rem;font-weight:700;}
  .c-val sup{font-size:0.6rem;}

  /* ── CONTROL TAB ── */
  .ctrl-card{background:#081312;border:1px solid #0d2420;border-radius:10px;padding:12px;margin-bottom:12px;}
  .ctrl-title{font-size:0.82rem;font-weight:700;color:#38bdf8;margin-bottom:10px;}
  .ctrl-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #0d2420;font-size:0.8rem;}
  .ctrl-row:last-child{border-bottom:none;}
  .ctrl-key{color:#8b949e;}
  .ctrl-val{font-family:'Share Tech Mono',monospace;font-weight:700;}
  .btn-scan{background:#38bdf8;color:#060e0c;border:none;padding:9px 18px;border-radius:8px;font-size:0.8rem;font-weight:800;cursor:pointer;width:100%;margin-bottom:8px;}
  .btn-connect{background:rgba(63,185,80,.2);border:1px solid #3fb950;color:#3fb950;padding:5px 12px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;}
  .btn-danger{background:rgba(248,81,73,.15);border:1px solid #f85149;color:#f85149;padding:10px;border-radius:8px;font-size:0.82rem;font-weight:700;cursor:pointer;width:100%;margin-top:8px;}
  .scan-info{font-size:0.75rem;padding:7px 10px;border-radius:6px;margin-top:8px;display:none;font-weight:600;}
  .ble-list{margin-top:10px;display:none;}
  .ble-item{background:#060e0c;border:1px solid #0d2420;border-radius:7px;padding:8px 10px;display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}

  /* ── FOOTER NAV ── */
  .footer-nav{position:fixed;bottom:0;left:0;right:0;background:#060e0c;border-top:1px solid #122520;display:flex;z-index:200;}
  .f-btn{flex:1;display:flex;flex-direction:column;align-items:center;padding:8px 0;color:#8b949e;font-size:0.65rem;font-weight:700;border:none;background:none;cursor:pointer;gap:2px;}
  .f-btn.active{color:#3fb950;}
  .f-icon{font-size:1.15rem;}
</style>
</head>
<body>

<!-- TOP BAR -->
<div class="top-bar">
  <div class="top-bar-switches">
    <span class="sw">Chg <strong class="${chargeMos?'sw-on':'sw-off'}">${chargeMos?'ON':'OFF'}</strong></span>
    <span class="sw">Dsg <strong class="${dischargeMos?'sw-on':'sw-off'}">${dischargeMos?'ON':'OFF'}</strong></span>
    <span class="sw">Bal <strong class="${balance?'sw-on':'sw-off'}">${balance?'ON':'OFF'}</strong></span>
  </div>
  <div class="top-bar-id">${d.device_id}</div>
</div>

<!-- HERO SOC RING -->
<div class="hero">
  <div class="soc-ring-wrap">
    <svg width="200" height="200" viewBox="0 0 100 100">
      <!-- Background track arc -->
      <circle cx="50" cy="50" r="40" fill="none" stroke="#122520" stroke-width="7"
        stroke-dasharray="251.3" stroke-dashoffset="0" stroke-linecap="round"/>
      <!-- SOC arc -->
      <circle cx="50" cy="50" r="40" fill="none"
        stroke="${socNum>50?'#3fb950':socNum>20?'#e3b341':'#f85149'}" stroke-width="7"
        stroke-dasharray="251.3" stroke-dashoffset="${251.3 - ringDash}" stroke-linecap="round"/>
    </svg>
    <div class="soc-center">
      <div class="soc-pct" id="hero-soc">${socNum}%</div>
      <div class="soc-label">STATE OF CHARGE</div>
    </div>
  </div>
  <div class="volt-curr-row">
    <div class="vc-item">
      <div class="vc-val" id="hero-v">${voltage}<span class="vc-unit">V</span></div>
      <div class="vc-label">VOLTAGE</div>
    </div>
    <div class="vc-item">
      <div class="vc-val" id="hero-a">${current}<span class="vc-unit">A</span></div>
      <div class="vc-label">CURRENT</div>
    </div>
  </div>
</div>

<!-- STATUS BANNER -->
<div class="status-banner${bleConnected?'':' offline'}">
  ${bleConnected
    ? '<span>🛡️</span><span>The battery is functioning properly</span>'
    : '<span>📡</span><span>BMS chưa kết nối Bluetooth</span>'}
  <span style="margin-left:auto;font-size:0.65rem;color:${statusColor};">${statusText}</span>
</div>

<!-- 4-COL GRID ROW 1: Cell data -->
<div class="grid4">
  <div class="g4-item">
    <div class="g4-val blue" id="g-mincell">${bleConnected && d.min_cell_voltage ? d.min_cell_voltage.toFixed(3) : '—'}</div>
    <div class="g4-label">Low Cell (V)</div>
  </div>
  <div class="g4-item">
    <div class="g4-val red" id="g-maxcell">${bleConnected && d.max_cell_voltage ? d.max_cell_voltage.toFixed(3) : '—'}</div>
    <div class="g4-label">High Cell (V)</div>
  </div>
  <div class="g4-item">
    <div class="g4-val yellow" id="g-delta">${cellDelta}</div>
    <div class="g4-label">Volt-Diff (V)</div>
  </div>
  <div class="g4-item">
    <div class="g4-val" id="g-balcurr">${balCurr}</div>
    <div class="g4-label">Bal-Curr (A)</div>
  </div>
</div>

<!-- 4-COL GRID ROW 2: Capacity & Temp -->
<div class="grid4">
  <div class="g4-item">
    <div class="g4-val" id="g-cap">${capAh}</div>
    <div class="g4-label">Capacity (Ah)</div>
  </div>
  <div class="g4-item">
    <div class="g4-val" id="g-rem">${remCap}</div>
    <div class="g4-label">Rem. Cap. (Ah)</div>
  </div>
  <div class="g4-item">
    <div class="g4-val yellow" id="g-mostemp">${mosTemp}</div>
    <div class="g4-label">High Temp (°C)</div>
  </div>
  <div class="g4-item">
    <div class="g4-val blue">LFP</div>
    <div class="g4-label">Cell Type</div>
  </div>
</div>

<!-- NAV TABS -->
<div class="nav-tabs">
  <button class="tab-btn active" onclick="showTab('home')">🏠 Home</button>
  <button class="tab-btn" onclick="showTab('status')">📊 Status</button>
  <button class="tab-btn" onclick="showTab('control')">🎛️ Control</button>
</div>

<!-- TAB HOME: Current bar + quick info -->
<div id="tab-home" class="tab-content active">
  <!-- Current / Power bar -->
  <div class="curr-bar-wrap">
    <div class="curr-bar-row">
      <span class="curr-label">⚡ Current (A):</span>
      <span class="curr-val-green" id="bar-curr">${current}</span>
    </div>
    <div class="curr-bar-row">
      <span class="curr-label">🔥 Power (W):</span>
      <span class="curr-val-green" id="bar-power">${power}</span>
    </div>
    <div class="bar-track">
      <div class="bar-fill" id="bar-fill" style="width:${socNum}%;"></div>
    </div>
    <div class="curr-status-row">
      <span style="color:#8b949e;font-size:0.72rem;">Status: <strong style="color:${bleConnected?(current&&parseFloat(current)<0?'#38bdf8':'#3fb950'):'#f85149'};">${bleConnected?(current&&parseFloat(current)<0?'Discharge':(parseFloat(current)>0?'Charge':'Idle')):'Offline'}</strong></span>
      <span style="color:#8b949e;font-size:0.72rem;">WiFi: <strong style="color:${statusColor};">${statusText}</strong> &nbsp; RSSI: <strong style="color:#38bdf8;">${rssiVal}</strong></span>
    </div>
  </div>

  <!-- Quick telemetry 2-col grid -->
  <div class="rt-label">● Real-time</div>
  <div class="rt-grid">
    <div class="rt-row"><span class="rt-key">Bat. Power:</span><span class="rt-val" id="rt-power">${power} W</span></div>
    <div class="rt-row"><span class="rt-key">Cell AVG:</span><span class="rt-val" id="rt-avg">${aveCellVolt} V</span></div>
    <div class="rt-row"><span class="rt-key">Capacity:</span><span class="rt-val" id="rt-cap">${capAh} Ah</span></div>
    <div class="rt-row"><span class="rt-key">Volt-Diff:</span><span class="rt-val yellow" id="rt-delta">${cellDelta} V</span></div>
    <div class="rt-row"><span class="rt-key">Remain Cap.:</span><span class="rt-val" id="rt-rem">${remCap} Ah</span></div>
    <div class="rt-row"><span class="rt-key">Bal. Current:</span><span class="rt-val" id="rt-bal">${balCurr} A</span></div>
    <div class="rt-row"><span class="rt-key">CMOS Temp.:</span><span class="rt-val yellow" id="rt-mos">${mosTemp} °C</span></div>
    <div class="rt-row"><span class="rt-key">Cycle Count:</span><span class="rt-val" id="rt-cyc">${cycles}</span></div>
    ${temp1 ? `<div class="rt-row"><span class="rt-key">Battery T1:</span><span class="rt-val blue">${temp1} °C</span></div>` : ''}
    ${temp2 ? `<div class="rt-row"><span class="rt-key">Battery T2:</span><span class="rt-val blue">${temp2} °C</span></div>` : ''}
    <div class="rt-row"><span class="rt-key">Cycle Cap.:</span><span class="rt-val">${cycleCap} Ah</span></div>
    <div class="rt-row"><span class="rt-key">Detail Logs:</span><span class="rt-val" id="rt-dlogs">${detailLogs}</span></div>
    <div class="rt-row"><span class="rt-key">Cell Type:</span><span class="rt-val blue">LFP</span></div>
    <div class="rt-row"><span class="rt-key">Balancer:</span><span class="rt-val ${balance?'':'red'}">${balance?'ON':'OFF'}</span></div>
  </div>
</div>

<!-- TAB STATUS: Cell voltages -->
<div id="tab-status" class="tab-content">
  <div class="section-hdr">● Cell Voltages (V)</div>
  <div class="cells-grid">${cellItemsHtml}</div>

  <div class="section-hdr">● Device Info</div>
  <div class="rt-grid">
    <div class="rt-row"><span class="rt-key">IP Local:</span><span class="rt-val blue">${d.local_ip||'—'}</span></div>
    <div class="rt-row"><span class="rt-key">Wi-Fi:</span><span class="rt-val">${d.ssid||'—'}</span></div>
    <div class="rt-row"><span class="rt-key">Hostname:</span><span class="rt-val">${d.hostname||'—'}</span></div>
    <div class="rt-row"><span class="rt-key">Firmware:</span><span class="rt-val blue">v${d.firmware_version||'—'}</span></div>
    <div class="rt-row"><span class="rt-key">BMS MAC:</span><span class="rt-val" style="font-size:0.65rem;">${d.active_bms_mac||'—'}</span></div>
    <div class="rt-row"><span class="rt-key">Kích Hoạt:</span><span class="rt-val" style="font-size:0.68rem;">${reg}</span></div>
  </div>
</div>

<!-- TAB CONTROL -->
<div id="tab-control" class="tab-content">
  <!-- BLE Manager -->
  <div class="ctrl-card" style="border-color:rgba(56,189,248,.3);">
    <div class="ctrl-title">📡 Kết Nối Bluetooth BMS</div>
    <div class="ctrl-row"><span class="ctrl-key">BMS đang kết nối:</span><span class="ctrl-val" id="bms-connected-status" style="color:${bleConnected?'#3fb950':'#f85149'};">${d.active_bms_name||(bleConnected?'JK-BMS':'Chưa kết nối')}</span></div>
    <div class="ctrl-row"><span class="ctrl-key">Địa chỉ MAC:</span><span class="ctrl-val" id="bms-mac-status" style="font-size:0.68rem;">${d.active_bms_mac||'—'}</span></div>
    <button class="btn-scan" onclick="scanBle()">🔍 Quét Bluetooth BMS Xung Quanh</button>
    <div class="scan-info" id="scan-status"></div>
    <div class="ble-list" id="ble-devices-list"><div id="ble-devices-grid"></div></div>
  </div>

  <!-- MOS Control -->
  <div class="ctrl-card">
    <div class="ctrl-title">🎛️ Điều Khiển MOSFET</div>
    <div class="ctrl-row"><span class="ctrl-key">Charge MOSFET:</span><span class="ctrl-val" style="color:${chargeMos?'#3fb950':'#f85149'}">${chargeMos?'ENABLED':'DISABLED'}</span></div>
    <div class="ctrl-row"><span class="ctrl-key">Discharge MOSFET:</span><span class="ctrl-val" style="color:${dischargeMos?'#3fb950':'#f85149'}">${dischargeMos?'ENABLED':'DISABLED'}</span></div>
    <div class="ctrl-row"><span class="ctrl-key">Active Balancer:</span><span class="ctrl-val" style="color:${balance?'#3fb950':'#f85149'}">${balance?'ENABLED':'DISABLED'}</span></div>
  </div>

  <!-- Device Info -->
  <div class="ctrl-card">
    <div class="ctrl-title">📟 Thông Tin Thiết Bị</div>
    <div class="ctrl-row"><span class="ctrl-key">Device ID:</span><span class="ctrl-val blue">${d.device_id}</span></div>
    <div class="ctrl-row"><span class="ctrl-key">IP Local:</span><span class="ctrl-val">${d.local_ip||'—'}</span></div>
    <div class="ctrl-row"><span class="ctrl-key">Hostname:</span><span class="ctrl-val">${d.hostname||'—'}</span></div>
    <div class="ctrl-row"><span class="ctrl-key">Firmware:</span><span class="ctrl-val blue">v${d.firmware_version||'—'}</span></div>
    <div class="ctrl-row"><span class="ctrl-key">Wi-Fi RSSI:</span><span class="ctrl-val">${rssiVal}</span></div>
    <button class="btn-danger" onclick="resetWifi()">🔄 Reset Cấu Hình Wi-Fi (AP Setup)</button>
    <div id="reset-msg" style="font-size:0.75rem;margin-top:8px;display:none;font-weight:600;text-align:center;"></div>
  </div>
</div>

<!-- FOOTER NAV -->
<div class="footer-nav">
  <button class="f-btn active" id="f-home" onclick="showTab('home')"><span class="f-icon">🏠</span>Home</button>
  <button class="f-btn" id="f-status" onclick="showTab('status')"><span class="f-icon">📊</span>Status</button>
  <button class="f-btn" id="f-control" onclick="showTab('control')"><span class="f-icon">🎛️</span>Control</button>
</div>

<script>
  function showTab(name) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.f-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    const idx = {home:0,status:1,control:2}[name] || 0;
    document.querySelectorAll('.tab-btn')[idx].classList.add('active');
    document.getElementById('f-' + name).classList.add('active');
  }

  function updateSocRing(socVal) {
    const ring = document.querySelector('circle:last-of-type');
    if (!ring) return;
    const dash = Math.round(socVal * 2.513);
    ring.setAttribute('stroke-dashoffset', 251.3 - dash);
    ring.setAttribute('stroke', socVal > 50 ? '#3fb950' : socVal > 20 ? '#e3b341' : '#f85149');
    const socEl = document.getElementById('hero-soc');
    if (socEl) socEl.textContent = socVal + '%';
    const bar = document.getElementById('bar-fill');
    if (bar) bar.style.width = socVal + '%';
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
          return '<div class="ble-item"><div><div style="font-size:0.8rem;font-weight:700;color:#e6edf3;">📟 '+name+'</div><div style="font-size:0.68rem;color:#8b949e;font-family:monospace;">'+mac+' • 📶 '+rssi+'</div></div><button class="btn-connect" onclick="connectBms(\''+mac+'\',\''+name+'\')">🔌 Kết Nối</button></div>';
        }).join('');
      }
    }
  }

  async function scanBle() {
    updateScanStatus('⏳ Đang gửi lệnh quét Bluetooth tới ESP32...', '#e3b341');
    try {
      await fetch('/api/send-command', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({device_id:'${d.device_id}', cmd:{cmd:'scan_ble'}}) });
      let attempts = 0;
      const timer = setInterval(async () => {
        attempts++;
        updateScanStatus('⏳ Đang quét... (' + (attempts*2) + 's)', '#e3b341');
        try {
          const res = await fetch('/api/scanned-ble?device_id=${d.device_id}');
          const data = await res.json();
          if (data.devices && data.devices.length > 0) { clearInterval(timer); updateScanStatus('✅ Tìm thấy '+data.devices.length+' thiết bị!', '#3fb950', data.devices); }
          else if (attempts >= 6) { clearInterval(timer); updateScanStatus('❌ Không tìm thấy JK-BMS nào.', '#f85149'); }
        } catch(e){}
      }, 2000);
    } catch(e) { updateScanStatus('❌ Lỗi gửi lệnh!', '#f85149'); }
  }

  async function connectBms(mac, name) {
    if (!confirm('Kết nối ESP32 tới BMS '+name+' ('+mac+')?')) return;
    const el = document.getElementById('scan-status');
    if (el) { el.style.display='block'; el.style.color='#e3b341'; el.textContent='⏳ Đang gửi lệnh kết nối...'; }
    try {
      await fetch('/api/send-command', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({device_id:'${d.device_id}', cmd:{cmd:'connect_bms', mac:mac, name:name, pin:'1234'}}) });
      if (el) { el.style.color='#3fb950'; el.textContent='✅ Đã gửi lệnh! ESP32 đang kết nối...'; }
      setTimeout(() => location.reload(), 4000);
    } catch(e) { if (el) { el.style.color='#f85149'; el.textContent='❌ Lỗi gửi lệnh!'; } }
  }

  async function resetWifi() {
    if (!confirm('Xác nhận Reset Wi-Fi thiết bị ${d.device_id}?')) return;
    const msgEl = document.getElementById('reset-msg');
    msgEl.style.display='block'; msgEl.style.color='#e3b341'; msgEl.textContent='⏳ Đang gửi lệnh Reset...';
    try {
      const res = await fetch('/api/send-command', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({device_id:'${d.device_id}', cmd:{cmd:'reset_wifi'}}) });
      const data = await res.json();
      msgEl.style.color = data.status==='ok' ? '#3fb950' : '#f85149';
      msgEl.textContent = data.status==='ok' ? '✅ Đã gửi lệnh reset thành công!' : '❌ Lỗi gửi lệnh!';
    } catch(e) { msgEl.style.color='#f85149'; msgEl.textContent='❌ Lỗi kết nối máy chủ!'; }
  }

  async function refreshLiveData() {
    try {
      const res = await fetch('/api/devices');
      if (!res.ok) return;
      const devices = await res.json();
      const dev = devices.find(item => item.device_id === '${d.device_id}');
      if (!dev) return;
      const bc = dev.connected && dev.voltage > 0;

      const heroV = document.getElementById('hero-v');
      if (heroV) heroV.innerHTML = (bc && dev.voltage ? dev.voltage.toFixed(2) : '—') + '<span class="vc-unit">V</span>';
      const heroA = document.getElementById('hero-a');
      if (heroA) heroA.innerHTML = (bc && dev.current !== undefined ? dev.current.toFixed(2) : '—') + '<span class="vc-unit">A</span>';
      if (bc && dev.soc !== undefined) updateSocRing(dev.soc);

      const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      if (bc) {
        const pow = dev.power !== undefined ? Math.abs(dev.power).toFixed(1) : '—';
        setEl('bar-curr', dev.current !== undefined ? dev.current.toFixed(2) : '—');
        setEl('bar-power', pow);
        setEl('rt-power', pow + ' W');
        setEl('rt-rem', (dev.remain_capacity_ah !== undefined ? dev.remain_capacity_ah.toFixed(1) : '—') + ' Ah');
        setEl('rt-mos', (dev.mos_temp !== undefined ? dev.mos_temp.toFixed(1) : '—') + ' °C');
        setEl('rt-cyc', dev.cycle_count !== undefined ? dev.cycle_count : '—');
        setEl('g-mostemp', dev.mos_temp !== undefined ? dev.mos_temp.toFixed(1) : '—');
        setEl('g-rem', dev.remain_capacity_ah !== undefined ? dev.remain_capacity_ah.toFixed(1) : '—');
        setEl('rt-cap', (dev.capacity_ah !== undefined ? dev.capacity_ah.toFixed(1) : '—') + ' Ah');
        setEl('rt-bal', (dev.balance_current !== undefined ? dev.balance_current.toFixed(3) : '—') + ' A');
      }

      const bleEl = document.getElementById('bms-connected-status');
      if (bleEl) { bleEl.textContent = bc ? (dev.active_bms_name||'JK-BMS') : 'Chưa kết nối'; bleEl.style.color = bc ? '#3fb950' : '#f85149'; }
      const macEl = document.getElementById('bms-mac-status');
      if (macEl) macEl.textContent = dev.active_bms_mac || '—';
    } catch(e){}
  }

  setInterval(refreshLiveData, 3000);
  refreshLiveData();
</script>
</body>
</html>`;
}


function DEVICE_NOT_FOUND_HTML(deviceId) {
  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Không tìm thấy thiết bị</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Inter',sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;}
.icon{font-size:4rem;margin-bottom:16px;}.h{font-size:1.3rem;font-weight:700;margin-bottom:8px;}.s{color:#8b949e;font-size:0.85rem;line-height:1.6;}.id{font-family:monospace;background:#161b22;padding:4px 10px;border-radius:6px;color:#f85149;}</style>
</head><body><div><div class="icon">📡</div><div class="h">Không tìm thấy thiết bị</div>
<div class="s">ID <span class="id">${deviceId}</span> chưa đăng ký hoặc chưa kết nối lần nào.<br>Kiểm tra lại thiết bị và đảm bảo đã kết nối WiFi.</div></div></body></html>`;
}
