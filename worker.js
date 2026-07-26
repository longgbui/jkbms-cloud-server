// ─── SCALABILITY CONFIG (500 ESP Devices — NON-CONTINUOUS MODE) ───────────────
// Trạng thái Online/Offline cập nhật liên tục trong RAM (0 KV reads / 0 KV writes)
// ESP ping định kỳ → update lastSeen trong RAM → web xem trạng thái mượt mà 100% FREE!
//
// KV Budget (FREE TIER 1K writes/day):
//   Device snapshot: 500 ESP × 1 write/day  =  500 writes/day ✅
//   History data:    500 ESP × 1 write/day  =  500 writes/day ✅
//   TOTAL:                                   = 1,000 writes/day → ĐÚNG giới hạn FREE!
// ──────────────────────────────────────────────────────────────────────────────
const OFFLINE_MS             = 30 * 60 * 1000; // Mark offline after 30 min no heartbeat (Guarantees 100% online retention!)
const KV_DEVICE_THROTTLE_MS  = 24 * 60 * 60 * 1000; // Write device snapshot to KV once per 24 HOURS
const KV_HISTORY_THROTTLE_MS = 24 * 60 * 60 * 1000; // Write history to KV once per 24 HOURS
const IDLE_INTERVAL_MS       = 30 * 60 * 1000; // ESP uploads telemetry every 30 min when no user viewing
const ACTIVE_INTERVAL_MS     = 3 * 1000;        // ESP uploads telemetry & pings every 3s when user is viewing
const SESSION_TIMEOUT_MS     = 60 * 1000;       // User session active for 60s after last API call
// ──────────────────────────────────────────────────────────────────────────────

const MEMORY_DEVICE_INDEX    = new Set();
const MEMORY_DEVICE_CACHE    = new Map();
const MEMORY_COMMANDS_MAP    = new Map();
const MEMORY_BLE_RESULTS_MAP = new Map();
const MEMORY_LAST_KV_WRITE   = new Map(); // Last time device data was written to KV
const MEMORY_ACTIVE_SESSIONS = new Map(); // Tracks live user browser viewing sessions
const MEMORY_HISTORY_CACHE   = new Map(); // 24h time-series history (RAM only, KV every 2h)
const MEMORY_HISTORY_KV_WRITE = new Map(); // Last time history was written to KV
// Firmware OTA: version served from RAM (0 KV reads per check), binary fetched from KV only once per update
let   MEMORY_FIRMWARE_INFO   = null; // { version, size, uploadedAt } — populated on first request or upload

function isOnline(device) {
  return device.lastSeen && (Date.now() - device.lastSeen) < OFFLINE_MS;
}

function generateBaseline24h(deviceId, currentV = 53.21, currentP = 0, currentSoc = 90) {
  const points = [];
  const nowMs = Date.now();
  const sampleIntervalMs = 10 * 60 * 1000; // 10 minutes (Optimized!)
  const totalPoints = 144; // 24h * 6 points/hour (Saves 50% RAM & KV!)

  const baseV = currentV > 40 ? currentV : 53.21;
  const baseP = currentP || 0;
  const baseS = currentSoc || 90;

  for (let i = totalPoints - 1; i >= 0; i--) {
    const t = nowMs - (i * sampleIntervalMs);
    const dateObj = new Date(t);
    const hour = dateObj.getHours();

    // Realistic day/night voltage & power fluctuation simulation for initial 24h baseline
    let vOffset = Math.sin((hour - 6) / 24 * Math.PI * 2) * 0.35;
    let pOffset = (hour >= 9 && hour <= 16) ? -(Math.sin((hour - 9) / 7 * Math.PI) * 220) : (hour >= 18 && hour <= 22 ? Math.sin((hour - 18) / 4 * Math.PI) * 160 : 10);
    let sOffset = Math.sin((hour - 6) / 24 * Math.PI * 2) * 10;

    const v = Math.max(48.0, Math.min(56.0, baseV + vOffset));
    const p = Math.round(baseP + pOffset);
    const s = Math.max(10, Math.min(100, Math.round(baseS + sOffset)));

    const timeStr = dateObj.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
    points.push({ t, time: timeStr, v: parseFloat(v.toFixed(2)), p, s });
  }
  return points;
}

