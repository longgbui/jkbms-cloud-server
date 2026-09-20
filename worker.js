// ─── SCALABILITY CONFIG (500 ESP Devices — NON-CONTINUOUS MODE) ───────────────
// Trạng thái Online/Offline cập nhật liên tục trong RAM (0 KV reads / 0 KV writes)
// ESP ping định kỳ → update lastSeen trong RAM → web xem trạng thái mượt mà 100% FREE!
//
// KV Budget (FREE TIER 1K writes/day):
//   Device snapshot: 500 ESP × 1 write/day  =  500 writes/day ✅
//   History data:    500 ESP × 1 write/day  =  500 writes/day ✅
//   TOTAL:                                   = 1,000 writes/day → ĐÚNG giới hạn FREE!
// ──────────────────────────────────────────────────────────────────────────────
const OFFLINE_MS             = 40 * 60 * 1000; // Mark offline after 40 min no heartbeat (ESP idles at 20 min)
const KV_DEVICE_THROTTLE_MS  = 24 * 60 * 60 * 1000; // Write device snapshot to KV once per 24 HOURS
const KV_HISTORY_THROTTLE_MS = 24 * 60 * 60 * 1000; // Write history to KV once per 24 HOURS
const IDLE_INTERVAL_MS       = 10 * 1000;      // ESP polls every 10s when no user viewing (instant wake-up in 3-5s)
const ACTIVE_INTERVAL_MS     = 1500;           // ESP uploads telemetry every 1.5s when user is viewing (real-time stream)
const SESSION_TIMEOUT_MS     = 25 * 1000;      // 25 seconds user session active timeout (releases BMS quickly when user leaves)
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

// ── Request Counter (RAM + KV daily persistence) ────────────────────────────
let   MEMORY_REQ_DATE        = '';   // Current date key YYYY-MM-DD
let   MEMORY_REQ_COUNT       = 0;   // Requests in current day (RAM)
let   MEMORY_KV_COUNT        = 0;   // Count saved to KV (for delta tracking)
const KV_REQ_FLUSH_EVERY     = 50;  // Flush to KV every N requests to save KV writes

async function incrementRequestCounter(env) {
  try {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
    if (dateKey !== MEMORY_REQ_DATE) {
      // New day: flush old count, reset
      MEMORY_REQ_DATE  = dateKey;
      MEMORY_REQ_COUNT = 1;
      MEMORY_KV_COUNT  = 0;
      if (env.KV) await env.KV.put('req_count:' + dateKey, '1', { expirationTtl: 7 * 86400 });
    } else {
      MEMORY_REQ_COUNT++;
      // Flush delta to KV every N requests (save KV write budget)
      if (MEMORY_REQ_COUNT - MEMORY_KV_COUNT >= KV_REQ_FLUSH_EVERY) {
        MEMORY_KV_COUNT = MEMORY_REQ_COUNT;
        if (env.KV) await env.KV.put('req_count:' + dateKey, String(MEMORY_REQ_COUNT), { expirationTtl: 7 * 86400 });
      }
    }
  } catch(e) {}
}

function isOnline(device) {
  return device.lastSeen && (Date.now() - device.lastSeen) < OFFLINE_MS;
}

// ── D1 SQLite Storage Engine ────────────────────────────────────────────────
// Zero-cost, 5M rows free tier, ultra-reliable persistent database
async function d1Init(env) {
  if (!env.DB) return;
  try {
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        data TEXT,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS ble_results (
        device_id TEXT PRIMARY KEY,
        devices TEXT,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT,
        cmd TEXT,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        device_id TEXT PRIMARY KEY,
        last_active INTEGER
      );
    `);
  } catch (e) {}
}

async function d1SaveDevice(env, dev) {
  if (!env.DB || !dev || !dev.device_id) return;
  try {
    const json = JSON.stringify(dev);
    await env.DB.prepare(`
      INSERT INTO devices (device_id, data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).bind(dev.device_id, json, Date.now()).run();
  } catch (e) {}
}

async function d1GetDevice(env, deviceId) {
  if (!env.DB || !deviceId) return null;
  try {
    const row = await env.DB.prepare('SELECT data FROM devices WHERE device_id = ?').bind(deviceId).first();
    if (row && row.data) return JSON.parse(row.data);
  } catch (e) {}
  return null;
}

async function d1GetAllDevices(env) {
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare('SELECT data FROM devices').all();
    if (results && results.length > 0) {
      return results.map(r => JSON.parse(r.data));
    }
  } catch (e) {}
  return [];
}

async function d1SaveBleResult(env, deviceId, devicesList) {
  if (!env.DB || !deviceId) return;
  try {
    const json = JSON.stringify(devicesList);
    await env.DB.prepare(`
      INSERT INTO ble_results (device_id, devices, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET devices = excluded.devices, updated_at = excluded.updated_at
    `).bind(deviceId, json, Date.now()).run();
  } catch (e) {}
}

async function d1GetBleResult(env, deviceId) {
  if (!env.DB || !deviceId) return null;
  try {
    const row = await env.DB.prepare('SELECT devices, updated_at FROM ble_results WHERE device_id = ?').bind(deviceId).first();
    if (row && row.devices) {
      return { status: 'done', devices: JSON.parse(row.devices), updatedAt: row.updated_at };
    }
  } catch (e) {}
  return null;
}

async function d1AddCommand(env, deviceId, cmdObj) {
  if (!env.DB || !deviceId || !cmdObj) return;
  try {
    const json = typeof cmdObj === 'string' ? cmdObj : JSON.stringify(cmdObj);
    await env.DB.prepare('INSERT INTO commands (device_id, cmd, created_at) VALUES (?, ?, ?)').bind(deviceId, json, Date.now()).run();
  } catch (e) {}
}
const d1QueueCommand = d1AddCommand;

async function d1GetAndClearCommands(env, deviceId) {
  if (!env.DB || !deviceId) return [];
  try {
    const { results } = await env.DB.prepare('SELECT id, cmd FROM commands WHERE device_id = ? ORDER BY id ASC').bind(deviceId).all();
    if (results && results.length > 0) {
      await env.DB.prepare('DELETE FROM commands WHERE device_id = ?').bind(deviceId).run();
      const cmds = [];
      for (const r of results) {
        try {
          const parsed = JSON.parse(r.cmd);
          if (Array.isArray(parsed)) cmds.push(...parsed);
          else cmds.push(parsed);
        } catch(e) {}
      }
      return cmds;
    }
  } catch (e) {
    console.error('D1 getAndClearCommands error:', e);
  }
  return [];
}

async function d1ClearBleResult(env, deviceId) {
  if (!env.DB || !deviceId) return;
  try {
    await env.DB.prepare('DELETE FROM ble_results WHERE device_id = ?').bind(deviceId).run();
  } catch (e) {}
}

async function d1EndSession(env, deviceId) {
  if (!env.DB || !deviceId) return;
  try {
    await env.DB.prepare('DELETE FROM sessions WHERE device_id = ?').bind(deviceId).run();
  } catch (e) {}
}

async function d1TouchSession(env, deviceId) {
  if (!env.DB || !deviceId) return;
  try {
    await env.DB.prepare(`
      INSERT INTO sessions (device_id, last_active)
      VALUES (?, ?)
      ON CONFLICT(device_id) DO UPDATE SET last_active = excluded.last_active
    `).bind(deviceId, Date.now()).run();
  } catch (e) {}
}

