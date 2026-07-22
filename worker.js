const OFFLINE_MS = 3 * 60 * 1000; // 3 minutes

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
        return new Response(e.message, { status: 500 });
      }
    }

    // ── POST /api/register-device ─────────────────────────────
    if (method === 'POST' && path === '/api/register-device') {
      try {
        const body = await request.json();
        const deviceId = body.device_id;
        if (!deviceId) return jsonResponse({ error: 'device_id required' }, 400, corsHeaders);

        const existingRaw = await env.DEVICES.get(deviceId);
        const existing = existingRaw ? JSON.parse(existingRaw) : {};
        const now = Date.now();

        const device = {
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
          connected: existing.connected || false,
          voltage: existing.voltage || 0,
          current: existing.current || 0,
          soc: existing.soc || 0,
          mos_temp: existing.mos_temp || 0,
        };

        await env.DEVICES.put(deviceId, JSON.stringify(device));

        // Also add to device list index
        const listRaw = await env.DEVICES.get('__device_list__');
        const deviceList = listRaw ? JSON.parse(listRaw) : [];
        if (!deviceList.includes(deviceId)) {
          deviceList.push(deviceId);
          await env.DEVICES.put('__device_list__', JSON.stringify(deviceList));
        }

        return jsonResponse({ status: 'ok', message: 'Registered', device_id: deviceId }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/device-heartbeat ────────────────────────────
    if (method === 'POST' && path === '/api/device-heartbeat') {
      try {
        const body = await request.json();
        const deviceId = body.device_id;
        if (!deviceId) return jsonResponse({ error: 'device_id required' }, 400, corsHeaders);

        const existingRaw = await env.DEVICES.get(deviceId);
        const existing = existingRaw ? JSON.parse(existingRaw) : { device_id: deviceId, registeredAt: Date.now() };

        const device = {
          ...existing,
          local_ip: body.local_ip || existing.local_ip || '',
          ssid: body.ssid || existing.ssid || '',
          rssi: body.rssi || existing.rssi || 0,
          firmware_version: body.firmware || existing.firmware_version || '',
          connected: body.connected !== undefined ? Boolean(body.connected) : false,
          voltage: body.voltage !== undefined ? parseFloat(body.voltage) : 0,
          current: body.current !== undefined ? parseFloat(body.current) : 0,
          soc: body.soc !== undefined ? parseInt(body.soc) : 0,
          mos_temp: body.mos_temp !== undefined ? parseFloat(body.mos_temp) : 0,
          lastSeen: Date.now(),
        };

        await env.DEVICES.put(deviceId, JSON.stringify(device));
        return jsonResponse({ status: 'ok' }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/send-command ────────────────────────────────
    if (method === 'POST' && path === '/api/send-command') {
      try {
        const body = await request.json();
        const { device_id, cmd } = body;
        if (!device_id || !cmd) return jsonResponse({ error: 'device_id and cmd required' }, 400, corsHeaders);

        let targetIds = [device_id];
        if (device_id === 'all') {
          const listRaw = await env.DEVICES.get('__device_list__');
          targetIds = listRaw ? JSON.parse(listRaw) : [];
        }

        for (const id of targetIds) {
          const key = `__cmds_${id}__`;
          const raw = await env.DEVICES.get(key);
          const cmds = raw ? JSON.parse(raw) : [];
          cmds.push(cmd);
          await env.DEVICES.put(key, JSON.stringify(cmds));
        }

        return jsonResponse({ status: 'ok', message: 'Command queued' }, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/device-commands ──────────────────────────────
    if (method === 'GET' && path === '/api/device-commands') {
      try {
        const deviceId = url.searchParams.get('device_id');
        if (!deviceId) return jsonResponse([], 200, corsHeaders);

        const key = `__cmds_${deviceId}__`;
        const raw = await env.DEVICES.get(key);
        const cmds = raw ? JSON.parse(raw) : [];

        if (cmds.length > 0) {
          await env.DEVICES.delete(key);
        }

        return jsonResponse(cmds, 200, corsHeaders);
      } catch(e) {
        return jsonResponse([], 200, corsHeaders);
      }
    }

    // ── GET /api/devices ──────────────────────────────────────
    if (method === 'GET' && path === '/api/devices') {
      try {
        const listRaw = await env.DEVICES.get('__device_list__');
        const deviceList = listRaw ? JSON.parse(listRaw) : [];

        const devices = [];
        for (const id of deviceList) {
          const raw = await env.DEVICES.get(id);
          if (raw) {
            const d = JSON.parse(raw);
            devices.push({
              ...d,
              online: isOnline(d),
              lastSeenAgo: d.lastSeen ? Math.floor((Date.now() - d.lastSeen) / 1000) : null,
            });
          }
        }
        devices.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        return jsonResponse(devices, 200, corsHeaders);
      } catch (e) {
        return jsonResponse([], 200, corsHeaders);
      }
    }

    // ── GET /d/:deviceId (Customer Device Page) ───────────────
    if (method === 'GET' && path.startsWith('/d/')) {
      const deviceId = path.slice(3);
      if (!deviceId) return new Response('Device ID required', { status: 400 });

      const raw = await env.DEVICES.get(deviceId);
      if (!raw) {
        return new Response(DEVICE_NOT_FOUND_HTML(deviceId), {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      const d = JSON.parse(raw);
      d.online = isOnline(d);
      d.lastSeenAgo = d.lastSeen ? Math.floor((Date.now() - d.lastSeen) / 1000) : null;

      return new Response(CUSTOMER_DEVICE_HTML(d), {
        headers: { 
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
        },
      });
    }

    // ── GET / (Dashboard) ─────────────────────────────────────
    if (method === 'GET' && (path === '/' || path === '')) {
      return new Response(DASHBOARD_HTML, {
        headers: { 
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
        },
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

function jsonResponse(data, status, corsHeaders) {
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
  body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
  header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;}
  .logo{display:flex;align-items:center;gap:12px;}
  .logo-icon{width:36px;height:36px;background:linear-gradient(135deg,var(--primary),#1a7f37);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;}
  .logo h1{font-size:1.1rem;font-weight:700;}.logo span{font-size:0.75rem;color:var(--subtext);}
  .refresh-badge{font-size:0.75rem;color:var(--subtext);background:var(--surface2);padding:4px 10px;border-radius:20px;border:1px solid var(--border);}
  .stats-bar{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:20px 24px;max-width:1200px;margin:0 auto;}
  .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 20px;display:flex;align-items:center;gap:14px;}
  .stat-icon{width:44px;height:44px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;}
  .stat-icon.green{background:var(--primary-dim);}.stat-icon.red{background:var(--danger-dim);}.stat-icon.blue{background:rgba(88,166,255,0.15);}
  .stat-val{font-size:1.6rem;font-weight:700;line-height:1;}.stat-label{font-size:0.78rem;color:var(--subtext);margin-top:2px;}
  .content{max-width:1200px;margin:0 auto;padding:0 24px 32px;}
  .section-title{font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--subtext);margin-bottom:12px;}
  .device-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px;}
  .device-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px;transition:border-color 0.2s,transform 0.15s;position:relative;}
  .device-card:hover{border-color:var(--accent);transform:translateY(-2px);}
  .device-card.online{border-left:3px solid var(--primary);}.device-card.offline{border-left:3px solid var(--danger);opacity:0.65;}
  .card-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;}
  .device-name{font-weight:600;font-size:1rem;}.device-sub{font-size:0.75rem;color:var(--subtext);margin-top:2px;font-family:monospace;}
  .badge{font-size:0.7rem;font-weight:600;padding:3px 8px;border-radius:20px;white-space:nowrap;}
  .badge-online{background:var(--primary-dim);color:var(--primary);border:1px solid rgba(63,185,80,0.3);}
  .badge-offline{background:var(--danger-dim);color:var(--danger);border:1px solid rgba(248,81,73,0.3);}
  .metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;}
  .metric{background:var(--surface2);border-radius:8px;padding:10px 12px;}
  .metric-val{font-size:1.15rem;font-weight:700;line-height:1;}
  .metric-val.green{color:var(--primary);}.metric-val.blue{color:var(--accent);}.metric-val.warning{color:var(--warning);}
  .metric-label{font-size:0.7rem;color:var(--subtext);margin-top:3px;}
  .device-info{border-top:1px solid var(--border);padding-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:6px;}
  .info-row{display:flex;flex-direction:column;}
  .info-key{font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--subtext);}
  .info-val{font-size:0.8rem;font-weight:500;font-family:monospace;margin-top:1px;}
  .no-devices{grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--subtext);}
  .no-devices .icon{font-size:3rem;margin-bottom:12px;}.no-devices h3{font-size:1rem;font-weight:600;margin-bottom:6px;color:var(--text);}
  .last-seen{font-size:0.7rem;color:var(--subtext);margin-top:8px;text-align:right;}
  .pulse{width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 1.5s ease-in-out infinite;display:inline-block;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.3;}}
  @media(max-width:600px){.stats-bar{grid-template-columns:1fr;padding:16px;}.device-grid{grid-template-columns:1fr;}.content{padding:0 16px 24px;}}
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">🔋</div>
    <div><h1>JK BMS Cloud</h1><span>Quản lý thiết bị tập trung</span></div>
  </div>
  <span class="refresh-badge" id="refresh-label">Đang tải...</span>
</header>
<div class="stats-bar">
  <div class="stat-card"><div class="stat-icon green">📡</div><div><div class="stat-val" id="stat-online">—</div><div class="stat-label">Thiết bị Online</div></div></div>
  <div class="stat-card"><div class="stat-icon red">⚠️</div><div><div class="stat-val" id="stat-offline">—</div><div class="stat-label">Thiết bị Offline</div></div></div>
  <div class="stat-card"><div class="stat-icon blue">🔩</div><div><div class="stat-val" id="stat-total">—</div><div class="stat-label">Tổng Thiết Bị</div></div></div>
</div>
<div class="content">
  <div class="section-title" style="margin-bottom:14px;">📋 Danh sách thiết bị</div>
  <div class="device-grid" id="device-grid"><div class="no-devices"><div class="icon">⏳</div><h3>Đang tải...</h3></div></div>
</div>
<script>
  function timeSince(s){if(!s&&s!==0)return'Chưa rõ';if(s<60)return s+'s trước';if(s<3600)return Math.floor(s/60)+' phút trước';return Math.floor(s/3600)+' giờ trước';}
  async function fetchDevices(){
    try{
      const res=await fetch('/api/devices');const devices=await res.json();
      document.getElementById('stat-online').textContent=devices.filter(d=>d.online).length;
      document.getElementById('stat-offline').textContent=devices.filter(d=>!d.online).length;
      document.getElementById('stat-total').textContent=devices.length;
      document.getElementById('refresh-label').textContent='Cập nhật: '+new Date().toLocaleTimeString('vi-VN');
      const grid=document.getElementById('device-grid');
      if(!devices.length){grid.innerHTML='<div class="no-devices"><div class="icon">📡</div><h3>Chưa có thiết bị nào</h3><p>ESP32-C3 tự động xuất hiện khi kết nối Wi-Fi.</p></div>';return;}
      grid.innerHTML=devices.map(d=>{
        const socColor=d.soc>50?'green':d.soc>20?'warning':'danger';
        return \`<div class="device-card \${d.online?'online':'offline'}">
          <div class="card-header">
            <div><div class="device-name">📟 \${d.device_id}</div><div class="device-sub">\${d.mac||''}</div></div>
            <span class="badge \${d.online?'badge-online':'badge-offline'}">\${d.online?'<span class=\\'pulse\\'></span> Online':'Offline'}</span>
          </div>
          <div class="metrics">
            <div class="metric"><div class="metric-val blue">\${(d.voltage||0).toFixed(1)} V</div><div class="metric-label">Điện áp Pack</div></div>
            <div class="metric"><div class="metric-val \${socColor}">\${d.soc||0} %</div><div class="metric-label">SoC Pin</div></div>
            <div class="metric"><div class="metric-val">\${(d.current||0).toFixed(1)} A</div><div class="metric-label">Dòng điện</div></div>
            <div class="metric"><div class="metric-val warning">\${(d.mos_temp||0).toFixed(1)} °C</div><div class="metric-label">Nhiệt độ MOS</div></div>
          </div>
          <div class="device-info">
            <div class="info-row"><span class="info-key">IP Local</span><span class="info-val">\${d.local_ip||'—'}</span></div>
            <div class="info-row"><span class="info-key">Wi-Fi</span><span class="info-val">\${d.ssid||'—'}</span></div>
            <div class="info-row"><span class="info-key">Hostname</span><span class="info-val">\${d.hostname||'—'}</span></div>
            <div class="info-row"><span class="info-key">Firmware</span><span class="info-val">v\${d.firmware_version||'—'}</span></div>
          </div>
          <div class="last-seen">🕐 \${d.online?'Hoạt động ':'Offline từ '}\${timeSince(d.lastSeenAgo)}</div>
        </div>\`;
      }).join('');
    }catch(e){document.getElementById('refresh-label').textContent='Lỗi kết nối!';}
  }
  fetchDevices();setInterval(fetchDevices,10000);
</script>
</body>
</html>`;

// ── CUSTOMER DEVICE PAGE ──────────────────────────────────────────────────────
function CUSTOMER_DEVICE_HTML(d) {
  const online = d.online;
  const bleConnected = d.connected;
  const soc = d.soc || 0;
  const voltage = (d.voltage || 0).toFixed(2);
  const current = (d.current || 0).toFixed(1);
  const power = (d.power || (d.voltage * d.current) || 0).toFixed(1);
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
<title>Giám Sát Pin - ${d.device_id}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Inter',sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh;padding-bottom:30px;}
  .hero{background:linear-gradient(135deg,#0d1117 0%,#161b22 50%,#0d1117 100%);padding:28px 20px 0;text-align:center;position:relative;overflow:hidden;}
  .hero::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(63,185,80,0.12) 0%,transparent 70%);}
  .status-dot{width:10px;height:10px;border-radius:50%;background:${statusColor};display:inline-block;margin-right:6px;animation:${online ? 'pulse' : 'none'} 1.5s ease-in-out infinite;}
  .status-badge{display:inline-flex;align-items:center;background:${online ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)'};border:1px solid ${statusColor}33;color:${statusColor};padding:5px 14px;border-radius:20px;font-size:0.8rem;font-weight:600;margin-bottom:14px;}
  h1{font-size:1.5rem;font-weight:800;letter-spacing:-0.02em;margin-bottom:2px;}
  .device-id{font-size:0.8rem;color:#8b949e;font-family:monospace;margin-bottom:14px;}
  .ble-status{font-size:0.9rem;font-weight:700;color:${bleColor};margin-bottom:20px;padding:6px 16px;background:rgba(255,255,255,0.04);border-radius:20px;display:inline-block;}
  
  .soc-ring{position:relative;width:170px;height:170px;margin:0 auto 24px;}
  .soc-ring svg{transform:rotate(-90deg);}
  .soc-ring circle{fill:none;stroke-width:12;stroke-linecap:round;}
  .soc-track{stroke:#21262d;}
  .soc-fill{stroke:${socColor};stroke-dasharray:${Math.PI * 2 * 68};stroke-dashoffset:${Math.PI * 2 * 68 * (1 - soc / 100)};transition:stroke-dashoffset 1s ease;}
  .soc-label{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}
  .soc-val{font-size:2.4rem;font-weight:800;color:${socColor};line-height:1;}
  .soc-unit{font-size:0.8rem;color:#8b949e;margin-top:2px;}

  .section{max-width:440px;margin:0 auto;padding:0 16px 16px;}
  .section-title{font-size:0.8rem;font-weight:700;color:#58a6ff;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;display:flex;align-items:center;gap:6px;}

  .metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  .metric-card{background:#161b22;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px 14px;}
  .metric-icon{font-size:1.3rem;margin-bottom:6px;}
  .metric-val{font-size:1.35rem;font-weight:800;line-height:1;}
  .metric-label{font-size:0.7rem;color:#8b949e;margin-top:4px;text-transform:uppercase;letter-spacing:0.05em;}

  .info-card{background:#161b22;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px 16px;}
  .info-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05);}
  .info-row:last-child{border-bottom:none;}
  .info-key{font-size:0.78rem;color:#8b949e;}
  .info-val{font-size:0.82rem;font-weight:600;font-family:monospace;color:#e6edf3;}

  .cells-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px;}

  .status-pill{padding:4px 10px;border-radius:12px;font-size:0.75rem;font-weight:700;}
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
    <h1>🔋 Giám Sát Pin JK-BMS</h1>
    <div class="device-id">ID: ${d.device_id}</div>
    <div class="ble-status">${bleText}</div>
    
    <div class="soc-ring">
      <svg width="170" height="170" viewBox="0 0 170 170">
        <circle class="soc-track" cx="85" cy="85" r="68"/>
        <circle class="soc-fill" cx="85" cy="85" r="68"/>
      </svg>
      <div class="soc-label">
        <span class="soc-val">${soc}</span>
        <span class="soc-unit">% Dung Lượng</span>
      </div>
    </div>
  </div>
</div>

<!-- BLOCK 1: THÔNG SỐ TỔNG QUAN -->
<div class="section">
  <div class="section-title">⚡ Thông Số Điện Áp & Dòng Điện</div>
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
      <div class="metric-label">Nhiệt Đồ Cảm Biến T1 / T2</div>
    </div>
  </div>
</div>

<!-- BLOCK 2: CHI TIẾT CELL VOLTAGES -->
<div class="section">
  <div class="section-title">📊 Điện Áp Chi Tiết Từng Cell</div>
  <div class="info-card">
    <div class="info-row"><span class="info-key">Cell Cao Nhất (Max)</span><span class="info-val" style="color:#3fb950;">Cell ${cellMaxNum} (${cellMax} V)</span></div>
    <div class="info-row"><span class="info-key">Cell Thấp Nhất (Min)</span><span class="info-val" style="color:#f85149;">Cell ${cellMinNum} (${cellMin} V)</span></div>
    <div class="info-row"><span class="info-key">Chênh Lệch App (ΔV)</span><span class="info-val" style="color:#e3b341;">${cellDelta} V</span></div>
    <div class="info-row"><span class="info-key">Số Chu Kỳ Sạc/Xả</span><span class="info-val">${cycleCount} Chu Kỳ</span></div>
    
    <div style="font-size:0.75rem;color:#8b949e;margin-top:12px;margin-bottom:6px;font-weight:bold;">LƯỚI ĐIỆN ÁP CELL (C1 - C${cells.length || 'N'}):</div>
    <div class="cells-grid">
      ${cellsGridHtml}
    </div>
  </div>
</div>

<!-- BLOCK 3: TRẠNG THÁI MOSFET & CÂN BẰNG -->
<div class="section">
  <div class="section-title">⚙️ Công Tắc MOSFET & Cân Bằng</div>
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
  </div>
</div>

<!-- BLOCK 4: QUẢN LÝ WIFI & HỆ THỐNG -->
<div class="section">
  <div class="section-title">🌐 Thông Tin Wi-Fi & Thiết Bị</div>
  <div class="info-card">
    <div class="info-row"><span class="info-key">Mạng Wi-Fi</span><span class="info-val">${d.ssid || '—'}</span></div>
    <div class="info-row"><span class="info-key">Mức Sóng WiFi (RSSI)</span><span class="info-val" style="color:#3fb950;">📶 ${rssiVal}</span></div>
    <div class="info-row"><span class="info-key">IP Local</span><span class="info-val">${d.local_ip || '—'}</span></div>
    <div class="info-row"><span class="info-key">Hostname</span><span class="info-val">${d.hostname || '—'}.local</span></div>
    <div class="info-row"><span class="info-key">Lắp đặt từ</span><span class="info-val">${reg}</span></div>
  </div>
</div>

<div class="footer">
  Tự động cập nhật mỗi 15 giây • <a href="/">Trang quản lý</a>
</div>

<script>
  setTimeout(()=>location.reload(), 15000);
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