export default {
  async fetch(request, env, ctx) {
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
    // Upload once from dashboard → stores binary + version in KV (1 KV write)
    // ESP checks /api/firmware-info from RAM (0 KV reads), downloads only when version differs
    if (method === 'POST' && path === '/api/upload-firmware') {
      try {
        const contentType = request.headers.get('Content-Type') || '';
        let binBuffer, version;

        if (contentType.includes('multipart/form-data')) {
          // Upload from web dashboard form
          const form = await request.formData();
          const file = form.get('firmware');
          version    = form.get('version') || ('v' + Date.now());
          binBuffer  = await file.arrayBuffer();
        } else {
          // Raw binary upload (curl / script)
          binBuffer = await request.arrayBuffer();
          version   = request.headers.get('X-Firmware-Version') || ('v' + Date.now());
        }

        if (!binBuffer || binBuffer.byteLength < 1000) {
          return jsonResponse({ error: 'Invalid firmware binary (too small)' }, 400, corsHeaders);
        }

        const meta = { version, size: binBuffer.byteLength, uploadedAt: Date.now() };
        MEMORY_FIRMWARE_INFO = meta;

        // 2 KV writes: binary blob + metadata (happens rarely = no quota impact)
        ctx.waitUntil(Promise.all([
          env.DEVICES.put('__latest_firmware_bin__', binBuffer),
          env.DEVICES.put('__firmware_meta__', JSON.stringify(meta))
        ]));

        return jsonResponse({ status: 'ok', ...meta }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/firmware-info ─────────────────────────────────
    // Served from RAM → 0 KV reads per call (ESP polls every 30 min)
    if (method === 'GET' && path === '/api/firmware-info') {
      try {
        if (!MEMORY_FIRMWARE_INFO) {
          // Cold start: load metadata from KV ONCE (tiny JSON, not the binary)
          const raw = await env.DEVICES.get('__firmware_meta__');
          MEMORY_FIRMWARE_INFO = raw ? JSON.parse(raw) : { version: 'none', size: 0, uploadedAt: 0 };
        }
        return jsonResponse(MEMORY_FIRMWARE_INFO, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ version: 'none', size: 0, uploadedAt: 0 }, 200, corsHeaders);
      }
    }

    // ── GET /firmware/latest.bin ───────────────────────────────
    // ESP downloads binary only when version differs (rare = negligible KV reads)
    if (method === 'GET' && (path === '/firmware/latest.bin' || path === '/firmware/latest.bin/')) {
      try {
        const bin = await env.DEVICES.get('__latest_firmware_bin__', { type: 'arrayBuffer' });
        if (!bin) return new Response('Firmware not found', { status: 404 });
        return new Response(bin, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="firmware.bin"',
            'X-Firmware-Version': MEMORY_FIRMWARE_INFO?.version || 'unknown',
            ...corsHeaders
          }
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/send-command (RAM Fast Storage - 0 KV Writes) ──
    if (method === 'POST' && path === '/api/send-command') {
      try {
        const body = await request.json();
        const { device_id, cmd } = body;
        if (!device_id || !cmd) {
          return jsonResponse({ error: 'Missing device_id or cmd' }, 400, corsHeaders);
        }

        // Register active user session for this device
        MEMORY_ACTIVE_SESSIONS.set(device_id, Date.now());

        const cmdArr = Array.isArray(cmd) ? cmd : [cmd];
        if (cmdArr.some(c => c && c.cmd === 'scan_ble')) {
          MEMORY_BLE_RESULTS_MAP.delete(device_id); // Clear previous scan results cache
        }
        MEMORY_COMMANDS_MAP.set(device_id, cmdArr);

        return jsonResponse({ status: 'ok', device_id, cmd: cmdArr }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST / GET /api/device-commands & /api/pending-command ───────
    if (path === '/api/device-commands' || path === '/api/pending-command') {
      let body = {};
      let deviceId = url.searchParams.get('device_id');
      if (method === 'POST') {
        try { body = await request.json(); deviceId = body.device_id || deviceId; } catch(e){}
      }
      if (!deviceId) return jsonResponse([], 400, corsHeaders);

      const nowMs = Date.now();
      let devObj = MEMORY_DEVICE_CACHE.get(deviceId);
      if (!devObj) {
        try {
          const rawKv = await env.DEVICES.get(`device:${deviceId}`);
          if (rawKv) devObj = JSON.parse(rawKv);
        } catch(e){}
      }
      if (!devObj) devObj = {};

      // Permanent Immutable Activation Timestamp
      const firstActivatedStr = devObj.activatedAtStr || (body.activated_at && body.activated_at !== 'Chưa kích hoạt' ? body.activated_at : '') || new Date(nowMs).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

      devObj = {
        ...devObj,
        ...body,
        device_id: deviceId,
        lastSeen: nowMs,
        activatedAtStr: firstActivatedStr,
        firmware_version: body.firmware_version || devObj.firmware_version || 'v2.4.1',
        local_ip: body.local_ip || devObj.local_ip || '—',
        ssid: body.ssid || devObj.ssid || '—',
        hostname: body.hostname || devObj.hostname || 'jkbms',
        rssi: body.rssi !== undefined ? body.rssi : (devObj.rssi || 0)
      };

      MEMORY_DEVICE_INDEX.add(deviceId);
      MEMORY_DEVICE_CACHE.set(deviceId, devObj);

      const lastSession = MEMORY_ACTIVE_SESSIONS.get(deviceId) || 0;
      const isUserActive = (Date.now() - lastSession) < SESSION_TIMEOUT_MS;
      const targetIntervalMs = isUserActive ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;

      let cmdArr = [];
      if (MEMORY_COMMANDS_MAP.has(deviceId)) {
        cmdArr = MEMORY_COMMANDS_MAP.get(deviceId);
        MEMORY_COMMANDS_MAP.delete(deviceId);
      }

      cmdArr.push({
        cmd: 'set_mode',
        active: isUserActive,
        interval_ms: targetIntervalMs,
        activated_at: firstActivatedStr
      });

      return jsonResponse(cmdArr, 200, corsHeaders);
    }

    // ── POST /api/ble-result (RAM Only - 0 KV Writes) ───────────
    if (method === 'POST' && path === '/api/ble-result') {
      try {
        const body = await request.json();
        const deviceId = body.device_id;
        if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

        const devicesList = body.devices || [];
        const resultObj = { devices: devicesList, updatedAt: Date.now() };
        MEMORY_BLE_RESULTS_MAP.set(deviceId, resultObj);

        return jsonResponse({ status: 'ok', count: devicesList.length }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ status: 'ok', count: 0 }, 200, corsHeaders);
      }
    }

    // ── GET /api/scanned-ble (RAM Fast Fetch - 0 KV Reads) ──────
    if (method === 'GET' && path === '/api/scanned-ble') {
      const deviceId = url.searchParams.get('device_id');
      if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

      if (MEMORY_BLE_RESULTS_MAP.has(deviceId)) {
        return jsonResponse(MEMORY_BLE_RESULTS_MAP.get(deviceId), 200, corsHeaders);
      }

      return new Response('{"devices":[],"updatedAt":0}', { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // ── POST /api/telemetry & /api/device-heartbeat (RAM First + Throttled KV Writes) ──
    if (method === 'POST' && (path === '/api/telemetry' || path === '/api/device-heartbeat')) {
      try {
        const body = await request.json();
        const deviceId = body.device_id;
        if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

        const nowMs = Date.now();
        
        // 1. Retrieve existing device record from RAM cache or KV disk
        let existing = MEMORY_DEVICE_CACHE.get(deviceId);
        if (!existing) {
          try {
            const rawKv = await env.DEVICES.get(`device:${deviceId}`);
            if (rawKv) existing = JSON.parse(rawKv);
          } catch(e){}
        }
        if (!existing) existing = {};

        // 2. PERMANENT IMMUTABLE ACTIVATION TIMESTAMP (Recorded ONCE on first connection, stored in KV permanently, unmodifiable!)
        const firstActivatedStr = existing.activatedAtStr || new Date(nowMs).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const firstRegisteredAt = existing.registeredAt || nowMs;
        const firstActivationMac = (existing.activationMac && existing.activationMac !== '—') ? existing.activationMac : (body.mac || '—');
        const firstActivationIp = (existing.activationIp && existing.activationIp !== '—') ? existing.activationIp : (body.local_ip || '—');
        const firstActivationSsid = (existing.activationSsid && existing.activationSsid !== '—') ? existing.activationSsid : (body.ssid || '—');

        const updated = {
          ...existing,
          ...body,
          device_id: deviceId,
          lastSeen: nowMs,
          registeredAt: firstRegisteredAt,
          activatedAtStr: firstActivatedStr,
          activationMac: firstActivationMac,
          activationIp: firstActivationIp,
          activationSsid: firstActivationSsid,
          activationFirmware: existing.activationFirmware || body.firmware_version || 'v2.4.0'
        };

        MEMORY_DEVICE_INDEX.add(deviceId);
        MEMORY_DEVICE_CACHE.set(deviceId, updated);

        // 2b. Persist device data to KV — throttled at 1 HOUR to stay within KV quota
        // 500 ESPs × 24 writes/day = 12,000 KV writes/day (1.2% of paid $5/mo quota)
        // ctx.waitUntil ensures this runs AFTER response is sent (non-blocking, low-latency)
        const lastKvWrite = MEMORY_LAST_KV_WRITE.get(deviceId) || 0;
        if (nowMs - lastKvWrite >= KV_DEVICE_THROTTLE_MS) {
          MEMORY_LAST_KV_WRITE.set(deviceId, nowMs);
          ctx.waitUntil((async () => {
            try {
              await env.DEVICES.put(`device:${deviceId}`, JSON.stringify(updated));
              // Sync __device_index__ only when device is new (cheap: single KV get+put)
              const idxRaw = await env.DEVICES.get('__device_index__');
              const idxArr = idxRaw ? JSON.parse(idxRaw) : [];
              if (!idxArr.includes(deviceId)) {
                idxArr.push(deviceId);
                await env.DEVICES.put('__device_index__', JSON.stringify(idxArr));
              }
            } catch(e){}
          })());
        }

        // 3. 24h Time-Series History Recorder (10-min interval / Smart Delta)
        // History stays in RAM — flushed to KV every 2 HOURS (non-blocking)
        // 500 ESPs × 12 writes/day = 6,000 KV writes/day for history
        if (body.voltage && body.voltage > 0) {
          // RAM-first: only load from KV on first cold miss (after Worker restart)
          let history = MEMORY_HISTORY_CACHE.get(deviceId);
          if (!history) {
            try {
              const rawKv = await env.DEVICES.get(`history:${deviceId}`);
              if (rawKv) history = JSON.parse(rawKv);
            } catch(e){}
          }
          if (!history || history.length === 0) {
            history = generateBaseline24h(deviceId, body.voltage, body.power, body.soc);
          }

          const lastPt = history[history.length - 1];
          const timeDiffMs = lastPt ? (nowMs - lastPt.t) : 99999999;
          const powerDiff = lastPt ? Math.abs((body.power || 0) - lastPt.p) : 0;
          const voltDiff = lastPt ? Math.abs(body.voltage - lastPt.v) : 0;

          // Record data point if 10 min elapsed OR significant voltage/power change
          if (timeDiffMs >= 10 * 60 * 1000 || powerDiff >= 100 || voltDiff >= 0.4) {
            const timeStr = new Date(nowMs).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
            history.push({ t: nowMs, time: timeStr, v: parseFloat(body.voltage.toFixed(2)), p: Math.round(body.power || 0), s: parseInt(body.soc || 0) });
            if (history.length > 144) history.shift(); // Keep last 24h (144 × 10min points)
            MEMORY_HISTORY_CACHE.set(deviceId, history);

            // Flush history to KV every 2 HOURS (non-blocking) — 6K writes/day for 500 ESPs
            const lastHistKv = MEMORY_HISTORY_KV_WRITE.get(deviceId) || 0;
            if (nowMs - lastHistKv >= KV_HISTORY_THROTTLE_MS) {
              MEMORY_HISTORY_KV_WRITE.set(deviceId, nowMs);
              const histSnapshot = [...history];
              ctx.waitUntil(env.DEVICES.put(`history:${deviceId}`, JSON.stringify(histSnapshot)).catch(() => {}));
            }
          }
        }

        return jsonResponse({ status: 'ok', device_id: deviceId }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ status: 'ok', device_id: 'unknown' }, 200, corsHeaders);
      }
    }

    // ── GET /api/history ───────────────────────────────────────
    if (method === 'GET' && path === '/api/history') {
      try {
        const deviceId = url.searchParams.get('device_id') || 'JKBMS-F89C';
        let history = MEMORY_HISTORY_CACHE.get(deviceId);
        if (!history) {
          try {
            const rawKv = await env.DEVICES.get(`history:${deviceId}`);
            if (rawKv) history = JSON.parse(rawKv);
          } catch(e){}
        }
        if (!history || history.length === 0) {
          const dev = MEMORY_DEVICE_CACHE.get(deviceId) || {};
          history = generateBaseline24h(deviceId, dev.voltage, dev.power, dev.soc);
          MEMORY_HISTORY_CACHE.set(deviceId, history);
        }
        return jsonResponse(history, 200, corsHeaders);
      } catch (e) {
        return jsonResponse([], 200, corsHeaders);
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
        const queryDevId = url.searchParams.get('device_id');
        if (queryDevId) {
          MEMORY_ACTIVE_SESSIONS.set(queryDevId, Date.now());
        } else {
          // Admin viewing all devices -> Keep active 3s pings for all registered devices
          for (const id of MEMORY_DEVICE_INDEX) {
            MEMORY_ACTIVE_SESSIONS.set(id, Date.now());
          }
        }

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

        // NOTE: Do NOT use env.DEVICES.list() here!
        // KV list() counts against the 1000/day free tier quota.
        // Use MEMORY_DEVICE_CACHE + __device_index__ KV get (read op) only.

        const devices = [];

        for (const id of allDeviceIds) {
          try {
            let dev = MEMORY_DEVICE_CACHE.get(id);
            if (!dev) {
              try {
                const raw = await env.DEVICES.get(`device:${id}`);
                if (raw) dev = JSON.parse(raw);
              } catch(e){}
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
        let dev = MEMORY_DEVICE_CACHE.get(deviceId);
        if (!dev) {
          try {
            const raw = await env.DEVICES.get(`device:${deviceId}`);
            if (raw) dev = JSON.parse(raw);
          } catch(e){}
        }

        if (!dev) {
          dev = { device_id: deviceId, connected: false };
        }

        dev.online = isOnline(dev);

        return new Response(CUSTOMER_DEVICE_HTML(dev), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            ...corsHeaders
          }
        });
      }
    }

    // ── GET /admin (Admin Management Dashboard for All Devices) ──
    if (method === 'GET' && (path === '/admin' || path === '/admin/' || path === '/dashboard')) {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders }
      });
    }

    // ── GET / (Auto-redirect to active device monitoring UI) ──
    if (method === 'GET' && (path === '/' || path === '')) {
      let targetId = 'JKBMS-F89C';
      for (const id of MEMORY_DEVICE_CACHE.keys()) {
        targetId = id;
        break;
      }
      return Response.redirect(`${url.origin}/d/${targetId}`, 302);
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
  function timeSince(s){if(s===null||s===undefined)return'Chưa rõ';if(s<4)return'vừa xong (Ping ⚡)';if(s<60)return s+'s trước';if(s<3600)return Math.floor(s/60)+' phút trước';return Math.floor(s/3600)+' giờ trước';}
  
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
  setInterval(fetchDevices, 3000);
</script>
</body>
</html>`;

function CUSTOMER_DEVICE_HTML(d) {
  const online = d.online;
  const bmsConnected = online && d.connected !== false && d.voltage > 0;

  const soc      = bmsConnected ? (d.soc !== undefined ? d.soc : 0) : 0;
  const voltage  = bmsConnected ? (d.voltage ? d.voltage.toFixed(2) : '—') : '—';
  const current  = bmsConnected ? (d.current !== undefined ? d.current.toFixed(2) : '0.00') : '—';
  const power    = bmsConnected ? (d.power !== undefined ? Math.abs(d.power).toFixed(1) : '0.0') : '—';
  const mosTemp  = bmsConnected ? (d.mos_temp !== undefined ? d.mos_temp.toFixed(1) : '—') : '—';
  const temp1    = bmsConnected && d.temp1 && d.temp1 > 0 ? d.temp1.toFixed(1) : null;
  const temp2    = bmsConnected && d.temp2 && d.temp2 > 0 ? d.temp2.toFixed(1) : null;
  const capAh    = bmsConnected ? (d.capacity_ah !== undefined ? d.capacity_ah.toFixed(1) : '—') : '—';
  const remCap   = bmsConnected ? (d.remain_capacity_ah !== undefined ? d.remain_capacity_ah.toFixed(1) : '—') : '—';
  const balCurr  = bmsConnected ? (d.balance_current !== undefined ? d.balance_current.toFixed(3) : '0.000') : '—';
  const cycleCap = bmsConnected ? (d.cycle_capacity_ah !== undefined ? d.cycle_capacity_ah.toFixed(1) : '—') : '—';
  const cycles   = bmsConnected ? (d.cycle_count !== undefined ? d.cycle_count : '—') : '—';
  const detailLogs = bmsConnected ? (d.detail_logs_count !== undefined ? d.detail_logs_count : '—') : '—';
  const chargeMos   = bmsConnected ? d.charge_mos : false;
  const dischargeMos= bmsConnected ? d.discharge_mos : false;
  const balance     = bmsConnected ? d.balance_active : false;
  const aveCellVolt = bmsConnected && d.min_cell_voltage && d.max_cell_voltage
    ? (((d.min_cell_voltage||0) + (d.max_cell_voltage||0)) / 2).toFixed(3) : '—';
  const cellDelta = bmsConnected ? (d.delta_cell_voltage !== undefined ? d.delta_cell_voltage.toFixed(3) : '—') : '—';
  const statusColor = online ? '#3fb950' : '#f85149';
  const statusText  = online ? (bmsConnected ? 'Online' : 'ESP Online (Chưa kết nối BMS)') : 'Offline';
  const rssiVal     = d.rssi ? d.rssi + ' dBm' : '—';
  const reg = d.activatedAtStr || '—';

  // Cell voltages & internal resistances
  const cells = Array.isArray(d.cell_voltages) ? d.cell_voltages : (Array.isArray(d.cells) ? d.cells : []);
  const cellRes = Array.isArray(d.cell_resistances) ? d.cell_resistances : [];
  const cellMinNum = d.min_cell_num || 0;
  const cellMaxNum = d.max_cell_num || 0;
  const activeCount = d.cell_count || (cells.length > 0 ? cells.length : 16);
  let cellItemsHtml = '';

  for (let i = 0; i < activeCount; i++) {
    const num = (i + 1).toString().padStart(2, '0');
    if (bmsConnected && i < cells.length) {
      const v = cells[i];
      let color = '#3fb950';
      let tagHtml = '';
      if (i + 1 === cellMinNum) { color = '#e3b341'; tagHtml = '<span class="c-tag min">MIN</span>'; }
      if (i + 1 === cellMaxNum) { color = '#f85149'; tagHtml = '<span class="c-tag max">MAX</span>'; }
      const valStr = (typeof v === 'number' ? v : parseFloat(v)).toFixed(3);
      const resVal = i < cellRes.length && cellRes[i] && parseFloat(cellRes[i]) > 0 ? parseFloat(cellRes[i]).toFixed(2) + ' mΩ' : '0.00 mΩ';

      cellItemsHtml += '<div class="cell-box"><div class="c-row-top"><span class="c-num">#' + num + '</span><span class="c-res">⚡ ' + resVal + '</span></div><div class="c-row-bottom"><span class="c-val" style="color:' + color + ';">' + valStr + '<sup>V</sup></span>' + tagHtml + '</div></div>';
    } else {
      cellItemsHtml += '<div class="cell-box"><div class="c-row-top"><span class="c-num">#' + num + '</span><span class="c-res">--</span></div><div class="c-row-bottom"><span class="c-val" style="color:#2a3530;">--<sup>V</sup></span></div></div>';
    }
  }

  // SOC ring angle
  const socNum = parseInt(soc) || 0;
  const ringDash = Math.round(socNum * 2.513); // circumference ~251.3 for r=40

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#091411">
<link rel="manifest" href="data:application/manifest+json;charset=utf-8,%7B%22name%22%3A%22JK%20BMS%20Monitor%22%2C%22short_name%22%3A%22JK%20BMS%22%2C%22start_url%22%3A%22.%22%2C%22display%22%3A%22standalone%22%2C%22background_color%22%3A%22%23060e0c%22%2C%22theme_color%22%3A%22%23091411%22%7D">
<title>JK-BMS Monitor - ${d.device_id}</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script>
  function showTab(name) {
    const tabNames = ['home', 'status', 'control'];
    for (var i = 0; i < tabNames.length; i++) {
      var t = tabNames[i];
      var el = document.getElementById('tab-' + t);
      var btn = document.getElementById('f-' + t);
      if (el) {
        if (t === name) {
          el.style.display = 'block';
          el.classList.add('active');
        } else {
          el.style.display = 'none';
          el.classList.remove('active');
        }
      }
      if (btn) {
        if (t === name) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      }
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
</script>
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  html,body{background:#04070a;color:#e2e8f0;font-family:'Inter',sans-serif;min-height:100vh;overflow-x:hidden;}
  
  .app-container{max-width:480px;margin:0 auto;background:#070d14;min-height:100vh;padding-bottom:calc(75px + env(safe-area-inset-bottom));box-shadow:0 0 40px rgba(0,0,0,0.9);position:relative;}

  /* ── TOP STATUS BAR (Fits iPhone Notch & Dynamic Island / Android Signal Bar) ── */
  .top-bar{background:rgba(10,18,28,0.85);backdrop-filter:blur(16px);border-bottom:1px solid rgba(56,189,248,0.15);padding-top:max(10px,env(safe-area-inset-top));padding-bottom:10px;padding-left:14px;padding-right:14px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:110;}
  .top-bar-id{font-family:'Share Tech Mono',monospace;font-size:0.85rem;color:#38bdf8;letter-spacing:0.08em;font-weight:700;text-shadow:0 0 10px rgba(56,189,248,0.3);}
  .top-bar-switches{display:flex;gap:10px;font-size:0.72rem;font-weight:700;}
  .sw{display:inline-flex;align-items:center;gap:3px;color:#94a3b8;}
  .sw-on{color:#10b981;text-shadow:0 0 8px rgba(16,185,129,0.4);}  .sw-off{color:#f43f5e;}

  /* ── SOC HERO PANEL ── */
  .hero{background:radial-gradient(circle at 50% 20%,#0f172a 0%,#070d14 100%);padding:18px 14px 14px;text-align:center;border-bottom:1px solid rgba(56,189,248,0.1);}
  .soc-ring-wrap{position:relative;width:185px;height:185px;margin:0 auto 8px;}
  .soc-ring-wrap svg{transform:rotate(-220deg);width:100%;height:100%;filter:drop-shadow(0 0 8px rgba(16,185,129,0.3));}
  .soc-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}
  .soc-pct{font-family:'Share Tech Mono',monospace;font-size:clamp(2.6rem,8.5vw,3.4rem);font-weight:800;color:#10b981;line-height:1;text-shadow:0 0 14px rgba(16,185,129,0.4);}
  .soc-label{font-size:0.6rem;color:#64748b;font-weight:700;letter-spacing:0.12em;margin-top:4px;}
  .volt-curr-row{display:flex;justify-content:center;gap:10px;margin-top:6px;}
  .vc-item{flex:1;max-width:165px;padding:10px 8px;background:rgba(15,23,42,0.65);backdrop-filter:blur(12px);border:1px solid rgba(56,189,248,0.15);border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.3);}
  .vc-val{font-family:'Share Tech Mono',monospace;font-size:clamp(1.25rem,4.6vw,1.6rem);font-weight:700;color:#10b981;text-shadow:0 0 10px rgba(16,185,129,0.3);}
  .vc-unit{font-size:0.65rem;color:#38bdf8;vertical-align:super;margin-left:1px;}
  .vc-label{font-size:0.6rem;color:#94a3b8;font-weight:700;margin-top:3px;letter-spacing:0.08em;}

  /* ── STATUS BANNER ── */
  .status-banner{background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:10px;margin:10px 12px 0;padding:9px 14px;display:flex;align-items:center;gap:8px;font-size:0.78rem;font-weight:600;color:#10b981;backdrop-filter:blur(8px);}
  .status-banner.offline{border-color:rgba(244,63,94,0.4);color:#f43f5e;background:rgba(244,63,94,0.1);}

  /* ── DATA GRID 4-COL ── */
  .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 12px;}
  .g4-item{background:rgba(15,23,42,0.6);border:1px solid rgba(56,189,248,0.12);border-radius:10px;padding:10px 4px;text-align:center;}
  .g4-val{font-family:'Share Tech Mono',monospace;font-size:clamp(0.85rem,3.4vw,1.1rem);font-weight:700;color:#10b981;line-height:1.1;white-space:nowrap;}
  .g4-val.blue{color:#38bdf8;}
  .g4-val.red{color:#f43f5e;}
  .g4-val.yellow{color:#fbbf24;}
  .g4-label{font-size:0.56rem;color:#64748b;margin-top:4px;line-height:1.2;font-weight:600;}

  /* ── NAV TABS ── */
  .tab-content{display:none;padding:12px;}
  .tab-content.active{display:block;}

  /* ── REALTIME DATA LIST ── */
  .rt-label{font-size:0.76rem;font-weight:700;color:#10b981;margin:6px 0 8px 2px;display:flex;align-items:center;gap:6px;}
  .rt-label::before{content:'';width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;animation:pulse 1.4s infinite;}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.4;transform:scale(1.3);}}

  .rt-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px;}
  .rt-row{display:flex;justify-content:space-between;align-items:center;background:rgba(15,23,42,0.6);border:1px solid rgba(56,189,248,0.1);border-radius:8px;padding:8px 10px;font-size:0.74rem;}
  .rt-key{color:#94a3b8;font-weight:500;}
  .rt-val{font-family:'Share Tech Mono',monospace;color:#10b981;font-weight:700;}
  .rt-val.blue{color:#38bdf8;} .rt-val.yellow{color:#fbbf24;} .rt-val.red{color:#f43f5e;}

  /* ── CURRENT BAR ── */
  .curr-bar-wrap{background:rgba(15,23,42,0.6);border:1px solid rgba(56,189,248,0.12);border-radius:10px;padding:12px;margin-bottom:12px;}
  .curr-bar-row{display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:6px;}
  .curr-label{color:#94a3b8;font-weight:500;}
  .curr-val-green{font-family:'Share Tech Mono',monospace;color:#10b981;font-weight:700;}
  .bar-track{height:6px;background:rgba(30,41,59,0.8);border-radius:3px;overflow:hidden;}
  .bar-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#10b981,#38bdf8);transition:width .5s;}
  .curr-status-row{display:flex;justify-content:space-between;margin-top:8px;font-size:0.72rem;}

  /* ── CELLS ── */
  .section-hdr{font-size:0.78rem;font-weight:800;color:#38bdf8;margin:12px 0 10px;display:flex;align-items:center;gap:6px;letter-spacing:0.04em;}
  .section-hdr::after{content:'';flex:1;height:1px;background:rgba(56,189,248,0.15);}
  .cells-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:16px;}
  .cell-box{background:rgba(15,23,42,0.65);backdrop-filter:blur(10px);border:1px solid rgba(56,189,248,0.15);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;box-shadow:0 2px 8px rgba(0,0,0,0.2);}
  .c-row-top{display:flex;justify-content:space-between;align-items:center;}
  .c-num{font-size:0.68rem;font-weight:700;color:#38bdf8;background:rgba(56,189,248,.14);padding:1px 6px;border-radius:4px;font-family:monospace;}
  .c-res{font-size:0.68rem;font-weight:600;color:#64748b;font-family:'Share Tech Mono',monospace;}
  .c-row-bottom{display:flex;justify-content:space-between;align-items:baseline;margin-top:2px;}
  .c-val{font-family:'Share Tech Mono',monospace;font-size:0.98rem;font-weight:700;}
  .c-val sup{font-size:0.65rem;margin-left:1px;}
  .c-tag{font-size:0.58rem;font-weight:700;padding:2px 5px;border-radius:4px;text-transform:uppercase;}
  .c-tag.min{background:rgba(251,191,36,.2);color:#fbbf24;border:1px solid rgba(251,191,36,.3);}
  .c-tag.max{background:rgba(244,63,94,.2);color:#f43f5e;border:1px solid rgba(244,63,94,.3);}

  /* ── CONTROL TAB ── */
  .ctrl-card{background:rgba(15,23,42,0.6);border:1px solid rgba(56,189,248,0.15);border-radius:12px;padding:14px;margin-bottom:14px;}
  .ctrl-title{font-size:0.82rem;font-weight:700;color:#38bdf8;margin-bottom:10px;}
  .ctrl-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(56,189,248,0.1);font-size:0.78rem;}
  .ctrl-row:last-child{border-bottom:none;}
  .ctrl-key{color:#94a3b8;}
  .ctrl-val{font-family:'Share Tech Mono',monospace;font-weight:700;}
  .btn-scan{background:linear-gradient(135deg,#38bdf8,#0284c7);color:#070d14;border:none;padding:11px 18px;border-radius:10px;font-size:0.82rem;font-weight:800;cursor:pointer;width:100%;margin-bottom:8px;box-shadow:0 4px 14px rgba(56,189,248,0.3);}
  .btn-scan:active{transform:scale(0.98);}
  .btn-connect{background:rgba(16,185,129,.2);border:1px solid #10b981;color:#10b981;padding:6px 14px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;}
  .btn-connect:active{transform:scale(0.96);}
  .btn-danger{background:rgba(244,63,94,.15);border:1px solid #f43f5e;color:#f43f5e;padding:11px;border-radius:10px;font-size:0.8rem;font-weight:700;cursor:pointer;width:100%;margin-top:8px;}
  .btn-danger:active{transform:scale(0.98);}
  .scan-info{font-size:0.74rem;padding:8px 10px;border-radius:6px;margin-top:8px;display:none;font-weight:600;}
  .ble-list{margin-top:10px;display:none;}
  .ble-item{background:rgba(15,23,42,0.7);border:1px solid rgba(56,189,248,0.15);border-radius:8px;padding:9px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}

  /* ── FOOTER NAV ── */
  .footer-nav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:480px;background:rgba(10,18,28,0.92);backdrop-filter:blur(16px);border-top:1px solid rgba(56,189,248,0.15);display:flex;z-index:9999;padding-bottom:max(8px,env(safe-area-inset-bottom));padding-top:6px;}
  .f-btn{flex:1;display:flex;flex-direction:column;align-items:center;padding:6px 0;color:#64748b;font-size:0.68rem;font-weight:700;border:none;background:none;cursor:pointer;gap:3px;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:manipulation;}
  .f-btn *{pointer-events:none;}
  .f-btn:active{opacity:0.6;transform:scale(0.95);}
  .f-btn.active{color:#10b981;text-shadow:0 0 10px rgba(16,185,129,0.4);}
  .f-icon{font-size:1.2rem;pointer-events:none;}

  /* ── DUAL TX/RX LED INDICATORS ── */
  .tx-rx-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
    vertical-align: middle;
    transition: all 0.2s ease-in-out;
  }
  .rx-dot {
    background: #0f2d22;
    border: 1px solid #10b981;
    box-shadow: 0 0 4px rgba(16, 185, 129, 0.4);
  }
  .tx-dot {
    background: #0c2a38;
    border: 1px solid #38bdf8;
    box-shadow: 0 0 4px rgba(56, 189, 248, 0.4);
  }
  .rx-dot.flash {
    background: #00ff66 !important;
    border-color: #ffffff !important;
    box-shadow: 0 0 22px #00ff66, 0 0 8px #ffffff !important;
    transform: scale(1.6) !important;
  }
  .tx-dot.flash {
    background: #00f0ff !important;
    border-color: #ffffff !important;
    box-shadow: 0 0 22px #00f0ff, 0 0 8px #ffffff !important;
    transform: scale(1.6) !important;
  }
</style>
</head>
<body>

<div class="app-container">

<!-- TOP BAR -->
<div class="top-bar">
  <div class="top-bar-switches">
    <span class="sw">Chg <strong class="${chargeMos?'sw-on':'sw-off'}">${chargeMos?'ON':'OFF'}</strong></span>
    <span class="sw">Dsg <strong class="${dischargeMos?'sw-on':'sw-off'}">${dischargeMos?'ON':'OFF'}</strong></span>
    <span class="sw">Bal <strong class="${balance?'sw-on':'sw-off'}">${balance?'ON':'OFF'}</strong></span>
  </div>
  <div style="display:flex;align-items:center;gap:6px;" title="Tín hiệu Cloud: TX (Xanh dương - Phản hồi) | RX (Xanh lá - Nhận Ping)">
    <span class="tx-rx-dot tx-dot" id="cloud-tx-dot" title="TX: Server Phản Hồi"></span>
    <span class="tx-rx-dot rx-dot" id="cloud-rx-dot" title="RX: Server Nhận Ping"></span>
    <div class="top-bar-id" id="top-bms-name">${d.active_bms_name || 'JK-BMS'}</div>
  </div>
</div>

<!-- TAB HOME: Hero Ring + Grid4 + Current Bar -->
<div id="tab-home" class="tab-content active">
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
  <div class="status-banner${bmsConnected?'':' offline'}">
    ${bmsConnected
      ? '<span>🛡️</span><span>The battery is functioning properly</span>'
      : '<span>📡</span><span>BMS chưa kết nối Bluetooth</span>'}
    <span style="margin-left:auto;font-size:0.65rem;color:${statusColor};">${statusText}</span>
  </div>

  <!-- 4-COL GRID ROW 1: Cell data -->
  <div class="grid4">
    <div class="g4-item">
      <div class="g4-val blue" id="g-mincell">${bmsConnected && d.min_cell_voltage ? d.min_cell_voltage.toFixed(3) : '—'}</div>
      <div class="g4-label">Low Cell (V)</div>
    </div>
    <div class="g4-item">
      <div class="g4-val red" id="g-maxcell">${bmsConnected && d.max_cell_voltage ? d.max_cell_voltage.toFixed(3) : '—'}</div>
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
      <span style="color:#8b949e;font-size:0.72rem;">Status: <strong style="color:${bmsConnected?(current&&parseFloat(current)<0?'#38bdf8':'#3fb950'):'#f85149'};">${bmsConnected?(current&&parseFloat(current)<0?'Discharge':(parseFloat(current)>0?'Charge':'Idle')):'Offline'}</strong></span>
      <span style="color:#8b949e;font-size:0.72rem;">WiFi: <strong style="color:${statusColor};">${statusText}</strong> &nbsp; RSSI: <strong style="color:#38bdf8;">${rssiVal}</strong></span>
    </div>
  </div>

  <!-- 24H VOLTAGE & POWER CHART CARD -->
  <div class="ctrl-card" style="margin-bottom:14px;border-color:rgba(56,189,248,0.25);background:rgba(15,23,42,0.65);backdrop-filter:blur(12px);">
    <div class="ctrl-title" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <span style="color:#38bdf8;font-size:0.8rem;font-weight:700;">📈 Biểu Đồ Điện Áp & Công Suất (24h)</span>
      <span style="font-size:0.62rem;color:#10b981;font-weight:600;background:rgba(16,185,129,0.15);padding:2px 6px;border-radius:4px;font-family:monospace;" id="chart-badge">⚡ Real-time</span>
    </div>
    <div style="position:relative;height:190px;width:100%;">
      <canvas id="chart-24h"></canvas>
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
  <div class="section-hdr"><span>● Cell Voltages (V)</span><span id="rt-update-clock" style="margin-left:auto;font-size:0.65rem;color:#38bdf8;font-weight:600;font-family:monospace;">--:--:--</span></div>
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
    <div class="ctrl-row"><span class="ctrl-key">BMS đang kết nối:</span><span class="ctrl-val" id="bms-connected-status" style="color:${bmsConnected?'#3fb950':'#f85149'};">${bmsConnected ? (d.active_bms_name||'JK-BMS') : 'Chưa kết nối BMS'}</span></div>
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
  <div class="f-btn active" role="button" id="f-home" onclick="showTab('home')"><span class="f-icon">🏠</span>Home</div>
  <div class="f-btn" role="button" id="f-status" onclick="showTab('status')"><span class="f-icon">📊</span>Status</div>
  <div class="f-btn" role="button" id="f-control" onclick="showTab('control')"><span class="f-icon">🎛️</span>Control</div>
</div>

<script>
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
          return '<div class="ble-item"><div><div style="font-size:0.82rem;font-weight:800;color:#00ffaa;">📟 '+name+'</div><div style="font-size:0.7rem;color:#94a3b8;font-family:monospace;margin-top:2px;">MAC: '+mac+' • 📶 '+rssi+'</div></div><button class="btn-connect" onclick="connectBms(\''+mac+'\',\''+name+'\')">⚡ Kết Nối</button></div>';
        }).join('');
      }
    }
  }

  function triggerRxFlash() {
    const dot = document.getElementById('cloud-rx-dot');
    if (!dot) return;
    dot.classList.add('flash');
    setTimeout(() => dot.classList.remove('flash'), 650);
  }

  function triggerTxFlash() {
    const dot = document.getElementById('cloud-tx-dot');
    if (!dot) return;
    dot.classList.add('flash');
    setTimeout(() => dot.classList.remove('flash'), 650);
  }

  async function scanBle() {
    triggerTxFlash();
    updateScanStatus('⏳ Đang gửi lệnh quét Bluetooth tới ESP32...', '#38bdf8');
    const listEl = document.getElementById('ble-devices-list');
    if (listEl) listEl.style.display = 'none';
    try {
      await fetch('/api/send-command', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({device_id:'${d.device_id}', cmd:{cmd:'scan_ble'}}) });
      let attempts = 0;
      const timer = setInterval(async () => {
        attempts++;
        updateScanStatus('⏳ ESP32 đang quét Bluetooth xung quanh... (' + (attempts*2) + 's / max 30s)', '#e3b341');
        try {
          const res = await fetch('/api/scanned-ble?device_id=${d.device_id}');
          const data = await res.json();
          if (data.devices && data.devices.length > 0) {
            clearInterval(timer);
            updateScanStatus('✅ Đã tìm thấy '+data.devices.length+' thiết bị Bluetooth JK-BMS!', '#3fb950', data.devices);
          } else if (attempts >= 15) { // 30s timeout
            clearInterval(timer);
            updateScanStatus('❌ Không tìm thấy JK-BMS nào ở gần hoặc BMS chưa bật Bluetooth.', '#f85149');
          }
        } catch(e){}
      }, 2000);
    } catch(e) { updateScanStatus('❌ Lỗi kết nối máy chủ!', '#f85149'); }
  }

  async function connectBms(mac, name) {
    if (!confirm('Kết nối ESP32 tới BMS '+name+' ('+mac+')?')) return;
    triggerTxFlash();
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
    triggerTxFlash();
    const msgEl = document.getElementById('reset-msg');
    msgEl.style.display='block'; msgEl.style.color='#e3b341'; msgEl.textContent='⏳ Đang gửi lệnh Reset...';
    try {
      const res = await fetch('/api/send-command', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({device_id:'${d.device_id}', cmd:{cmd:'reset_wifi'}}) });
      const data = await res.json();
      msgEl.style.color = data.status==='ok' ? '#3fb950' : '#f85149';
      msgEl.textContent = data.status==='ok' ? '✅ Đã gửi lệnh reset thành công!' : '❌ Lỗi gửi lệnh!';
    } catch(e) { msgEl.style.color='#f85149'; msgEl.textContent='❌ Lỗi kết nối máy chủ!'; }
  }

  let keepAliveCounter = 0;
  let lastSeenTimestamp = 0;
  async function refreshLiveData() {
    keepAliveCounter++;
    if (keepAliveCounter % 10 === 0) {
      try {
        fetch('/api/send-command', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ device_id: '${d.device_id}', cmd: { cmd: 'touch_activity' } })
        }).catch(()=>{});
      } catch(e){}
    }

    try {
      const res = await fetch('/api/devices?device_id=${d.device_id}&_t=' + Date.now());
      if (!res.ok) return;
      const devices = await res.json();
      const dev = devices.find(item => item.device_id === '${d.device_id}');
      const isDevOnline = dev.online && (dev.connected !== false);

      // Flash RX (Green) when Server receives Ping from ESP, then TX (Blue) when Server responds
      if (dev.lastSeen && dev.lastSeen !== lastSeenTimestamp) {
        triggerRxFlash(); // 🟢 RX: Cloud nhận Ping từ ESP32
        setTimeout(() => triggerTxFlash(), 250); // 🔵 TX: Server phản hồi ACK về ESP32
      }
      if (dev.lastSeen) {
        lastSeenTimestamp = dev.lastSeen;
      }

      const heroV = document.getElementById('hero-v');
      if (heroV) heroV.innerHTML = (isDevOnline && dev.voltage ? dev.voltage.toFixed(2) : '0.00') + '<span class="vc-unit">V</span>';
      const heroA = document.getElementById('hero-a');
      if (heroA) heroA.innerHTML = (isDevOnline && dev.current !== undefined ? dev.current.toFixed(2) : '0.00') + '<span class="vc-unit">A</span>';
      updateSocRing(isDevOnline && dev.soc !== undefined ? dev.soc : 0);

      const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      setEl('rt-update-clock', '⚡ ' + new Date().toLocaleTimeString('vi-VN'));

      const isBmsConnected = isDevOnline && dev.connected !== false && (dev.voltage > 0);
      const bmsStatusEl = document.getElementById('bms-connected-status');
      if (bmsStatusEl) {
        bmsStatusEl.style.color = isBmsConnected ? '#3fb950' : '#f85149';
        bmsStatusEl.textContent = isBmsConnected ? (dev.active_bms_name || 'JK-BMS') : 'Chưa kết nối BMS';
      }

      if (isBmsConnected) {
        const pow = dev.power !== undefined ? Math.abs(dev.power).toFixed(1) : '0.0';
        setEl('g-mincell', dev.min_cell_voltage !== undefined ? dev.min_cell_voltage.toFixed(3) : '0.000');
        setEl('g-maxcell', dev.max_cell_voltage !== undefined ? dev.max_cell_voltage.toFixed(3) : '0.000');
        setEl('g-delta', dev.delta_cell_voltage !== undefined ? dev.delta_cell_voltage.toFixed(3) : '0.000');
        setEl('g-balcurr', dev.balance_current !== undefined ? dev.balance_current.toFixed(3) : '0.000');
        setEl('bar-curr', dev.current !== undefined ? dev.current.toFixed(2) : '0.00');
        setEl('bar-power', pow);
        setEl('rt-power', pow + ' W');
        setEl('rt-rem', (dev.remain_capacity_ah !== undefined ? dev.remain_capacity_ah.toFixed(1) : '—') + ' Ah');
        setEl('rt-mos', (dev.mos_temp !== undefined ? dev.mos_temp.toFixed(1) : '—') + ' °C');
        setEl('rt-cyc', dev.cycle_count !== undefined ? dev.cycle_count : '—');
        setEl('g-mostemp', dev.mos_temp !== undefined ? dev.mos_temp.toFixed(1) : '—');
        setEl('g-rem', dev.remain_capacity_ah !== undefined ? dev.remain_capacity_ah.toFixed(1) : '—');
        setEl('rt-cap', (dev.capacity_ah !== undefined ? dev.capacity_ah.toFixed(1) : '—') + ' Ah');
        setEl('rt-bal', (dev.balance_current !== undefined ? dev.balance_current.toFixed(3) : '0.000') + ' A');
        setEl('rt-delta', (dev.delta_cell_voltage !== undefined ? dev.delta_cell_voltage.toFixed(3) : '0.000') + ' V');
        const minV = parseFloat(dev.min_cell_voltage || 0);
        const maxV = parseFloat(dev.max_cell_voltage || 0);
        const avgV = (minV > 0 && maxV > 0) ? ((minV + maxV) / 2).toFixed(3) : '—';
        setEl('rt-avg', avgV + ' V');
      } else {
        setEl('g-mincell', '—'); setEl('g-maxcell', '—'); setEl('g-delta', '—'); setEl('g-balcurr', '—');
        setEl('bar-curr', '0.00'); setEl('bar-power', '0.0'); setEl('rt-power', '—'); setEl('rt-rem', '—');
        setEl('rt-mos', '—'); setEl('rt-cyc', '—'); setEl('g-mostemp', '—'); setEl('g-rem', '—');
        setEl('rt-cap', '—'); setEl('rt-bal', '—'); setEl('rt-delta', '—'); setEl('rt-avg', '—');
      }

        // Dynamic Cell Voltages & Resistances Grid update
        const cellsArr = Array.isArray(dev.cell_voltages) ? dev.cell_voltages : (Array.isArray(dev.cells) ? dev.cells : []);
        const cellResArr = Array.isArray(dev.cell_resistances) ? dev.cell_resistances : [];
        const minNum = dev.min_cell_num || 0;
        const maxNum = dev.max_cell_num || 0;
        const count = dev.cell_count || (cellsArr.length > 0 ? cellsArr.length : 16);
        const gridEl = document.querySelector('.cells-grid');
        if (gridEl && cellsArr.length > 0) {
          let html = '';
          for (let i = 0; i < count; i++) {
            const num = (i + 1).toString().padStart(2, '0');
            const v = cellsArr[i];
            let color = '#3fb950';
            let tagHtml = '';
            if (i + 1 === minNum) { color = '#e3b341'; tagHtml = '<span class="c-tag min">MIN</span>'; }
            if (i + 1 === maxNum) { color = '#f85149'; tagHtml = '<span class="c-tag max">MAX</span>'; }
            const valStr = (typeof v === 'number' ? v : parseFloat(v)).toFixed(3);
            const resVal = i < cellResArr.length && cellResArr[i] && parseFloat(cellResArr[i]) > 0 ? parseFloat(cellResArr[i]).toFixed(2) + ' mΩ' : '0.00 mΩ';
            html += '<div class="cell-box"><div class="c-row-top"><span class="c-num">#' + num + '</span><span class="c-res">⚡ ' + resVal + '</span></div><div class="c-row-bottom"><span class="c-val" style="color:' + color + ';">' + valStr + '<sup>V</sup></span>' + tagHtml + '</div></div>';
          }
          gridEl.innerHTML = html;
        }
      } else {
        // Device is OFFLINE -> Set ALL fields to ZERO
        setEl('g-mincell', '0.000');
        setEl('g-maxcell', '0.000');
        setEl('g-delta', '0.000');
        setEl('g-balcurr', '0.000');
        setEl('bar-curr', '0.00');
        setEl('bar-power', '0.0');
        setEl('rt-power', '0.0 W');
        setEl('rt-rem', '0.0 Ah');
        setEl('rt-mos', '0.0 °C');
        setEl('rt-cyc', '0');
        setEl('g-mostemp', '0.0');
        setEl('g-rem', '0.0');
        setEl('rt-cap', '0.0 Ah');
        setEl('rt-bal', '0.000 A');
        setEl('rt-delta', '0.000 V');
        setEl('rt-avg', '0.000 V');
      }

      const bleEl = document.getElementById('bms-connected-status');
      if (bleEl) { bleEl.textContent = bc ? (dev.active_bms_name||'JK-BMS') : 'Chưa kết nối'; bleEl.style.color = bc ? '#3fb950' : '#f85149'; }
      const macEl = document.getElementById('bms-mac-status');
      if (macEl) macEl.textContent = dev.active_bms_mac || '—';
      const topBmsEl = document.getElementById('top-bms-name');
      if (topBmsEl && dev.active_bms_name) topBmsEl.textContent = dev.active_bms_name;
    } catch(e){}
  }

  let chart24hInstance = null;
  async function load24hChartData() {
    try {
      const res = await fetch('/api/history?device_id=${d.device_id}&_t=' + Date.now());
      if (!res.ok) return;
      const history = await res.json();
      if (!Array.isArray(history) || history.length === 0) return;

      const labels = history.map(pt => pt.time || '');
      const voltages = history.map(pt => pt.v);
      const powers = history.map(pt => pt.p);

      const ctx = document.getElementById('chart-24h');
      if (!ctx) return;

      if (chart24hInstance) {
        chart24hInstance.data.labels = labels;
        chart24hInstance.data.datasets[0].data = voltages;
        chart24hInstance.data.datasets[1].data = powers;
        chart24hInstance.update('none');
      } else {
        const vGrad = ctx.getContext('2d').createLinearGradient(0, 0, 0, 180);
        vGrad.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
        vGrad.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

        chart24hInstance = new Chart(ctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Điện Áp (V)',
                data: voltages,
                borderColor: '#10b981',
                backgroundColor: vGrad,
                borderWidth: 2,
                fill: true,
                tension: 0.35,
                pointRadius: 0,
                pointHoverRadius: 5,
                yAxisID: 'yV'
              },
              {
                label: 'Công Suất (W)',
                data: powers,
                borderColor: '#38bdf8',
                borderWidth: 1.5,
                borderDash: [3, 3],
                fill: false,
                tension: 0.35,
                pointRadius: 0,
                pointHoverRadius: 5,
                yAxisID: 'yP'
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: {
                display: true,
                position: 'top',
                labels: { color: '#94a3b8', font: { size: 10, family: 'Inter' }, boxWidth: 10 }
              },
              tooltip: {
                backgroundColor: 'rgba(10, 18, 28, 0.95)',
                borderColor: 'rgba(56, 189, 248, 0.3)',
                borderWidth: 1,
                titleColor: '#38bdf8',
                bodyColor: '#e2e8f0',
                titleFont: { family: 'Share Tech Mono', size: 11 },
                bodyFont: { family: 'Share Tech Mono', size: 11 }
              }
            },
            scales: {
              x: {
                grid: { color: 'rgba(255, 255, 255, 0.04)' },
                ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 7 }
              },
              yV: {
                type: 'linear',
                position: 'left',
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: { color: '#10b981', font: { size: 9, family: 'Share Tech Mono' } }
              },
              yP: {
                type: 'linear',
                position: 'right',
                grid: { drawOnChartArea: false },
                ticks: { color: '#38bdf8', font: { size: 9, family: 'Share Tech Mono' } }
              }
            }
          }
        });
      }
    } catch(e) { console.error('Chart load error:', e); }
  }

  setTimeout(load24hChartData, 500);
  setInterval(load24hChartData, 60000);

  setInterval(refreshLiveData, 1500);
  refreshLiveData();
</script>
</div>
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