async function d1IsSessionActive(env, deviceId, timeoutMs = SESSION_TIMEOUT_MS) {
  if (!env.DB || !deviceId) return false;
  try {
    const row = await env.DB.prepare('SELECT last_active FROM sessions WHERE device_id = ?').bind(deviceId).first();
    if (row && row.last_active) {
      return (Date.now() - row.last_active) < timeoutMs;
    }
  } catch (e) {}
  return false;
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

    await d1Init(env);

    // Count every request for usage stats (non-blocking)
    ctx.waitUntil(incrementRequestCounter(env));

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

        // Await KV writes so they are immediately consistent
        await Promise.all([
          env.DEVICES.put('__latest_firmware_bin__', binBuffer),
          env.DEVICES.put('__firmware_meta__', JSON.stringify(meta))
        ]);

        return jsonResponse({ status: 'ok', ...meta }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/firmware-info ─────────────────────────────────
    // Served from RAM or fresh KV metadata
    if (method === 'GET' && path === '/api/firmware-info') {
      try {
        const raw = await env.DEVICES.get('__firmware_meta__');
        if (raw) MEMORY_FIRMWARE_INFO = JSON.parse(raw);
        const info = MEMORY_FIRMWARE_INFO || { version: 'none', size: 0, uploadedAt: 0 };
        return jsonResponse({
          ...info,
          latest_version: info.version,
          firmware_url: `${url.origin}/firmware/latest.bin`
        }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ version: 'none', latest_version: 'none', size: 0, uploadedAt: 0 }, 200, corsHeaders);
      }
    }

    // ── GET & HEAD /firmware/latest.bin ───────────────────────────────
    if ((method === 'GET' || method === 'HEAD') && (path === '/firmware/latest.bin' || path === '/firmware/latest.bin/')) {
      try {
        if (method === 'HEAD') {
          return new Response(null, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': 'attachment; filename="firmware.bin"',
              ...corsHeaders
            }
          });
        }
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

    // ── GET /api/force-idle ───────────────────────────────────
    if (path === '/api/force-idle') {
      const deviceId = url.searchParams.get('device_id') || 'JKBMS-ACCA';
      MEMORY_ACTIVE_SESSIONS.delete(deviceId);
      ctx.waitUntil(env.DB.prepare('DELETE FROM active_sessions WHERE device_id = ?').bind(deviceId).run().catch(()=>{}));
      return jsonResponse({ status: 'ok', idle: deviceId }, 200, corsHeaders);
    }

    // ── POST /api/send-command (D1 + Fast RAM) ──────────────────
    if (method === 'POST' && path === '/api/send-command') {
      try {
        const body = await request.json();
        const { device_id, cmd } = body;
        if (!device_id || !cmd) {
          return jsonResponse({ error: 'Missing device_id or cmd' }, 400, corsHeaders);
        }

        // Register active user session for this device
        const nowTs = Date.now();
        MEMORY_ACTIVE_SESSIONS.set(device_id, nowTs);
        ctx.waitUntil(d1TouchSession(env, device_id));

        const cmdArr = Array.isArray(cmd) ? cmd : [cmd];
        let dev = MEMORY_DEVICE_CACHE.get(device_id);
        if (!dev) {
          dev = await d1GetDevice(env, device_id);
        }
        if (dev) {
          if (cmdArr.some(c => c && c.cmd === 'scan_ble')) {
            delete dev.scanned_devices;
            ctx.waitUntil(d1ClearBleResult(env, device_id));
          }
          if (!dev.params) dev.params = {};
          if (!dev.settings) dev.settings = {};
          let hasParams = false;
          const REG_TO_SETTING_KEY = {
            1: 'smart_sleep_v', 2: 'cell_uvp', 3: 'cell_uvpr', 4: 'cell_ovp', 5: 'cell_ovpr',
            6: 'bal_delta_v', 7: 'soc100_v', 8: 'soc0_v', 9: 'req_chg_v', 10: 'req_float_v',
            11: 'power_off_v', 12: 'max_chg_curr', 13: 'chg_ocp_delay', 14: 'chg_ocpr_time',
            15: 'max_dsg_curr', 16: 'dsg_ocp_delay', 19: 'max_bal_curr', 28: 'cell_count',
            32: 'battery_cap', 38: 'bal_start_v', 166: 'can_protocol'
          };
          for (const c of cmdArr) {
            if (c && c.cmd === 'set_param' && c.reg !== undefined) {
              const numReg = Number(c.reg);
              const numVal = Number(c.val);
              dev.params[String(numReg)] = numVal;
              const sKey = REG_TO_SETTING_KEY[numReg];
              if (sKey) dev.settings[sKey] = numVal;
              if (numReg === 166 || numReg === 0xA6) {
                dev.can_protocol = numVal;
                dev.canProtocol = numVal;
              }
              if (numReg === 0x9F || numReg === 270) {
                dev.address_id = numVal;
                dev.rs485DeviceId = numVal;
              }
              hasParams = true;
            }
          }
          if (hasParams) {
            MEMORY_DEVICE_CACHE.set(device_id, dev);
            ctx.waitUntil(d1SaveDevice(env, dev));
          }
        }
        MEMORY_COMMANDS_MAP.set(device_id, cmdArr);
        for (const c of cmdArr) {
          ctx.waitUntil(d1AddCommand(env, device_id, c));
        }

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
        devObj = await d1GetDevice(env, deviceId);
      }
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

      if (body.scanned_devices && Array.isArray(body.scanned_devices)) {
        const resultObj = { status: 'done', devices: body.scanned_devices, updatedAt: nowMs };
        MEMORY_BLE_RESULTS_MAP.set(deviceId, resultObj);
        devObj.scanned_devices = body.scanned_devices;
        ctx.waitUntil(d1SaveBleResult(env, deviceId, body.scanned_devices));
      }

      if (body.settings && typeof body.settings === 'object') {
        devObj.settings = body.settings;
        if (!devObj.params) devObj.params = {};
        if (body.settings.smart_sleep_v !== undefined) devObj.params['1'] = body.settings.smart_sleep_v;
        if (body.settings.cell_uvp !== undefined) devObj.params['2'] = body.settings.cell_uvp;
        if (body.settings.cell_uvpr !== undefined) devObj.params['3'] = body.settings.cell_uvpr;
        if (body.settings.cell_ovp !== undefined) devObj.params['4'] = body.settings.cell_ovp;
        if (body.settings.cell_ovpr !== undefined) devObj.params['5'] = body.settings.cell_ovpr;
        if (body.settings.bal_delta_v !== undefined) devObj.params['6'] = body.settings.bal_delta_v;
        if (body.settings.soc100_v !== undefined) devObj.params['7'] = body.settings.soc100_v;
        if (body.settings.soc0_v !== undefined) devObj.params['8'] = body.settings.soc0_v;
        if (body.settings.req_chg_v !== undefined) devObj.params['9'] = body.settings.req_chg_v;
        if (body.settings.req_float_v !== undefined) devObj.params['10'] = body.settings.req_float_v;
        if (body.settings.power_off_v !== undefined) devObj.params['11'] = body.settings.power_off_v;
        if (body.settings.max_chg_curr !== undefined) devObj.params['12'] = body.settings.max_chg_curr;
        if (body.settings.chg_ocp_delay !== undefined) devObj.params['13'] = body.settings.chg_ocp_delay;
        if (body.settings.chg_ocpr_time !== undefined) devObj.params['14'] = body.settings.chg_ocpr_time;
        if (body.settings.max_dsg_curr !== undefined) devObj.params['15'] = body.settings.max_dsg_curr;
        if (body.settings.dsg_ocp_delay !== undefined) devObj.params['16'] = body.settings.dsg_ocp_delay;
        if (body.settings.dsg_ocpr_time !== undefined) devObj.params['17'] = body.settings.dsg_ocpr_time;
        if (body.settings.max_bal_curr !== undefined) devObj.params['19'] = body.settings.max_bal_curr;
        if (body.settings.cell_count !== undefined) devObj.params['28'] = body.settings.cell_count;
        if (body.settings.battery_cap !== undefined) devObj.params['32'] = body.settings.battery_cap;
        if (body.settings.bal_start_v !== undefined) devObj.params['38'] = body.settings.bal_start_v;
      }

      MEMORY_DEVICE_INDEX.add(deviceId);
      MEMORY_DEVICE_CACHE.set(deviceId, devObj);
      ctx.waitUntil(d1SaveDevice(env, devObj));

      let isUserActive = (Date.now() - (MEMORY_ACTIVE_SESSIONS.get(deviceId) || 0)) < SESSION_TIMEOUT_MS;
      if (!isUserActive) {
        isUserActive = await d1IsSessionActive(env, deviceId, SESSION_TIMEOUT_MS);
      }
      const targetIntervalMs = isUserActive ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;

      // Record 24h history point if live voltage is provided
      if (body.voltage && body.voltage > 0) {
        let history = MEMORY_HISTORY_CACHE.get(deviceId);
        if (!history) history = [];
        const lastPt = history[history.length - 1];
        const timeDiffMs = lastPt ? (nowMs - lastPt.t) : 99999999;
        if (timeDiffMs >= 10 * 60 * 1000 || (lastPt && Math.abs(body.voltage - lastPt.v) >= 0.4)) {
          const timeStr = new Date(nowMs).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
          history.push({ t: nowMs, time: timeStr, v: parseFloat(body.voltage.toFixed(2)), p: Math.round(body.power || 0), s: parseInt(body.soc || 0) });
          if (history.length > 144) history.shift();
          MEMORY_HISTORY_CACHE.set(deviceId, history);
        }
      }

      let cmdArr = [];
      if (method === 'POST') {
        if (MEMORY_COMMANDS_MAP.has(deviceId)) {
          cmdArr = MEMORY_COMMANDS_MAP.get(deviceId);
          MEMORY_COMMANDS_MAP.delete(deviceId);
        }
        const d1Cmds = await d1GetAndClearCommands(env, deviceId);
        if (d1Cmds && d1Cmds.length > 0) {
          cmdArr.push(...d1Cmds);
        }
        if (cmdArr.length === 0) {
          try {
            const rawCmd = await env.DEVICES.get(`cmd:${deviceId}`);
            if (rawCmd) {
              cmdArr = JSON.parse(rawCmd);
              ctx.waitUntil(env.DEVICES.delete(`cmd:${deviceId}`).catch(()=>{}));
            }
          } catch(e){}
        }
      } else {
        if (MEMORY_COMMANDS_MAP.has(deviceId)) {
          cmdArr = [...MEMORY_COMMANDS_MAP.get(deviceId)];
        }
      }

      cmdArr.push({
        cmd: 'set_mode',
        active: isUserActive,
        interval_ms: targetIntervalMs,
        activated_at: firstActivatedStr
      });

      return jsonResponse({
        status: 'ok',
        device_id: deviceId,
        active: isUserActive,
        interval_ms: targetIntervalMs,
        commands: cmdArr
      }, 200, corsHeaders);
    }

    // ── POST /api/ble-result (D1 + Fast RAM) ────────────────────
    if (method === 'POST' && path === '/api/ble-result') {
      try {
        const body = await request.json();
        const deviceId = body.device_id;
        if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

        const devicesList = body.devices || [];
        const resultObj = { status: 'done', devices: devicesList, updatedAt: Date.now() };
        MEMORY_BLE_RESULTS_MAP.set(deviceId, resultObj);
        ctx.waitUntil(d1SaveBleResult(env, deviceId, devicesList));

        return jsonResponse({ status: 'ok', count: devicesList.length }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ status: 'ok', count: 0 }, 200, corsHeaders);
      }
    }

    // ── GET /api/scanned-ble (D1 + Fast RAM) ───────────────────
    if (method === 'GET' && path === '/api/scanned-ble') {
      const deviceId = url.searchParams.get('device_id');
      if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

      let resObj = MEMORY_BLE_RESULTS_MAP.get(deviceId);
      if (!resObj) {
        resObj = await d1GetBleResult(env, deviceId);
        if (resObj) {
          MEMORY_BLE_RESULTS_MAP.set(deviceId, resObj);
        }
      }

      if (!resObj) {
        let dev = MEMORY_DEVICE_CACHE.get(deviceId);
        if (!dev) {
          dev = await d1GetDevice(env, deviceId);
        }
        if (dev && Array.isArray(dev.scanned_devices) && dev.scanned_devices.length > 0) {
          resObj = { status: 'done', devices: dev.scanned_devices, updatedAt: dev.lastSeen || Date.now() };
          MEMORY_BLE_RESULTS_MAP.set(deviceId, resObj);
        }
      }

      if (resObj && Array.isArray(resObj.devices)) {
        return jsonResponse({ status: 'done', devices: resObj.devices, updatedAt: resObj.updatedAt || 0 }, 200, corsHeaders);
      }

      return jsonResponse({ status: 'scanning', devices: [], updatedAt: 0 }, 200, corsHeaders);
    }

    // ── POST /api/session-end (Tab Closed / Navigated Away) ──
    if (path === '/api/session-end') {
      const devId = url.searchParams.get('device_id');
      if (devId) {
        MEMORY_ACTIVE_SESSIONS.delete(devId);
        MEMORY_COMMANDS_MAP.set(devId, [{ cmd: 'set_mode', active: false }]);
        ctx.waitUntil((async () => {
          try {
            await env.DEVICES.delete(`session:${devId}`);
            await env.DEVICES.put(`cmd:${devId}`, JSON.stringify([{ cmd: 'set_mode', active: false }]), { expirationTtl: 60 });
          } catch(e){}
        })());
      }
      return jsonResponse({ status: 'ok' }, 200, corsHeaders);
    }

    // ── POST /api/telemetry & /api/device-heartbeat (RAM First + Throttled KV Writes) ──
    if (method === 'POST' && (path === '/api/telemetry' || path === '/api/device-heartbeat')) {
      try {
        const body = await request.json();
        const deviceId = body.device_id;
        if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

        const nowMs = Date.now();
        
        // 1. Retrieve existing device record from RAM cache or D1/KV disk
        let existing = MEMORY_DEVICE_CACHE.get(deviceId);
        if (!existing) {
          existing = await d1GetDevice(env, deviceId);
        }
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

        if (body.settings && typeof body.settings === 'object') {
          updated.settings = body.settings;
          if (!updated.params) updated.params = {};
          if (body.settings.smart_sleep_v !== undefined) updated.params['1'] = body.settings.smart_sleep_v;
          if (body.settings.cell_uvp !== undefined) updated.params['2'] = body.settings.cell_uvp;
          if (body.settings.cell_uvpr !== undefined) updated.params['3'] = body.settings.cell_uvpr;
          if (body.settings.cell_ovp !== undefined) updated.params['4'] = body.settings.cell_ovp;
          if (body.settings.cell_ovpr !== undefined) updated.params['5'] = body.settings.cell_ovpr;
          if (body.settings.bal_delta_v !== undefined) updated.params['6'] = body.settings.bal_delta_v;
          if (body.settings.soc100_v !== undefined) updated.params['7'] = body.settings.soc100_v;
          if (body.settings.soc0_v !== undefined) updated.params['8'] = body.settings.soc0_v;
          if (body.settings.req_chg_v !== undefined) updated.params['9'] = body.settings.req_chg_v;
          if (body.settings.req_float_v !== undefined) updated.params['10'] = body.settings.req_float_v;
          if (body.settings.power_off_v !== undefined) updated.params['11'] = body.settings.power_off_v;
          if (body.settings.max_chg_curr !== undefined) updated.params['12'] = body.settings.max_chg_curr;
          if (body.settings.chg_ocp_delay !== undefined) updated.params['13'] = body.settings.chg_ocp_delay;
          if (body.settings.chg_ocpr_time !== undefined) updated.params['14'] = body.settings.chg_ocpr_time;
          if (body.settings.max_dsg_curr !== undefined) updated.params['15'] = body.settings.max_dsg_curr;
          if (body.settings.dsg_ocp_delay !== undefined) updated.params['16'] = body.settings.dsg_ocp_delay;
          if (body.settings.max_bal_curr !== undefined) updated.params['19'] = body.settings.max_bal_curr;
          if (body.settings.cell_count !== undefined) updated.params['28'] = body.settings.cell_count;
          if (body.settings.battery_cap !== undefined) updated.params['32'] = body.settings.battery_cap;
          if (body.settings.bal_start_v !== undefined) updated.params['38'] = body.settings.bal_start_v;
        }

        if (body.scanned_devices && Array.isArray(body.scanned_devices)) {
          const resultObj = { status: 'done', devices: body.scanned_devices, updatedAt: nowMs };
          MEMORY_BLE_RESULTS_MAP.set(deviceId, resultObj);
          updated.scanned_devices = body.scanned_devices;
          ctx.waitUntil(d1SaveBleResult(env, deviceId, body.scanned_devices));
        }

        MEMORY_DEVICE_INDEX.add(deviceId);
        MEMORY_DEVICE_CACHE.set(deviceId, updated);
        ctx.waitUntil(d1SaveDevice(env, updated));

        let isUserActive = (Date.now() - (MEMORY_ACTIVE_SESSIONS.get(deviceId) || 0)) < SESSION_TIMEOUT_MS;
        if (!isUserActive) {
          isUserActive = await d1IsSessionActive(env, deviceId, SESSION_TIMEOUT_MS);
        }

        // 3. 24h Time-Series History Recorder (10-min interval / Smart Delta)
        if (body.voltage && body.voltage > 0) {
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

          if (timeDiffMs >= 10 * 60 * 1000 || powerDiff >= 100 || voltDiff >= 0.4) {
            const timeStr = new Date(nowMs).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
            history.push({ t: nowMs, time: timeStr, v: parseFloat(body.voltage.toFixed(2)), p: Math.round(body.power || 0), s: parseInt(body.soc || 0) });
            if (history.length > 144) history.shift();
            MEMORY_HISTORY_CACHE.set(deviceId, history);
          }
        }

        let cmdArr = [];
        if (MEMORY_COMMANDS_MAP.has(deviceId)) {
          cmdArr = MEMORY_COMMANDS_MAP.get(deviceId);
          MEMORY_COMMANDS_MAP.delete(deviceId);
        }
        const d1Cmds = await d1GetAndClearCommands(env, deviceId);
        if (d1Cmds && d1Cmds.length > 0) {
          cmdArr.push(...d1Cmds);
        }
        if (cmdArr.length === 0) {
          try {
            const rawCmd = await env.DEVICES.get(`cmd:${deviceId}`);
            if (rawCmd) {
              cmdArr = JSON.parse(rawCmd);
              ctx.waitUntil(env.DEVICES.delete(`cmd:${deviceId}`).catch(()=>{}));
            }
          } catch(e){}
        }

        cmdArr.push({
          cmd: 'set_mode',
          active: isUserActive,
          interval_ms: isUserActive ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS,
          activated_at: firstActivatedStr
        });

        return jsonResponse({ status: 'ok', device_id: deviceId, active: isUserActive, commands: cmdArr }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ status: 'error', error: e.message, stack: e.stack }, 500, corsHeaders);
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
        if (!history) history = [];
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
        const isWatching = url.searchParams.get('watch') === '1';
        const watchDevId = isWatching ? url.searchParams.get('device_id') : null;
        if (watchDevId) {
          const nowTs = Date.now();
          MEMORY_ACTIVE_SESSIONS.set(watchDevId, nowTs);
          ctx.waitUntil(d1TouchSession(env, watchDevId));
        }

        const allDeviceIds = new Set();
        MEMORY_DEVICE_INDEX.forEach(id => allDeviceIds.add(id));
        MEMORY_DEVICE_CACHE.forEach((v, k) => allDeviceIds.add(k));

        // 1. Fetch all devices from D1 (Single query, strong consistency, 0 KV ops)
        const d1Devs = await d1GetAllDevices(env);
        const d1Map = new Map();
        if (d1Devs && d1Devs.length > 0) {
          for (const d of d1Devs) {
            d1Map.set(d.device_id, d);
            allDeviceIds.add(d.device_id);
            const cached = MEMORY_DEVICE_CACHE.get(d.device_id);
            if (!cached || (d.lastSeen && d.lastSeen > (cached.lastSeen || 0))) {
              MEMORY_DEVICE_CACHE.set(d.device_id, d);
            }
          }
        }

        try {
          const listRaw = await env.DEVICES.get('__device_index__');
          if (listRaw) {
            const arr = JSON.parse(listRaw);
            arr.forEach(id => allDeviceIds.add(id));
          }
        } catch(e){}

        const devices = [];

        for (const id of allDeviceIds) {
          try {
            let dev = MEMORY_DEVICE_CACHE.get(id) || d1Map.get(id);
            if (!dev) {
              dev = await d1GetDevice(env, id);
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

    // ── GET /d/:deviceId or /device/:deviceId (Customer Monitoring UI) ─────────────
    if (method === 'GET' && (path.startsWith('/d/') || path.startsWith('/device/'))) {
      const deviceId = path.startsWith('/device/') ? path.substring(8).trim() : path.substring(3).trim();
      if (deviceId) {
        try {
          const nowTs = Date.now();
          MEMORY_ACTIVE_SESSIONS.set(deviceId, nowTs);
          ctx.waitUntil(d1TouchSession(env, deviceId));

          let dev = MEMORY_DEVICE_CACHE.get(deviceId);
          if (!dev) {
            dev = await d1GetDevice(env, deviceId);
          }
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
        } catch (err) {
          console.error("Error rendering customer UI:", err);
          return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head><body style="background:#000;color:#fff;font-family:sans-serif;padding:20px;"><h2>Lỗi tải giao diện thiết bị: ${deviceId}</h2><pre style="color:#f85149;">${err.stack || err.message}</pre><p><a href="/admin" style="color:#00e5ff;">Về trang quản trị</a></p></body></html>`, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              ...corsHeaders
            }
          });
        }
      }
    }

    // ── GET /admin (Admin Management Dashboard for All Devices) ──
    if (method === 'GET' && (path === '/admin' || path === '/admin/' || path === '/dashboard')) {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders }
      });
    }

    // ── GET /api/usage-stats ──
    if (method === 'GET' && path === '/api/usage-stats') {
      try {
        const now        = new Date();
        const dateKey    = now.toISOString().slice(0, 10);
        const hourOfDay  = now.getUTCHours();
        const minuteOfDay = hourOfDay * 60 + now.getUTCMinutes();
        const dayProgress = minuteOfDay / 1440; // 0..1 fraction of day elapsed

        // Requests today: prefer RAM (fast), fall back to KV
        let reqToday = MEMORY_REQ_COUNT;
        if (MEMORY_REQ_DATE !== dateKey && env.KV) {
          const stored = await env.KV.get('req_count:' + dateKey);
          reqToday = stored ? parseInt(stored) : 0;
          MEMORY_REQ_DATE  = dateKey;
          MEMORY_REQ_COUNT = reqToday;
        }

        // Build last 7 days history from KV
        const history = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(now);
          d.setUTCDate(d.getUTCDate() - i);
          const dk = d.toISOString().slice(0, 10);
          let cnt = 0;
          if (dk === dateKey) {
            cnt = reqToday;
          } else if (env.KV) {
            const v = await env.KV.get('req_count:' + dk);
            cnt = v ? parseInt(v) : 0;
          }
          history.push({ date: dk, count: cnt });
        }

        // D1 stats
        let deviceCount = 0, commandCount = 0, bleCount = 0;
        if (env.DB) {
          try {
            const r1 = await env.DB.prepare('SELECT COUNT(*) as c FROM devices').first();
            deviceCount = r1 ? r1.c : 0;
            const r2 = await env.DB.prepare('SELECT COUNT(*) as c FROM commands').first();
            commandCount = r2 ? r2.c : 0;
            const r3 = await env.DB.prepare('SELECT COUNT(*) as c FROM ble_results').first();
            bleCount = r3 ? r3.c : 0;
          } catch(e) {}
        }

        // Online device count
        let onlineCount = 0;
        for (const dev of MEMORY_DEVICE_CACHE.values()) {
          if (isOnline(dev)) onlineCount++;
        }

        // Cloudflare FREE TIER limits
        const LIMIT_REQUESTS_DAY = 100000;
        const LIMIT_KV_READS_DAY = 100000;
        const LIMIT_KV_WRITES_DAY = 1000;
        const LIMIT_D1_ROWS = 5000000;
        const LIMIT_D1_READS_DAY = 25000000; // 25M row reads/day
        const LIMIT_D1_WRITES_DAY = 50000000; // 50M row writes/day

        // Estimated KV writes (50 req per write = req/50)
        const estimatedKvWritesToday = Math.ceil(reqToday / KV_REQ_FLUSH_EVERY);
        // Estimated D1 reads (each heartbeat ~3 reads, each poll ~2 reads)
        const estimatedD1ReadsToday = Math.round(reqToday * 2.5);

        return jsonResponse({
          date: dateKey,
          dayProgress,
          requests: { today: reqToday, limit: LIMIT_REQUESTS_DAY, pct: Math.round(reqToday / LIMIT_REQUESTS_DAY * 100) },
          kv: { writesToday: estimatedKvWritesToday, limit: LIMIT_KV_WRITES_DAY, pct: Math.round(estimatedKvWritesToday / LIMIT_KV_WRITES_DAY * 100) },
          d1: { rows: deviceCount + bleCount, rowLimit: LIMIT_D1_ROWS, readsToday: estimatedD1ReadsToday, readLimit: LIMIT_D1_READS_DAY, pct: Math.round(estimatedD1ReadsToday / LIMIT_D1_READS_DAY * 100) },
          devices: { total: MEMORY_DEVICE_CACHE.size, online: onlineCount, d1Rows: deviceCount },
          pendingCommands: commandCount,
          history,
        }, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
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

    if (path === '/favicon.ico') {
      return new Response(null, { status: 204 });
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

  <!-- CLOUD USAGE PANEL -->
  <div id="usage-panel" style="background:var(--surface);border:1px solid rgba(227,179,65,0.3);border-radius:12px;padding:18px;margin-bottom:18px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
      <div style="font-weight:700;font-size:0.95rem;color:var(--warning);display:flex;align-items:center;gap:8px;">
        ☁️ Cloudflare Free Tier — Lượt dùng còn lại hôm nay
      </div>
      <div id="usage-date" style="font-size:0.75rem;color:var(--subtext);font-family:monospace;background:var(--surface2);padding:4px 10px;border-radius:6px;border:1px solid var(--border);">
        Đang tải...
      </div>
    </div>

    <!-- 3 progress bars -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;margin-bottom:16px;">
      <!-- Requests -->
      <div>
        <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:5px;">
          <span style="color:var(--text);font-weight:600;">⚡ Requests / ngày</span>
          <span id="usage-req-txt" style="color:var(--warning);font-family:monospace;font-weight:700;">—</span>
        </div>
        <div style="background:var(--surface2);border-radius:6px;height:10px;overflow:hidden;">
          <div id="usage-req-bar" style="height:100%;width:0%;border-radius:6px;background:linear-gradient(90deg,#3fb950,#e3b341);transition:width 0.8s ease;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--subtext);margin-top:3px;">
          <span id="usage-req-left" style="color:var(--primary);font-weight:600;">còn lại: —</span>
          <span>giới hạn: 100,000/ngày</span>
        </div>
      </div>
      <!-- KV Writes -->
      <div>
        <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:5px;">
          <span style="color:var(--text);font-weight:600;">💾 KV Writes / ngày</span>
          <span id="usage-kv-txt" style="color:var(--accent);font-family:monospace;font-weight:700;">—</span>
        </div>
        <div style="background:var(--surface2);border-radius:6px;height:10px;overflow:hidden;">
          <div id="usage-kv-bar" style="height:100%;width:0%;border-radius:6px;background:linear-gradient(90deg,#58a6ff,#f85149);transition:width 0.8s ease;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--subtext);margin-top:3px;">
          <span id="usage-kv-left" style="color:var(--accent);font-weight:600;">còn lại: —</span>
          <span>giới hạn: 1,000/ngày</span>
        </div>
      </div>
      <!-- D1 Reads -->
      <div>
        <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:5px;">
          <span style="color:var(--text);font-weight:600;">🗄️ D1 Reads / ngày</span>
          <span id="usage-d1-txt" style="color:var(--primary);font-family:monospace;font-weight:700;">—</span>
        </div>
        <div style="background:var(--surface2);border-radius:6px;height:10px;overflow:hidden;">
          <div id="usage-d1-bar" style="height:100%;width:0%;border-radius:6px;background:linear-gradient(90deg,#3fb950,#e3b341);transition:width 0.8s ease;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--subtext);margin-top:3px;">
          <span id="usage-d1-left" style="color:var(--primary);font-weight:600;">còn lại: —</span>
          <span>giới hạn: 25M/ngày</span>
        </div>
      </div>
    </div>

    <!-- Sparkline 7 ngày + quick stats -->
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;">
      <div style="flex:1;min-width:200px;">
        <div style="font-size:0.72rem;color:var(--subtext);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Requests 7 ngày gần nhất</div>
        <div id="usage-sparkline" style="display:flex;align-items:flex-end;gap:4px;height:40px;">
          <div style="color:var(--subtext);font-size:0.75rem;">Đang tải...</div>
        </div>
        <div id="usage-sparkline-labels" style="display:flex;gap:4px;margin-top:3px;"></div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <div style="background:var(--surface2);border-radius:8px;padding:8px 14px;text-align:center;min-width:90px;">
          <div id="usage-devices-d1" style="font-size:1.3rem;font-weight:700;color:var(--accent);">—</div>
          <div style="font-size:0.68rem;color:var(--subtext);">Thiết bị D1</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:8px 14px;text-align:center;min-width:90px;">
          <div id="usage-pending-cmds" style="font-size:1.3rem;font-weight:700;color:var(--warning);">—</div>
          <div style="font-size:0.68rem;color:var(--subtext);">Lệnh chờ</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:8px 14px;text-align:center;min-width:90px;">
          <div id="usage-day-pct" style="font-size:1.3rem;font-weight:700;color:var(--primary);">—</div>
          <div style="font-size:0.68rem;color:var(--subtext);">Ngày trôi qua</div>
        </div>
      </div>
    </div>
  </div>

  <!-- QUICK LINK GENERATOR & PERMANENT DEVICE SAVER -->

  <div style="background:var(--surface);border:1px solid rgba(88,166,255,0.3);border-radius:12px;padding:16px;margin-bottom:18px;">
    <div style="font-weight:700;font-size:0.9rem;color:var(--accent);margin-bottom:10px;display:flex;align-items:center;gap:6px;">
      <span>💾 Quản Lý & Lưu Vĩnh Viễn Danh Sách Thiết Bị</span>
      <span style="font-size:0.75rem;color:var(--subtext);font-weight:400;">(Nhập Device ID để lưu vĩnh viễn vào Cloud)</span>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <input type="text" id="quick-dev-id" placeholder="Nhập ID bo mạch (Ví dụ: JKBMS-F89C)" value="JKBMS-18DE" style="flex:1;min-width:200px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:9px 14px;border-radius:8px;font-family:monospace;font-size:0.88rem;outline:none;">
      <button onclick="registerDevice()" style="background:rgba(63,185,80,0.2);border:1px solid #3fb950;color:#3fb950;padding:9px 16px;border-radius:8px;font-size:0.8rem;font-weight:700;cursor:pointer;">💾 Lưu Vĩnh Viễn</button>
      <button onclick="openQuickLink()" style="background:var(--accent);color:#0d1117;border:none;padding:9px 16px;border-radius:8px;font-size:0.8rem;font-weight:700;cursor:pointer;">🔗 Mở Giao Diện</button>
      <button onclick="copyQuickLink()" style="background:var(--primary-dim);border:1px solid var(--primary);color:var(--primary);padding:9px 16px;border-radius:8px;font-size:0.8rem;font-weight:700;cursor:pointer;">📋 Copy Link</button>
    </div>
    <div id="quick-msg" style="font-size:0.78rem;color:var(--primary);margin-top:8px;display:none;font-weight:600;"></div>
  </div>

  <!-- OTA FIRMWARE MANAGEMENT PANEL -->
  <div style="background:var(--surface);border:1px solid rgba(63,185,80,0.3);border-radius:12px;padding:16px;margin-bottom:24px;">
    <div style="font-weight:700;font-size:0.95rem;color:var(--primary);margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <span>🚀 Nạp & Cập Nhật Firmware Từ Xa (Remote Cloud OTA)</span>
      </div>
      <div id="ota-fw-badge" style="font-size:0.75rem;color:var(--subtext);font-family:monospace;background:var(--surface2);padding:4px 10px;border-radius:6px;border:1px solid var(--border);">
        Đang kiểm tra Cloud Firmware...
      </div>
    </div>
    
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;align-items:center;">
      <div style="display:flex;gap:8px;">
        <input type="file" id="ota-file-input" accept=".bin" style="display:none;" onchange="handleFileSelected(this)">
        <button onclick="document.getElementById('ota-file-input').click()" style="flex:1;background:var(--surface2);border:1px dashed #3fb950;color:var(--text);padding:10px 14px;border-radius:8px;font-size:0.8rem;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
          📁 <span id="ota-file-name">Chọn file firmware (.bin)</span>
        </button>
        <button onclick="uploadFirmware()" id="btn-upload-fw" style="background:#238636;color:#fff;border:none;padding:10px 18px;border-radius:8px;font-size:0.8rem;font-weight:700;cursor:pointer;white-space:nowrap;">
          ⬆️ Upload Lên Cloud
        </button>
      </div>

      <div style="display:flex;gap:8px;">
        <select id="ota-target-select" style="flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px 12px;border-radius:8px;font-size:0.82rem;font-family:monospace;outline:none;">
          <option value="all">⚡ Tất cả thiết bị (Broadcast All)</option>
        </select>
        <button onclick="triggerOtaUpdate()" id="btn-trigger-ota" style="background:linear-gradient(135deg,#38bdf8,#0284c7);color:#070d14;border:none;padding:10px 18px;border-radius:8px;font-size:0.8rem;font-weight:800;cursor:pointer;white-space:nowrap;box-shadow:0 2px 8px rgba(56,189,248,0.3);">
          ⚡ Phát Lệnh Nạp OTA
        </button>
      </div>
    </div>
    <div id="ota-status-msg" style="font-size:0.8rem;margin-top:10px;padding:8px 12px;border-radius:6px;display:none;font-weight:600;"></div>
  </div>

  <div class="device-grid" id="device-grid"><div class="no-devices"><div class="icon">⏳</div><h3>Đang tải danh sách...</h3></div></div>
</div>
<script>
  function timeSince(s){if(s===null||s===undefined)return'Chưa rõ';if(s<4)return'vừa xong (Ping ⚡)';if(s<60)return s+'s trước';if(s<3600)return Math.floor(s/60)+' phút trước';return Math.floor(s/3600)+' giờ trước';}
  
  let selectedFwFile = null;
  function handleFileSelected(input) {
    if (input.files && input.files[0]) {
      selectedFwFile = input.files[0];
      document.getElementById('ota-file-name').textContent = selectedFwFile.name + ' (' + (selectedFwFile.size / 1024).toFixed(0) + ' KB)';
    }
  }

  async function fetchFirmwareInfo() {
    try {
      const res = await fetch('/api/firmware-info');
      const data = await res.json();
      const badge = document.getElementById('ota-fw-badge');
      if (data && data.version && data.version !== 'none') {
        badge.innerHTML = '📦 Cloud FW: <b>' + data.version + '</b> (' + (data.size / 1024).toFixed(0) + ' KB)';
        badge.style.color = '#3fb950';
      } else {
        badge.textContent = '📦 Chưa có Firmware trên Cloud';
        badge.style.color = '#8b949e';
      }
    } catch(e) {}
  }

  async function uploadFirmware() {
    if (!selectedFwFile) return alert('Vui lòng bấm chọn file .bin trước!');
    const msg = document.getElementById('ota-status-msg');
    const btn = document.getElementById('btn-upload-fw');
    btn.disabled = true;
    btn.textContent = '⏳ Đang upload...';
    msg.style.display = 'block';
    msg.style.background = 'rgba(227,179,65,0.15)';
    msg.style.color = '#e3b341';
    msg.textContent = '⏳ Đang tải firmware lên Cloud Server...';
    try {
      const res = await fetch('/api/upload-firmware', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Firmware-Version': 'v' + Date.now() },
        body: selectedFwFile
      });
      const data = await res.json();
      if (data.status === 'ok') {
        msg.style.background = 'rgba(63,185,80,0.15)';
        msg.style.color = '#3fb950';
        msg.textContent = '✅ Đã tải lên Cloud thành công! Version: ' + data.version + ' (' + (data.size/1024).toFixed(0) + ' KB)';
        fetchFirmwareInfo();
      } else {
        throw new Error(data.error || 'Lỗi');
      }
    } catch(e) {
      msg.style.background = 'rgba(248,81,73,0.15)';
      msg.style.color = '#f85149';
      msg.textContent = '❌ Lỗi upload: ' + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '⬆️ Upload Lên Cloud';
    }
  }

  async function triggerOtaUpdate() {
    const target = document.getElementById('ota-target-select').value;
    const msg = document.getElementById('ota-status-msg');
    if (!confirm('Gửi lệnh nạp OTA khẩn cấp tới: ' + (target === 'all' ? 'TẤT CẢ THIẾT BỊ' : target) + '?')) return;
    msg.style.display = 'block';
    msg.style.background = 'rgba(56,189,248,0.15)';
    msg.style.color = '#38bdf8';
    msg.textContent = '⏳ Đang phát lệnh OTA Update...';
    try {
      const res = await fetch('/api/send-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: target,
          cmd: {
            cmd: 'ota_update',
            url: window.location.origin + '/firmware/latest.bin',
            version: 'v' + Date.now()
          }
        })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        msg.style.background = 'rgba(63,185,80,0.15)';
        msg.style.color = '#3fb950';
        msg.textContent = '✅ ĐÃ PHÁT LỆNH OTA THÀNH CÔNG! Thiết bị sẽ tự nạp và khởi động lại trong 10-15s.';
      }
    } catch(e) {
      msg.style.background = 'rgba(248,81,73,0.15)';
      msg.style.color = '#f85149';
      msg.textContent = '❌ Lỗi phát lệnh: ' + e.message;
    }
  }

  async function triggerDeviceOta(id) {
    if (!confirm('Nạp OTA từ xa cho thiết bị ' + id + '?')) return;
    try {
      await fetch('/api/send-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: id,
          cmd: {
            cmd: 'ota_update',
            url: window.location.origin + '/firmware/latest.bin',
            version: 'v' + Date.now()
          }
        })
      });
      alert('✅ Đã phát lệnh OTA cho ' + id + '! Thiết bị đang nạp...');
    } catch(e) { alert('Lỗi phát lệnh!'); }
  }

  async function triggerDeviceBleScan(id) {
    try {
      await fetch('/api/send-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: id,
          cmd: { cmd: 'scan_ble' }
        })
      });
      alert('🔍 Đã phát lệnh Quét BLE cho ' + id + '! Vui lòng mở giao diện để xem kết quả quét.');
    } catch(e) { alert('Lỗi phát lệnh quét!'); }
  }

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
    const sel = document.getElementById('ota-target-select');
    try{
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const devices = await res.json();
      
      document.getElementById('stat-online').textContent = devices.filter(function(d){ return d.online; }).length;
      document.getElementById('stat-offline').textContent = devices.filter(function(d){ return !d.online; }).length;
      document.getElementById('stat-total').textContent = devices.length;
      document.getElementById('refresh-label').textContent = 'Cập nhật: ' + new Date().toLocaleTimeString('vi-VN');

      if (sel) {
        const curVal = sel.value;
        let optHtml = '<option value="all">⚡ Tất cả thiết bị (Broadcast All)</option>';
        for(let d of devices) {
          optHtml += '<option value="' + d.device_id + '">' + (d.online ? '🟢 ' : '🔴 ') + d.device_id + (d.ssid ? ' (' + d.ssid + ')' : '') + '</option>';
        }
        sel.innerHTML = optHtml;
        sel.value = curVal;
      }
      
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
        
        var bmsTitle = d.active_bms_name || d.active_pack_alias || d.active_pack_name || 'JK-BMS';
        htmlArr.push(
          '<div class="device-card ' + (d.online ? 'online' : 'offline') + '">' +
            '<div class="card-header">' +
              '<div><div class="device-name">📟 ' + d.device_id + '</div><div class="device-sub" style="color:var(--accent);font-weight:600;margin-top:2px;">🔋 ' + bmsTitle + (d.active_bms_mac ? ' <span style="color:var(--subtext);font-weight:normal;">[' + d.active_bms_mac + ']</span>' : '') + '</div></div>' +
              statusBadge +
            '</div>' +
            '<div class="metrics">' +
              '<div class="metric"><div class="metric-val blue">' + voltStr + ' V</div><div class="metric-label">Điện áp Pack</div></div>' +
              '<div class="metric"><div class="metric-val ' + socColor + '">' + (d.soc || 0) + ' %</div><div class="metric-label">SoC Pin</div></div>' +
              '<div class="metric"><div class="metric-val warning">' + tempStr + ' °C</div><div class="metric-label">Nhiệt độ MOS</div></div>' +
            '</div>' +
            '<div class="device-info">' +
              '<div class="info-row"><span class="info-key">Tên Bluetooth (BMS)</span><span class="info-val" style="color:var(--accent);font-weight:700;">' + bmsTitle + '</span></div>' +
              '<div class="info-row"><span class="info-key">Ngày Kích Hoạt</span><span class="info-val" style="color:var(--primary);font-weight:700;">' + activatedStr + '</span></div>' +
              '<div class="info-row"><span class="info-key">IP Local</span><span class="info-val">' + localIp + '</span></div>' +
              '<div class="info-row"><span class="info-key">Wi-Fi</span><span class="info-val">' + ssidName + '</span></div>' +
              '<div class="info-row"><span class="info-key">Hostname</span><span class="info-val">' + hostName + '</span></div>' +
              '<div class="info-row"><span class="info-key">Firmware</span><span class="info-val">v' + fwVer + '</span></div>' +
            '</div>' +
            '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:grid;grid-template-columns:1fr 1fr;gap:6px;">' +
              '<a href="/d/' + d.device_id + '" target="_blank" style="background:var(--surface2);border:1px solid var(--accent);color:var(--accent);padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;text-decoration:none;text-align:center;">' +
                '🔗 Mở Link' +
              '</a>' +
              '<button data-id="' + d.device_id + '" onclick="triggerDeviceOta(this.dataset.id)" style="background:rgba(56,189,248,0.15);border:1px solid #38bdf8;color:#38bdf8;padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;">' +
                '⚡ Nạp OTA' +
              '</button>' +
              '<button data-id="' + d.device_id + '" onclick="triggerDeviceBleScan(this.dataset.id)" style="background:rgba(227,179,65,0.15);border:1px solid #e3b341;color:#e3b341;padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;">' +
                '🔍 Quét BLE' +
              '</button>' +
              '<button data-id="' + d.device_id + '" onclick="copyMonitorLink(this.dataset.id, this)" style="background:var(--primary-dim);border:1px solid var(--primary);color:var(--primary);padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;cursor:pointer;">' +
                '📋 Copy' +
              '</button>' +
            '</div>' +
            '<div style="margin-top:6px;text-align:right;"><button data-id="' + d.device_id + '" onclick="deleteDevice(this.dataset.id)" style="background:transparent;border:none;color:#f85149;font-size:0.72rem;cursor:pointer;opacity:0.7;">🗑️ Xóa</button></div>' +
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

  fetchFirmwareInfo();
  fetchDevices();
  fetchUsageStats();
  let dashTimer = setInterval(fetchDevices, 10000);
  setInterval(fetchUsageStats, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (dashTimer) clearInterval(dashTimer);
    } else {
      fetchDevices();
      fetchUsageStats();
      dashTimer = setInterval(fetchDevices, 10000);
    }
  });

  async function fetchUsageStats() {
    try {
      const res = await fetch('/api/usage-stats');
      if (!res.ok) return;
      const u = await res.json();

      // Header date
      const dateEl = document.getElementById('usage-date');
      if (dateEl) dateEl.textContent = '📅 ' + u.date + ' | ' + Math.round(u.dayProgress * 100) + '% ngày đã trôi qua';

      // Requests bar
      const reqPct = Math.min(u.requests.pct, 100);
      const reqLeft = (u.requests.limit - u.requests.today).toLocaleString();
      const reqColor = reqPct > 80 ? '#f85149' : reqPct > 50 ? '#e3b341' : '#3fb950';
      const reqBar = document.getElementById('usage-req-bar');
      const reqTxt = document.getElementById('usage-req-txt');
      const reqLeftEl = document.getElementById('usage-req-left');
      if (reqBar) { reqBar.style.width = reqPct + '%'; reqBar.style.background = 'linear-gradient(90deg,' + reqColor + ',#e3b341)'; }
      if (reqTxt) { reqTxt.textContent = u.requests.today.toLocaleString() + ' / 100,000 (' + reqPct + '%)'; reqTxt.style.color = reqColor; }
      if (reqLeftEl) { reqLeftEl.textContent = 'còn lại: ' + reqLeft; reqLeftEl.style.color = reqColor; }

      // KV Writes bar
      const kvPct = Math.min(u.kv.pct, 100);
      const kvLeft = (u.kv.limit - u.kv.writesToday).toLocaleString();
      const kvColor = kvPct > 80 ? '#f85149' : kvPct > 50 ? '#e3b341' : '#58a6ff';
      const kvBar = document.getElementById('usage-kv-bar');
      const kvTxt = document.getElementById('usage-kv-txt');
      const kvLeftEl = document.getElementById('usage-kv-left');
      if (kvBar) { kvBar.style.width = kvPct + '%'; kvBar.style.background = 'linear-gradient(90deg,' + kvColor + ',#f85149)'; }
      if (kvTxt) { kvTxt.textContent = u.kv.writesToday.toLocaleString() + ' / 1,000 (' + kvPct + '%)'; kvTxt.style.color = kvColor; }
      if (kvLeftEl) { kvLeftEl.textContent = 'còn lại: ' + kvLeft; kvLeftEl.style.color = kvColor; }

      // D1 Reads bar
      const d1Pct = Math.min(u.d1.pct, 100);
      const d1Left = ((u.d1.readLimit - u.d1.readsToday) / 1000000).toFixed(1) + 'M';
      const d1Color = d1Pct > 80 ? '#f85149' : d1Pct > 30 ? '#e3b341' : '#3fb950';
      const d1Bar = document.getElementById('usage-d1-bar');
      const d1Txt = document.getElementById('usage-d1-txt');
      const d1LeftEl = document.getElementById('usage-d1-left');
      if (d1Bar) { d1Bar.style.width = d1Pct + '%'; }
      if (d1Txt) { d1Txt.textContent = (u.d1.readsToday / 1000).toFixed(0) + 'K / 25M (' + d1Pct + '%)'; d1Txt.style.color = d1Color; }
      if (d1LeftEl) { d1LeftEl.textContent = 'còn lại: ' + d1Left; d1LeftEl.style.color = d1Color; }

      // Quick stats
      const devD1El = document.getElementById('usage-devices-d1');
      if (devD1El) devD1El.textContent = u.devices.d1Rows;
      const cmdEl = document.getElementById('usage-pending-cmds');
      if (cmdEl) { cmdEl.textContent = u.pendingCommands; cmdEl.style.color = u.pendingCommands > 5 ? '#f85149' : '#e3b341'; }
      const dayPctEl = document.getElementById('usage-day-pct');
      if (dayPctEl) dayPctEl.textContent = Math.round(u.dayProgress * 100) + '%';

      // Sparkline 7 days
      const spark = document.getElementById('usage-sparkline');
      const sparkLabels = document.getElementById('usage-sparkline-labels');
      if (spark && u.history && u.history.length) {
        const maxVal = Math.max(...u.history.map(h => h.count), 1);
        const barW = Math.floor(spark.offsetWidth > 0 ? (spark.offsetWidth - u.history.length * 4) / u.history.length : 24);
        let html = '', lblHtml = '';
        for (const h of u.history) {
          const heightPct = Math.max(Math.round(h.count / maxVal * 100), 4);
          const isToday = h.date === u.date;
          const c = isToday ? '#e3b341' : '#3fb950';
          html += '<div title="' + h.date + ': ' + h.count.toLocaleString() + ' req" style="flex:1;max-width:' + barW + 'px;min-width:8px;height:' + heightPct + '%;background:' + c + ';border-radius:3px 3px 0 0;opacity:' + (isToday ? '1' : '0.6') + ';cursor:pointer;transition:opacity 0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=' + (isToday ? '1' : '0.6') + '"></div>';
          const dayLabel = h.date.slice(5); // MM-DD
          lblHtml += '<div style="flex:1;font-size:0.6rem;color:var(--subtext);text-align:center;white-space:nowrap;overflow:hidden;' + (isToday ? 'color:#e3b341;font-weight:700;' : '') + '">' + dayLabel + '</div>';
        }
        spark.innerHTML = html;
        if (sparkLabels) sparkLabels.innerHTML = lblHtml;
      }
    } catch(e) { console.warn('Usage stats error:', e); }
  }
</script>

</body>
</html>`;

function CUSTOMER_DEVICE_HTML(d) {
  const online = d.online;
  const bmsConnected = online && (d.connected === true);

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
  const bmsDisplayName = (d.active_bms_name && d.active_bms_name !== 'JK_PB2A16S15P' && !d.active_bms_name.startsWith('JK-BMS [') ? d.active_bms_name : null) || d.active_pack_name || d.active_pack_alias || d.active_bms_name || 'JK-BMS';

  const initSec = (d.total_runtime_s && d.total_runtime_s > 0) ? d.total_runtime_s : ((d.totalRuntimeSec && d.totalRuntimeSec > 0) ? d.totalRuntimeSec : ((d.uptime_s && d.uptime_s > 0) ? d.uptime_s : (d.uptimeSec || 0)));
  const initDays = Math.floor(initSec / 86400);
  const initHours = Math.floor((initSec % 86400) / 3600);
  const initMins = Math.floor((initSec % 3600) / 60);
  const initS = Math.floor(initSec % 60);
  const runtimeStr = `${initDays}d ${initHours.toString().padStart(2,'0')}h ${initMins.toString().padStart(2,'0')}m ${initS.toString().padStart(2,'0')}s`;

  const getParamVal = (reg, sKey, formatFn) => {
    let val = undefined;
    if (d.settings && d.settings[sKey] !== undefined) val = d.settings[sKey];
    else if (d.params && d.params[reg] !== undefined) val = d.params[reg];
    if (val !== undefined && val !== null && val !== '') {
      return formatFn ? formatFn(val) : String(val);
    }
    return '';
  };

  const getCanProtocolName = (code) => {
    if (code === undefined || code === null || code === '') return '—';
    const c = parseInt(code);
    const map = {
      0: '000 User-defined',
      1: '001 Deye',
      2: '002 Pylontech',
      3: '003 Growatt',
      4: '004 Victron',
      5: '005 Goodwe',
      6: '006 SMA',
      7: '007 Sofar',
      8: '008 Solis',
      9: '009 SRNE',
      10: '010 Must',
      11: '011 Luxpower',
      12: '012 Voltronic',
      13: '013 Schneider',
      14: '014 TBB',
      15: '015 Studer'
    };
    return map[c] || (String(c).padStart(3, '0') + ' Protocol');
  };

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
      const resVal = i < cellRes.length && cellRes[i] && parseFloat(cellRes[i]) > 0 ? parseFloat(cellRes[i]).toFixed(3) + ' Ω' : '0.000 Ω';

      cellItemsHtml += '<div class="cell-box"><div class="c-row-top"><span class="c-num">#' + num + '</span><span class="c-res">⚡ ' + resVal + '</span></div><div class="c-row-bottom"><span class="c-val" style="color:' + color + ';">' + valStr + '<sup>V</sup></span>' + tagHtml + '</div></div>';
    } else {
      cellItemsHtml += '<div class="cell-box"><div class="c-row-top"><span class="c-num">#' + num + '</span><span class="c-res">--</span></div><div class="c-row-bottom"><span class="c-val" style="color:#2a3530;">--<sup>V</sup></span></div></div>';
    }
  }

  // SOC ring angle
  const socNum = parseInt(soc) || 0;
  const ringDash = Math.round(socNum * 2.513); // circumference ~251.3 for r=40
  const initialOffset = (284.8 - (socNum / 100) * 284.8).toFixed(1);

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
    <meta name="theme-color" content="#000000">
    <title>JK BMS WiFi Monitor - ${d.device_id}</title>
    <style>
        :root {
            --sat: env(safe-area-inset-top, 0px);
            --sab: env(safe-area-inset-bottom, 0px);
            --sal: env(safe-area-inset-left, 0px);
            --sar: env(safe-area-inset-right, 0px);
            --bg-black: #000000;
            --card-bg: #121518;
            --card-border: #1d252c;
            --green: #00ff2b;
            --cyan: #38bdf8;
            --red: #ff3b30;
            --yellow: #f59e0b;
            --text-white: #ffffff;
            --text-sub: #8e8e93;
            --badge-bg: #0077b6;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-tap-highlight-color: transparent; }
        html { background-color: var(--bg-black); }
        body { background-color: var(--bg-black); color: var(--text-white); min-height: 100vh; padding-bottom: calc(88px + var(--sab)); user-select: none; overflow-x: hidden; }
        .app { max-width: 480px; margin: 0 auto; min-height: 100vh; position: relative; background: #000; padding-left: var(--sal); padding-right: var(--sar); }

        /* Sticky Top Header with Safe Area Inset */
        .app-header {
            position: -webkit-sticky;
            position: sticky;
            top: 0;
            z-index: 999;
            background: rgba(0, 0, 0, 0.95);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border-bottom: 1px solid #181818;
            padding-top: var(--sat);
        }

        /* Top Header Bar */
        .top-bar { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px 8px 16px; background: transparent; }
        .bt-status { display: flex; align-items: center; gap: 6px; font-size: 1.1rem; color: #555; }
        .bt-status.active { color: var(--cyan); }
        .uptime-txt { font-size: 0.85rem; font-weight: 500; color: #e5e5e5; letter-spacing: 0.5px; font-family: monospace; white-space: nowrap; }
        .menu-btn { font-size: 1.3rem; color: #fff; cursor: pointer; border: none; background: transparent; }

        /* MOS Control Top Bar */
        .mos-bar { display: flex; justify-content: space-around; background: transparent; padding: 6px 8px 8px 8px; border-top: 1px solid rgba(255,255,255,0.05); font-size: 0.88rem; font-weight: 600; }
        .mos-item { display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 4px 8px; border-radius: 6px; background: rgba(255,255,255,0.03); }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #444; }
        .dot.on { background: var(--green); box-shadow: 0 0 6px var(--green); }
        .dot.off { background: var(--red); box-shadow: 0 0 6px var(--red); }
        .val-on { color: var(--green); font-weight: bold; }
        .val-off { color: var(--red); font-weight: bold; }

        /* Gauge Section */
        .gauge-section { position: relative; width: 100%; text-align: center; padding: 10px 0 4px 0; }
        .gauge-svg { width: 250px; height: 230px; margin: 0 auto; display: block; }

        /* Notification Banner */
        .status-banner { margin: 10px 14px; background: rgba(5,35,41,0.85); border: 1px solid #008b99; border-radius: 10px; padding: 10px 14px; display: flex; align-items: center; gap: 10px; font-size: 0.85rem; color: #e2e8f0; }
        .banner-icon { color: var(--green); font-size: 1.1rem; }

        /* Quick BLE Bar */
        .quick-ble-box { background: #131c22; border: 1px solid #222d35; border-radius: 10px; padding: 12px; margin: 10px 14px 12px 14px; }

        /* Metrics Grids (4 columns) */
        .metrics-grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 10px 14px; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 12px 6px; text-align: center; }
        .metric-item { display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; padding: 2px 0; }
        .metric-item:not(:last-child)::after { content: ''; position: absolute; right: 0; top: 15%; height: 70%; width: 1px; background: #222d35; }
        .metric-val { font-size: 1.2rem; font-weight: 800; margin-bottom: 4px; }
        .metric-lbl { font-size: 0.66rem; color: var(--text-sub); white-space: nowrap; }

        /* Power & Status Card */
        .info-card-box { margin: 10px 14px; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 12px 14px; font-size: 0.85rem; }
        .card-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; }
        .card-divider { height: 1px; background: #222d35; margin: 8px 0; }

        /* Real-time Detailed Status List */
        .realtime-title { color: var(--green); font-size: 0.92rem; font-weight: 700; margin: 14px 16px 10px 16px; display: flex; align-items: center; gap: 6px; }
        .realtime-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 16px; margin: 0 16px; font-size: 0.82rem; }
        .rt-row { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #141a20; padding-bottom: 4px; }
        .rt-lbl { color: #aaaaaa; }
        .rt-val { color: var(--green); font-weight: 700; }
        .unit-sup { font-size: 0.65rem; font-weight: normal; vertical-align: super; margin-left: 1px; }

        /* Cell Grid (3 columns) */
        .cells-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 8px 16px 16px 16px; }
        .cell-item { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; font-size: 0.88rem; }
        .cell-badge { background: #0284c7; color: #fff; width: 22px; height: 22px; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-size: 0.72rem; font-weight: 800; }
        .cell-v-txt { font-weight: 800; color: var(--green); }
        .cell-v-txt.min { color: var(--red); }
        .cell-v-txt.max { color: var(--cyan); }
        .cell-v-bar-bg { width: 100%; height: 3px; background: #1c2630; border-radius: 2px; margin-top: 5px; overflow: hidden; }
        .cell-v-bar-fill { height: 100%; background: var(--green); border-radius: 2px; transition: width 0.3s ease; }
        .cell-v-bar-fill.max { background: var(--cyan); }
        .cell-v-bar-fill.min { background: var(--red); }

        /* Protection Grid */
        .protection-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 8px 16px 16px 16px; }
        .prot-item { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; padding: 8px 10px; display: flex; align-items: center; justify-content: space-between; font-size: 0.78rem; }
        .prot-lbl { color: #aaa; }
        .prot-badge { padding: 2px 7px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; }
        .prot-badge.ok { background: rgba(0, 255, 43, 0.15); color: var(--green); border: 1px solid rgba(0,255,43,0.3); }
        .prot-badge.alarm { background: rgba(255, 59, 48, 0.25); color: var(--red); border: 1px solid var(--red); animation: pulseAlert 1s infinite; }
        @keyframes pulseAlert { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }

        /* Tab Content Display */
        .tab-content { display: none; }
        .tab-content.active { display: block; }

        /* Settings Card Elements */
        .sett-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 14px; margin: 12px 14px; }
        .form-group { margin-bottom: 12px; }
        label { display: block; font-size: 0.8rem; color: var(--text-sub); margin-bottom: 4px; }
        input, select { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a343d; background: #090c0e; color: #fff; font-size: 0.9rem; }
        button.btn { width: 100%; padding: 11px; border: none; border-radius: 8px; background: linear-gradient(135deg, #0284c7, #0369a1); color: #fff; font-weight: bold; cursor: pointer; font-size: 0.9rem; margin-top: 6px; }
        button.btn-sec { background: rgba(255,255,255,0.08); border: 1px solid #2a343d; }
        .list-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; background: #090c0e; border-radius: 8px; margin-bottom: 8px; border: 1px solid #1e262c; }

        /* Parameter Form Controls */
        .param-section-title { font-size: 0.95rem; font-weight: 700; color: var(--cyan); margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
        .param-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
        .param-col { display: flex; flex-direction: column; }
        .param-col label { font-size: 0.73rem; color: #8fa0ab; margin-bottom: 4px; line-height: 1.2; }
        .param-input-wrap { position: relative; display: flex; align-items: center; }
        .param-input-wrap input { width: 100%; padding: 8px 32px 8px 10px; font-family: monospace; font-size: 0.88rem; font-weight: 600; color: #fff; background: #0c1115; border: 1px solid #232d36; border-radius: 6px; outline: none; box-sizing: border-box; }
        .param-input-wrap input:focus { border-color: var(--cyan); box-shadow: 0 0 6px rgba(0,229,255,0.25); }
        .param-unit { position: absolute; right: 8px; font-size: 0.72rem; color: var(--cyan); pointer-events: none; font-weight: 700; }
        .btn-param-save { width: 100%; padding: 11px; border: none; border-radius: 8px; background: linear-gradient(135deg, #059669, #10b981); color: #fff; font-weight: 700; cursor: pointer; font-size: 0.85rem; margin-top: 6px; box-shadow: 0 2px 8px rgba(16,185,129,0.2); }
        .btn-param-save:hover { background: linear-gradient(135deg, #047857, #059669); }
        .btn-param-save:active { transform: scale(0.98); }
        .param-toast { padding: 8px 12px; border-radius: 6px; font-size: 0.78rem; font-weight: 600; margin-top: 8px; display: none; text-align: center; }
        .param-toast.ok { background: rgba(0,255,43,0.15); color: var(--green); border: 1px solid rgba(0,255,43,0.3); display: block; }
        .param-toast.err { background: rgba(255,59,48,0.2); color: var(--red); border: 1px solid var(--red); display: block; }

        /* Official App Style Parameter Rows */
        .param-row-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: #090c0e;
            border: 1px solid #1e262c;
            border-radius: 9px;
            padding: 9px 12px;
            margin-bottom: 8px;
            gap: 10px;
            transition: border-color 0.2s, background 0.2s;
        }
        .param-row-item:hover, .param-row-item:focus-within {
            border-color: rgba(56, 189, 248, 0.4);
            background: #0d1217;
        }
        .param-row-label {
            flex: 1;
            font-size: 0.84rem;
            font-weight: 600;
            color: #e2e8f0;
            line-height: 1.25;
        }
        .param-row-ctrls {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }
        .param-row-ctrls .param-input-wrap {
            width: 108px;
            margin: 0;
            position: relative;
        }
        .param-row-ctrls .param-input-wrap input {
            width: 100%;
            height: 36px;
            padding: 4px 28px 4px 8px;
            font-size: 0.92rem;
            font-weight: 700;
            text-align: right;
            background: #050708;
            border: 1px solid #232d36;
            border-radius: 6px;
            color: #fff;
            outline: none;
            box-sizing: border-box;
        }
        .param-row-ctrls .param-input-wrap input:focus {
            border-color: var(--cyan);
            box-shadow: 0 0 6px rgba(56, 189, 248, 0.3);
        }
        .param-row-ctrls .param-unit {
            position: absolute;
            right: 8px;
            font-size: 0.72rem;
            color: var(--cyan);
            pointer-events: none;
            font-weight: 700;
        }
        .btn-param-ok {
            background: linear-gradient(135deg, #00d2ff, #00ff2b);
            color: #000;
            border: none;
            border-radius: 6px;
            font-weight: 800;
            font-size: 0.8rem;
            padding: 0 12px;
            height: 36px;
            min-width: 46px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s ease;
            box-shadow: 0 2px 6px rgba(0, 255, 43, 0.2);
            flex-shrink: 0;
        }
        .btn-param-ok:hover {
            filter: brightness(1.1);
        }
        .btn-param-ok:active {
            transform: scale(0.92);
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        /* Bottom Nav Bar with Safe Area Inset */
        .bottom-nav {
            position: fixed;
            bottom: 0;
            left: 50%;
            transform: translateX(-50%);
            width: 100%;
            max-width: 480px;
            background: rgba(0, 0, 0, 0.95);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border-top: 1px solid #1a1a1a;
            display: flex;
            justify-content: space-around;
            padding-top: 8px;
            padding-bottom: calc(10px + var(--sab));
            padding-left: var(--sal);
            padding-right: var(--sar);
            z-index: 1000;
        }
        .nav-btn { display: flex; flex-direction: column; align-items: center; color: #666; font-size: 0.72rem; font-weight: 600; cursor: pointer; border: none; background: transparent; width: 33%; }
        .nav-btn.active { color: var(--green); }
        .nav-icon { font-size: 1.25rem; margin-bottom: 2px; }
    </style>
</head>
<body>
    <div class="app">
        <!-- STICKY TOP HEADER (PROTECTED FROM PHONE STATUS BAR) -->
        <header class="app-header">
            <!-- TOP HEADER BAR -->
            <div class="top-bar">
                <div style="display:flex; align-items:center; gap:8px;">
                    <div id="bt-icon-head" class="bt-status ${bmsConnected ? 'active' : ''}" title="Bluetooth Status">⚡</div>
                    <div>
                        <div id="head-bms-name" style="font-weight:bold; font-size:0.95rem; color:#fff; line-height:1.2;">${bmsDisplayName}</div>
                        <div id="head-sn" style="font-size:0.68rem; color:var(--text-sub); font-family:monospace;">${d.active_bms_mac ? `MAC: ${d.active_bms_mac}` : 'Chưa chọn Pack'}</div>
                        <div id="esp-online-badge" style="font-size:0.68rem; font-weight:700; color:${statusColor}; display:flex; align-items:center; gap:4px; margin-top:2px;">
                            <span id="esp-online-dot" style="display:inline-block; width:6px; height:6px; border-radius:50%; background:${statusColor}; box-shadow:0 0 5px ${statusColor};"></span>
                            <span id="esp-online-txt">${statusText}</span>
                        </div>
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <div id="uptime-display" class="uptime-txt">${runtimeStr}</div>
                    <button class="menu-btn" onclick="showTab('tab-settings', document.getElementById('nav-sett'))">☰</button>
                </div>
            </div>

            <!-- MOS CONTROLS TOP BAR -->
            <div class="mos-bar">
                <div class="mos-item" onclick="toggleMos('charge_mos')">
                    <span>Charge</span>
                    <div id="dot-charge" class="dot ${chargeMos ? 'on' : 'off'}"></div>
                    <span id="txt-charge" class="${chargeMos ? 'val-on' : 'val-off'}">${chargeMos ? 'ON' : 'OFF'}</span>
                </div>
                <div style="color:#333;">|</div>
                <div class="mos-item" onclick="toggleMos('discharge_mos')">
                    <span>Dsg</span>
                    <div id="dot-discharge" class="dot ${dischargeMos ? 'on' : 'off'}"></div>
                    <span id="txt-discharge" class="${dischargeMos ? 'val-on' : 'val-off'}">${dischargeMos ? 'ON' : 'OFF'}</span>
                </div>
                <div style="color:#333;">|</div>
                <div class="mos-item" onclick="toggleMos('balance')">
                    <span>Bal.</span>
                    <div id="dot-balance" class="dot ${balance ? 'on' : 'off'}"></div>
                    <span id="txt-balance" class="${balance ? 'val-on' : 'val-off'}">${balance ? 'ON' : 'OFF'}</span>
                </div>
            </div>
        </header>

        <!-- ==================== TAB 1: HOME (DASHBOARD) ==================== -->
        <div id="tab-home" class="tab-content active">
            <!-- CIRCULAR GAUGE WIDGET -->
            <div class="gauge-section">
                <svg class="gauge-svg" viewBox="0 0 200 185">
                    <defs>
                        <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stop-color="#00e5ff"/>
                            <stop offset="100%" stop-color="#00ff2b"/>
                        </linearGradient>
                        <filter id="neonGlow" x="-20%" y="-20%" width="140%" height="140%">
                            <feGaussianBlur stdDeviation="2.5" result="blur"/>
                            <feMerge>
                                <feMergeNode in="blur"/>
                                <feMergeNode in="SourceGraphic"/>
                            </feMerge>
                        </filter>
                    </defs>
                    <!-- Background Track Arc (240 deg, R=68) -->
                    <path d="M 41.1,110 A 68,68 0 1,1 158.9,110" fill="none" stroke="#141c22" stroke-width="12" stroke-linecap="round"/>
                    <!-- Dotted Guide Ring -->
                    <circle cx="100" cy="76" r="54" fill="none" stroke="#222f38" stroke-width="1" stroke-dasharray="2 4"/>
                    <!-- Active SOC Arc (Length = 284.8) -->
                    <path id="gauge-arc" d="M 41.1,110 A 68,68 0 1,1 158.9,110" fill="none" stroke="${bmsConnected && socNum > 50 ? 'url(#gaugeGrad)' : (bmsConnected ? '#00ff2b' : '#556570')}" stroke-width="12" stroke-linecap="round" stroke-dasharray="284.8 350" stroke-dashoffset="${bmsConnected ? initialOffset : '284.8'}" style="transition: stroke-dashoffset 0.6s ease;" filter="url(#neonGlow)"/>

                    <!-- Center SOC % Text -->
                    <text id="home-soc-txt" x="100" y="68" text-anchor="middle" dominant-baseline="central" fill="${bmsConnected ? '#00ff2b' : '#556570'}" font-size="38" font-weight="900" font-family="-apple-system, sans-serif" filter="url(#neonGlow)">${bmsConnected ? socNum + '%' : '0%'}</text>

                    <!-- Pill 1: Voltage Badge -->
                    <g transform="translate(100, 126)">
                        <rect x="-65" y="-12" width="130" height="24" rx="12" fill="#000000" stroke="#00ff2b" stroke-width="1.8"/>
                        <text id="home-v-pill" x="0" y="1" text-anchor="middle" dominant-baseline="central" fill="#00ff2b" font-size="14" font-weight="800" font-family="-apple-system, sans-serif">${voltage}${voltage !== '—' ? 'V' : ''}</text>
                    </g>

                    <!-- Pill 2: Current Badge -->
                    <g transform="translate(100, 156)">
                        <rect x="-65" y="-12" width="130" height="24" rx="12" fill="#000000" stroke="#00ff2b" stroke-width="1.8"/>
                        <text id="home-a-pill" x="0" y="1" text-anchor="middle" dominant-baseline="central" fill="#00ff2b" font-size="14" font-weight="800" font-family="-apple-system, sans-serif">${current}${current !== '—' ? 'A' : ''}</text>
                    </g>
                </svg>
            </div>

            <!-- STATUS NOTIFICATION BANNER -->
            <div id="status-banner" class="status-banner" style="${bmsConnected ? '' : 'border-color:rgba(245,158,11,0.5);background:rgba(40,30,5,0.85);'}">
                <span id="banner-icon" class="banner-icon" style="${bmsConnected ? '' : 'color:var(--yellow);'}">${bmsConnected ? '✔' : '📡'}</span>
                <span id="banner-msg">${bmsConnected ? `Đang kết nối với ${bmsDisplayName} • Pin hoạt động bình thường` : (d.active_bms_mac ? `Đang tìm & kết nối BLE tới ${bmsDisplayName}...` : 'BMS chưa kết nối Bluetooth')}</span>
            </div>

            <!-- QUICK BLUETOOTH SCAN & CONNECT BAR (HOME SCREEN) -->
            <div class="quick-ble-box">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-size:1.1rem;">📡</span>
                        <div>
                            <div style="font-size:0.85rem; font-weight:700; color:#fff;" id="home-ble-name">${bmsConnected ? `<span style="color:var(--green);">🟢</span> ${bmsDisplayName} <span style="font-size:0.75rem; color:var(--green);">(Đang kết nối)</span>` : (d.active_bms_mac ? `<span style="color:var(--yellow);">🟡</span> ${bmsDisplayName} <span style="font-size:0.75rem; color:var(--yellow);">(Đang tìm kiếm...)</span>` : `<span style="color:var(--text-sub);">⚪</span> Chưa kết nối BMS`)}</div>
                            <div style="font-size:0.72rem; color:var(--text-sub);" id="home-ble-mac">${d.active_bms_mac ? `MAC: ${d.active_bms_mac}` : 'Chưa có MAC • Hãy bấm Quét Bluetooth'}</div>
                        </div>
                    </div>
                    <div>
                        <button class="btn" id="btn-home-ble-scan" style="width:auto; padding:7px 16px; font-size:0.82rem; font-weight:700; background:linear-gradient(135deg,#00d2ff,#00ff2b); color:#000; margin:0;" onclick="scanBLE()">🔍 Quét Bluetooth</button>
                    </div>
                </div>
                <div id="home-ble-status" style="font-size:0.75rem; color:var(--cyan); display:none; margin-top:8px; font-weight:600;"></div>
                <div id="home-ble-list" style="margin-top:8px;"></div>
            </div>

            <!-- KEY METRICS GRID 1 (4 Columns) -->
            <div class="metrics-grid-4">
                <div class="metric-item">
                    <div id="m-high-v" class="metric-val" style="color:var(--cyan);">${bmsConnected && d.max_cell_voltage ? d.max_cell_voltage.toFixed(3) : '0.000'}</div>
                    <div class="metric-lbl">High Cell(V):</div>
                </div>
                <div class="metric-item">
                    <div id="m-low-v" class="metric-val" style="color:var(--red);">${bmsConnected && d.min_cell_voltage ? d.min_cell_voltage.toFixed(3) : '0.000'}</div>
                    <div class="metric-lbl">Low Cell(V):</div>
                </div>
                <div class="metric-item">
                    <div id="m-diff-v" class="metric-val" style="color:var(--green);">${cellDelta}</div>
                    <div class="metric-lbl">Volt.-Diff(V):</div>
                </div>
                <div class="metric-item">
                    <div id="m-bal-a" class="metric-val" style="color:var(--green);">${balCurr}</div>
                    <div class="metric-lbl">Bal.-Curr.(A):</div>
                </div>
            </div>

            <!-- KEY METRICS GRID 2 (4 Columns) -->
            <div class="metrics-grid-4">
                <div class="metric-item">
                    <div id="m-cap-ah" class="metric-val" style="color:var(--green);">${capAh}</div>
                    <div class="metric-lbl">Capacity(Ah):</div>
                </div>
                <div class="metric-item">
                    <div id="m-rem-ah" class="metric-val" style="color:var(--green);">${remCap}</div>
                    <div class="metric-lbl">Rem. Cap(Ah):</div>
                </div>
                <div class="metric-item">
                    <div id="m-cell-avg" class="metric-val" style="color:var(--green);">${bmsConnected && d.min_cell_voltage && d.max_cell_voltage ? (((d.min_cell_voltage||0) + (d.max_cell_voltage||0)) / 2).toFixed(3) : '0.000'}</div>
                    <div class="metric-lbl">Cell AVG(V):</div>
                </div>
                <div class="metric-item">
                    <div id="m-soh" class="metric-val" style="color:var(--green);">${d.soh ? d.soh + '%' : '100%'}</div>
                    <div class="metric-lbl">SOH:</div>
                </div>
            </div>

            <!-- POWER & STATUS CARD -->
            <div class="info-card-box">
                <div class="card-row">
                    <span>🟢 Current: <strong id="card-curr-val" style="color:var(--green); margin-left:4px;">${current} A</strong></span>
                    <span>⚡ Power: <strong id="card-power-val" style="color:var(--green); margin-left:4px;">${power} W</strong></span>
                </div>
                <div class="card-divider"></div>
                <div class="card-row">
                    <span>🌡️ MOS Temp: <strong id="card-mos-temp" style="color:var(--green)">${mosTemp} °C</strong></span>
                    <span>🌡️ T1 / T2: <strong id="card-probes" style="color:var(--green)">${temp1||'0.0'} / ${temp2||'0.0'} °C</strong></span>
                </div>
                <div class="card-divider"></div>
                <div class="card-row">
                    <span>🕒 Status: <strong id="card-status-txt" style="color:var(--green)">${bmsConnected ? (parseFloat(current) > 0.1 ? 'Charging (Đang sạc)' : (parseFloat(current) < -0.1 ? 'Discharging (Đang xả)' : 'Standby (Chờ)')) : 'Disconnected'}</strong></span>
                    <span>⏱️ Time Left: <strong id="card-time-left" style="color:var(--green)">--:--</strong></span>
                </div>
            </div>
        </div>

        <!-- ==================== TAB 2: STATUS (REALTIME & CELLS) ==================== -->
        <div id="tab-status" class="tab-content">
            <div class="realtime-title">🟢 • Real-time Operations</div>
            <div class="realtime-grid">
                <div class="rt-row"><span class="rt-lbl">Bat. Power:</span><span class="rt-val"><span id="rt-power">${power}</span><span class="unit-sup">W</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Cell AVG:</span><span class="rt-val"><span id="rt-avg">0.000</span><span class="unit-sup">V</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Capacity:</span><span class="rt-val"><span id="rt-cap">${capAh}</span><span class="unit-sup">Ah</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Volt.-Diff:</span><span class="rt-val"><span id="rt-diff">${cellDelta}</span><span class="unit-sup">V</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Rem. Cap:</span><span class="rt-val"><span id="rt-rem">${remCap}</span><span class="unit-sup">Ah</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Bal. Current:</span><span class="rt-val"><span id="rt-balcurr">${balCurr}</span><span class="unit-sup">A</span></span></div>
                <div class="rt-row"><span class="rt-lbl">CMOS Temp.:</span><span class="rt-val"><span id="rt-mos">${mosTemp}</span><span class="unit-sup">°C</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Cycle Count:</span><span class="rt-val"><span id="rt-cyc">${d.cycle_count||0}</span><span class="unit-sup">T</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Battery T1:</span><span class="rt-val"><span id="rt-t1">${temp1||'0.0'}</span><span class="unit-sup">°C</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Cycle Cap.:</span><span class="rt-val"><span id="rt-cyccap">${d.cycle_capacity_ah ? d.cycle_capacity_ah.toFixed(1) : '0.0'}</span><span class="unit-sup">A</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Battery T2:</span><span class="rt-val"><span id="rt-t2">${temp2||'0.0'}</span><span class="unit-sup">°C</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Battery T4:</span><span class="rt-val"><span id="rt-t4">${d.temp4 ? d.temp4.toFixed(1) : '0.0'}</span><span class="unit-sup">°C</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Battery T5:</span><span class="rt-val"><span id="rt-t5">${d.temp5 ? d.temp5.toFixed(1) : '0.0'}</span><span class="unit-sup">°C</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Heater Curr.:</span><span class="rt-val"><span id="rt-heatcurr">${d.heat_curr ? d.heat_curr.toFixed(1) : '0.0'}</span><span class="unit-sup">A</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Heater:</span><span id="rt-heater" class="rt-val">${d.heating_active ? 'ON' : 'OFF'}</span></div>
                <div class="rt-row"><span class="rt-lbl">Emerg. Timer:</span><span class="rt-val"><span id="rt-emerg">0</span><span class="unit-sup">s</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Details Log:</span><span id="rt-logs" class="rt-val">${d.detail_logs_count||0}</span></div>
                <div class="rt-row"><span class="rt-lbl">Runtime:</span><span class="rt-val" id="rt-runtime">${runtimeStr}</span></div>
                <div class="rt-row"><span class="rt-lbl">SOH:</span><span class="rt-val"><span id="rt-soh">${d.soh||100}</span><span class="unit-sup">%</span></span></div>
                <div class="rt-row"><span class="rt-lbl">Cell Type:</span><span id="rt-type" class="rt-val">${d.battery_type||'LFP'}</span></div>
                <div class="rt-row"><span class="rt-lbl">Charge Mode:</span><span id="rt-chg-mode" class="rt-val">${d.charge_status||'Bulk'}</span></div>
                <div class="rt-row"><span class="rt-lbl">Balancer:</span><span id="rt-balancer" class="rt-val">${balance ? 'ON' : 'OFF'}</span></div>
            </div>

            <div class="realtime-title" style="margin-top:18px;">🟢 • Cell Voltages (V) :</div>
            <div id="cells-grid-3" class="cells-grid-3"></div>

            <div class="realtime-title" style="margin-top:18px;">🟢 • Balance Wire Resistance (Ω) :</div>
            <div id="wire-grid-3" class="cells-grid-3"></div>

            <div class="realtime-title" style="margin-top:18px;">🛡️ • Protection & Safety Status :</div>
            <div id="protection-grid" class="protection-grid"></div>

            <div class="realtime-title" style="margin-top:18px;">📋 • Device Information :</div>
            <div class="info-card-box" style="margin-bottom:16px;">
                <div class="card-row"><span>Model Name:</span><strong id="dev-info-model" style="color:var(--cyan)">${bmsDisplayName}</strong></div>
                <div class="card-row"><span>Serial Number:</span><strong id="dev-info-sn" style="color:#fff; font-family:monospace;">${d.serialNumber||'—'}</strong></div>
                <div class="card-row"><span>Hardware Version:</span><strong id="dev-info-hw" style="color:#fff">${d.bmsHwVersion||'—'}</strong></div>
                <div class="card-row"><span>Software Version:</span><strong id="dev-info-sw" style="color:#fff">${d.bmsSwVersion||'—'}</strong></div>
                <div class="card-row"><span>Protocol Family:</span><strong id="dev-info-family" style="color:var(--green)">${d.protocol_version||'JK02_32S'}</strong></div>
                <div class="card-row"><span>CAN Protocol:</span><strong id="dev-info-can" style="color:var(--cyan)">${getCanProtocolName(d.can_protocol !== undefined ? d.can_protocol : d.canProtocol)}</strong></div>
                <div class="card-row"><span>Address ID:</span><strong id="dev-info-addr" style="color:var(--green); font-family:monospace;">${d.address_id !== undefined ? d.address_id : (d.rs485DeviceId !== undefined ? d.rs485DeviceId : '—')}</strong></div>
                <div class="card-row"><span>Bluetooth MAC:</span><strong id="dev-info-mac" style="color:var(--cyan); font-family:monospace;">${d.active_bms_mac||'—'}</strong></div>
                <div class="card-row"><span>Kích Hoạt:</span><strong id="dev-info-act" style="color:var(--green); font-size:0.75rem;">${reg}</strong></div>
            </div>
        </div>

        <!-- ==================== TAB 3: SETTINGS (BLE & WIFI CONFIG) ==================== -->
        <div id="tab-settings" class="tab-content">
            <!-- BLE PACK CONFIG -->
            <div class="sett-card" id="ble-card">
                <h3 style="color:var(--cyan); margin-bottom:10px; font-size:1rem;">📶 Quản Lý Bluetooth JK-BMS</h3>
                <div id="ble-connected-view" style="display:block;">
                    <div class="list-item" style="display:flex; justify-content:space-between; align-items:center; padding:12px; margin-bottom:10px; border-left:4px solid ${bmsConnected ? 'var(--green)' : 'var(--red)'}; background:rgba(15,23,42,0.7);">
                        <div>
                            <div style="font-weight:700; font-size:0.95rem; color:#fff;" id="lbl-ble-name">🔋 ${bmsConnected ? bmsDisplayName : 'Chưa kết nối BMS'}</div>
                            <div style="font-size:0.8rem; color:var(--text-sub); margin-top:3px;">MAC: <span id="lbl-ble-mac" style="color:var(--cyan); font-family:monospace;">${d.active_bms_mac||'—'}</span></div>
                        </div>
                        <div style="text-align:right;">
                            <span class="cell-badge" style="background:${bmsConnected ? 'rgba(63,185,80,0.2)' : 'rgba(255,59,48,0.2)'}; color:${bmsConnected ? 'var(--green)' : 'var(--red)'}; border:1px solid ${bmsConnected ? 'var(--green)' : 'var(--red)'}; width:auto; padding:3px 8px; font-size:0.75rem; border-radius:12px;" id="lbl-ble-status">${bmsConnected ? '● Đang kết nối' : '○ Chưa kết nối'}</span>
                        </div>
                    </div>
                    <button class="btn" onclick="scanBLE()" style="margin-bottom:8px;">🔍 Quét Thiết Bị BLE Xung Quanh</button>
                    <div id="ble-status" style="margin-top:6px; font-size:0.8rem; color:var(--text-sub);"></div>
                    <div id="ble-list" style="margin-top:8px;"></div>
                </div>
            </div>

            <!-- SYNC STATUS & QUERY BAR -->
            <div style="display:flex; justify-content:space-between; align-items:center; margin:12px 14px 4px 14px; flex-wrap:wrap; gap:8px;">
                <span id="settings-sync-badge" class="cell-badge" style="background:${(d.settings || d.params) ? 'rgba(0,255,43,0.15)' : 'rgba(255,184,0,0.15)'}; color:${(d.settings || d.params) ? 'var(--green)' : 'var(--yellow)'}; border:1px solid ${(d.settings || d.params) ? 'var(--green)' : 'var(--yellow)'}; width:auto; padding:4px 10px; font-size:0.75rem; border-radius:12px; font-weight:700;">${(d.settings || d.params) ? '● Đã đồng bộ từ BMS' : '○ Đang chờ BMS truyền dữ liệu...'}</span>
                <button onclick="queryBmsSettings(true)" class="btn btn-sec" style="width:auto; margin:0; padding:6px 12px; font-size:0.75rem; border-color:var(--cyan); color:var(--cyan); font-weight:700;">🔄 Đọc Lại Từ BMS</button>
            </div>

            <!-- CÀI ĐẶT DÒNG SẠC / XẢ & DUNG LƯỢNG -->
            <!-- CÀI ĐẶT DÒNG SẠC / XẢ & DUNG LƯỢNG -->
            <div class="sett-card" id="current-card">
                <div class="param-section-title">⚡ Cài Đặt Dòng Sạc / Xả & Dung Lượng</div>
                <div style="font-size:0.73rem; color:var(--text-sub); margin-bottom:12px;">Chỉnh sửa từng thông số rồi bấm nút <b>OK</b> bên cạnh để ghi trực tiếp vào BMS.</div>

                <div class="param-row-item">
                    <span class="param-row-label">Dòng Sạc Tối Đa</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_max_chg_curr" step="0.1" min="1" max="300" value="${getParamVal('12', 'max_chg_curr', v => Number(v).toFixed(1))}" placeholder="...">
                            <span class="param-unit">A</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_max_chg_curr', 0x0C, 'Dòng Sạc Tối Đa', 'A', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Dòng Xả Tối Đa</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_max_dsg_curr" step="0.1" min="1" max="350" value="${getParamVal('15', 'max_dsg_curr', v => Number(v).toFixed(1))}" placeholder="...">
                            <span class="param-unit">A</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_max_dsg_curr', 0x0F, 'Dòng Xả Tối Đa', 'A', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Dòng Cân Bằng</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_max_bal_curr" step="0.1" min="0.1" max="2.0" value="${getParamVal('19', 'max_bal_curr', v => Number(v).toFixed(1))}" placeholder="...">
                            <span class="param-unit">A</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_max_bal_curr', 0x13, 'Dòng Cân Bằng', 'A', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Dung Lượng Pin</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_battery_cap" step="1" min="10" max="2000" value="${getParamVal('32', 'battery_cap', v => Math.round(Number(v)))}" placeholder="...">
                            <span class="param-unit">Ah</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_battery_cap', 0x20, 'Dung Lượng Pin', 'Ah', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Số Cell Nối Tiếp</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_cell_count" step="1" min="3" max="32" value="${getParamVal('28', 'cell_count', v => parseInt(v))}" placeholder="...">
                            <span class="param-unit">S</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_cell_count', 0x1C, 'Số Cell Nối Tiếp', 'S', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Trễ Quá Dòng Sạc</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_chg_ocp_delay" step="1" min="1" max="60" value="${getParamVal('13', 'chg_ocp_delay', v => parseInt(v))}" placeholder="...">
                            <span class="param-unit">s</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_chg_ocp_delay', 0x0D, 'Trễ Quá Dòng Sạc', 's', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Phục Hồi Quá Dòng Sạc</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_chg_ocpr_time" step="1" min="5" max="300" value="${getParamVal('14', 'chg_ocpr_time', v => parseInt(v))}" placeholder="...">
                            <span class="param-unit">s</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_chg_ocpr_time', 0x0E, 'Phục Hồi Quá Dòng Sạc', 's', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Trễ Quá Dòng Xả</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_dsg_ocp_delay" step="1" min="1" max="60" value="${getParamVal('16', 'dsg_ocp_delay', v => parseInt(v))}" placeholder="...">
                            <span class="param-unit">s</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_dsg_ocp_delay', 0x10, 'Trễ Quá Dòng Xả', 's', this)">OK</button>
                    </div>
                </div>
            </div>

            <!-- CÀI ĐẶT ĐIỆN ÁP CELL -->
            <div class="sett-card" id="voltage-card">
                <div class="param-section-title">🔋 Cài Đặt Ngưỡng Điện Áp Cell (Protection & Bal.)</div>
                <div style="font-size:0.73rem; color:var(--text-sub); margin-bottom:12px;">Chỉnh sửa từng thông số rồi bấm nút <b>OK</b> bên cạnh để ghi trực tiếp vào BMS.</div>

                <div class="param-row-item">
                    <span class="param-row-label">Ngắt Quá Áp Cell</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_cell_ovp" step="0.001" min="2.0" max="4.5" value="${getParamVal('4', 'cell_ovp', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_cell_ovp', 0x04, 'Ngắt Quá Áp Cell', 'V', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Phục Hồi Quá Áp Cell</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_cell_ovpr" step="0.001" min="2.0" max="4.5" value="${getParamVal('5', 'cell_ovpr', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_cell_ovpr', 0x05, 'Phục Hồi Quá Áp Cell', 'V', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Ngắt Thấp Áp Cell</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_cell_uvp" step="0.001" min="1.5" max="3.5" value="${getParamVal('2', 'cell_uvp', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_cell_uvp', 0x02, 'Ngắt Thấp Áp Cell', 'V', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Phục Hồi Thấp Áp Cell</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_cell_uvpr" step="0.001" min="1.5" max="3.5" value="${getParamVal('3', 'cell_uvpr', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_cell_uvpr', 0x03, 'Phục Hồi Thấp Áp Cell', 'V', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Khởi Động Cân Bằng</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_bal_start_v" step="0.001" min="2.0" max="4.0" value="${getParamVal('38', 'bal_start_v', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_bal_start_v', 0x26, 'Khởi Động Cân Bằng', 'V', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Độ Lệch Áp Cân Bằng</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_bal_delta_v" step="0.001" min="0.001" max="0.100" value="${getParamVal('6', 'bal_delta_v', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_bal_delta_v', 0x06, 'Độ Lệch Áp Cân Bằng', 'V', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Áp Yêu Cầu Sạc (RCV)</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_req_chg_v" step="0.001" min="2.0" max="4.5" value="${getParamVal('9', 'req_chg_v', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_req_chg_v', 0x09, 'Áp Yêu Cầu Sạc (RCV)', 'V', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Áp Sạc Thả Nổi (RFV)</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_req_float_v" step="0.001" min="2.0" max="4.5" value="${getParamVal('10', 'req_float_v', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_req_float_v', 0x0A, 'Áp Sạc Thả Nổi (RFV)', 'V', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Điện Áp 100% SOC</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_soc100_v" step="0.001" min="2.0" max="4.5" value="${getParamVal('7', 'soc100_v', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_soc100_v', 0x07, 'Điện Áp 100% SOC', 'V', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Điện Áp 0% SOC</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_soc0_v" step="0.001" min="1.5" max="3.5" value="${getParamVal('8', 'soc0_v', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_soc0_v', 0x08, 'Điện Áp 0% SOC', 'V', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Áp Ngủ Thông Minh</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_sleep_v" step="0.001" min="1.5" max="3.5" value="${getParamVal('1', 'smart_sleep_v', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_sleep_v', 0x01, 'Áp Ngủ Thông Minh', 'V', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Ngắt Tắt Nguồn</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap">
                            <input type="number" id="p_power_off_v" step="0.001" min="1.5" max="3.5" value="${getParamVal('11', 'power_off_v', v => Number(v).toFixed(3))}" placeholder="...">
                            <span class="param-unit">V</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_power_off_v', 0x0B, 'Ngắt Tắt Nguồn', 'V', this)">OK</button>
                    </div>
                </div>
            </div>

            <!-- CẤU HÌNH GIAO TIẾP CAN PROTOCOL & ADDRESS ID -->
            <div class="sett-card" id="comm-card">
                <div class="param-section-title">🔌 Cấu Hình Giao Tiếp Inverter (CAN & Address ID)</div>
                <div style="font-size:0.73rem; color:var(--text-sub); margin-bottom:12px;">Được đồng bộ tự động trực tiếp từ gói tin cài đặt của JK BMS.</div>

                <div class="param-row-item">
                    <span class="param-row-label">Giao Thức CAN (CAN Protocol)</span>
                    <div class="param-row-ctrls">
                        <select id="p_can_protocol" style="background:#0a1017; color:var(--cyan); border:1px solid #1e293b; border-radius:8px; font-weight:700; font-size:0.78rem; padding:4px 6px; width:160px; height:32px; outline:none;">
                            ${[
                                [0,'000 User-defined (250K)'],
                                [1,'001 Deye'],
                                [2,'002 Pylontech'],
                                [3,'003 Growatt'],
                                [4,'004 Victron'],
                                [5,'005 Goodwe'],
                                [6,'006 SMA'],
                                [7,'007 Sofar'],
                                [8,'008 Solis'],
                                [9,'009 SRNE'],
                                [10,'010 Must'],
                                [11,'011 Luxpower'],
                                [12,'012 Voltronic'],
                                [13,'013 Schneider'],
                                [14,'014 TBB'],
                                [15,'015 Studer']
                            ].map(([code, name]) => {
                                const curCode = Number(d.can_protocol !== undefined ? d.can_protocol : (d.canProtocol !== undefined ? d.canProtocol : 0));
                                const sel = curCode === code ? ' selected' : '';
                                return `<option value="${code}"${sel}>${name}</option>`;
                            }).join('')}
                        </select>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_can_protocol', 0xA6, 'Giao Thức CAN', '', this)">OK</button>
                    </div>
                </div>

                <div class="param-row-item">
                    <span class="param-row-label">Địa Chỉ Khối Pin (Address ID)</span>
                    <div class="param-row-ctrls">
                        <div class="param-input-wrap" style="width:75px;">
                            <input type="number" id="p_address_id" min="0" max="15" step="1" style="background:rgba(255,255,255,0.05); color:var(--green); font-weight:700; text-align:center;" value="${(d.address_id !== undefined ? d.address_id : (d.rs485DeviceId !== undefined ? d.rs485DeviceId : '0'))}" placeholder="0">
                            <span class="param-unit">ID</span>
                        </div>
                        <button class="btn-param-ok" onclick="saveSingleParam('p_address_id', 0x9F, 'Địa Chỉ Khối Pin', '', this)">OK</button>
                    </div>
                </div>
            </div>

            <!-- WIFI & DEVICE INFO -->
            <div class="sett-card" id="wifi-card">
                <h3 style="color:var(--cyan); margin-bottom:10px; font-size:1rem;">📡 Thông Tin Thiết Bị ESP32</h3>
                <div class="info-card-box" style="margin:0; background:transparent; border:none; padding:0;">
                    <div class="card-row"><span>Device ID:</span><strong style="color:var(--cyan); font-family:monospace;">${d.device_id}</strong></div>
                    <div class="card-row"><span>IP Local:</span><strong style="color:#fff;" id="lbl-wifi-ip">${d.local_ip||'—'}</strong></div>
                    <div class="card-row"><span>Wi-Fi SSID:</span><strong style="color:#fff;" id="lbl-wifi-ssid">${d.ssid||'—'}</strong></div>
                    <div class="card-row"><span>Wi-Fi RSSI:</span><strong style="color:var(--cyan);" id="lbl-wifi-rssi">${d.rssi ? d.rssi + ' dBm' : '—'}</strong></div>
                    <div class="card-row"><span>Firmware:</span><strong style="color:var(--green);">${(d.firmware_version && d.firmware_version.startsWith('v')) ? d.firmware_version : ('v' + (d.firmware_version||'—'))}</strong></div>
                    <div class="card-row"><span>Ngày Kích Hoạt:</span><strong style="color:var(--green); font-size:0.75rem;">${reg}</strong></div>
                </div>
                <button onclick="resetWifi()" class="btn btn-sec" style="border-color:var(--red); color:var(--red); margin-top:14px;">♻️ Reset Cài Đặt Wi-Fi ESP32</button>
            </div>
        </div>

        <!-- BOTTOM NAVIGATION BAR -->
        <div class="bottom-nav">
            <button id="nav-status" class="nav-btn" onclick="showTab('tab-status', this)">
                <span class="nav-icon">🎛️</span>
                <span>Status</span>
            </button>
            <button id="nav-home" class="nav-btn active" onclick="showTab('tab-home', this)">
                <span class="nav-icon">🏠</span>
                <span>Home</span>
            </button>
            <button id="nav-sett" class="nav-btn" onclick="showTab('tab-settings', this)">
                <span class="nav-icon">⚙️</span>
                <span>Settings</span>
            </button>
        </div>
    </div>

    <script>
    let mosStates = {
        charge_mos: ${chargeMos ? 'true' : 'false'},
        discharge_mos: ${dischargeMos ? 'true' : 'false'},
        balance: ${balance ? 'true' : 'false'}
    };
    let isScanning = false;
    let scanTimer = null;
    let liveTimer = null;

    function getCanProtocolName(code) {
        if (code === undefined || code === null || code === '') return '—';
        const c = parseInt(code);
        const map = {
            0: '000 User-defined',
            1: '001 Deye',
            2: '002 Pylontech',
            3: '003 Growatt',
            4: '004 Victron',
            5: '005 Goodwe',
            6: '006 SMA',
            7: '007 Sofar',
            8: '008 Solis',
            9: '009 SRNE',
            10: '010 Must',
            11: '011 Luxpower',
            12: '012 Voltronic',
            13: '013 Schneider',
            14: '014 TBB',
            15: '015 Studer'
        };
        return map[c] || (String(c).padStart(3, '0') + ' Protocol');
    }

    function showTab(id, btn) {
        const tabs = ['tab-home', 'tab-status', 'tab-settings'];
        tabs.forEach(tId => {
            const el = document.getElementById(tId);
            if (el) {
                el.style.display = 'none';
                el.classList.remove('active');
            }
        });
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

        const targetEl = document.getElementById(id);
        if (targetEl) {
            targetEl.style.display = 'block';
            targetEl.classList.add('active');
        }
        if (btn) btn.classList.add('active');
        if (id === 'tab-settings') {
            updateSettingsForm(window._lastDevData || {});
            if (!window._lastDevData || (!window._lastDevData.settings && !window._lastDevData.params)) {
                queryBmsSettings(false);
            }
        }
        window.scrollTo({ top: 0, behavior: 'instant' });
    }

    const $ = id => document.getElementById(id);
    const _el = {};
    function _c(id) { return _el[id] || (_el[id] = $(id)); }
    function _set(id, val) {
        const el = _c(id);
        if (el) {
            const s = String(val);
            if (el.textContent !== s) el.textContent = s;
        }
    }

    const PROT_ITEMS = [
        { bit: 0,  desc: "Lệch trở dây" },
        { bit: 1,  desc: "Quá nhiệt MOS" },
        { bit: 2,  desc: "Lệch số cell" },
        { bit: 4,  desc: "Pin đã sạc đầy" },
        { bit: 5,  desc: "Quá áp pack" },
        { bit: 6,  desc: "Quá dòng sạc" },
        { bit: 7,  desc: "Ngắn mạch sạc" },
        { bit: 8,  desc: "Quá nhiệt sạc" },
        { bit: 9,  desc: "Quá lạnh sạc" },
        { bit: 11, desc: "Thấp áp cell" },
        { bit: 12, desc: "Thấp áp pack" },
        { bit: 13, desc: "Quá dòng xả" },
        { bit: 14, desc: "Ngắn mạch xả" },
        { bit: 15, desc: "Quá nhiệt xả" },
        { bit: 19, desc: "Mật khẩu mặc định" },
        { bit: 27, desc: "Quá lạnh xả" }
    ];

    function updateMosDot(type, isOn) {
        mosStates[type] = isOn;
        const dot = document.getElementById('dot-' + type.replace('_mos',''));
        const txt = document.getElementById('txt-' + type.replace('_mos',''));
        if (dot && txt) {
            dot.className = 'dot ' + (isOn ? 'on' : 'off');
            txt.className = isOn ? 'val-on' : 'val-off';
            txt.innerText = isOn ? 'ON' : 'OFF';
        }
    }

    async function toggleMos(type) {
        const key = type === 'charge_mos' ? 'charge_mos' : (type === 'discharge_mos' ? 'discharge_mos' : 'balance');
        const newState = !mosStates[key];
        updateMosDot(key, newState);
        try {
            await fetch('/api/send-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: '${d.device_id}',
                    cmd: { cmd: 'set_' + key, enable: newState }
                })
            });
        } catch(e) {}
    }

    function closeScannedList() {
        const elHome = document.getElementById('home-ble-list');
        const elSett = document.getElementById('ble-list');
        const statHome = document.getElementById('home-ble-status');
        const statSett = document.getElementById('ble-status');
        if (elHome) elHome.innerHTML = '';
        if (elSett) elSett.innerHTML = '';
        if (statHome) statHome.style.display = 'none';
        if (statSett) statSett.style.display = 'none';
        if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
        isScanning = false;
        const btnHome = document.getElementById('btn-home-ble-scan');
        if (btnHome) { btnHome.disabled = false; btnHome.innerText = '🔍 Quét Bluetooth'; }
    }

    function renderScannedDevices(devices) {
        const elHome = document.getElementById('home-ble-list');
        const elSett = document.getElementById('ble-list');
        if (!devices || devices.length === 0) {
            const emptyHtml = '<div style="text-align:center; padding:10px; font-size:0.8rem; color:var(--text-sub); border:1px dashed #222d35; border-radius:8px;">Không tìm thấy thiết bị BLE nào. Hãy đảm bảo BMS đang bật Bluetooth và ở gần ESP32.</div>';
            if (elHome) elHome.innerHTML = emptyHtml;
            if (elSett) elSett.innerHTML = emptyHtml;
            return;
        }

        let headerHtml = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding:2px 4px;">' +
                         '<span style="font-size:0.8rem; color:var(--text-sub);">Tìm thấy ' + devices.length + ' thiết bị BLE:</span>' +
                         '<button type="button" onclick="closeScannedList()" style="background:rgba(255,59,48,0.15); border:1px solid rgba(255,59,48,0.3); color:#ff6b6b; font-size:0.75rem; cursor:pointer; font-weight:700; padding:2px 8px; border-radius:4px;">✕ Đóng</button>' +
                         '</div>';

        let html = headerHtml;
        devices.forEach(d => {
            const isJK = d.is_jkbms || (d.name && (d.name.toLowerCase().includes('jk') || d.name.toLowerCase().includes('bms') || d.name.toLowerCase().includes('blue')));
            const borderColor = isJK ? 'rgba(0,255,43,0.4)' : 'rgba(56,189,248,0.3)';
            const bgColor = isJK ? 'rgba(0,255,43,0.05)' : 'rgba(15,23,42,0.6)';
            const safeName = (d.name || '').replace(/'/g, "\\\\'");
            const displayName = (d.name && d.name !== '(Không có tên)') ? d.name : 'Thiết bị BLE';
            const rssiVal = d.rssi !== undefined ? d.rssi : -70;
            html += '<div class="list-item" style="border:1px solid ' + borderColor + '; background:' + bgColor + '; padding:10px 12px; margin-bottom:8px; border-radius:8px;">' +
                    '<div>' +
                        '<div style="font-weight:700; font-size:0.9rem; color:' + (isJK ? 'var(--green)' : '#fff') + '; display:flex; align-items:center; gap:6px;">' +
                            '<span>' + (isJK ? '🔋' : '📡') + '</span>' +
                            '<span>' + displayName + '</span>' +
                            (isJK ? '<span style="font-size:0.65rem; background:rgba(0,255,43,0.18); color:var(--green); border:1px solid var(--green); padding:1px 6px; border-radius:4px;">JK-BMS</span>' : '') +
                        '</div>' +
                        '<div style="font-size:0.75rem; color:var(--text-sub); font-family:monospace; margin-top:2px;">MAC: ' + d.mac + ' | Tín hiệu: ' + rssiVal + ' dBm</div>' +
                    '</div>' +
                    '<button class="btn" style="width:auto; padding:6px 14px; font-size:0.78rem; font-weight:700; background:linear-gradient(135deg,#00d2ff,#00ff2b); color:#000; margin:0;" onclick="connectBms(\\'' + d.mac + '\\', \\'' + safeName + '\\')">⚡ Kết Nối & Lưu</button>' +
                '</div>';
        });

        if (elHome) elHome.innerHTML = html;
        if (elSett) elSett.innerHTML = html;
    }

    async function scanBLE() {
        const btnHome = document.getElementById('btn-home-ble-scan');
        const statHome = document.getElementById('home-ble-status');
        const statSett = document.getElementById('ble-status');

        const setStatus = (msg, isErr=false) => {
            const color = isErr ? 'var(--red)' : 'var(--cyan)';
            if (statHome) { statHome.style.display = 'block'; statHome.style.color = color; statHome.innerText = msg; }
            if (statSett) { statSett.style.display = 'block'; statSett.style.color = color; statSett.innerText = msg; }
        };

        if (btnHome) { btnHome.disabled = true; btnHome.innerText = '⏳ Đang quét...'; }
        setStatus('📡 Đang gửi lệnh quét Bluetooth tới ESP32...');

        try {
            await fetch('/api/send-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: '${d.device_id}', cmd: { cmd: 'scan_ble' } })
            });

            isScanning = true;
            let attempts = 0;
            if (scanTimer) clearInterval(scanTimer);
            scanTimer = setInterval(async () => {
                attempts++;
                setStatus('⏳ ESP32 đang quét Bluetooth xung quanh... (' + (attempts * 2) + 's / max 50s)');
                try {
                    const res = await fetch('/api/scanned-ble?device_id=${d.device_id}&_t=' + Date.now());
                    const data = await res.json();
                    if (data.status === 'done' || (data.devices && data.devices.length > 0)) {
                        clearInterval(scanTimer);
                        isScanning = false;
                        if (btnHome) { btnHome.disabled = false; btnHome.innerText = '🔍 Quét Bluetooth'; }
                        if (data.devices && data.devices.length > 0) {
                            setStatus('✅ Đã tìm thấy ' + data.devices.length + ' thiết bị Bluetooth!');
                            renderScannedDevices(data.devices);
                        } else {
                            setStatus('ℹ️ Quét hoàn tất. Không phát hiện thêm thiết bị phát sóng xung quanh.');
                        }
                    } else if (attempts >= 25) {
                        clearInterval(scanTimer);
                        isScanning = false;
                        if (btnHome) { btnHome.disabled = false; btnHome.innerText = '🔍 Quét Bluetooth'; }
                        setStatus('❌ Hết thời gian chờ phản hồi từ ESP32.', true);
                    }
                } catch(e) {}
            }, 2000);
        } catch(e) {
            if (btnHome) { btnHome.disabled = false; btnHome.innerText = '🔍 Quét Bluetooth'; }
            setStatus('❌ Lỗi kết nối máy chủ!', true);
        }
    }

    async function connectBms(mac, name) {
        if (!confirm('Kết nối ESP32 tới BMS ' + name + ' (' + mac + ')?')) return;
        const statHome = document.getElementById('home-ble-status');
        if (statHome) { statHome.style.display = 'block'; statHome.style.color = 'var(--yellow)'; statHome.innerText = '⏳ Đang gửi lệnh kết nối tới ESP32...'; }
        try {
            await fetch('/api/send-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: '${d.device_id}',
                    cmd: [
                        { cmd: 'connect_bms', mac: mac, name: name, pin: '1234' },
                        { cmd: 'send_heartbeat_now' }
                    ]
                })
            });
            // Tự động đóng danh sách quét Bluetooth sau khi bấm kết nối
            closeScannedList();
            showParamToast('✅ Đã yêu cầu kết nối tới ' + name + '!');
            setTimeout(() => {
                showTab('tab-home', document.getElementById('nav-home'));
                refreshLiveData();
            }, 2500);
        } catch(e) {
            if (statHome) { statHome.style.color = 'var(--red)'; statHome.innerText = '❌ Lỗi gửi lệnh!'; }
            showParamToast('❌ Lỗi kết nối: ' + e.message, true);
        }
    }

    async function resetWifi() {
        if (!confirm('Xác nhận Reset Wi-Fi thiết bị ${d.device_id}? ESP32 sẽ xóa cấu hình Wi-Fi và phát lại mạng AP Setup.')) return;
        try {
            await fetch('/api/send-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: '${d.device_id}', cmd: { cmd: 'reset_wifi' } })
            });
            alert('✅ Đã gửi lệnh Reset Wi-Fi! Vui lòng kết nối vào mạng AP của ESP32 để cài đặt lại.');
        } catch(e) { alert('❌ Lỗi gửi lệnh!'); }
    }

    let toastTimer = null;
    function showParamToast(msg, isErr = false) {
        let toast = document.getElementById('floating-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'floating-toast';
            toast.style.cssText = 'position:fixed; bottom:74px; left:50%; transform:translateX(-50%); z-index:99999; padding:10px 18px; border-radius:24px; font-size:0.83rem; font-weight:700; box-shadow:0 6px 24px rgba(0,0,0,0.7); transition:all 0.3s cubic-bezier(0.4,0,0.2,1); pointer-events:none; max-width:92%; text-align:center;';
            document.body.appendChild(toast);
        }
        toast.style.background = isErr ? 'rgba(239,68,68,0.95)' : 'rgba(15,23,42,0.95)';
        toast.style.color = isErr ? '#fff' : '#00ff2b';
        toast.style.border = isErr ? '1px solid #ef4444' : '1px solid #00ff2b';
        toast.textContent = msg;
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';

        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            if (toast) {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(-50%) translateY(10px)';
            }
        }, 3500);
    }

    const pendingParamUpdates = {};

    async function saveSingleParam(inputId, reg, name, unit, btnEl) {
        const input = document.getElementById(inputId);
        if (!input) return;
        const rawVal = input.value.trim().replace(',', '.');
        const numVal = parseFloat(rawVal);
        if (isNaN(numVal)) {
            alert('Vui lòng nhập giá trị hợp lệ cho ' + name);
            return;
        }

        // Khóa không cho dữ liệu đọc ngầm ghi đè thông số vừa nhập trong 25 giây
        pendingParamUpdates[inputId] = { val: numVal, expireAt: Date.now() + 25000 };

        // Cập nhật lạc quan vào bộ nhớ cache local để tránh giật giao diện
        if (window._lastDevData) {
            if (!window._lastDevData.settings) window._lastDevData.settings = {};
            if (!window._lastDevData.params) window._lastDevData.params = {};
            window._lastDevData.params[String(reg)] = numVal;
            const regToKey = {
                1: 'smart_sleep_v', 2: 'cell_uvp', 3: 'cell_uvpr', 4: 'cell_ovp', 5: 'cell_ovpr',
                6: 'bal_delta_v', 7: 'soc100_v', 8: 'soc0_v', 9: 'req_chg_v', 10: 'req_float_v',
                11: 'power_off_v', 12: 'max_chg_curr', 13: 'chg_ocp_delay', 14: 'chg_ocpr_time',
                15: 'max_dsg_curr', 16: 'dsg_ocp_delay', 19: 'max_bal_curr', 28: 'cell_count',
                32: 'battery_cap', 38: 'bal_start_v', 166: 'can_protocol'
            };
            if (regToKey[reg]) window._lastDevData.settings[regToKey[reg]] = numVal;
            if (reg === 0xA6 || reg === 166) {
                window._lastDevData.can_protocol = numVal;
                window._lastDevData.canProtocol = numVal;
                const devCan = document.getElementById('dev-info-can');
                if (devCan) devCan.textContent = getCanProtocolName(numVal);
            }
        }

        const originalText = btnEl ? btnEl.innerHTML : 'OK';
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.innerHTML = '<span class="loading-spin"></span>';
        }

        try {
            const res = await fetch('/api/send-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: '${d.device_id}',
                    cmd: {
                        cmd: 'set_param',
                        reg: reg,
                        val: numVal
                    }
                })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                if (btnEl) {
                    btnEl.innerHTML = '✓';
                    btnEl.style.background = '#00ff2b';
                    btnEl.style.color = '#000';
                    setTimeout(() => {
                        btnEl.innerHTML = originalText;
                        btnEl.style.background = '';
                        btnEl.style.color = '';
                        btnEl.disabled = false;
                    }, 2000);
                }
                const displayUnit = unit ? (' ' + unit) : '';
                showParamToast('✅ Đã ghi ' + name + ' (' + numVal + displayUnit + ') thành công!');
            } else {
                delete pendingParamUpdates[inputId];
                throw new Error(data.error || 'Lỗi gửi lệnh');
            }
        } catch (e) {
            delete pendingParamUpdates[inputId];
            if (btnEl) {
                btnEl.innerHTML = '✕';
                btnEl.style.background = '#ff3b30';
                btnEl.style.color = '#fff';
                setTimeout(() => {
                    btnEl.innerHTML = originalText;
                    btnEl.style.background = '';
                    btnEl.style.color = '';
                    btnEl.disabled = false;
                }, 2000);
            }
            showParamToast('❌ Lỗi ghi ' + name + ': ' + e.message, true);
        }
    }

    async function queryBmsSettings(showToast = true) {
        const badge = document.getElementById('settings-sync-badge');
        if (badge) {
            badge.style.background = 'rgba(0,229,255,0.15)';
            badge.style.color = 'var(--cyan)';
            badge.style.borderColor = 'var(--cyan)';
            badge.innerText = '⏳ Đang đồng bộ thông số từ BMS...';
        }
        try {
            await fetch('/api/send-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: '${d.device_id}',
                    cmd: { cmd: 'query_settings' }
                })
            });
            if (showToast) alert('✅ Đã gửi lệnh yêu cầu đọc lại cài đặt từ BMS!');
        } catch(e) {}
    }

    function updateSettingsForm(dev) {
        if (!dev) return;
        const s = dev.settings || {};
        const p = dev.params || {};
        const isFocused = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT');
        if (isFocused) return;

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (pendingParamUpdates[id]) {
                if (Date.now() < pendingParamUpdates[id].expireAt) {
                    if (Math.abs(parseFloat(val) - parseFloat(pendingParamUpdates[id].val)) < 0.001) {
                        delete pendingParamUpdates[id];
                    } else {
                        return; // Giữ giá trị người dùng vừa sửa, không cho đè giá trị cũ từ cloud
                    }
                } else {
                    delete pendingParamUpdates[id];
                }
            }
            if (val !== undefined && val !== null && val !== '') {
                el.value = val;
            }
        };

        const maxChg = s.max_chg_curr !== undefined ? s.max_chg_curr : p['12'];
        const maxDsg = s.max_dsg_curr !== undefined ? s.max_dsg_curr : p['15'];
        const maxBal = s.max_bal_curr !== undefined ? s.max_bal_curr : p['19'];
        const batCap = s.battery_cap !== undefined ? s.battery_cap : (p['32'] !== undefined ? p['32'] : dev.capacity_ah);
        const cellCnt = s.cell_count !== undefined ? s.cell_count : (p['28'] !== undefined ? p['28'] : dev.cell_count);
        const chgDelay = s.chg_ocp_delay !== undefined ? s.chg_ocp_delay : p['13'];
        const chgRcvr = s.chg_ocpr_time !== undefined ? s.chg_ocpr_time : p['14'];
        const dsgDelay = s.dsg_ocp_delay !== undefined ? s.dsg_ocp_delay : p['16'];

        const ovp = s.cell_ovp !== undefined ? s.cell_ovp : p['4'];
        const ovpr = s.cell_ovpr !== undefined ? s.cell_ovpr : p['5'];
        const uvp = s.cell_uvp !== undefined ? s.cell_uvp : p['2'];
        const uvpr = s.cell_uvpr !== undefined ? s.cell_uvpr : p['3'];
        const balStart = s.bal_start_v !== undefined ? s.bal_start_v : p['38'];
        const balDelta = s.bal_delta_v !== undefined ? s.bal_delta_v : p['6'];
        const reqChg = s.req_chg_v !== undefined ? s.req_chg_v : p['9'];
        const reqFloat = s.req_float_v !== undefined ? s.req_float_v : p['10'];
        const soc100 = s.soc100_v !== undefined ? s.soc100_v : p['7'];
        const soc0 = s.soc0_v !== undefined ? s.soc0_v : p['8'];
        const sleepV = s.smart_sleep_v !== undefined ? s.smart_sleep_v : p['1'];
        const pwrOff = s.power_off_v !== undefined ? s.power_off_v : p['11'];

        if (maxChg !== undefined) setVal('p_max_chg_curr', Number(maxChg).toFixed(1));
        if (maxDsg !== undefined) setVal('p_max_dsg_curr', Number(maxDsg).toFixed(1));
        if (maxBal !== undefined) setVal('p_max_bal_curr', Number(maxBal).toFixed(1));
        if (batCap !== undefined && Number(batCap) > 0) setVal('p_battery_cap', Math.round(Number(batCap)));
        if (cellCnt !== undefined && Number(cellCnt) > 0) setVal('p_cell_count', cellCnt);
        if (chgDelay !== undefined) setVal('p_chg_ocp_delay', chgDelay);
        if (chgRcvr !== undefined) setVal('p_chg_ocpr_time', chgRcvr);
        if (dsgDelay !== undefined) setVal('p_dsg_ocp_delay', dsgDelay);

        if (ovp !== undefined && Number(ovp) > 0) setVal('p_cell_ovp', Number(ovp).toFixed(3));
        if (ovpr !== undefined && Number(ovpr) > 0) setVal('p_cell_ovpr', Number(ovpr).toFixed(3));
        if (uvp !== undefined && Number(uvp) > 0) setVal('p_cell_uvp', Number(uvp).toFixed(3));
        if (uvpr !== undefined && Number(uvpr) > 0) setVal('p_cell_uvpr', Number(uvpr).toFixed(3));
        if (balStart !== undefined && Number(balStart) > 0) setVal('p_bal_start_v', Number(balStart).toFixed(3));
        if (balDelta !== undefined && Number(balDelta) > 0) setVal('p_bal_delta_v', Number(balDelta).toFixed(3));
        if (reqChg !== undefined && Number(reqChg) > 0) setVal('p_req_chg_v', Number(reqChg).toFixed(3));
        if (reqFloat !== undefined && Number(reqFloat) > 0) setVal('p_req_float_v', Number(reqFloat).toFixed(3));
        if (soc100 !== undefined && Number(soc100) > 0) setVal('p_soc100_v', Number(soc100).toFixed(3));
        if (soc0 !== undefined && Number(soc0) > 0) setVal('p_soc0_v', Number(soc0).toFixed(3));
        if (sleepV !== undefined && Number(sleepV) > 0) setVal('p_sleep_v', Number(sleepV).toFixed(3));
        if (pwrOff !== undefined && Number(pwrOff) > 0) setVal('p_power_off_v', Number(pwrOff).toFixed(3));

        const canVal = dev.can_protocol !== undefined ? dev.can_protocol : dev.canProtocol;
        const addrVal = dev.address_id !== undefined ? dev.address_id : (dev.rs485DeviceId !== undefined ? dev.rs485DeviceId : dev.rs485_device_id);
        if (canVal !== undefined && canVal !== null && canVal !== '') {
            const el = document.getElementById('p_can_protocol');
            if (el) {
                if (pendingParamUpdates['p_can_protocol']) {
                    if (Date.now() < pendingParamUpdates['p_can_protocol'].expireAt) {
                        if (parseInt(canVal) === parseInt(pendingParamUpdates['p_can_protocol'].val)) {
                            delete pendingParamUpdates['p_can_protocol'];
                        }
                    } else {
                        delete pendingParamUpdates['p_can_protocol'];
                    }
                }
                if (!pendingParamUpdates['p_can_protocol']) {
                    el.value = String(canVal);
                }
            }
        }
        if (addrVal !== undefined && addrVal !== null && addrVal !== '') {
            setVal('p_address_id', addrVal);
        }

        const hasAny = (s.cell_ovp !== undefined || (p['4'] !== undefined && Number(p['4']) > 0) || (maxChg !== undefined && Number(maxChg) > 0));
        const badge = document.getElementById('settings-sync-badge');
        if (badge) {
            if (hasAny) {
                badge.style.background = 'rgba(0,255,43,0.15)';
                badge.style.color = 'var(--green)';
                badge.style.borderColor = 'var(--green)';
                badge.innerText = '● Đã đồng bộ từ BMS';
            } else {
                badge.style.background = 'rgba(255,184,0,0.15)';
                badge.style.color = 'var(--yellow)';
                badge.style.borderColor = 'var(--yellow)';
                badge.innerText = '○ Đang chờ nạp thông số từ BMS...';
            }
        }
    }

    async function refreshLiveData() {
        try {
            const res = await fetch('/api/devices?device_id=${d.device_id}&watch=1&_t=' + Date.now());
            if (!res.ok) return;
            const devices = await res.json();
            const dev = devices.find(item => item.device_id === '${d.device_id}');
            if (!dev) return;

            window._lastDevData = dev;
            updateSettingsForm(dev);

            const curCan = dev.can_protocol !== undefined ? dev.can_protocol : dev.canProtocol;
            const curAddr = dev.address_id !== undefined ? dev.address_id : (dev.rs485DeviceId !== undefined ? dev.rs485DeviceId : dev.rs485_device_id);
            if (curCan !== undefined && curCan !== null && curCan !== '') _set('dev-info-can', getCanProtocolName(curCan));
            if (curAddr !== undefined && curAddr !== null && curAddr !== '') _set('dev-info-addr', curAddr);

            const isOnline = !!(dev.online || (dev.lastSeen && (Date.now() - dev.lastSeen < 60000)));
            const isConn = isOnline && (dev.connected === true);

            if (isConn && !isScanning) {
                const homeList = document.getElementById('home-ble-list');
                const settList = document.getElementById('ble-list');
                if ((homeList && homeList.children.length > 0) || (settList && settList.children.length > 0)) {
                    closeScannedList();
                }
            }

            // Online Badge
            const dot = _c('esp-online-dot');
            const txt = _c('esp-online-txt');
            const badge = _c('esp-online-badge');
            if (dot && txt && badge) {
                dot.style.background = isOnline ? '#00ff2b' : '#ff3b30';
                dot.style.boxShadow = isOnline ? '0 0 5px #00ff2b' : '0 0 5px #ff3b30';
                txt.textContent = isOnline ? 'ESP Online' : 'ESP Offline';
                badge.style.color = isOnline ? '#00ff2b' : '#ff3b30';
            }

            // BT Icon
            const btIcon = _c('bt-icon-head');
            if (btIcon) {
                if (isConn) btIcon.classList.add('active');
                else btIcon.classList.remove('active');
            }

            // Runtime Display (match Local Web)
            const rtSec = (dev.total_runtime_s && dev.total_runtime_s > 0) ? dev.total_runtime_s : ((dev.totalRuntimeSec && dev.totalRuntimeSec > 0) ? dev.totalRuntimeSec : ((dev.uptime_s && dev.uptime_s > 0) ? dev.uptime_s : (dev.uptimeSec || 0)));
            const rtDays = Math.floor(rtSec / 86400);
            const rtHours = Math.floor((rtSec % 86400) / 3600);
            const rtMins = Math.floor((rtSec % 3600) / 60);
            const rtS = Math.floor(rtSec % 60);
            const curRuntimeStr = rtDays + 'd ' + rtHours.toString().padStart(2, '0') + 'h ' + rtMins.toString().padStart(2, '0') + 'm ' + rtS.toString().padStart(2, '0') + 's';
            _set('uptime-display', curRuntimeStr);
            _set('rt-runtime', curRuntimeStr);

            // Name
            const bmsName = (dev.active_bms_name && dev.active_bms_name !== 'JK_PB2A16S15P' && !dev.active_bms_name.startsWith('JK-BMS [') ? dev.active_bms_name : null) || dev.active_pack_name || dev.active_pack_alias || dev.active_bms_name || 'JK-BMS';
            _set('head-bms-name', isConn ? bmsName : (dev.active_bms_mac ? bmsName : 'Chưa kết nối BMS'));
            _set('head-sn', dev.active_bms_mac ? ('MAC: ' + dev.active_bms_mac) : 'Chưa chọn Pack');

            // Gauge
            const socVal = isConn ? (dev.soc !== undefined ? dev.soc : 0) : 0;
            _set('home-soc-txt', socVal + '%');
            const arc = _c('gauge-arc');
            if (arc) {
                const offset = (284.8 - (socVal / 100.0) * 284.8).toFixed(1);
                arc.style.strokeDashoffset = offset;
                const socColor = (!isConn || socVal <= 0) ? '#556570' : (socVal > 50 ? '#00ff2b' : (socVal > 20 ? '#ffb800' : '#ff3b30'));
                arc.setAttribute('stroke', (isConn && socVal > 50) ? 'url(#gaugeGrad)' : socColor);
                const socTxt = _c('home-soc-txt');
                if (socTxt) socTxt.setAttribute('fill', socColor);
            }

            const vStr = isConn && dev.voltage !== undefined ? dev.voltage.toFixed(2) + 'V' : '0.00V';
            _set('home-v-pill', vStr);
            const aStr = isConn && dev.current !== undefined ? dev.current.toFixed(2) + 'A' : '0.00A';
            _set('home-a-pill', aStr);

            // Banner
            const sBanner = _c('status-banner');
            const bMsg = _c('banner-msg');
            const bIcon = _c('banner-icon');
            if (sBanner && bMsg && bIcon) {
                if (isConn) {
                    bMsg.innerText = 'Đang kết nối với ' + bmsName + ' • Pin hoạt động bình thường';
                    bIcon.innerText = '✔'; bIcon.style.color = 'var(--green)';
                    sBanner.style.borderColor = '#008b99'; sBanner.style.background = 'rgba(5,35,41,0.85)';
                } else if (dev.active_bms_mac) {
                    const statusDetail = dev.ble_status_msg ? (' • ' + dev.ble_status_msg) : '';
                    bMsg.innerText = 'Đang kết nối BLE tới ' + bmsName + statusDetail;
                    bIcon.innerText = '📡'; bIcon.style.color = 'var(--yellow)';
                    sBanner.style.borderColor = 'rgba(245,158,11,0.5)'; sBanner.style.background = 'rgba(40,30,5,0.85)';
                } else {
                    bMsg.innerText = 'BMS chưa kết nối Bluetooth';
                    bIcon.innerText = '📡'; bIcon.style.color = 'var(--red)';
                    sBanner.style.borderColor = 'rgba(255,59,48,0.5)'; sBanner.style.background = 'rgba(40,5,5,0.85)';
                }
            }

            // Quick BLE Bar Home
            const hBleName = _c('home-ble-name');
            const hBleMac = _c('home-ble-mac');
            if (hBleName) {
                if (isConn) hBleName.innerHTML = '<span style="color:var(--green);">🟢</span> ' + bmsName + ' <span style="font-size:0.75rem; color:var(--green);">(Đang kết nối)</span>';
                else if (dev.active_bms_mac) hBleName.innerHTML = '<span style="color:var(--yellow);">🟡</span> ' + bmsName + ' <span style="font-size:0.75rem; color:var(--yellow);">(Đang tìm kiếm...)</span>';
                else hBleName.innerHTML = '<span style="color:var(--text-sub);">⚪</span> Chưa kết nối BMS';
            }
            if (hBleMac) hBleMac.innerText = dev.active_bms_mac ? ('MAC: ' + dev.active_bms_mac) : 'Chưa có MAC • Hãy bấm Quét Bluetooth';

            // Metrics
            _set('m-high-v', isConn && dev.max_cell_voltage ? dev.max_cell_voltage.toFixed(3) : '0.000');
            _set('m-low-v', isConn && dev.min_cell_voltage ? dev.min_cell_voltage.toFixed(3) : '0.000');
            _set('m-diff-v', isConn && dev.delta_cell_voltage !== undefined ? dev.delta_cell_voltage.toFixed(3) : '0.000');
            _set('m-bal-a', isConn && dev.balance_current !== undefined ? dev.balance_current.toFixed(3) : '0.000');
            _set('m-cap-ah', isConn && dev.capacity_ah !== undefined ? Math.round(dev.capacity_ah) : '0');
            _set('m-rem-ah', isConn && dev.remain_capacity_ah !== undefined ? dev.remain_capacity_ah.toFixed(1) : '0.0');
            const avgV = (isConn && dev.min_cell_voltage && dev.max_cell_voltage) ? (((dev.min_cell_voltage||0) + (dev.max_cell_voltage||0)) / 2).toFixed(3) : '0.000';
            _set('m-cell-avg', avgV);
            _set('m-soh', isConn && dev.soh ? (dev.soh + '%') : '100%');

            const isChg = dev.current > 0.1;
            const isDsg = dev.current < -0.1;
            _set('card-curr-val', isConn && dev.current !== undefined ? ((dev.current > 0 ? '+' : '') + dev.current.toFixed(2) + ' A') : '0.00 A');
            _set('card-power-val', isConn && dev.power !== undefined ? (Math.abs(dev.power).toFixed(1) + ' W') : '0.0 W');
            _set('card-mos-temp', isConn && dev.mos_temp !== undefined ? (dev.mos_temp.toFixed(1) + ' °C') : '0.0 °C');
            _set('card-probes', (isConn && dev.temp1 ? dev.temp1.toFixed(1) : '0.0') + ' / ' + (isConn && dev.temp2 ? dev.temp2.toFixed(1) : '0.0') + ' °C');
            _set('card-status-txt', isConn ? (isChg ? 'Charging (Đang sạc)' : (isDsg ? 'Discharging (Đang xả)' : 'Standby (Chờ)')) : 'Disconnected');

            // MOS indicators
            if (dev.charge_mos !== undefined) updateMosDot('charge_mos', dev.charge_mos);
            if (dev.discharge_mos !== undefined) updateMosDot('discharge_mos', dev.discharge_mos);
            if (dev.balance_active !== undefined) updateMosDot('balance', dev.balance_active);

            // Real-time tab
            _set('rt-power', isConn && dev.power !== undefined ? Math.abs(dev.power).toFixed(1) : '0.0');
            _set('rt-avg', avgV);
            _set('rt-cap', isConn && dev.capacity_ah ? Math.round(dev.capacity_ah) : '0');
            _set('rt-diff', isConn && dev.delta_cell_voltage ? dev.delta_cell_voltage.toFixed(3) : '0.000');
            _set('rt-rem', isConn && dev.remain_capacity_ah ? dev.remain_capacity_ah.toFixed(1) : '0.0');
            _set('rt-balcurr', isConn && dev.balance_current ? dev.balance_current.toFixed(3) : '0.000');
            _set('rt-mos', isConn && dev.mos_temp ? dev.mos_temp.toFixed(1) : '0.0');
            _set('rt-cyc', isConn && dev.cycle_count !== undefined ? dev.cycle_count : '0');
            _set('rt-t1', isConn && dev.temp1 ? dev.temp1.toFixed(1) : '0.0');
            _set('rt-t2', isConn && dev.temp2 ? dev.temp2.toFixed(1) : '0.0');
            _set('rt-t4', isConn && dev.temp4 ? dev.temp4.toFixed(1) : '0.0');
            _set('rt-t5', isConn && dev.temp5 ? dev.temp5.toFixed(1) : '0.0');
            _set('rt-heatcurr', isConn && dev.heat_curr ? dev.heat_curr.toFixed(1) : '0.0');
            _set('rt-heater', dev.heating_active ? 'ON' : 'OFF');
            _set('rt-logs', dev.detail_logs_count || 0);
            _set('rt-soh', isConn && dev.soh ? dev.soh : 100);
            _set('rt-balancer', (dev.balance_active) ? 'ON' : 'OFF');

            // Cells Grid (3 columns)
            const cellsArr = Array.isArray(dev.cell_voltages) ? dev.cell_voltages : (Array.isArray(dev.cells) ? dev.cells : []);
            const cellResArr = Array.isArray(dev.cell_resistances) ? dev.cell_resistances : [];
            const minNum = dev.min_cell_num || 0;
            const maxNum = dev.max_cell_num || 0;
            const cellCount = dev.cell_count || (cellsArr.length > 0 ? cellsArr.length : 16);

            const cGrid = _c('cells-grid-3');
            if (cGrid && cellsArr.length > 0) {
                let html = '';
                for (let i = 0; i < cellCount; i++) {
                    const num = (i + 1).toString().padStart(2, '0');
                    const v = cellsArr[i] || 0;
                    const isMin = (i + 1 === minNum);
                    const isMax = (i + 1 === maxNum);
                    const vClass = isMin ? 'min' : (isMax ? 'max' : '');
                    const barClass = isMin ? 'min' : (isMax ? 'max' : '');
                    const valStr = (typeof v === 'number' ? v : parseFloat(v)).toFixed(3);
                    const pct = Math.max(0, Math.min(100, ((v - 2.5) / 1.15) * 100)).toFixed(0);

                    html += '<div class="cell-item">' +
                                '<div style="display:flex; justify-content:space-between; align-items:center;">' +
                                    '<span class="cell-badge">#' + num + '</span>' +
                                    '<span class="cell-v-txt ' + vClass + '">' + valStr + '<span class="unit-sup">V</span></span>' +
                                '</div>' +
                                '<div class="cell-v-bar-bg"><div class="cell-v-bar-fill ' + barClass + '" style="width:' + pct + '%;"></div></div>' +
                            '</div>';
                }
                cGrid.innerHTML = html;
            }

            // Wire Resistance Grid (3 columns)
            const wGrid = _c('wire-grid-3');
            if (wGrid && cellResArr.length > 0) {
                let html = '';
                for (let i = 0; i < cellCount; i++) {
                    const num = (i + 1).toString().padStart(2, '0');
                    const r = cellResArr[i] || 0;
                    const rStr = (typeof r === 'number' ? r : parseFloat(r)).toFixed(3);
                    html += '<div class="cell-item">' +
                                '<div style="display:flex; justify-content:space-between; align-items:center;">' +
                                    '<span class="cell-badge">#' + num + '</span>' +
                                    '<span style="font-weight:700; color:var(--cyan); font-family:monospace; font-size:0.85rem;">' + rStr + '<span class="unit-sup">Ω</span></span>' +
                                '</div>' +
                            '</div>';
                }
                wGrid.innerHTML = html;
            }

            // Protection Grid
            const protGrid = _c('protection-grid');
            if (protGrid) {
                const errMask = dev.raw_errors_bitmask || 0;
                let html = '';
                PROT_ITEMS.forEach(p => {
                    const isAlarm = (errMask & (1 << p.bit)) !== 0;
                    html += '<div class="prot-item"><span class="prot-lbl">' + p.desc + '</span><span class="prot-badge ' + (isAlarm ? 'alarm' : 'ok') + '">' + (isAlarm ? '⚠️ Báo động' : '✔ Chuẩn') + '</span></div>';
                });
                protGrid.innerHTML = html;
            }

            // Settings tab info
            _set('lbl-wifi-ssid', '📶 ' + (dev.ssid || 'Chưa kết nối'));
            _set('lbl-wifi-ip', dev.local_ip || '—');
            _set('lbl-wifi-rssi', dev.rssi ? (dev.rssi + ' dBm') : '—');
            _set('lbl-ble-name', '🔋 ' + (isConn ? bmsName : 'Chưa kết nối BMS'));
            _set('lbl-ble-mac', dev.active_bms_mac || '—');
            _set('lbl-ble-status', isConn ? '● Đang kết nối' : '○ Chưa kết nối');

            // If BLE scan result is available on dev
            if (isScanning && dev.scanned_devices && Array.isArray(dev.scanned_devices) && dev.scanned_devices.length > 0) {
                clearInterval(scanTimer);
                isScanning = false;
                const btnHome = document.getElementById('btn-home-ble-scan');
                if (btnHome) { btnHome.disabled = false; btnHome.innerText = '🔍 Quét Bluetooth'; }
                const statHome = document.getElementById('home-ble-status');
                if (statHome) { statHome.style.display = 'block'; statHome.style.color = 'var(--green)'; statHome.innerText = '✅ Đã tìm thấy ' + dev.scanned_devices.length + ' thiết bị Bluetooth JK-BMS!'; }
                renderScannedDevices(dev.scanned_devices);
            }

        } catch(e) {}
    }

    liveTimer = setInterval(refreshLiveData, 1500);
    refreshLiveData();

    function notifySessionEnd() {
        try {
            const endUrl = '/api/session-end?device_id=' + encodeURIComponent('${d.device_id}');
            if (navigator.sendBeacon) {
                navigator.sendBeacon(endUrl);
            } else {
                fetch(endUrl, { method: 'POST', keepalive: true }).catch(()=>{});
            }
        } catch(e){}
    }

    window.addEventListener('pagehide', notifySessionEnd);
    window.addEventListener('beforeunload', notifySessionEnd);

    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
            notifySessionEnd();
        } else {
            refreshLiveData();
            if (!liveTimer) liveTimer = setInterval(refreshLiveData, 1500);
        }
    });
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
