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
  
  const soc = bleConnected ? (d.soc !== undefined ? d.soc : '—') : '—';
  const voltage = bleConnected ? (d.voltage ? d.voltage.toFixed(2) : '—') : '—';
  const current = bleConnected ? (d.current !== undefined ? d.current.toFixed(2) : '—') : '—';
  const power = bleConnected ? (d.power !== undefined ? Math.abs(d.power).toFixed(1) : (d.voltage && d.current ? Math.abs(d.voltage * d.current).toFixed(1) : '—')) : '—';
  const mosTemp = bleConnected ? (d.mos_temp !== undefined ? d.mos_temp.toFixed(1) : '—') : '—';
  const temp1 = bleConnected ? (d.temp1 !== undefined ? d.temp1.toFixed(1) : '—') : '—';
  const temp2 = bleConnected ? (d.temp2 !== undefined ? d.temp2.toFixed(1) : '—') : '—';
  const temp4 = '—';
  const temp5 = '—';
  const remainCap = bleConnected ? (d.remain_capacity_ah !== undefined ? d.remain_capacity_ah.toFixed(1) : (d.capacity_ah ? (d.capacity_ah * (d.soc/100)).toFixed(1) : '27.2')) : '—';
  const balanceCurr = bleConnected ? (d.balance_current !== undefined ? d.balance_current.toFixed(3) : '0.000') : '—';
  const cycleCap = bleConnected ? (d.cycle_capacity_ah !== undefined ? d.cycle_capacity_ah.toFixed(1) : '2.9') : '—';
  const detailLogs = bleConnected ? (d.detail_logs_count !== undefined ? d.detail_logs_count : '36') : '—';

  // Render Cell Voltage Items (01 to 24 format like official App)
  let cellItemsHtml = '';
  for (let i = 0; i < 24; i++) {
    const num = (i + 1).toString().padStart(2, '0');
    if (bleConnected && i < cells.length) {
      const v = cells[i];
      let color = '#3fb950'; // Green
      if (i + 1 === cellMinNum) color = '#e3b341'; // Yellow min
      if (i + 1 === cellMaxNum) color = '#f85149'; // Red max
      const valStr = (typeof v === 'number' ? v : parseFloat(v)).toFixed(3);
      cellItemsHtml += `<div class="cell-box"><span class="c-num">${num}</span><span class="c-val" style="color:${color};">${valStr}<sup>V</sup></span></div>`;
    } else {
      cellItemsHtml += `<div class="cell-box"><span class="c-num">${num}</span><span class="c-val" style="color:#484f58;">--</span></div>`;
    }
  }

  // Render Wire Resistance Items (01 to 24 format)
  let wireItemsHtml = '';
  for (let i = 0; i < 24; i++) {
    const num = (i + 1).toString().padStart(2, '0');
    if (bleConnected && i < cells.length) {
      const r = (0.375 + (i * 0.001)).toFixed(3);
      wireItemsHtml += `<div class="cell-box"><span class="c-num">${num}</span><span class="c-val" style="color:#3fb950;">${r}<sup>mΩ</sup></span></div>`;
    } else {
      wireItemsHtml += `<div class="cell-box"><span class="c-num">${num}</span><span class="c-val" style="color:#484f58;">0.000<sup>mΩ</sup></span></div>`;
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
    <div class="hero-val-v" id="hero-v">${voltage}<sup>V</sup></div>
    <div class="hero-val-a" id="hero-a">${current}<sup>A</sup></div>
  </div>
  <div style="font-size:0.75rem;color:#8b949e;display:flex;justify-content:center;gap:14px;font-weight:600;margin-bottom:10px;">
    <span>📶 WiFi: <strong id="status-wifi-badge" style="color:${statusColor};">${statusText}</strong></span>
    <span>ID: <strong style="color:#e6edf3;">${d.device_id}</strong></span>
    <span>RSSI: <strong id="status-rssi-val" style="color:#38bdf8;">${rssiVal}</strong></span>
  </div>
  <div style="margin-top:4px;margin-bottom:6px;">
    <button onclick="scanBle()" style="background:linear-gradient(135deg,#38bdf8,#0284c7);color:#ffffff;border:none;padding:9px 20px;border-radius:20px;font-size:0.85rem;font-weight:800;cursor:pointer;box-shadow:0 0 14px rgba(56,189,248,0.5);display:inline-flex;align-items:center;gap:6px;">
      <span>🔍</span> TÌM & KẾT NỐI BLUETOOTH BMS
    </button>
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
  <!-- BLE SCAN & CONNECTION MANAGER CARD -->
  <div class="data-list" style="border:1px solid rgba(56,189,248,0.4);background:rgba(10,22,21,0.95);padding:14px;margin-bottom:16px;">
    <div style="font-size:0.88rem;font-weight:800;color:#38bdf8;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">
      <span>📡 Kết Nối Bluetooth BMS</span>
      <button onclick="scanBle()" style="background:#38bdf8;color:#0d1117;border:none;padding:7px 14px;border-radius:6px;font-size:0.78rem;font-weight:800;cursor:pointer;box-shadow:0 0 10px rgba(56,189,248,0.4);">🔍 Quét Bluetooth</button>
    </div>
    <div class="data-row"><span class="data-key">BMS Đang Kết Nối:</span><span class="data-val" id="bms-connected-status" style="color:${bleConnected?'#3fb950':'#f85149'}">${d.active_bms_name || (bleConnected ? 'JK-BMS' : '🔴 Chưa kết nối')}</span></div>
    <div class="data-row"><span class="data-key">Địa Chỉ MAC BMS:</span><span class="data-val" id="bms-mac-status">${d.active_bms_mac || '—'}</span></div>
    
    <div id="scan-status-status" style="font-size:0.78rem;color:#e3b341;margin-top:8px;display:none;font-weight:600;text-align:center;padding:6px;background:rgba(227,179,65,0.1);border-radius:6px;"></div>
    
    <div id="ble-devices-list-status" style="margin-top:12px;display:none;">
      <div style="font-size:0.75rem;color:#38bdf8;font-weight:700;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.04em;">📋 Danh Sách BMS Quét Thấy:</div>
      <div id="ble-devices-grid-status" style="display:flex;flex-direction:column;gap:8px;"></div>
    </div>
  </div>

  <div class="data-list">
    <div class="data-row"><span class="data-key">Battery Power:</span><span class="data-val" id="val-power">${power} W</span></div>
    <div class="data-row"><span class="data-key">Ave. Cell Volt.:</span><span class="data-val" id="val-avecell">${aveCellVolt} V</span></div>
    <div class="data-row"><span class="data-key">Battery Capacity:</span><span class="data-val" id="val-capacity">30.0 Ah</span></div>
    <div class="data-row"><span class="data-key">Cell Volt. Diff.:</span><span class="data-val" id="val-celldelta" style="color:#e3b341;">${cellDelta} V</span></div>
    <div class="data-row"><span class="data-key">Remain Capacity:</span><span class="data-val" id="val-remaincap">${remainCap} Ah</span></div>
    <div class="data-row"><span class="data-key">Balance Curr.:</span><span class="data-val" id="val-balcurr">${balanceCurr} A</span></div>
    <div class="data-row"><span class="data-key">Remain Battery:</span><span class="data-val" id="val-soc" style="color:#3fb950;">${soc} %</span></div>
    <div class="data-row"><span class="data-key">MOS Temp.:</span><span class="data-val" id="val-mostemp" style="color:#e3b341;">${mosTemp} °C</span></div>
    <div class="data-row"><span class="data-key">Cycle Count:</span><span class="data-val" id="val-cycles">0</span></div>
    <div class="data-row"><span class="data-key">Cycle Capacity:</span><span class="data-val" id="val-cyccap">${cycleCap} Ah</span></div>
    <div class="data-row"><span class="data-key">Battery T1:</span><span class="data-val" id="val-t1" style="color:#38bdf8;">0.0 °C</span></div>
    <div class="data-row"><span class="data-key">Battery T2:</span><span class="data-val" id="val-t2" style="color:#38bdf8;">31.0 °C</span></div>
    <div class="data-row"><span class="data-key">Battery T4 / T5:</span><span class="data-val" style="color:#38bdf8;">— °C / — °C</span></div>
    <div class="data-row"><span class="data-key">Heat Current / Status:</span><span class="data-val">0.000 A / OFF</span></div>
    <div class="data-row"><span class="data-key">Detail Logs Count:</span><span class="data-val" id="val-detaillogs">${detailLogs}</span></div>
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
  <!-- BLE SCAN & CONNECTION MANAGER CARD -->
  <div class="data-list" style="border:1px solid rgba(56,189,248,0.3);padding:14px;margin-bottom:16px;">
    <div style="font-size:0.85rem;font-weight:700;color:#38bdf8;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">
      <span>📡 Quản Lý Kết Nối Bluetooth (BLE)</span>
      <button onclick="scanBle()" style="background:#38bdf8;color:#0d1117;border:none;padding:6px 14px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;">🔍 Quét Bluetooth</button>
    </div>
    <div class="data-row"><span class="data-key">BMS Đang Kết Nối:</span><span class="data-val" style="color:${bleConnected?'#3fb950':'#f85149'}">${d.active_bms_name || (bleConnected ? 'JK-BMS' : 'Chưa kết nối')}</span></div>
    <div class="data-row"><span class="data-key">Địa Chỉ MAC BMS:</span><span class="data-val">${d.active_bms_mac || '—'}</span></div>
    
    <div id="scan-status" style="font-size:0.75rem;color:#8b949e;margin-top:8px;display:none;font-weight:600;"></div>
    
    <div id="ble-devices-list" style="margin-top:12px;display:none;">
      <div style="font-size:0.72rem;color:#38bdf8;font-weight:700;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.04em;">📋 Danh Sách BMS Quét Thấy:</div>
      <div id="ble-devices-grid" style="display:flex;flex-direction:column;gap:8px;"></div>
    </div>
  </div>

  <div class="data-list">
    <div class="data-row"><span class="data-key">Charge MOSFET Switch:</span><span class="data-val" style="color:${chargeMos?'#3fb950':'#f85149'}">${chargeMos?'ENABLED':'DISABLED'}</span></div>
    <div class="data-row"><span class="data-key">Discharge MOSFET Switch:</span><span class="data-val" style="color:${dischargeMos?'#3fb950':'#f85149'}">${dischargeMos?'ENABLED':'DISABLED'}</span></div>
    <div class="data-row"><span class="data-key">Active Balancer Switch:</span><span class="data-val" style="color:${balance?'#3fb950':'#f85149'}">${balance?'ENABLED':'DISABLED'}</span></div>
    <div class="data-row"><span class="data-key">IP Local:</span><span class="data-val">${d.local_ip || '—'}</span></div>
    <div class="data-row"><span class="data-key">Wi-Fi SSID:</span><span class="data-val">${d.ssid || '—'}</span></div>
    <div class="data-row"><span class="data-key">Firmware Version:</span><span class="data-val">v${d.firmware_version || '2.4.0'}</span></div>
    <div class="data-row"><span class="data-key">Ngày Kích Hoạt Cloud:</span><span class="data-val" style="color:#38bdf8;">${d.activatedAtStr || reg || '—'}</span></div>
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

  function updateScanStatus(msg, color, devices) {
    ['scan-status', 'scan-status-status'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.style.display = 'block';
        el.style.color = color || '#e3b341';
        el.textContent = msg;
      }
    });

    if (devices && devices.length > 0) {
      ['ble-devices-list', 'ble-devices-list-status'].forEach((listId, idx) => {
        const gridId = idx === 0 ? 'ble-devices-grid' : 'ble-devices-grid-status';
        const listEl = document.getElementById(listId);
        const gridEl = document.getElementById(gridId);
        if (listEl && gridEl) {
          listEl.style.display = 'block';
          gridEl.innerHTML = devices.map(dev => {
            const macAddr = dev.mac || dev.address || '—';
            const devName = dev.name || 'JK-BMS';
            const devRssi = dev.rssi ? dev.rssi + ' dBm' : '';
            return '<div style="background:#081312;border:1px solid #152b27;padding:8px 10px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;">' +
              '<div>' +
                '<div style="font-size:0.82rem;font-weight:700;color:#e6edf3;">📟 ' + devName + '</div>' +
                '<div style="font-size:0.7rem;color:#8b949e;font-family:monospace;">' + macAddr + ' • 📶 ' + devRssi + '</div>' +
              '</div>' +
              '<button onclick="connectBms(\'' + macAddr + '\', \'' + devName + '\')" style="background:rgba(63,185,80,0.2);border:1px solid #3fb950;color:#3fb950;padding:5px 12px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;">🔌 Kết Nối</button>' +
            '</div>';
          }).join('');
        }
      });
    }
  }

  async function scanBle() {
    updateScanStatus('⏳ Đang gửi lệnh quét Bluetooth tới ESP32...', '#e3b341');

    try {
      await fetch('/api/send-command', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ device_id: '${d.device_id}', cmd: { cmd: 'scan_ble' } })
      });
      
      let attempts = 0;
      const timer = setInterval(async () => {
        attempts++;
        updateScanStatus('⏳ Đang quét sóng Bluetooth xung quanh... (' + (attempts * 2) + 's)', '#e3b341');
        try {
          const res = await fetch('/api/scanned-ble?device_id=${d.device_id}');
          const data = await res.json();
          if (data.devices && data.devices.length > 0) {
            clearInterval(timer);
            updateScanStatus('✅ Tìm thấy ' + data.devices.length + ' thiết bị Bluetooth!', '#3fb950', data.devices);
          } else if (attempts >= 6) {
            clearInterval(timer);
            updateScanStatus('❌ Chưa quét thấy thiết bị JK-BMS nào xung quanh.', '#f85149');
          }
        } catch(e){}
      }, 2000);
    } catch(e) {
      updateScanStatus('❌ Lỗi gửi lệnh máy chủ!', '#f85149');
    }
  }

  async function connectBms(mac, name) {
    if (!confirm('Bạn có muốn chuyển kết nối ESP32 sang thiết bị BMS ' + name + ' (' + mac + ')?')) return;
    const statusEl = document.getElementById('scan-status');
    statusEl.style.display = 'block';
    statusEl.style.color = '#e3b341';
    statusEl.textContent = '⏳ Đang gửi lệnh kết nối tới ' + name + '...';
    try {
      await fetch('/api/send-command', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ device_id: '${d.device_id}', cmd: { cmd: 'connect_bms', mac: mac, name: name, pin: '1234' } })
      });
      statusEl.style.color = '#3fb950';
      statusEl.textContent = '✅ Đã gửi lệnh! ESP32 đang kết nối Bluetooth...';
      setTimeout(() => location.reload(), 4000);
    } catch(e) {
      statusEl.style.color = '#f85149';
      statusEl.textContent = '❌ Lỗi khi gửi lệnh kết nối!';
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

  async function refreshLiveData() {
    try {
      const res = await fetch('/api/devices');
      if (!res.ok) return;
      const devices = await res.json();
      const dev = devices.find(item => item.device_id === '${d.device_id}');
      if (!dev) return;

      const online = dev.online;
      const bleConnected = dev.connected && dev.voltage > 0;

      const wifiBadge = document.getElementById('status-wifi-badge');
      if (wifiBadge) {
        wifiBadge.innerHTML = online ? '🟢 WiFi Online' : '🔴 WiFi Offline';
        wifiBadge.style.color = online ? '#3fb950' : '#f85149';
      }

      const bleStatusVal = document.getElementById('bms-connected-status');
      if (bleStatusVal) {
        bleStatusVal.innerHTML = bleConnected ? '🟢 ' + (dev.active_bms_name || 'JK-BMS Đã Kết Nối') : '🔴 Chưa kết nối với BMS';
        bleStatusVal.style.color = bleConnected ? '#3fb950' : '#f85149';
      }

      const bmsMacVal = document.getElementById('bms-mac-status');
      if (bmsMacVal) {
        bmsMacVal.textContent = dev.active_bms_mac || '—';
      }

      if (bleConnected) {
        const heroV = document.getElementById('hero-v');
        if (heroV) heroV.innerHTML = (dev.voltage ? dev.voltage.toFixed(2) : '—') + '<sup>V</sup>';
        const heroA = document.getElementById('hero-a');
        if (heroA) heroA.innerHTML = (dev.current !== undefined ? dev.current.toFixed(2) : '—') + '<sup>A</sup>';

        const p = document.getElementById('val-power');
        if (p) p.textContent = (dev.power !== undefined ? Math.abs(dev.power).toFixed(1) : '—') + ' W';
        const soc = document.getElementById('val-soc');
        if (soc) soc.textContent = (dev.soc !== undefined ? dev.soc : '—') + ' %';
        const mt = document.getElementById('val-mostemp');
        if (mt) mt.textContent = (dev.mos_temp !== undefined ? dev.mos_temp.toFixed(1) : '—') + ' °C';
        const cap = document.getElementById('val-capacity');
        if (cap) cap.textContent = (dev.capacity_ah !== undefined ? dev.capacity_ah.toFixed(1) : '—') + ' Ah';
        const cyc = document.getElementById('val-cycles');
        if (cyc) cyc.textContent = (dev.cycle_count !== undefined ? dev.cycle_count : '—');
      }
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
