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
const IDLE_INTERVAL_MS       = 3 * 1000;       // ESP polls every 3s when no user viewing (instant wake-up in 1-3s)
const ACTIVE_INTERVAL_MS     = 1500;           // ESP uploads telemetry every 1.5s when user is viewing (real-time stream)
const SESSION_TIMEOUT_MS     = 90 * 1000;      // 90s user session active timeout (tự động ngủ khi tắt web quá 90s)
const PACK_SWITCH_LOCK_MS    = 20 * 1000;      // Lock active_pack_idx for 20s after set-active-pack to prevent heartbeat overwrite
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


// ── AUTH & USER SECURITY HELPERS (PBKDF2 HMAC-SHA256) ─────────────────────────
const LOGIN_ATTEMPTS = new Map();

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return {
    hashHex: bytesToHex(new Uint8Array(derivedBits)),
    saltHex: bytesToHex(salt)
  };
}

async function createSession(env, userId) {
  const randBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToHex(randBytes);
  const now = Date.now();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000; // 30 days
  if (env.DB) {
    try {
      await env.DB.prepare('INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(token, userId, now, expiresAt).run();
    } catch(e) {}
  }
  return token;
}

async function getAuthenticatedUser(request, env) {
  try {
    const cookieHeader = request.headers.get('Cookie') || '';
    const match = cookieHeader.match(/session_token=([a-f0-9]{64})/);
    let token = match ? match[1] : null;
    if (!token) {
      const authHeader = request.headers.get('Authorization') || '';
      if (authHeader.startsWith('Bearer ')) token = authHeader.substring(7).trim();
    }
    if (!token) return null;

    if (env.DB) {
      const row = await env.DB.prepare(
        'SELECT u.id, u.username, u.role, u.fullname, u.phone, s.expires_at FROM user_sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ?'
      ).bind(token).first();
      if (row && row.expires_at > Date.now()) {
        return {
          id: row.id,
          username: row.username,
          role: row.role,
          fullname: row.fullname || row.username,
          phone: row.phone || ''
        };
      }
    }
  } catch(e) {}
  return null;
}

async function getAdminPassword(env) {
  if (env.KV) {
    try {
      const p = await env.KV.get('config:admin_password');
      if (p) return p;
    } catch(e) {}
  }
  return 'anhkun123';
}

async function makeAdminToken(password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password + ':jkbms-admin-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', keyMaterial, enc.encode('admin-authenticated'));
  return bytesToHex(new Uint8Array(sig));
}

async function verifyAdminAuth(request, env) {
  try {
    const user = await getAuthenticatedUser(request, env);
    if (user && ['admin', 'admin_level_1', 'admin_level_2', 'tech', 'technician', 'superadmin', 'manager'].includes(user.role)) return true;
  } catch(e){}
  try {
    const currentPass = await getAdminPassword(env);
    const expectedToken = await makeAdminToken(currentPass);
    const cookieHeader = request.headers.get('Cookie') || '';
    if (cookieHeader.includes('admin_token=' + expectedToken)) return true;
    const authHeader = request.headers.get('Authorization') || '';
    if (authHeader === 'Bearer ' + expectedToken) return true;
  } catch(e){}
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
    // Hỗ trợ lưu trữ song song 2 bản Firmware: 'ble' và 'rs485'
    if (method === 'POST' && path === '/api/upload-firmware') {
      try {
        const contentType = request.headers.get('Content-Type') || '';
        let binBuffer, version, typeParam;

        typeParam = url.searchParams.get('type') || request.headers.get('X-Firmware-Type') || '';

        if (contentType.includes('multipart/form-data')) {
          const form = await request.formData();
          const file = form.get('firmware');
          version    = form.get('version') || ('v' + Date.now());
          typeParam  = form.get('type') || typeParam;
          binBuffer  = await file.arrayBuffer();
        } else {
          binBuffer = await request.arrayBuffer();
          version   = request.headers.get('X-Firmware-Version') || ('v' + Date.now());
        }

        if (!binBuffer || binBuffer.byteLength < 1000) {
          return jsonResponse({ error: 'Invalid firmware binary (too small)' }, 400, corsHeaders);
        }

        // Tự động phân loại BLE, RS485 hoặc Balancer UART dựa theo tham số hoặc tên version
        let fwType = 'generic';
        const vLower = (version + ' ' + typeParam).toLowerCase();
        if (vLower.includes('rs485') || vLower.includes('modbus')) {
          fwType = 'rs485';
        } else if (vLower.includes('balancer') || vLower.includes('uart') || vLower.includes('bal')) {
          fwType = 'balancer';
        } else if (vLower.includes('ble') || vLower.includes('blue')) {
          fwType = 'ble';
        }

        const meta = { version, type: fwType, size: binBuffer.byteLength, uploadedAt: Date.now() };

        if (fwType === 'rs485') {
          await Promise.all([
            env.DEVICES.put('__latest_firmware_rs485_bin__', binBuffer),
            env.DEVICES.put('__firmware_rs485_meta__', JSON.stringify(meta))
          ]);
        } else if (fwType === 'balancer') {
          await Promise.all([
            env.DEVICES.put('__latest_firmware_balancer_bin__', binBuffer),
            env.DEVICES.put('__firmware_balancer_meta__', JSON.stringify(meta))
          ]);
        } else if (fwType === 'ble') {
          await Promise.all([
            env.DEVICES.put('__latest_firmware_ble_bin__', binBuffer),
            env.DEVICES.put('__firmware_ble_meta__', JSON.stringify(meta)),
            env.DEVICES.put('__latest_firmware_bin__', binBuffer),
            env.DEVICES.put('__firmware_meta__', JSON.stringify(meta))
          ]);
        } else {
          await Promise.all([
            env.DEVICES.put('__latest_firmware_bin__', binBuffer),
            env.DEVICES.put('__firmware_meta__', JSON.stringify(meta))
          ]);
        }
        MEMORY_FIRMWARE_INFO = meta;

        return jsonResponse({ status: 'ok', type: fwType, ...meta }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/firmware-info ─────────────────────────────────
    if (method === 'GET' && path === '/api/firmware-info') {
      try {
        const typeQuery = (url.searchParams.get('type') || request.headers.get('X-Firmware-Type') || '').toLowerCase();
        const isRs485Req = (typeQuery.includes('rs485') || typeQuery.includes('modbus'));

        const isBalReq   = typeQuery.includes('balancer') || typeQuery.includes('uart') || typeQuery.includes('bal');
        const [rawBle, rawRs485, rawBal] = await Promise.all([
          env.DEVICES.get('__firmware_ble_meta__'),
          env.DEVICES.get('__firmware_rs485_meta__'),
          env.DEVICES.get('__firmware_balancer_meta__')
        ]);

        const bleInfo    = rawBle ? JSON.parse(rawBle) : null;
        const rs485Info  = rawRs485 ? JSON.parse(rawRs485) : null;
        const balInfo    = rawBal ? JSON.parse(rawBal) : { version: 'v1.0.4-BALANCER', size: 1048576, type: 'balancer' };

        const targetInfo = isBalReq ? balInfo : (isRs485Req ? (rs485Info || { version: 'none', size: 0 }) : (bleInfo || { version: 'none', size: 0 }));

        return jsonResponse({
          ...targetInfo,
          latest_version: targetInfo.version,
          firmware_url: isBalReq ? `${url.origin}/firmware/balancer.bin` : (isRs485Req ? `${url.origin}/firmware/rs485.bin` : `${url.origin}/firmware/ble.bin`),
          ble: bleInfo ? { ...bleInfo, url: `${url.origin}/firmware/ble.bin` } : null,
          rs485: rs485Info ? { ...rs485Info, url: `${url.origin}/firmware/rs485.bin` } : null,
          balancer: balInfo ? { ...balInfo, url: `${url.origin}/firmware/balancer.bin` } : null
        }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ version: 'none', latest_version: 'none', size: 0, uploadedAt: 0 }, 200, corsHeaders);
      }
    }

    // ── GET & HEAD /firmware/latest.bin & /firmware/rs485.bin & /firmware/ble.bin ──
    if ((method === 'GET' || method === 'HEAD') && (
        path === '/firmware/latest.bin' || path === '/firmware/latest.bin/' ||
        path === '/firmware/rs485.bin'  || path === '/firmware/rs485.bin/' ||
        path === '/firmware/latest-rs485.bin' ||
        path === '/firmware/balancer.bin' || path === '/firmware/balancer.bin/' ||
        path === '/firmware/latest-balancer.bin' ||
        path === '/firmware/ble.bin'    || path === '/firmware/ble.bin/' ||
        path === '/firmware/latest-ble.bin'
    )) {
      try {
        const typeQuery = (url.searchParams.get('type') || request.headers.get('x-firmware-type') || '').toLowerCase();
        const isBalReq = path.includes('balancer') || typeQuery.includes('balancer') || typeQuery.includes('uart') || typeQuery.includes('bal');
        const isRs485Req = !isBalReq && (path.includes('rs485') || typeQuery.includes('rs485') || typeQuery.includes('modbus'));

        let binKey = isBalReq ? '__latest_firmware_balancer_bin__' : (isRs485Req ? '__latest_firmware_rs485_bin__' : '__latest_firmware_ble_bin__');

        let bin = await env.DEVICES.get(binKey, { type: 'arrayBuffer' });
        // Fallback an toàn sang BLE
        if (!bin) {
          bin = await env.DEVICES.get('__latest_firmware_ble_bin__', { type: 'arrayBuffer' });
        }
        if (!bin) {
          bin = await env.DEVICES.get('__latest_firmware_bin__', { type: 'arrayBuffer' });
        }
        if (!bin) return new Response('Firmware not found', { status: 404 });

        if (method === 'HEAD') {
          return new Response(null, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': bin.byteLength.toString(),
              'Content-Disposition': 'attachment; filename="' + (isRs485Req ? 'rs485.bin' : 'ble.bin') + '"',
              ...corsHeaders
            }
          });
        }

        return new Response(bin, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': bin.byteLength.toString(),
            'Content-Disposition': 'attachment; filename="' + (isRs485Req ? 'rs485.bin' : 'ble.bin') + '"',
            ...corsHeaders
          }
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/clear-all-ota ────────────────────────────────
    if (path === '/api/clear-all-ota') {
      try {
        MEMORY_COMMANDS_MAP.clear();
        if (env.DB) {
          await env.DB.prepare("DELETE FROM commands WHERE cmd LIKE '%ota_update%'").run();
        }
        return jsonResponse({ status: 'ok', message: 'Cleared all pending OTA commands' }, 200, corsHeaders);
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

        // Support broadcast to all devices (with auto firmware matching)
        if (device_id === 'all' || device_id === 'all_ble' || device_id === 'all_rs485' || device_id === 'all_balancer') {
          const allDevs = await d1GetAllDevices(env);
          const targetIds = new Set([...MEMORY_DEVICE_INDEX, ...allDevs.map(d => d.device_id).filter(Boolean)]);
          const isBleOnly = (device_id === 'all_ble');
          const isRs485Only = (device_id === 'all_rs485');
          const isBalOnly = (device_id === 'all_balancer');

          for (const tId of targetIds) {
            if (!tId || tId.startsWith('all')) continue;
            const tDev = MEMORY_DEVICE_CACHE.get(tId) || allDevs.find(x => x.device_id === tId);
            const isBal = tDev && ((tDev.conn_type === 'uart_lcd') || (tDev.conn_type === 'balancer') || (tDev.conn_type_num === 3) || (tDev.firmware_version && tDev.firmware_version.includes('BALANCER')));
            const isMod = !isBal && tDev && ((tDev.conn_type === 'modbus') || (tDev.conn_type === 'rs485') || (tDev.conn_type_num === 2) || (tDev.firmware_version && tDev.firmware_version.includes('RS485')));
            const isBle = !isBal && !isMod;

            if (isBalOnly && !isBal) continue;
            if (isBleOnly && !isBle) continue;
            if (isRs485Only && !isMod) continue;
            if (device_id === 'all' && isBal) continue; // Mặc định broadcast all chỉ nạp cho BMS

            const customizedCmdArr = cmdArr.map(c => {
              if (c && c.cmd === 'ota_update') {
                const targetType = isBal ? 'balancer' : (isMod ? 'rs485' : 'ble');
                return {
                  ...c,
                  target_type: targetType,
                  url: 'http://bms.lha.io.vn/api/ota-bin?type=' + targetType,
                  version: isBal ? 'v1.0.4-BALANCER' : (isMod ? 'v2.9.2-RS485' : 'v2.9.0-BLE')
                };
              }
              return c;
            });

            let existing = MEMORY_COMMANDS_MAP.get(tId) || [];
            existing.push(...customizedCmdArr);
            MEMORY_COMMANDS_MAP.set(tId, existing);
            if (env.DEVICES) {
              try { await env.DEVICES.put(`cmd:${tId}`, JSON.stringify(existing)); } catch(e){}
            }
            for (const c of customizedCmdArr) {
              ctx.waitUntil(d1AddCommand(env, tId, c));
            }
          }
          return jsonResponse({ status: 'ok', device_id, targets: Array.from(targetIds) }, 200, corsHeaders);
        }

        let dev = MEMORY_DEVICE_CACHE.get(device_id);
        if (!dev) {
          dev = await d1GetDevice(env, device_id);
        }

        // Tự động gán đúng URL firmware theo loại kết nối khi phát OTA đơn lẻ
        if (cmdArr.some(c => c && c.cmd === 'ota_update')) {
          const isBal = dev && ((dev.conn_type === 'uart_lcd') || (dev.conn_type === 'balancer') || (dev.conn_type_num === 3) || (dev.firmware_version && dev.firmware_version.includes('BALANCER')));
          const isMod = !isBal && dev && ((dev.conn_type === 'modbus') || (dev.conn_type === 'rs485') || (dev.conn_type_num === 2) || (dev.firmware_version && dev.firmware_version.includes('RS485')));
          for (const c of cmdArr) {
            if (c && c.cmd === 'ota_update') {
              if (c.target_type === 'balancer' || (isBal && (!c.target_type || c.target_type === 'auto'))) {
                c.target_type = 'balancer';
                c.url = c.url || 'https://jkbms-cloud.jkbmscloud.workers.dev/firmware/balancer.bin';
                c.version = c.version || 'v1.0.4-BALANCER';
              } else if (c.target_type === 'rs485' || (isMod && (!c.target_type || c.target_type === 'auto'))) {
                c.target_type = 'rs485';
                c.url = c.url || 'https://jkbms-cloud.jkbmscloud.workers.dev/firmware/rs485.bin';
                c.version = c.version || 'v2.9.8-RS485';
              } else {
                c.target_type = 'ble';
                c.url = c.url || 'https://jkbms-cloud.jkbmscloud.workers.dev/firmware/ble.bin';
                c.version = c.version || 'v2.9.7-BLE';
              }
            }
          }
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
              if (numReg === 270) {
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
        if (env.DEVICES) {
          try { await env.DEVICES.put(`cmd:${device_id}`, JSON.stringify(cmdArr)); } catch(e){}
        }
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

      const isBleIncoming = (body.conn_type === 'ble') || (body.conn_type_num === 1) || (body.firmware_version && body.firmware_version.includes('BLE'));
      const isRs485Incoming = (body.conn_type === 'modbus') || (body.conn_type === 'rs485') || (body.conn_type_num === 2) || (body.firmware_version && body.firmware_version.includes('RS485'));

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

      if (isBleIncoming) {
        devObj.conn_type = 'ble';
        devObj.conn_type_num = 1;
        devObj.conn_protocol = 'Bluetooth BLE';
        delete devObj.rs485_pack_count;
        delete devObj.rs485_slave_id;
        delete devObj.active_slave_ids;
        delete devObj.summary;
        if (devObj.packs_summary && devObj.packs_summary.some(p => p.name && p.name.includes('JK-PB (ID'))) {
          delete devObj.packs_summary;
        }
      } else if (isRs485Incoming) {
        devObj.conn_type = 'modbus';
        devObj.conn_type_num = 2;
        devObj.conn_protocol = 'RS485 Modbus RTU';
      }

      // Normalize balance & balance_active:
      const balCur = parseFloat(body.balanceCurrent || body.balance_current || devObj.balanceCurrent || devObj.balance_current || 0);
      devObj.balanceCurrent = balCur;
      devObj.balance_current = balCur;

      if (balCur > 0.01) {
        devObj.balance = true;
        devObj.balance_active = true;
      } else {
        if (body.balance !== undefined) devObj.balance = !!body.balance;
        else if (body.balance_switch !== undefined) devObj.balance = !!body.balance_switch;
        else if (devObj.balance !== undefined) devObj.balance = !!devObj.balance;
        else if (body.balance_active !== undefined) devObj.balance = !!body.balance_active;
        else devObj.balance = false;

        devObj.balance_active = false;
      }
      devObj.balanceActive = devObj.balance_active;
      devObj.balanceStatus = devObj.balance;

      // Cumulative Runtime Normalization
      const inRt = (body.totalRuntimeSec && body.totalRuntimeSec > 0) ? body.totalRuntimeSec : ((body.total_runtime_s && body.total_runtime_s > 0) ? body.total_runtime_s : ((body.total_runtime_sec && body.total_runtime_sec > 0) ? body.total_runtime_sec : 0));
      if (inRt > 0) {
        if (!devObj.totalRuntimeSec || inRt >= devObj.totalRuntimeSec) {
          devObj.totalRuntimeSec = inRt;
        } else {
          devObj.totalRuntimeSec = (devObj.totalRuntimeSec || 0) + 1;
        }
      } else if (devObj.totalRuntimeSec) {
        devObj.totalRuntimeSec = devObj.totalRuntimeSec + 1;
      } else if (body.uptimeSec || devObj.uptimeSec) {
        devObj.totalRuntimeSec = body.uptimeSec || devObj.uptimeSec;
      }
      devObj.total_runtime_s = devObj.totalRuntimeSec;
      devObj.total_runtime_sec = devObj.totalRuntimeSec;

      if (body.connected === true) {
        devObj.lastBmsConnected = nowMs;
      } else if (!devObj.lastBmsConnected && body.voltage && body.voltage > 0) {
        devObj.lastBmsConnected = nowMs;
      }
      // 90s BMS Reconnection Grace Period: Giữ trạng thái connected = true nếu vừa mất kết nối trong 90s
      const timeSinceBms1 = devObj.lastBmsConnected ? (nowMs - devObj.lastBmsConnected) : 999999;
      if (body.connected === false && timeSinceBms1 < 90000 && (devObj.voltage > 0 || (body.voltage && body.voltage > 0))) {
        devObj.connected = true;
        devObj.ble_reconnecting = true;
      }

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

      // Lưu packs_summary (tóm tắt data tất cả pack từ ESP)
      if (body.packs_summary && Array.isArray(body.packs_summary)) {
        devObj.packs_summary = body.packs_summary;
        // Chỉ cập nhật active_pack_idx khi KHÔNG đang trong lock period (sau set-active-pack)
        const packSwitchLocked = devObj._packSwitchLockedUntil && Date.now() < devObj._packSwitchLockedUntil;
        if (!packSwitchLocked && body.active_pack_idx !== undefined) {
          devObj.active_pack_idx = body.active_pack_idx;
        }
        // Auto-sync active_pack_idx with active_bms_mac if available
        if (!packSwitchLocked && devObj.active_bms_mac) {
          const curNorm = devObj.active_bms_mac.toLowerCase().replace(/[:-]/g, '');
          const fIdx = devObj.packs_summary.findIndex(p => (p.mac || '').toLowerCase().replace(/[:-]/g, '') === curNorm);
          if (fIdx >= 0) {
            devObj.active_pack_idx = fIdx;
            devObj.packs_summary.forEach((p, idx) => {
              p.active = (idx === fIdx);
              if (idx === fIdx) {
                p.connected = !!devObj.connected;
                if (devObj.voltage > 0) p.voltage = devObj.voltage;
                if (devObj.soc !== undefined) p.soc = devObj.soc;
              } else if (p.connected && idx !== fIdx) {
                p.connected = false;
              }
            });
          }
        }
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

      // VỆ SINH TUYỆT ĐỐI CÁC LỆNH OTA TRƯỚC KHI TRẢ VỀ CHO THIẾT BỊ:
      // Ngăn chặn 100% việc thiết bị BLE nhận nhầm URL RS485 và ngược lại!
      const devFromCache = MEMORY_DEVICE_CACHE.get(deviceId);
      const isDeviceBle = (body.conn_type === 'ble') || (body.conn_type_num === 1) || (body.firmware_version && body.firmware_version.includes('BLE'));
      const isDeviceRs485 = !isDeviceBle && (
        body.conn_type === 'rs485' || body.conn_type === 'modbus' || body.conn_type_num === 2 ||
        (body.firmware_version && body.firmware_version.includes('RS485')) ||
        (devFromCache && ((devFromCache.conn_type === 'modbus') || (devFromCache.conn_type === 'rs485') || (devFromCache.conn_type_num === 2) || (devFromCache.firmware_version && devFromCache.firmware_version.includes('RS485'))))
      );

      cmdArr = cmdArr.filter(c => {
        if (!c) return false;
        if (c.cmd === 'ota_update') {
          if (c.target_type === 'ble') {
            c.url = c.url || 'https://jkbms-cloud.jkbmscloud.workers.dev/firmware/ble.bin';
            c.version = c.version || 'v2.9.7-BLE';
            return true;
          } else if (c.target_type === 'rs485') {
            c.url = c.url || 'https://jkbms-cloud.jkbmscloud.workers.dev/firmware/rs485.bin';
            c.version = c.version || 'v2.9.8-RS485';
            return true;
          }
          // Tự động phân loại theo phần cứng thực tế đang heartbeat:
          c.url = c.url || ('https://jkbms-cloud.jkbmscloud.workers.dev/firmware/' + (isDeviceRs485 ? 'rs485.bin' : 'ble.bin'));
          c.version = c.version || (isDeviceRs485 ? 'v2.9.8-RS485' : 'v2.9.7-BLE');
        }
        return true;
      });

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

    // ── POST /api/set-active-pack — Cloud chọn pack để stream ────────────────
    if (method === 'POST' && path === '/api/set-active-pack') {
      let body = {};
      try { body = await request.json(); } catch(e){}
      const deviceId = body.device_id;
      const packIdx  = body.idx !== undefined ? parseInt(body.idx) : null;
      const packMac  = body.mac || null;
      if (!deviceId || (packIdx === null && !packMac)) {
        return jsonResponse({ error: 'Missing device_id and idx/mac' }, 400, corsHeaders);
      }
      // Enqueue set_active_pack command → ESP sẽ nhận và chuyển pack
      const cmd = { cmd: 'set_active_pack', idx: packIdx !== null ? packIdx : 0, mac: packMac || '' };
      let existing = MEMORY_COMMANDS_MAP.get(deviceId) || [];
      // Xóa set_active_pack cũ nếu có (chỉ giữ lệnh mới nhất)
      existing = existing.filter(c => c.cmd !== 'set_active_pack');
      existing.push(cmd);
      MEMORY_COMMANDS_MAP.set(deviceId, existing);
      // Cập nhật active_pack_idx và active_bms_name/mac trong RAM cache ngay
      const devObj = MEMORY_DEVICE_CACHE.get(deviceId);
      if (devObj) {
        const lastSwitch = devObj._lastPackSwitchRequestMs || 0;
        const nowMs = Date.now();
        if (nowMs - lastSwitch < 5000) {
          const waitSec = Math.ceil((5000 - (nowMs - lastSwitch)) / 1000);
          return jsonResponse({
            error: `Vui lòng đợi ${waitSec} giây trước khi chuyển pack tiếp theo để bảo vệ kết nối Bluetooth!`,
            cooldown: true,
            retry_after_sec: waitSec
          }, 429, corsHeaders);
        }
        devObj._lastPackSwitchRequestMs = nowMs;
        const newIdx = packIdx !== null ? packIdx : devObj.active_pack_idx;
        devObj.active_pack_idx = newIdx;
        devObj._packSwitchLockedUntil = nowMs + PACK_SWITCH_LOCK_MS; // Lock: ignore heartbeat active_pack_idx
        // Update name/mac from packs_summary so Cloud UI shows correct pack name immediately
        if (devObj.packs_summary && Array.isArray(devObj.packs_summary)) {
          const targetPack = devObj.packs_summary.find(p => p.idx === newIdx);
          if (targetPack) {
            if (targetPack.name) devObj.active_bms_name = targetPack.name;
            if (targetPack.mac) devObj.active_bms_mac = targetPack.mac;
          }
        } else if (packMac) {
          devObj.active_bms_mac = packMac;
        }
        MEMORY_DEVICE_CACHE.set(deviceId, devObj);
      }
      return jsonResponse({ status: 'queued', cmd }, 200, corsHeaders);
    }

    // ── POST /api/delete-pack / /api/remove-pack ─────────────────────────────
    if (method === 'POST' && (path === '/api/delete-pack' || path === '/api/remove-pack')) {
      let body = {};
      try { body = await request.json(); } catch(e){}
      const deviceId = body.device_id;
      let targetIdx  = body.idx !== undefined ? parseInt(body.idx) : -1;
      const packMac  = body.mac || '';
      if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

      const devObj = MEMORY_DEVICE_CACHE.get(deviceId);
      let removed = false;
      if (devObj && devObj.packs_summary && Array.isArray(devObj.packs_summary)) {
        if (targetIdx >= 0 && targetIdx < devObj.packs_summary.length) {
          devObj.packs_summary.splice(targetIdx, 1);
          removed = true;
        } else if (packMac) {
          const norm = packMac.toLowerCase().replace(/[:-]/g, '');
          const fIdx = devObj.packs_summary.findIndex(p => (p.mac || '').toLowerCase().replace(/[:-]/g, '') === norm);
          if (fIdx >= 0) {
            targetIdx = fIdx;
            devObj.packs_summary.splice(fIdx, 1);
            removed = true;
          }
        }
        if (removed) {
          devObj.packs_summary.forEach((p, i) => { p.idx = i; });
          if (devObj.active_pack_idx >= devObj.packs_summary.length) {
            devObj.active_pack_idx = 0;
          }
          if (devObj.packs_summary[devObj.active_pack_idx]) {
            devObj.active_bms_mac = devObj.packs_summary[devObj.active_pack_idx].mac || devObj.active_bms_mac;
            devObj.active_bms_name = devObj.packs_summary[devObj.active_pack_idx].name || devObj.active_bms_name;
          }
          MEMORY_DEVICE_CACHE.set(deviceId, devObj);
        }
      }

      // Enqueue remove_pack command for ESP32
      const cmd = { cmd: 'remove_pack', idx: targetIdx >= 0 ? targetIdx : 255, mac: packMac };
      let existing = MEMORY_COMMANDS_MAP.get(deviceId) || [];
      existing.push(cmd);
      MEMORY_COMMANDS_MAP.set(deviceId, existing);

      return jsonResponse({
        status: 'ok',
        message: 'Đã xóa pack thành công',
        active_pack_idx: devObj ? devObj.active_pack_idx : 0,
        packs_summary: devObj ? devObj.packs_summary : []
      }, 200, corsHeaders);
    }

    // ── POST /api/clear-packs / /api/clear-all-packs ──────────────────────────
    if (method === 'POST' && (path === '/api/clear-packs' || path === '/api/clear-all-packs')) {
      let body = {};
      try { body = await request.json(); } catch(e){}
      const deviceId = body.device_id;
      if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

      const devObj = MEMORY_DEVICE_CACHE.get(deviceId);
      if (devObj) {
        devObj.packs_summary = [];
        devObj.active_pack_idx = 0;
        MEMORY_DEVICE_CACHE.set(deviceId, devObj);
        ctx.waitUntil(d1SaveDevice(env, devObj));
      }

      const cmd = { cmd: 'clear_packs' };
      let existing = MEMORY_COMMANDS_MAP.get(deviceId) || [];
      existing.push(cmd);
      MEMORY_COMMANDS_MAP.set(deviceId, existing);

      return jsonResponse({
        status: 'ok',
        message: 'Đã xóa toàn bộ danh sách pack thành công',
        active_pack_idx: 0,
        packs_summary: []
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

        const isBalancerPayload = (body.conn_type === 'uart_lcd') || (body.conn_type === 'balancer') || (body.conn_type_num === 3) || (body.firmware_version && body.firmware_version.includes('BALANCER')) || (deviceId.startsWith('JKBAL')) || (body.modelName && (body.modelName.includes('Balancer') || body.modelName.includes('B5A24S') || body.modelName.includes('JK_B'))) || (body.model_name && (body.model_name.includes('Balancer') || body.model_name.includes('B5A24S') || body.model_name.includes('JK_B')));
        const isBlePayload = !isBalancerPayload && ((body.conn_type === 'ble') || (body.conn_type_num === 1) || (body.firmware_version && body.firmware_version.includes('BLE')));
        const isRs485Payload = !isBalancerPayload && ((body.conn_type === 'modbus') || (body.conn_type === 'rs485') || (body.conn_type_num === 2) || (body.firmware_version && body.firmware_version.includes('RS485')));

        let finalConnType = 'ble';
        let finalConnNum = 1;
        let finalConnProtocol = 'Bluetooth BLE';

        if (isBalancerPayload) {
          finalConnType = 'uart_lcd';
          finalConnNum = 3;
          finalConnProtocol = 'JK Balancer UART (LCD Port)';
          body.mos_temp = 0;
          body.mosTemp = 0;
          body.temp1 = 0;
          body.temp2 = 0;
          body.tempSensor1 = 0;
          body.tempSensor2 = 0;
          body.charge_mos = true;
          body.discharge_mos = true;
          body.chargeMosOn = true;
          body.dischargeMosOn = true;
          if (body.balanceActive !== undefined) body.balanceActive = body.balanceActive;
          else if (body.balance_active !== undefined) body.balanceActive = body.balance_active;
          else if (body.balance !== undefined) body.balanceActive = body.balance;
          else body.balanceActive = false;
          body.balance_active = body.balanceActive;
          body.balance = body.balanceActive;
          body.balanceStatus = body.balanceActive;
        } else if (isBlePayload) {
          finalConnType = 'ble';
          finalConnNum = 1;
          finalConnProtocol = 'Bluetooth BLE';
        } else if (isRs485Payload) {
          finalConnType = 'modbus';
          finalConnNum = 2;
          finalConnProtocol = 'RS485 Modbus RTU';
        } else {
          const isBalancerExisting = (existing.conn_type === 'uart_lcd') || (existing.conn_type === 'balancer') || (existing.conn_type_num === 3) || (existing.firmware_version && existing.firmware_version.includes('BALANCER'));
          const isModbusExisting = !isBalancerExisting && ((existing.conn_type === 'modbus') || (existing.conn_type === 'rs485') || (existing.conn_type_num === 2) || (existing.firmware_version && existing.firmware_version.includes('RS485')));
          finalConnType = isBalancerExisting ? 'uart_lcd' : (isModbusExisting ? 'modbus' : 'ble');
          finalConnNum = isBalancerExisting ? 3 : (isModbusExisting ? 2 : 1);
          finalConnProtocol = isBalancerExisting ? 'JK Balancer UART (LCD Port)' : (isModbusExisting ? 'RS485 Modbus RTU' : 'Bluetooth BLE');
        }

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
          activationFirmware: existing.activationFirmware || body.firmware_version || 'v2.4.0',
          conn_type: finalConnType,
          conn_type_num: finalConnNum,
          conn_protocol: finalConnProtocol
        };

        if (finalConnType === 'ble') {
          delete updated.rs485_pack_count;
          delete updated.rs485_slave_id;
          delete updated.active_slave_ids;
          delete updated.summary;
          if (updated.packs_summary && updated.packs_summary.some(p => p.name && p.name.includes('JK-PB (ID'))) {
            delete updated.packs_summary;
          }
        }

        // NEVER overwrite valid battery readings with 0/empty when ESP is reconnecting or in standby!
        if ((!body.voltage || body.voltage === 0) && existing.voltage && existing.voltage > 0) {
          updated.voltage = existing.voltage;
          updated.soc = existing.soc;
          updated.current = existing.current;
          updated.power = existing.power;
          updated.capacity_ah = existing.capacity_ah;
          updated.remain_capacity_ah = existing.remain_capacity_ah;
          updated.cycle_count = existing.cycle_count;
          updated.mos_temp = existing.mos_temp;
          updated.temp1 = existing.temp1;
          updated.temp2 = existing.temp2;
          updated.temp4 = existing.temp4;
          updated.temp5 = existing.temp5;
          if (existing.cell_voltages && existing.cell_voltages.length > 0) updated.cell_voltages = existing.cell_voltages;
          if (existing.cells && existing.cells.length > 0) updated.cells = existing.cells;
          if (existing.cell_resistances && existing.cell_resistances.length > 0) updated.cell_resistances = existing.cell_resistances;
          if (existing.min_cell_voltage) updated.min_cell_voltage = existing.min_cell_voltage;
          if (existing.max_cell_voltage) updated.max_cell_voltage = existing.max_cell_voltage;
          if (existing.delta_cell_voltage !== undefined) updated.delta_cell_voltage = existing.delta_cell_voltage;
          if (existing.min_cell_num) updated.min_cell_num = existing.min_cell_num;
          if (existing.max_cell_num) updated.max_cell_num = existing.max_cell_num;
          if (existing.cell_count) updated.cell_count = existing.cell_count;
          // Only preserve name/mac from existing when the new body provides nothing useful
          if (!body.active_bms_name && existing.active_bms_name) updated.active_bms_name = existing.active_bms_name;
          if (!body.active_bms_mac && existing.active_bms_mac) updated.active_bms_mac = existing.active_bms_mac;
        }

        // Preserve BMS Hardware/Software & Serial info if existing has it and body is empty/missing
        if ((!body.serialNumber || body.serialNumber === '—' || body.serialNumber === '') && existing.serialNumber && existing.serialNumber !== '—') {
          updated.serialNumber = existing.serialNumber;
        }
        if ((!body.bmsSerialNumber || body.bmsSerialNumber === '—' || body.bmsSerialNumber === '') && existing.bmsSerialNumber && existing.bmsSerialNumber !== '—') {
          updated.bmsSerialNumber = existing.bmsSerialNumber;
        }
        if ((!body.hwVersionStr || body.hwVersionStr === '—' || body.hwVersionStr === '') && existing.hwVersionStr && existing.hwVersionStr !== '—') {
          updated.hwVersionStr = existing.hwVersionStr;
        }
        if ((!body.bmsHwVersion || body.bmsHwVersion === '—' || body.bmsHwVersion === '') && existing.bmsHwVersion && existing.bmsHwVersion !== '—') {
          updated.bmsHwVersion = existing.bmsHwVersion;
        }
        if ((!body.swVersionStr || body.swVersionStr === '—' || body.swVersionStr === '') && existing.swVersionStr && existing.swVersionStr !== '—') {
          updated.swVersionStr = existing.swVersionStr;
        }
        if ((!body.bmsSwVersion || body.bmsSwVersion === '—' || body.bmsSwVersion === '') && existing.bmsSwVersion && existing.bmsSwVersion !== '—') {
          updated.bmsSwVersion = existing.bmsSwVersion;
        }
        if ((!body.modelName || body.modelName === '—' || body.modelName === '') && existing.modelName && existing.modelName !== '—') {
          updated.modelName = existing.modelName;
        }
        if ((!body.bmsFamilyStr || body.bmsFamilyStr === '') && existing.bmsFamilyStr) {
          updated.bmsFamilyStr = existing.bmsFamilyStr;
        }

        if (body.connected === true) {
          updated.lastBmsConnected = nowMs;
        } else if (existing.lastBmsConnected) {
          updated.lastBmsConnected = existing.lastBmsConnected;
        } else if (updated.voltage && updated.voltage > 0) {
          updated.lastBmsConnected = nowMs;
        }
        // 90s BMS Reconnection Grace Period: Giữ trạng thái connected = true nếu vừa mất kết nối trong 90s
        const timeSinceBms2 = updated.lastBmsConnected ? (nowMs - updated.lastBmsConnected) : 999999;
        if (body.connected === false && timeSinceBms2 < 90000 && updated.voltage > 0) {
          updated.connected = true;
          updated.ble_reconnecting = true;
        }

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
        await d1SaveDevice(env, updated);

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
            history = [{
              t: nowMs,
              time: new Date(nowMs).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }),
              v: parseFloat((body.voltage || 0).toFixed(2)),
              p: Math.round(body.power || 0),
              s: parseInt(body.soc || 0)
            }];
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
        if (!await verifyAdminAuth(request, env)) return jsonResponse({ error: 'Unauthorized. Yêu cầu quyền Quản trị viên!' }, 401, corsHeaders);
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

          // ALWAYS query D1 to sync across all distributed Cloudflare edge isolates in real-time
          let dev = await d1GetDevice(env, watchDevId);
          const cached = MEMORY_DEVICE_CACHE.get(watchDevId);
          if (cached && cached.lastSeen && (!dev || cached.lastSeen > (dev.lastSeen || 0))) {
            dev = cached;
          } else if (dev) {
            MEMORY_DEVICE_CACHE.set(watchDevId, dev);
          }
          if (!dev && env.DEVICES) {
            try {
              const raw = await env.DEVICES.get(`device:${watchDevId}`);
              if (raw) dev = JSON.parse(raw);
            } catch(e){}
          }
          if (dev) {
            dev.online = isOnline(dev);
            dev.lastSeenAgo = dev.lastSeen ? Math.round((Date.now() - dev.lastSeen) / 1000) : null;
            if (!dev.activatedAtStr && dev.registeredAt) {
              dev.activatedAtStr = new Date(dev.registeredAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
            }
            return jsonResponse([dev], 200, { ...corsHeaders, 'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0' });
          }
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

          let dev = await d1GetDevice(env, deviceId);
          const cachedDev = MEMORY_DEVICE_CACHE.get(deviceId);
          if (cachedDev && cachedDev.lastSeen && (!dev || cachedDev.lastSeen > (dev.lastSeen || 0))) {
            dev = cachedDev;
          } else if (dev) {
            MEMORY_DEVICE_CACHE.set(deviceId, dev);
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

          const isBal = (dev.conn_type === 'uart_lcd') || (dev.conn_type === 'balancer') || (dev.conn_type_num === 3) || 
            (dev.firmware_version && dev.firmware_version.includes('BALANCER')) || 
            (dev.device_id && dev.device_id.startsWith('JKBAL')) ||
            (dev.modelName && (dev.modelName.includes('Balancer') || dev.modelName.includes('B5A24S') || dev.modelName.includes('JK_B'))) ||
            (dev.model_name && (dev.model_name.includes('Balancer') || dev.model_name.includes('B5A24S') || dev.model_name.includes('JK_B')));

          if (isBal) {
            return new Response(BALANCER_DEVICE_HTML(dev), {
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
                ...corsHeaders
              }
            });
          }

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

        // ── Web Serial USB Flasher Routes ──
    if (method === 'GET' && (path === '/flash' || path === '/flash/' || path === '/flasher' || path === '/web-flasher')) {
      return new Response(WEB_FLASHER_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders }
      });
    }

    if (method === 'GET' && path === '/manifest-ble.json') {
      return jsonResponse({
        name: 'JK BMS Monitor - Bluetooth BLE',
        version: 'v2.9.0-BLE',
        new_install_prompt_erase: false,
        builds: [
          { chipFamily: 'ESP32-C3', parts: [{ path: '/firmware/factory_ble.bin', offset: 0 }] },
          { chipFamily: 'ESP32', parts: [{ path: '/firmware/factory_ble.bin', offset: 0 }] }
        ]
      }, 200, corsHeaders);
    }

    if (method === 'GET' && path === '/manifest-rs485.json') {
      return jsonResponse({
        name: 'JK BMS Monitor - RS485 Modbus RTU',
        version: 'v2.9.2-RS485',
        new_install_prompt_erase: false,
        builds: [
          { chipFamily: 'ESP32-C3', parts: [{ path: '/firmware/factory_rs485.bin', offset: 0 }] },
          { chipFamily: 'ESP32', parts: [{ path: '/firmware/factory_rs485.bin', offset: 0 }] }
        ]
      }, 200, corsHeaders);
    }

    if (method === 'GET' && path === '/manifest-vf.json') {
      return jsonResponse({
        name: 'Mach Xoa Loi Pin VinFast (ESP32 CYD)',
        version: 'v1.0.0-VF-PIN',
        new_install_prompt_erase: false,
        builds: [
          { chipFamily: 'ESP32', parts: [{ path: '/firmware/factory_vf.bin', offset: 0 }] }
        ]
      }, 200, corsHeaders);
    }
    if (method === 'GET' && path === '/manifest-balancer.json') {
      return jsonResponse({
        name: 'JK Active Balancer - UART LCD TTL',
        version: 'v1.0.0-BALANCER-LCD',
        new_install_prompt_erase: false,
        builds: [
          { chipFamily: 'ESP32-C3', parts: [{ path: '/firmware/factory_balancer.bin', offset: 0 }] },
          { chipFamily: 'ESP32', parts: [{ path: '/firmware/factory_balancer.bin', offset: 0 }] }
        ]
      }, 200, corsHeaders);
    }


    // ── POST /api/admin/reset-password (Reset mật khẩu khách về 123456) ──
    if (method === 'POST' && path === '/api/admin/reset-password') {
      const isAuthed = await verifyAdminAuth(request, env);
      if (!isAuthed) return jsonResponse({ error: 'Unauthorized - Cần quyền Admin' }, 401, corsHeaders);

      try {
        const body = await request.json();
        const userId = body.user_id;
        const targetUsername = (body.username || '').trim();

        let targetUser = null;
        if (userId) {
          targetUser = await env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?').bind(userId).first();
        } else if (targetUsername) {
          targetUser = await env.DB.prepare('SELECT id, username, role FROM users WHERE username = ? COLLATE NOCASE').bind(targetUsername).first();
        }

        if (!targetUser) {
          return jsonResponse({ error: 'Không tìm thấy người dùng này trong hệ thống' }, 404, corsHeaders);
        }

        const newPass = '123456';
        const { hashHex, saltHex } = await hashPassword(newPass);

        await env.DB.prepare(
          'UPDATE users SET password_hash = ?, salt = ? WHERE id = ?'
        ).bind(hashHex, saltHex, targetUser.id).run();

        await env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(targetUser.id).run();

        return jsonResponse({
          status: 'ok',
          message: 'Đã đặt lại mật khẩu cho tài khoản ' + targetUser.username + ' về mặc định: 123456',
          username: targetUser.username,
          default_pass: '123456'
        }, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: 'Lỗi khi đặt lại mật khẩu: ' + e.message }, 500, corsHeaders);
      }
    }

// ── POST /api/auth/register ──
    if (method === 'POST' && path === '/api/auth/register') {
      try {
        const body = await request.json();
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();
        const fullname = (body.fullname || '').trim();
        const rawPhone = (body.phone || '').trim().replace(/\s+/g, '');
        const phone = rawPhone;

        if (!username || username.length < 3 || username.length > 30) {
          return jsonResponse({ error: 'Tên đăng nhập phải từ 3 đến 30 ký tự' }, 400, corsHeaders);
        }
        if (!/^[a-zA-Z0-9_\\-\\.]+$/.test(username)) {
          return jsonResponse({ error: 'Tên đăng nhập chỉ gồm chữ, số, dấu gạch dưới (_) hoặc gạch ngang (-)' }, 400, corsHeaders);
        }
        if (!password || password.length < 6) {
          return jsonResponse({ error: 'Mật khẩu phải có ít nhất 6 ký tự' }, 400, corsHeaders);
        }

        if (!env.DB) return jsonResponse({ error: 'Cơ sở dữ liệu chưa sẵn sàng' }, 500, corsHeaders);

        const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
        if (existing) {
          return jsonResponse({ error: 'Tên đăng nhập này đã được sử dụng. Vui lòng chọn tên khác!' }, 409, corsHeaders);
        }

        const { hashHex, saltHex } = await hashPassword(password);
        const now = Date.now();
        const res = await env.DB.prepare(
          'INSERT INTO users (username, password_hash, salt, role, fullname, phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(username, hashHex, saltHex, 'customer', fullname || username, phone, now).run();

        const newUserId = res.meta ? res.meta.last_row_id : null;
        const sessionToken = await createSession(env, newUserId);

        const headers = new Headers(corsHeaders);
        headers.set('Content-Type', 'application/json');
        headers.append('Set-Cookie', 'session_token=' + sessionToken + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure');

        return new Response(JSON.stringify({
          status: 'ok',
          user: { id: newUserId, username, role: 'customer', fullname: fullname || username },
          redirect: '/my-devices'
        }), { status: 201, headers });
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/auth/login ──
    if (method === 'POST' && path === '/api/auth/login') {
      try {
        const clientIp = request.headers.get('CF-Connecting-IP') || 'client';
        const now = Date.now();
        const attempt = LOGIN_ATTEMPTS.get(clientIp);
        if (attempt && attempt.lockedUntil && attempt.lockedUntil > now) {
          const waitMins = Math.ceil((attempt.lockedUntil - now) / 60000);
          return jsonResponse({ error: 'Quá nhiều lần thử sai. Tạm khóa trong ' + waitMins + ' phút để bảo vệ hệ thống.' }, 429, corsHeaders);
        }

        const body = await request.json();
        const loginInput = (body.username || '').trim();
        const cleanPhoneInput = loginInput.replace(/\s+/g, '');
        const password = (body.password || '').trim();

        if (!loginInput || !password) {
          return jsonResponse({ error: 'Vui lòng nhập tên đăng nhập/số điện thoại và mật khẩu' }, 400, corsHeaders);
        }

        let user = null;
        if (env.DB) {
          user = await env.DB.prepare(
            'SELECT * FROM users WHERE username = ? COLLATE NOCASE OR (phone IS NOT NULL AND phone != "" AND phone = ?) LIMIT 1'
          ).bind(loginInput, cleanPhoneInput).first();
        }

        if (user) {
          const check = await hashPassword(password, user.salt);
          if (check.hashHex === user.password_hash) {
            LOGIN_ATTEMPTS.delete(clientIp);
            const sessionToken = await createSession(env, user.id);
            const legacyAdminToken = (user.role === 'admin') ? await makeAdminToken(await getAdminPassword(env)) : '';

            const headers = new Headers(corsHeaders);
            headers.set('Content-Type', 'application/json');
            headers.append('Set-Cookie', 'session_token=' + sessionToken + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure');
            if (user.role === 'admin') {
              headers.append('Set-Cookie', 'admin_token=' + legacyAdminToken + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure');
            }

            return new Response(JSON.stringify({
              status: 'ok',
              user: {
                id: user.id,
                username: user.username,
                role: user.role,
                fullname: user.fullname || user.username
              },
              redirect: (user.role === 'admin') ? '/admin' : '/my-devices'
            }), { status: 200, headers });
          }
        }

        // Support direct admin password login for convenience
        const currentPass = await getAdminPassword(env);
        if ((loginInput.toLowerCase() === 'admin' || loginInput.toLowerCase() === 'longbui') && (password === currentPass || password === 'anhkun123')) {
          let adminUser = null;
          if (env.DB) adminUser = await env.DB.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").first();
          const uid = adminUser ? adminUser.id : 1;
          const sessionToken = await createSession(env, uid);
          const legacyAdminToken = await makeAdminToken(currentPass);
          const headers = new Headers(corsHeaders);
          headers.set('Content-Type', 'application/json');
          headers.append('Set-Cookie', 'session_token=' + sessionToken + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure');
          headers.append('Set-Cookie', 'admin_token=' + legacyAdminToken + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure');
          return new Response(JSON.stringify({
            status: 'ok',
            user: { id: uid, username: 'longbui', role: 'admin', fullname: 'Long Bùi (Admin)' },
            redirect: '/admin'
          }), { status: 200, headers });
        }

        const curr = LOGIN_ATTEMPTS.get(clientIp) || { count: 0, lockedUntil: 0 };
        curr.count = (curr.count || 0) + 1;
        if (curr.count >= 5) {
          curr.lockedUntil = now + 15 * 60 * 1000;
          LOGIN_ATTEMPTS.set(clientIp, curr);
          return jsonResponse({ error: 'Sai thông tin 5 lần. Tạm khóa 15 phút để bảo vệ tài khoản!' }, 429, corsHeaders);
        }
        LOGIN_ATTEMPTS.set(clientIp, curr);
        return jsonResponse({ error: 'Tài khoản hoặc mật khẩu không chính xác (còn ' + (5 - curr.count) + ' lần thử)' }, 401, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/auth/logout ──
    if (method === 'POST' && path === '/api/auth/logout') {
      const cookieHeader = request.headers.get('Cookie') || '';
      const match = cookieHeader.match(/session_token=([a-f0-9]+)/);
      if (match && env.DB) {
        try {
          await env.DB.prepare('DELETE FROM user_sessions WHERE token = ?').bind(match[1]).run();
        } catch(e) {}
      }
      const headers = new Headers(corsHeaders);
      headers.set('Content-Type', 'application/json');
      headers.append('Set-Cookie', 'session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
      headers.append('Set-Cookie', 'admin_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers });
    }

    // ── GET /api/auth/me ──
    if (method === 'GET' && path === '/api/auth/me') {
      const user = await getAuthenticatedUser(request, env);
      if (user) {
        return jsonResponse({ authenticated: true, user }, 200, corsHeaders);
      }
      return jsonResponse({ authenticated: false, user: null }, 200, corsHeaders);
    }

    // ── GET /api/user/devices (Fetch user's owned devices) ──
    if (method === 'GET' && path === '/api/user/devices') {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return jsonResponse({ error: 'Vui lòng đăng nhập' }, 401, corsHeaders);

      try {
        let devIds = [];
        let customNameMap = new Map();
        if (user.role === 'admin') {
          const allDevs = await d1GetAllDevices(env);
          allDevs.forEach(d => devIds.push(d.device_id));
        } else {
          const links = await env.DB.prepare('SELECT device_id, custom_name FROM user_devices WHERE user_id = ?').bind(user.id).all();
          if (links && links.results) {
            links.results.forEach(l => {
              devIds.push(l.device_id);
              if (l.custom_name) customNameMap.set(l.device_id, l.custom_name);
            });
          }
        }

        const list = [];
        for (const id of devIds) {
          let dev = MEMORY_DEVICE_CACHE.get(id);
          if (!dev && env.DB) dev = await d1GetDevice(env, id);
          if (dev) {
            dev.online = isOnline(dev);
            dev.lastSeenAgo = dev.lastSeen ? Math.round((Date.now() - dev.lastSeen) / 1000) : null;
            if (customNameMap.has(id)) dev.custom_name = customNameMap.get(id);
            list.push(dev);
          } else {
            list.push({ device_id: id, custom_name: customNameMap.get(id) || id, online: false, connected: false, voltage: 0, soc: 0 });
          }
        }
        return jsonResponse(list, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/user/link-device ──
    if (method === 'POST' && path === '/api/user/link-device') {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return jsonResponse({ error: 'Vui lòng đăng nhập' }, 401, corsHeaders);

      try {
        const body = await request.json();
        const deviceId = (body.device_id || '').trim().toUpperCase();
        const customName = (body.custom_name || '').trim();
        const pin = (body.pin || '').trim();

        if (!deviceId) return jsonResponse({ error: 'Vui lòng nhập Device ID (ví dụ: JKBMS-ACCA)' }, 400, corsHeaders);

        // 1-OWNER RULE: Check if device already has an owner
        const existingOwner = await env.DB.prepare('SELECT user_id FROM user_devices WHERE device_id = ? AND permission = "owner" AND user_id != ?').bind(deviceId, user.id).first();
        if (existingOwner && user.role !== 'admin') {
          return jsonResponse({ error: 'Bộ pin này đã được liên kết với một tài khoản khác! Vui lòng liên hệ chủ sở hữu cũ hoặc Quản trị viên để gỡ liên kết trước.' }, 409, corsHeaders);
        }

        let dev = MEMORY_DEVICE_CACHE.get(deviceId);
        if (!dev && env.DB) dev = await d1GetDevice(env, deviceId);

        if (dev && dev.devicePasscode && dev.devicePasscode.length >= 4) {
          if (!pin) {
            return jsonResponse({ error: 'Bộ pin này có cài mã PIN bảo vệ. Vui lòng nhập mã PIN của BMS!' }, 403, corsHeaders);
          }
          if (dev.devicePasscode !== pin) {
            return jsonResponse({ error: 'Mã PIN thiết bị không đúng. Vui lòng nhập chính xác mã PIN bảo vệ của bộ pin!' }, 403, corsHeaders);
          }
        }

        const now = Date.now();
        await env.DB.prepare(
          'INSERT INTO user_devices (user_id, device_id, custom_name, permission, linked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, device_id) DO UPDATE SET custom_name = excluded.custom_name'
        ).bind(user.id, deviceId, customName || deviceId, 'owner', now).run();

        return jsonResponse({ status: 'ok', message: 'Đã liên kết thiết bị ' + deviceId + ' thành công!' }, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/user/claim-device (Nhập mã liên kết từ trang cấu hình WiFi ESP) ──
    if (method === 'POST' && path === '/api/user/claim-device') {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return jsonResponse({ error: 'Vui lòng đăng nhập' }, 401, corsHeaders);

      try {
        const body = await request.json();
        const claimCode = (body.claim_code || '').trim().toUpperCase();
        const customName = (body.custom_name || '').trim();

        if (!claimCode) return jsonResponse({ error: 'Vui lòng nhập mã liên kết từ thiết bị (ví dụ: 8F2A1C)' }, 400, corsHeaders);

        // Find device in memory cache or D1
        let matchedDevId = null;
        for (const [id, dev] of MEMORY_DEVICE_CACHE.entries()) {
          if (dev.claim_code && dev.claim_code.toUpperCase() === claimCode) {
            matchedDevId = id;
            break;
          }
        }

        if (!matchedDevId && env.DB) {
          try {
            const d1Dev = await env.DB.prepare('SELECT device_id FROM devices WHERE json_extract(data, "$.claim_code") = ?').bind(claimCode).first();
            if (d1Dev) matchedDevId = d1Dev.device_id;
          } catch(e) {}
        }

        if (!matchedDevId) {
          return jsonResponse({ error: 'Không tìm thấy thiết bị nào có mã liên kết này! Hãy chắc chắn rằng ESP32 đã kết nối WiFi thành công và phát tín hiệu lên Cloud.' }, 404, corsHeaders);
        }

        matchedDevId = matchedDevId.toUpperCase();

        // 1-OWNER RULE: Check if device already has an owner
        const existingOwner = await env.DB.prepare('SELECT user_id FROM user_devices WHERE device_id = ? AND permission = "owner" AND user_id != ?').bind(matchedDevId, user.id).first();
        if (existingOwner && user.role !== 'admin') {
          return jsonResponse({ error: 'Bộ pin này (' + matchedDevId + ') đã thuộc sở hữu của một tài khoản khác!' }, 409, corsHeaders);
        }

        const now = Date.now();
        await env.DB.prepare(
          'INSERT INTO user_devices (user_id, device_id, custom_name, permission, linked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, device_id) DO UPDATE SET custom_name = excluded.custom_name'
        ).bind(user.id, matchedDevId, customName || matchedDevId, 'owner', now).run();

        return jsonResponse({ status: 'ok', device_id: matchedDevId, message: '🎉 Chúc mừng! Đã liên kết thành công thiết bị ' + matchedDevId + ' vào tài khoản của bạn!' }, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/user/unlink-device ──
    if (method === 'POST' && path === '/api/user/unlink-device') {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return jsonResponse({ error: 'Vui lòng đăng nhập' }, 401, corsHeaders);

      try {
        const body = await request.json();
        const deviceId = (body.device_id || '').trim().toUpperCase();
        if (!deviceId) return jsonResponse({ error: 'Missing device_id' }, 400, corsHeaders);

        if (user.role === 'admin') {
          const targetUserId = body.user_id;
          if (targetUserId) {
            await env.DB.prepare('DELETE FROM user_devices WHERE user_id = ? AND device_id = ?').bind(targetUserId, deviceId).run();
          } else {
            await env.DB.prepare('DELETE FROM user_devices WHERE device_id = ?').bind(deviceId).run();
          }
        } else {
          await env.DB.prepare('DELETE FROM user_devices WHERE user_id = ? AND device_id = ?').bind(user.id, deviceId).run();
        }
        return jsonResponse({ status: 'ok', message: 'Đã hủy liên kết thiết bị' }, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/user/create-bind-token ──
    if (method === 'POST' && path === '/api/user/create-bind-token') {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return jsonResponse({ error: 'Vui lòng đăng nhập' }, 401, corsHeaders);

      try {
        const rand = crypto.getRandomValues(new Uint8Array(4));
        const token = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        const now = Date.now();
        const expiresAt = now + 60 * 60 * 1000; // 1 hour token
        await env.DB.prepare('INSERT INTO bind_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(token, user.id, now, expiresAt).run();
        return jsonResponse({ status: 'ok', token: token, expires_at: expiresAt }, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/device/auto-bind (ESP32 calls this upon connecting to Wi-Fi) ──
    if (method === 'POST' && path === '/api/device/auto-bind') {
      try {
        const body = await request.json();
        const deviceId = (body.device_id || '').trim().toUpperCase();
        const bindToken = (body.bind_token || '').trim().toUpperCase();

        if (!deviceId || !bindToken) return jsonResponse({ error: 'Missing device_id or bind_token' }, 400, corsHeaders);

        const rec = await env.DB.prepare('SELECT user_id, expires_at FROM bind_tokens WHERE token = ?').bind(bindToken).first();
        if (!rec) return jsonResponse({ error: 'Mã liên kết không hợp lệ hoặc đã hết hạn' }, 404, corsHeaders);
        if (rec.expires_at < Date.now()) return jsonResponse({ error: 'Mã liên kết đã hết hạn' }, 410, corsHeaders);

        const now = Date.now();
        await env.DB.prepare(
          'INSERT INTO user_devices (user_id, device_id, custom_name, permission, linked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, device_id) DO NOTHING'
        ).bind(rec.user_id, deviceId, deviceId, 'owner', now).run();

        return jsonResponse({ status: 'ok', message: 'Thiết bị ' + deviceId + ' đã tự động liên kết thành công!' }, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/admin/users (Admin user management) ──
    if (method === 'GET' && path === '/api/admin/users') {
      const isAuthed = await verifyAdminAuth(request, env);
      if (!isAuthed) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

      try {
        const usersRes = await env.DB.prepare(
          'SELECT u.id, u.username, u.role, u.fullname, u.phone, u.created_at, ' +
          'GROUP_CONCAT(ud.device_id || CASE WHEN ud.custom_name IS NOT NULL AND length(ud.custom_name) > 0 THEN " (" || ud.custom_name || ")" ELSE "" END, ", ") as devices_list, ' +
          'COUNT(ud.device_id) as device_count ' +
          'FROM users u ' +
          'LEFT JOIN user_devices ud ON u.id = ud.user_id ' +
          'GROUP BY u.id ' +
          'ORDER BY u.created_at DESC'
        ).all();
        
        let allUds = [];
        try {
          const udRes = await env.DB.prepare('SELECT user_id, device_id, custom_name FROM user_devices').all();
          allUds = udRes.results || [];
        } catch(e) {}

        const list = (usersRes.results || []).map(u => {
          const uDevs = allUds.filter(d => d.user_id === u.id).map(d => ({ device_id: d.device_id, custom_name: d.custom_name || d.device_id }));
          return {
            ...u,
            devices: uDevs
          };
        });

        return jsonResponse(list, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/admin/system-devices ──
    if (method === 'GET' && path === '/api/admin/system-devices') {
      const isAuthed = await verifyAdminAuth(request, env);
      if (!isAuthed) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

      try {
        const now = Date.now();
        const devMap = new Map();

        // 1. From Memory cache
        for (const [id, d] of MEMORY_DEVICE_CACHE.entries()) {
          const isDevOnline = (now - (d.lastSeen || 0) < 60000);
          devMap.set(id.toUpperCase(), {
            device_id: id,
            name: d.active_bms_name || id,
            voltage: d.voltage || 0,
            soc: d.soc || 0,
            online: isDevOnline
          });
        }

        // 2. From D1
        if (env.DB) {
          const d1Devs = await d1GetAllDevices(env);
          for (const d of d1Devs) {
            const uId = (d.device_id || '').toUpperCase();
            if (!devMap.has(uId)) {
              const isDevOnline = (now - (d.lastSeen || 0) < 60000);
              devMap.set(uId, {
                device_id: d.device_id,
                name: d.active_bms_name || d.device_id,
                voltage: d.voltage || 0,
                soc: d.soc || 0,
                online: isDevOnline
              });
            }
          }

          const uDevs = await env.DB.prepare('SELECT device_id, custom_name FROM user_devices').all();
          if (uDevs && uDevs.results) {
            for (const d of uDevs.results) {
              const uId = (d.device_id || '').toUpperCase();
              if (!devMap.has(uId)) {
                devMap.set(uId, {
                  device_id: d.device_id,
                  name: d.custom_name || d.device_id,
                  voltage: 0,
                  soc: 0,
                  online: false
                });
              }
            }
          }
        }

        return jsonResponse(Array.from(devMap.values()), 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/admin/update-user ──
    if (method === 'POST' && path === '/api/admin/update-user') {
      const isAuthed = await verifyAdminAuth(request, env);
      if (!isAuthed) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

      try {
        const body = await request.json();
        const userId = Number(body.user_id);
        if (!userId) return jsonResponse({ error: 'Missing user_id' }, 400, corsHeaders);

        const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
        if (!user) return jsonResponse({ error: 'Không tìm thấy tài khoản người dùng' }, 404, corsHeaders);

        const newRole = body.role;
        const newFullname = (body.fullname !== undefined) ? body.fullname.trim() : user.fullname;
        const newPhone = (body.phone !== undefined) ? body.phone.trim() : user.phone;
        const devicesList = body.devices;

        if (user.username.toLowerCase() === 'longbui' && newRole && newRole !== 'admin') {
          return jsonResponse({ error: 'Không thể hạ quyền tài khoản Quản trị viên gốc (longbui)!' }, 400, corsHeaders);
        }

        let assignedRole = user.role;
        if (newRole && (newRole === 'admin' || newRole === 'customer' || newRole === 'user')) {
          assignedRole = (newRole === 'user') ? 'customer' : newRole;
        }

        await env.DB.prepare(
          'UPDATE users SET role = ?, fullname = ?, phone = ? WHERE id = ?'
        ).bind(assignedRole, newFullname, newPhone, userId).run();

        if (Array.isArray(devicesList)) {
          await env.DB.prepare('DELETE FROM user_devices WHERE user_id = ?').bind(userId).run();
          const now = Date.now();
          for (const item of devicesList) {
            const devId = (typeof item === 'string' ? item : item.device_id || '').trim().toUpperCase();
            const custName = (typeof item === 'object' && item.custom_name) ? item.custom_name.trim() : devId;
            if (devId) {
              await env.DB.prepare(
                'INSERT INTO user_devices (user_id, device_id, custom_name, permission, linked_at) VALUES (?, ?, ?, ?, ?)'
              ).bind(userId, devId, custName || devId, 'owner', now).run();
            }
          }
        }

        return jsonResponse({ status: 'ok', message: 'Cập nhật tài khoản [' + user.username + '] thành công!' }, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/admin/delete-user ──
    if (method === 'POST' && path === '/api/admin/delete-user') {
      const isAuthed = await verifyAdminAuth(request, env);
      if (!isAuthed) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

      try {
        const body = await request.json();
        const userId = Number(body.user_id);
        if (!userId) return jsonResponse({ error: 'Missing user_id' }, 400, corsHeaders);

        const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
        if (!user) return jsonResponse({ error: 'Không tìm thấy tài khoản cần xóa' }, 404, corsHeaders);

        if (user.username.toLowerCase() === 'longbui' || user.username.toLowerCase() === 'admin') {
          return jsonResponse({ error: 'Không thể xóa tài khoản Quản trị viên gốc!' }, 400, corsHeaders);
        }

        const currentAdmin = await getAuthenticatedUser(request, env);
        if (currentAdmin && currentAdmin.id === userId) {
          return jsonResponse({ error: 'Không thể xóa chính tài khoản bạn đang đăng nhập!' }, 400, corsHeaders);
        }

        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
        await env.DB.prepare('DELETE FROM user_devices WHERE user_id = ?').bind(userId).run();
        await env.DB.prepare('DELETE FROM bind_tokens WHERE user_id = ?').bind(userId).run();
        await env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId).run();

        return jsonResponse({ status: 'ok', message: 'Đã xóa vĩnh viễn tài khoản [' + user.username + '] khỏi hệ thống!' }, 200, corsHeaders);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    // ── GET /admin (Admin Management Dashboard for All Devices) ──
        // ── GET / or /login ──
    if (method === 'GET' && (path === '/' || path === '/login')) {
      const user = await getAuthenticatedUser(request, env);
      if (user) {
        if (user.role === 'admin') {
          return Response.redirect(new URL('/admin', request.url).toString(), 302);
        } else {
          return Response.redirect(new URL('/my-devices', request.url).toString(), 302);
        }
      }
      return new Response(UNIFIED_LOGIN_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders }
      });
    }

    // ── GET /my-devices (Customer Portal) ──
    if (method === 'GET' && (path === '/my-devices' || path === '/my-devices/')) {
      const user = await getAuthenticatedUser(request, env);
      if (!user) {
        return Response.redirect(new URL('/login', request.url).toString(), 302);
      }
      return new Response(CUSTOMER_PORTAL_HTML(user), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders }
      });
    }

    if (method === 'GET' && (path === '/admin' || path === '/admin/' || path === '/dashboard')) {
      const isAdmin = await verifyAdminAuth(request, env);
      if (!isAdmin) {
        return Response.redirect(new URL('/login', request.url).toString(), 302);
      }
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
          status: 'ok',
          date: dateKey,
          dayProgress,
          box: {
            ip: '192.168.31.10',
            port: 3001,
            uptime_str: '24/7 Active',
            uptime_sec: 86400,
            node_version: 'v24.18.0',
            memory_mb: 68,
            autoboot: true,
            watchdog: true
          },
          cloud: {
            domain: 'bms.lha.io.vn',
            tunnel: 'Active (24/7)',
            edge: 'Cloudflare HKG',
            ssl: true
          },
          devices: {
            total: MEMORY_DEVICE_CACHE.size || 2,
            online: onlineCount || 2,
            offline: 0,
            d1Rows: deviceCount || 2
          },
          users: {
            total: 3,
            customers: 2
          },
          requests: { today: reqToday, limit: LIMIT_REQUESTS_DAY, pct: Math.round(reqToday / LIMIT_REQUESTS_DAY * 100) },
          kv: { writesToday: estimatedKvWritesToday, limit: LIMIT_KV_WRITES_DAY, pct: Math.round(estimatedKvWritesToday / LIMIT_KV_WRITES_DAY * 100) },
          d1: { rows: deviceCount + bleCount, rowLimit: LIMIT_D1_ROWS, readsToday: estimatedD1ReadsToday, readLimit: LIMIT_D1_READS_DAY, pct: Math.round(estimatedD1ReadsToday / LIMIT_D1_READS_DAY * 100) },
          pendingCommands: commandCount,
          history
        });
      } catch(e) {
        return jsonResponse({ error: e.message }, 500, corsHeaders);
      }
    }

    return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
  }
};

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      ...corsHeaders
    },
  });
}


// ── AUTHENTICATION & CUSTOMER PORTAL HTML TEMPLATES ───────────────────────────
const UNIFIED_LOGIN_HTML = "<!DOCTYPE html>\n<html lang=\"vi\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\">\n<title>Đăng Nhập & Quản Lý - JK BMS Cloud</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap\" rel=\"stylesheet\">\n<style>\n  :root {\n    --bg:#0b0f17;--surface:#151d28;--surface2:#1c2738;--border:#243247;\n    --cyan:#38bdf8;--cyan-dim:rgba(56,189,248,0.15);\n    --green:#22c55e;--green-dim:rgba(34,197,94,0.15);\n    --danger:#f85149;--danger-dim:rgba(248,81,73,0.15);\n    --text:#f8fafc;--subtext:#94a3b8;\n  }\n  *{margin:0;padding:0;box-sizing:border-box;font-family:'Inter',sans-serif;-webkit-tap-highlight-color:transparent;}\n  body{background:radial-gradient(circle at 50% 20%, #172438 0%, #0b0f17 80%);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;}\n  .auth-card{width:100%;max-width:420px;background:rgba(21,29,40,0.85);backdrop-filter:blur(20px);border:1px solid rgba(56,189,248,0.25);border-radius:20px;padding:30px 24px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.7);}\n  .brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:6px;}\n  .logo-box{width:46px;height:46px;background:linear-gradient(135deg,#0284c7,#0369a1);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:1.6rem;box-shadow:0 0 16px rgba(2,132,199,0.5);}\n  .brand-title{font-size:1.35rem;font-weight:800;letter-spacing:-0.5px;color:#fff;}\n  .brand-sub{font-size:0.78rem;color:var(--subtext);text-align:center;margin-bottom:22px;}\n  \n  .tabs{display:flex;background:var(--surface2);border-radius:10px;padding:4px;margin-bottom:20px;border:1px solid var(--border);}\n  .tab-btn{flex:1;padding:9px;border:none;border-radius:8px;background:transparent;color:var(--subtext);font-weight:700;font-size:0.85rem;cursor:pointer;transition:all 0.2s ease;}\n  .tab-btn.active{background:linear-gradient(135deg,#0284c7,#0369a1);color:#fff;box-shadow:0 2px 8px rgba(2,132,199,0.4);}\n  \n  .form-group{margin-bottom:14px;}\n  label{display:block;font-size:0.75rem;color:var(--subtext);margin-bottom:6px;font-weight:600;}\n  .input-wrap{position:relative;display:flex;align-items:center;}\n  input{width:100%;padding:12px 14px;background:#090d14;border:1px solid var(--border);border-radius:10px;color:#fff;font-size:0.95rem;outline:none;transition:border-color 0.2s;}\n  input:focus{border-color:var(--cyan);box-shadow:0 0 0 2px var(--cyan-dim);}\n  .input-wrap input{padding-right:42px;}\n  .btn-eye{position:absolute;right:10px;background:none;border:none;color:#94a3b8;font-size:1.1rem;cursor:pointer;padding:4px;user-select:none;transition:color 0.2s;}\n  .btn-eye:hover{color:#38bdf8;}\n  \n  .btn-submit{width:100%;padding:13px;background:linear-gradient(135deg,#0284c7,#0369a1);border:none;border-radius:10px;color:#fff;font-size:0.95rem;font-weight:700;cursor:pointer;transition:all 0.15s ease;margin-top:8px;}\n  .btn-submit:active{transform:scale(0.98);}\n  \n  .alert-box{padding:10px 14px;border-radius:8px;font-size:0.8rem;margin-bottom:14px;display:none;}\n  .alert-err{background:var(--danger-dim);border:1px solid rgba(248,81,73,0.3);color:var(--danger);}\n  .alert-ok{background:var(--green-dim);border:1px solid rgba(34,197,94,0.3);color:var(--green);}\n  \n  .footer-links{display:flex;justify-content:center;margin-top:20px;padding-top:14px;border-top:1px solid var(--border);font-size:0.75rem;}\n  .footer-links a{color:var(--subtext);text-decoration:none;transition:color 0.2s;}\n  .footer-links a:hover{color:var(--cyan);}\n</style>\n</head>\n<body>\n<div class=\"auth-card\">\n  <div class=\"brand\">\n    <div class=\"logo-box\">⚡</div>\n    <div class=\"brand-title\">JK BMS Cloud</div>\n  </div>\n  <div class=\"brand-sub\">Hệ Thống Giám Sát & Điều Khiển Pin Thông Minh</div>\n\n  <div class=\"tabs\">\n    <button class=\"tab-btn active\" id=\"tab-login\" onclick=\"switchTab('login')\">Đăng Nhập</button>\n    <button class=\"tab-btn\" id=\"tab-register\" onclick=\"switchTab('register')\">Đăng Ký Khách Hàng</button>\n  </div>\n\n  <div id=\"msg-box\" class=\"alert-box\"></div>\n\n  <!-- FORM LOGIN -->\n  <form id=\"form-login\" onsubmit=\"handleLogin(event)\">\n    <div class=\"form-group\">\n      <label>Tên Đăng Nhập / Số Điện Thoại</label>\n      <input type=\"text\" id=\"login-username\" placeholder=\"Nhập tên tài khoản...\" required autofocus autocomplete=\"username\">\n    </div>\n    <div class=\"form-group\">\n      <label>Mật Khẩu</label>\n      <div class=\"input-wrap\">\n        <input type=\"password\" id=\"login-password\" placeholder=\"Nhập mật khẩu...\" required autocomplete=\"current-password\">\n        <button type=\"button\" class=\"btn-eye\" onclick=\"togglePass('login-password', this)\" title=\"Ẩn/hiện mật khẩu\">👁️</button>\n      </div>\n    </div>\n    <button type=\"submit\" class=\"btn-submit\" id=\"btn-login-submit\">Đăng Nhập Ngay</button>\n    <div style=\"font-size:0.72rem;color:var(--subtext);text-align:center;margin-top:12px;\">\n      🛡️ Tài khoản Quản Trị Viên (Admin) đăng nhập tại đây sẽ tự động mở trang Admin.\n    </div>\n  </form>\n\n  <!-- FORM REGISTER -->\n  <form id=\"form-register\" style=\"display:none;\" onsubmit=\"handleRegister(event)\">\n    <div class=\"form-group\">\n      <label>Tên Đăng Nhập (3-30 ký tự, viết liền không dấu)</label>\n      <input type=\"text\" id=\"reg-username\" placeholder=\"Ví dụ: nguyenvana\" required autocomplete=\"username\">\n    </div>\n    <div class=\"form-group\">\n      <label>Họ và Tên (Tùy chọn)</label>\n      <input type=\"text\" id=\"reg-fullname\" placeholder=\"Ví dụ: Nguyễn Văn A\">\n    </div>\n    <div class=\"form-group\">\n      <label>Số Điện Thoại (Tùy chọn, để hỗ trợ kỹ thuật)</label>\n      <input type=\"tel\" id=\"reg-phone\" placeholder=\"Ví dụ: 0912345678\">\n    </div>\n    <div class=\"form-group\">\n      <label>Mật Khẩu (Tối thiểu 6 ký tự)</label>\n      <div class=\"input-wrap\">\n        <input type=\"password\" id=\"reg-password\" placeholder=\"Tạo mật khẩu an toàn...\" required autocomplete=\"new-password\">\n        <button type=\"button\" class=\"btn-eye\" onclick=\"togglePass('reg-password', this)\" title=\"Ẩn/hiện mật khẩu\">👁️</button>\n      </div>\n    </div>\n    <div class=\"form-group\">\n      <label>Nhập Lại Mật Khẩu</label>\n      <div class=\"input-wrap\">\n        <input type=\"password\" id=\"reg-confirm\" placeholder=\"Xác nhận lại mật khẩu...\" required autocomplete=\"new-password\">\n        <button type=\"button\" class=\"btn-eye\" onclick=\"togglePass('reg-confirm', this)\" title=\"Ẩn/hiện mật khẩu\">👁️</button>\n      </div>\n    </div>\n    <button type=\"submit\" class=\"btn-submit\" id=\"btn-reg-submit\" style=\"background:linear-gradient(135deg,#10b981,#059669);\">Tạo Tài Khoản Mới</button>\n  </form>\n\n  <div class=\"footer-links\">\n    <a href=\"javascript:void(0)\" onclick=\"alert('Quý khách vui lòng liên hệ Admin / Kỹ thuật viên (Hotline/Zalo) để được hỗ trợ đặt lại mật khẩu.')\">❓ Quên mật khẩu hoặc cần hỗ trợ?</a>\n  </div>\n</div>\n\n<script>\n  function togglePass(id, btn) {\n    const el = document.getElementById(id);\n    if (!el) return;\n    if (el.type === 'password') {\n      el.type = 'text';\n      btn.textContent = '🙈';\n      btn.style.color = '#38bdf8';\n    } else {\n      el.type = 'password';\n      btn.textContent = '👁️';\n      btn.style.color = '#94a3b8';\n    }\n  }\n\n  function switchTab(mode) {\n    const isLogin = (mode === 'login');\n    document.getElementById('tab-login').className = 'tab-btn ' + (isLogin ? 'active' : '');\n    document.getElementById('tab-register').className = 'tab-btn ' + (!isLogin ? 'active' : '');\n    document.getElementById('form-login').style.display = isLogin ? 'block' : 'none';\n    document.getElementById('form-register').style.display = !isLogin ? 'block' : 'none';\n    hideMsg();\n  }\n\n  function showMsg(text, isErr) {\n    const box = document.getElementById('msg-box');\n    box.className = 'alert-box ' + (isErr ? 'alert-err' : 'alert-ok');\n    box.textContent = (isErr ? '⚠️ ' : '✅ ') + text;\n    box.style.display = 'block';\n  }\n\n  function hideMsg() {\n    document.getElementById('msg-box').style.display = 'none';\n  }\n\n  async function handleLogin(e) {\n    e.preventDefault();\n    hideMsg();\n    const btn = document.getElementById('btn-login-submit');\n    const u = document.getElementById('login-username').value.trim();\n    const p = document.getElementById('login-password').value;\n\n    btn.disabled = true;\n    btn.textContent = 'Đang kiểm tra...';\n\n    try {\n      const res = await fetch('/api/auth/login', {\n        method: 'POST',\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ username: u, password: p })\n      });\n      const data = await res.json();\n      if (res.ok && data.status === 'ok') {\n        showMsg('Đăng nhập thành công! Đang chuyển hướng...', false);\n        setTimeout(() => {\n          window.location.href = data.redirect || '/my-devices';\n        }, 400);\n      } else {\n        showMsg(data.error || 'Tài khoản hoặc mật khẩu không chính xác', true);\n        btn.disabled = false;\n        btn.textContent = 'Đăng Nhập Ngay';\n      }\n    } catch(err) {\n      showMsg('Lỗi kết nối máy chủ!', true);\n      btn.disabled = false;\n      btn.textContent = 'Đăng Nhập Ngay';\n    }\n  }\n\n  async function handleRegister(e) {\n    e.preventDefault();\n    hideMsg();\n    const btn = document.getElementById('btn-reg-submit');\n    const u = document.getElementById('reg-username').value.trim();\n    const fn = document.getElementById('reg-fullname').value.trim();\n    const phone = document.getElementById('reg-phone').value.trim();\n    const p = document.getElementById('reg-password').value;\n    const c = document.getElementById('reg-confirm').value;\n\n    if (p !== c) {\n      showMsg('Mật khẩu nhập lại không khớp!', true);\n      return;\n    }\n    if (p.length < 6) {\n      showMsg('Mật khẩu phải có tối thiểu 6 ký tự!', true);\n      return;\n    }\n\n    btn.disabled = true;\n    btn.textContent = 'Đang tạo tài khoản...';\n\n    try {\n      const res = await fetch('/api/auth/register', {\n        method: 'POST',\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ username: u, fullname: fn, phone: phone, password: p })\n      });\n      const data = await res.json();\n      if (res.ok && data.status === 'ok') {\n        showMsg('Tạo tài khoản thành công! Đang vào hệ thống...', false);\n        setTimeout(() => {\n          window.location.href = data.redirect || '/my-devices';\n        }, 500);\n      } else {\n        showMsg(data.error || 'Không thể tạo tài khoản', true);\n        btn.disabled = false;\n        btn.textContent = 'Tạo Tài Khoản Mới';\n      }\n    } catch(err) {\n      showMsg('Lỗi kết nối máy chủ!', true);\n      btn.disabled = false;\n      btn.textContent = 'Tạo Tài Khoản Mới';\n    }\n  }\n</script>\n</body>\n</html>";


function CUSTOMER_PORTAL_HTML(user) {
  const safeName = (user.fullname || user.username || '').replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Bộ Pin Của Tôi - JK BMS Cloud</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#0b0f17;--surface:#151d28;--surface2:#1c2738;--border:#243247;
    --cyan:#38bdf8;--cyan-dim:rgba(56,189,248,0.15);
    --green:#22c55e;--green-dim:rgba(34,197,94,0.15);
    --warning:#e3b341;--danger:#f85149;--danger-dim:rgba(248,81,73,0.15);
    --text:#f8fafc;--subtext:#94a3b8;
  }
  *{margin:0;padding:0;box-sizing:border-box;font-family:'Inter',sans-serif;-webkit-tap-highlight-color:transparent;}
  body{background:radial-gradient(circle at 50% 10%, #152236 0%, #0b0f17 70%);color:var(--text);min-height:100vh;padding-bottom:50px;}
  
  .navbar{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;background:rgba(21,29,40,0.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;}
  .brand{display:flex;align-items:center;gap:10px;}
  .logo-box{width:38px;height:38px;background:linear-gradient(135deg,#0284c7,#0369a1);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.3rem;box-shadow:0 0 12px rgba(2,132,199,0.5);}
  .brand-title{font-size:1.15rem;font-weight:800;letter-spacing:-0.5px;}
  
  .nav-right{display:flex;align-items:center;gap:10px;}
  .user-badge{background:var(--surface2);border:1px solid var(--border);padding:6px 12px;border-radius:20px;font-size:0.8rem;color:#cbd5e1;display:flex;align-items:center;gap:6px;}
  .btn-add{background:linear-gradient(135deg,#0284c7,#0369a1);color:#fff;border:none;padding:8px 16px;border-radius:10px;font-size:0.82rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;box-shadow:0 2px 8px rgba(2,132,199,0.3);}
  .btn-logout{background:transparent;border:1px solid var(--border);color:var(--subtext);padding:8px 12px;border-radius:10px;font-size:0.8rem;cursor:pointer;}
  
  .container{max-width:1100px;margin:24px auto;padding:0 16px;}
  
  .stats-bar{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px;}
  .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 18px;display:flex;flex-direction:column;gap:4px;}
  .stat-val{font-size:1.6rem;font-weight:800;}
  .stat-lbl{font-size:0.75rem;color:var(--subtext);text-transform:uppercase;letter-spacing:0.5px;}
  
  .devices-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px;}
  .device-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:14px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.5);transition:transform 0.15s ease, border-color 0.15s ease;}
  .device-card:hover{transform:translateY(-2px);border-color:rgba(56,189,248,0.4);}
  
  .card-top{display:flex;justify-content:space-between;align-items:flex-start;}
  .dev-name{font-size:1.1rem;font-weight:700;color:#fff;}
  .dev-id-tag{font-size:0.75rem;color:var(--subtext);font-family:monospace;margin-top:2px;}
  .badge-status{font-size:0.72rem;font-weight:700;padding:4px 10px;border-radius:20px;}
  .badge-online{background:var(--green-dim);color:var(--green);border:1px solid rgba(34,197,94,0.3);}
  .badge-offline{background:var(--danger-dim);color:var(--danger);border:1px solid rgba(248,81,73,0.3);}
  
  .metrics-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;background:var(--surface2);border-radius:12px;padding:12px 10px;text-align:center;}
  .metric-item div:first-child{font-size:1.15rem;font-weight:800;}
  .metric-item div:last-child{font-size:0.68rem;color:var(--subtext);margin-top:2px;}
  
  .switches-row{display:flex;gap:8px;justify-content:space-between;font-size:0.75rem;}
  .sw-badge{padding:3px 8px;border-radius:6px;font-weight:700;font-size:0.7rem;}
  .sw-on{background:var(--green-dim);color:var(--green);}
  .sw-off{background:var(--surface2);color:var(--subtext);}
  
  .card-actions{display:flex;gap:8px;margin-top:auto;}
  .btn-open-dev{flex:1;background:linear-gradient(135deg,#0284c7,#0369a1);color:#fff;border:none;padding:10px;border-radius:10px;font-size:0.85rem;font-weight:700;text-decoration:none;text-align:center;transition:opacity 0.2s;}
  .btn-open-dev:hover{opacity:0.9;}
  .btn-unlink{background:transparent;border:1px solid var(--border);color:var(--danger);padding:10px 14px;border-radius:10px;cursor:pointer;font-size:0.85rem;}
  
  .empty-state{grid-column:1/-1;background:var(--surface);border:1px dashed var(--border);border-radius:20px;padding:50px 20px;text-align:center;}
  .empty-icon{font-size:3rem;margin-bottom:12px;opacity:0.6;}
  
  /* MODAL */
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(8px);z-index:200;align-items:center;justify-content:center;padding:16px;}
  .modal-box{background:var(--surface);border:1px solid var(--border);border-radius:18px;max-width:460px;width:100%;padding:24px;box-shadow:0 25px 50px rgba(0,0,0,0.8);}
  .modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}
  .modal-title{font-size:1.15rem;font-weight:800;}
  .btn-close-modal{background:none;border:none;color:var(--subtext);font-size:1.5rem;cursor:pointer;}
  .modal-tabs{display:flex;gap:8px;background:var(--surface2);padding:4px;border-radius:10px;margin-bottom:16px;}
  .modal-tab-btn{flex:1;padding:8px;border:none;border-radius:6px;background:transparent;color:var(--subtext);font-size:0.8rem;font-weight:700;cursor:pointer;}
  .modal-tab-btn.active{background:var(--cyan-dim);color:var(--cyan);border:1px solid rgba(56,189,248,0.3);}
  
  .form-group{margin-bottom:14px;}
  label{display:block;font-size:0.75rem;color:var(--subtext);margin-bottom:6px;font-weight:600;}
  .input-wrap{position:relative;display:flex;align-items:center;}
  input{width:100%;padding:10px 12px;background:#090d14;border:1px solid var(--border);border-radius:8px;color:#fff;font-size:0.9rem;outline:none;}
  input:focus{border-color:var(--cyan);}
  .input-wrap input{padding-right:42px;}
  .btn-eye{position:absolute;right:10px;background:none;border:none;color:#94a3b8;font-size:1.1rem;cursor:pointer;padding:4px;user-select:none;}
  .btn-submit-modal{width:100%;padding:11px;background:linear-gradient(135deg,#0284c7,#0369a1);border:none;border-radius:8px;color:#fff;font-weight:700;cursor:pointer;margin-top:6px;}
</style>
</head>
<body>
<div class="navbar">
  <div class="brand">
    <div class="logo-box">⚡</div>
    <div>
      <div class="brand-title">JK BMS Cloud</div>
      <div style="font-size:0.7rem;color:var(--subtext);">Cổng Khách Hàng</div>
    </div>
  </div>
  <div class="nav-right">
    <div class="user-badge">
      <span>👤</span>
      <span>${safeName}</span>
    </div>
    <button onclick="openAddModal()" class="btn-add">➕ Thêm Bộ Pin</button>
    <button onclick="logoutUser()" class="btn-logout" title="Đăng Xuất">🚪</button>
  </div>
</div>

<div class="container">
  <div class="stats-bar">
    <div class="stat-card">
      <div class="stat-val" id="stat-total" style="color:var(--cyan);">--</div>
      <div class="stat-lbl">Tổng Số Bộ Pin</div>
    </div>
    <div class="stat-card">
      <div class="stat-val" id="stat-online" style="color:var(--green);">--</div>
      <div class="stat-lbl">Đang Hoạt Động</div>
    </div>
    <div class="stat-card">
      <div class="stat-val" id="stat-offline" style="color:var(--subtext);">--</div>
      <div class="stat-lbl">Ngoại Tuyến</div>
    </div>
  </div>

  <div class="devices-grid" id="my-devices-grid">
    <div class="empty-state">
      <div class="empty-icon">⏳</div>
      <h3 style="font-size:1.1rem;margin-bottom:6px;">Đang tải danh sách thiết bị...</h3>
      <p style="font-size:0.8rem;color:var(--subtext);">Vui lòng chờ trong giây lát.</p>
    </div>
  </div>
</div>

<!-- MODAL THÊM BỘ PIN -->
<div class="modal-overlay" id="add-modal">
  <div class="modal-box">
    <div class="modal-header">
      <div class="modal-title">➕ Liên Kết Bộ Pin Mới</div>
      <button class="btn-close-modal" onclick="closeAddModal()">&times;</button>
    </div>
    <div class="modal-tabs">
      <button class="modal-tab-btn active" id="mtab-claim" onclick="switchModalTab('claim')">🔑 Dán Mã Liên Kết</button>
      <button class="modal-tab-btn" id="mtab-manual" onclick="switchModalTab('manual')">⌨️ Nhập Device ID</button>
    </div>

    <!-- TAB 1: CLAIM CODE (DÁN MÃ TỪ TRANG CẤU HÌNH WIFI ESP) -->
    <div id="mcontent-claim">
      <div style="font-size:0.82rem;color:var(--subtext);line-height:1.5;margin-bottom:14px;">
        Khi cấu hình Wi-Fi cho mạch ESP32 (trang <strong>192.168.4.1</strong>), bạn sẽ thấy ô <strong>"🔑 Mã Liên Kết Tài Khoản"</strong>. Hãy sao chép và dán vào đây:
      </div>
      <form onsubmit="handleClaimDevice(event)">
        <div class="form-group">
          <label>Mã Liên Kết (Gồm 6 ký tự, ví dụ: 8F2A1C)</label>
          <input type="text" id="claim-code-input" placeholder="Dán mã liên kết vào đây..." required style="font-family:monospace;font-size:1.15rem;font-weight:800;letter-spacing:2px;text-transform:uppercase;text-align:center;">
        </div>
        <div class="form-group">
          <label>Đặt Tên Gợi Nhớ (Tùy chọn)</label>
          <input type="text" id="claim-dev-name" placeholder="Ví dụ: Pin Năng Lượng Tầng 2...">
        </div>
        <button type="submit" class="btn-submit-modal" id="btn-claim-submit">🎉 Xác Nhận Liên Kết Ngay</button>
      </form>
    </div>

    <!-- TAB 2: MANUAL BIND (DÀNH CHO ADMIN HOẶC NHẬP ID CŨ) -->
    <div id="mcontent-manual" style="display:none;">
      <form onsubmit="handleManualLink(event)">
        <div class="form-group">
          <label>Mã Device ID (Ví dụ: JKBMS-ACCA)</label>
          <input type="text" id="manual-dev-id" placeholder="Nhập Device ID..." required style="font-family:monospace;text-transform:uppercase;">
        </div>
        <div class="form-group">
          <label>Đặt Tên Gợi Nhớ (Tùy chọn)</label>
          <input type="text" id="manual-dev-name" placeholder="Tên gợi nhớ cho bộ pin...">
        </div>
        <div class="form-group">
          <label>Mã PIN BMS (Nếu có đặt mã bảo vệ PIN)</label>
          <div class="input-wrap">
            <input type="password" id="manual-dev-pin" placeholder="Mã PIN bảo vệ BMS">
            <button type="button" class="btn-eye" onclick="togglePass('manual-dev-pin', this)" title="Ẩn/hiện mã PIN">👁️</button>
          </div>
        </div>
        <button type="submit" class="btn-submit-modal" id="btn-manual-submit">Xác Nhận Thêm Thiết Bị</button>
      </form>
    </div>
  </div>
</div>

<script>
  function togglePass(id, btn) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'password') {
      el.type = 'text';
      btn.textContent = '🙈';
      btn.style.color = '#38bdf8';
    } else {
      el.type = 'password';
      btn.textContent = '👁️';
      btn.style.color = '#94a3b8';
    }
  }

  function openAddModal() {
    document.getElementById('add-modal').style.display = 'flex';
    setTimeout(() => {
      const inp = document.getElementById('claim-code-input');
      if (inp) inp.focus();
    }, 100);
  }
  function closeAddModal() {
    document.getElementById('add-modal').style.display = 'none';
  }

  function switchModalTab(tab) {
    const isClaim = (tab === 'claim');
    document.getElementById('mtab-claim').className = 'modal-tab-btn ' + (isClaim ? 'active' : '');
    document.getElementById('mtab-manual').className = 'modal-tab-btn ' + (!isClaim ? 'active' : '');
    document.getElementById('mcontent-claim').style.display = isClaim ? 'block' : 'none';
    document.getElementById('mcontent-manual').style.display = !isClaim ? 'block' : 'none';
  }

  async function handleClaimDevice(e) {
    e.preventDefault();
    const btn = document.getElementById('btn-claim-submit');
    const code = document.getElementById('claim-code-input').value.trim().toUpperCase();
    const name = document.getElementById('claim-dev-name').value.trim();

    btn.disabled = true;
    btn.textContent = 'Đang kiểm tra mã...';

    try {
      const res = await fetch('/api/user/claim-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim_code: code, custom_name: name })
      });
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        alert(data.message || '🎉 Liên kết thành công!');
        closeAddModal();
        fetchMyDevices();
      } else {
        alert('⚠️ ' + (data.error || 'Mã liên kết không hợp lệ'));
      }
    } catch(err) {
      alert('⚠️ Lỗi kết nối!');
    } finally {
      btn.disabled = false;
      btn.textContent = '🎉 Xác Nhận Liên Kết Ngay';
    }
  }

  async function handleManualLink(e) {
    e.preventDefault();
    const btn = document.getElementById('btn-manual-submit');
    const did = document.getElementById('manual-dev-id').value.trim().toUpperCase();
    const name = document.getElementById('manual-dev-name').value.trim();
    const pin = document.getElementById('manual-dev-pin').value.trim();

    btn.disabled = true;
    btn.textContent = 'Đang liên kết...';

    try {
      const res = await fetch('/api/user/link-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: did, custom_name: name, pin: pin })
      });
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        alert('🎉 ' + data.message);
        closeAddModal();
        fetchMyDevices();
      } else {
        alert('⚠️ ' + (data.error || 'Không thể liên kết thiết bị'));
      }
    } catch(err) {
      alert('⚠️ Lỗi kết nối!');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Xác Nhận Thêm Thiết Bị';
    }
  }

  async function unlinkDevice(did) {
    if (!confirm('Bạn có chắc chắn muốn hủy liên kết bộ pin ' + did + ' khỏi tài khoản?')) return;
    try {
      const res = await fetch('/api/user/unlink-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: did })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        fetchMyDevices();
      } else {
        alert(data.error || 'Lỗi khi hủy liên kết');
      }
    } catch(e) {
      alert('Lỗi kết nối!');
    }
  }

  async function logoutUser() {
    if (!confirm('Bạn có muốn đăng xuất khỏi tài khoản?')) return;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch(e) {}
    window.location.href = '/login';
  }

  async function fetchMyDevices() {
    const grid = document.getElementById('my-devices-grid');
    try {
      const res = await fetch('/api/user/devices');
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        if (grid && grid.querySelector('.empty-icon')?.textContent === '⏳') {
          grid.innerHTML = \`
            <div class="empty-state">
              <div class="empty-icon">⚠️</div>
              <h3 style="font-size:1.15rem;margin-bottom:8px;color:var(--danger);">Không Thể Tải Thiết Bị</h3>
              <p style="font-size:0.85rem;color:var(--subtext);max-width:400px;margin:0 auto 18px;">
                Máy chủ phản hồi lỗi (Mã \${res.status}). Vui lòng thử lại.
              </p>
              <button onclick="fetchMyDevices()" class="btn-add" style="margin:0 auto;">🔄 Thử Lại</button>
            </div>
          \`;
        }
        return;
      }
      const list = await res.json();
      if (!Array.isArray(list)) {
        console.error('Invalid devices response:', list);
        if (grid && grid.querySelector('.empty-icon')?.textContent === '⏳') {
          grid.innerHTML = \`
            <div class="empty-state">
              <div class="empty-icon">⚠️</div>
              <h3 style="font-size:1.15rem;margin-bottom:8px;color:var(--danger);">Dữ Liệu Không Hợp Lệ</h3>
              <p style="font-size:0.85rem;color:var(--subtext);max-width:400px;margin:0 auto 18px;">
                \${(list && list.error) ? list.error : 'Máy chủ gửi dữ liệu không đúng định dạng.'}
              </p>
              <button onclick="fetchMyDevices()" class="btn-add" style="margin:0 auto;">🔄 Thử Lại</button>
            </div>
          \`;
        }
        return;
      }

      let onlineCnt = 0;
      let offlineCnt = 0;
      for (const d of list) {
        if (d.online) onlineCnt++;
        else offlineCnt++;
      }
      document.getElementById('stat-total').textContent = list.length;
      document.getElementById('stat-online').textContent = onlineCnt;
      document.getElementById('stat-offline').textContent = offlineCnt;

      if (list.length === 0) {
        grid.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">📡</div>
            <h3 style="font-size:1.15rem;margin-bottom:8px;">Chưa Có Thiết Bị Nào</h3>
            <p style="font-size:0.85rem;color:var(--subtext);max-width:400px;margin:0 auto 18px;">
              Bạn chưa liên kết bộ pin hoặc mạch cân bằng nào vào tài khoản này.
            </p>
            <button onclick="openAddModal()" class="btn-add" style="margin:0 auto;">➕ Thêm Thiết Bị Ngay</button>
          </div>
        \`;
        return;
      }

      let html = '';
      for (const d of list) {
        const v = (d.voltage || 0).toFixed(1);
        const soc = (d.soc !== undefined && d.soc !== null) ? d.soc : '--';
        const t = (d.mos_temp !== undefined && d.mos_temp !== null) ? (d.mos_temp).toFixed(1) : '--';
        const titleName = d.custom_name || d.device_id;
        const subId = d.device_id;
        const isOnline = d.online;
        const statusTxt = isOnline ? '🟢 Hoạt động' : '🔴 Ngoại tuyến';
        const badgeCls = isOnline ? 'badge-online' : 'badge-offline';

        const isBal = (d.conn_type === 'uart_lcd') || (d.conn_type === 'balancer') || (d.conn_type_num === 3) || (d.firmware_version && d.firmware_version.indexOf('BALANCER') !== -1) || (d.device_id && d.device_id.startsWith('JKBAL'));
        const isMod = !isBal && ((d.conn_type === 'modbus') || (d.conn_type === 'rs485') || (d.conn_type_num === 2) || (d.firmware_version && d.firmware_version.indexOf('RS485') !== -1) || (d.active_bms_mac && String(d.active_bms_mac).startsWith('RS485')));

        const typeBadge = isBal 
          ? '<span style="background:rgba(16,185,129,0.18);color:#10b981;border:1px solid rgba(16,185,129,0.45);font-size:0.65rem;padding:2px 7px;border-radius:4px;font-weight:800;letter-spacing:0.5px;margin-left:6px;vertical-align:middle;">⚡ CÂN BẰNG JK</span>'
          : (isMod 
            ? '<span style="background:rgba(245,158,11,0.18);color:#f59e0b;border:1px solid rgba(245,158,11,0.45);font-size:0.65rem;padding:2px 7px;border-radius:4px;font-weight:800;letter-spacing:0.5px;margin-left:6px;vertical-align:middle;">🟠 MODBUS</span>'
            : '<span style="background:rgba(56,189,248,0.18);color:#38bdf8;border:1px solid rgba(56,189,248,0.45);font-size:0.65rem;padding:2px 7px;border-radius:4px;font-weight:800;letter-spacing:0.5px;margin-left:6px;vertical-align:middle;">🔵 BLUETOOTH</span>');

        const chgOn = d.charge_mos || d.chargeMosOn;
        const dsgOn = d.discharge_mos || d.dischargeMosOn;
        const balOn = d.balance || d.balanceActive;

        let metricsHtml = '';
        let switchesHtml = '';

        if (isBal) {
          const deltaV = (d.delta_cell_voltage !== undefined && d.delta_cell_voltage !== null) ? Number(d.delta_cell_voltage).toFixed(3) : ((d.cell_diff_v !== undefined && d.cell_diff_v !== null) ? Number(d.cell_diff_v).toFixed(3) : '0.000');
          const balCur = (d.balance_current !== undefined && d.balance_current !== null) ? Number(d.balance_current).toFixed(2) : '0.00';
          metricsHtml = \`
            <div class="metrics-row">
              <div class="metric-item">
                <div style="color:var(--cyan);">\${v} V</div>
                <div>Điện Áp Tổng</div>
              </div>
              <div class="metric-item">
                <div style="color:\${parseFloat(deltaV) > 0.030 ? 'var(--warning)' : 'var(--green)'};">\${deltaV} V</div>
                <div>Lệch Cell (ΔV)</div>
              </div>
              <div class="metric-item">
                <div style="color:var(--warning);">\${balCur} A</div>
                <div>Dòng Cân Bằng</div>
              </div>
            </div>
          \`;
          switchesHtml = \`
            <div class="switches-row">
              <div>Cân Bằng: <span class="sw-badge \${balOn ? 'sw-on' : 'sw-off'}">\${balOn ? 'BẬT' : 'TẮT'}</span></div>
              <div>Số Cell: <span style="font-weight:700;color:var(--cyan);">\${d.cell_count || 24}S</span></div>
              <div>Cổng: <span style="font-weight:700;color:#10b981;">UART-LCD</span></div>
            </div>
          \`;
        } else {
          metricsHtml = \`
            <div class="metrics-row">
              <div class="metric-item">
                <div style="color:var(--cyan);">\${v} V</div>
                <div>Điện Áp</div>
              </div>
              <div class="metric-item">
                <div style="color:var(--green);">\${soc} %</div>
                <div>SoC Pin</div>
              </div>
              <div class="metric-item">
                <div style="color:var(--warning);">\${t} °C</div>
                <div>Nhiệt Độ MOS</div>
              </div>
            </div>
          \`;
          switchesHtml = \`
            <div class="switches-row">
              <div>Sạc: <span class="sw-badge \${chgOn ? 'sw-on' : 'sw-off'}">\${chgOn ? 'BẬT' : 'TẮT'}</span></div>
              <div>Xả: <span class="sw-badge \${dsgOn ? 'sw-on' : 'sw-off'}">\${dsgOn ? 'BẬT' : 'TẮT'}</span></div>
              <div>Cân Bằng: <span class="sw-badge \${balOn ? 'sw-on' : 'sw-off'}">\${balOn ? 'BẬT' : 'TẮT'}</span></div>
            </div>
          \`;
        }

        html += \`
          <div class="device-card" style="border-left: 4px solid \${isBal ? '#10b981' : (isMod ? '#f59e0b' : '#38bdf8')};">
            <div class="card-top">
              <div>
                <div class="dev-name" style="display:flex;align-items:center;">\${titleName} \${typeBadge}</div>
                <div class="dev-id-tag">Mã ID: \${subId}</div>
              </div>
              <div class="badge-status \${badgeCls}">\${statusTxt}</div>
            </div>

            \${metricsHtml}
            \${switchesHtml}

            <div class="card-actions">
              <a href="/d/\${d.device_id}" class="btn-open-dev">🚀 Vào Điều Khiển & Cài Đặt</a>
              <button onclick="unlinkDevice('\${d.device_id}')" class="btn-unlink" title="Hủy liên kết">🗑️</button>
            </div>
          </div>
        \`;
      }
      grid.innerHTML = html;
    } catch(e) {
      console.warn('Error fetching devices:', e);
      if (grid && grid.querySelector('.empty-icon')?.textContent === '⏳') {
        grid.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">⚠️</div>
            <h3 style="font-size:1.15rem;margin-bottom:8px;color:var(--danger);">Mất Kết Nối Máy Chủ</h3>
            <p style="font-size:0.85rem;color:var(--subtext);max-width:400px;margin:0 auto 18px;">
              Không thể kết nối đến máy chủ Cloud. Vui lòng kiểm tra lại kết nối mạng.
            </p>
            <button onclick="fetchMyDevices()" class="btn-add" style="margin:0 auto;">🔄 Thử Lại</button>
          </div>
        \`;
      }
    }
  }

  fetchMyDevices();
  setInterval(fetchMyDevices, 4000);
</script>
</body>
</html>`;
}


const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
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
  html{background:var(--bg);-webkit-text-size-adjust:100%;text-size-adjust:100%;overflow-x:hidden;}
  body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:calc(16px + env(safe-area-inset-top, 0px)) 12px calc(24px + env(safe-area-inset-bottom, 0px));overflow-x:hidden;max-width:100vw;}
  .container{max-width:1100px;margin:0 auto;width:100%;overflow-x:hidden;}
  header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:10px;}
  .logo-area{display:flex;align-items:center;gap:10px;min-width:0;}
  .logo-icon{width:36px;height:36px;background:linear-gradient(135deg,#238636,#2ea043);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0;}
  h1{font-size:1.2rem;font-weight:700;letter-spacing:-0.02em;line-height:1.2;}
  .sub{font-size:0.75rem;color:var(--subtext);}
  .stats-bar{display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:8px;margin-bottom:20px;}
  .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 8px;display:flex;flex-direction:column;min-width:0;text-align:center;}
  .stat-val{font-size:1.4rem;font-weight:700;margin-top:2px;}
  .stat-val.green{color:var(--primary);}
  .stat-val.red{color:var(--danger);}
  .stat-val.blue{color:var(--accent);}
  .stat-label{font-size:0.68rem;color:var(--subtext);text-transform:uppercase;letter-spacing:0.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .device-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%, 320px),1fr));gap:14px;}
  .device-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;transition:all 0.2s;min-width:0;overflow:hidden;}
  .device-card.online{border-left:4px solid var(--primary);}
  .device-card.offline{border-left:4px solid var(--danger);opacity:0.75;}
  .card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:8px;}
  .device-name{font-size:0.98rem;font-weight:700;word-break:break-word;}
  .device-sub{font-size:0.72rem;color:var(--subtext);font-family:monospace;word-break:break-all;}
  .badge{font-size:0.7rem;padding:2px 7px;border-radius:20px;font-weight:600;display:inline-flex;align-items:center;gap:4px;flex-shrink:0;}
  .badge-online{background:var(--primary-dim);color:var(--primary);}
  .badge-offline{background:var(--danger-dim);color:var(--danger);}
  .metrics{display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:6px;margin-bottom:12px;background:var(--surface2);padding:8px;border-radius:8px;}
  .metric{text-align:center;min-width:0;overflow:hidden;}
  .metric-val{font-size:0.95rem;font-weight:700;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .metric-val.green{color:var(--primary);}
  .metric-val.warning{color:var(--warning);}
  .metric-val.blue{color:var(--accent);}
  .metric-label{font-size:0.62rem;color:var(--subtext);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .device-info{display:flex;flex-direction:column;gap:5px;font-size:0.76rem;margin-bottom:12px;}
  .info-row{display:flex;justify-content:space-between;gap:8px;min-width:0;}
  .info-key{color:var(--subtext);flex-shrink:0;}
  .info-val{font-family:monospace;text-align:right;word-break:break-word;min-width:0;}
  .last-seen{font-size:0.7rem;color:var(--subtext);margin-top:8px;text-align:right;}
  .no-devices{grid-column:1/-1;text-align:center;padding:48px 16px;background:var(--surface);border-radius:12px;color:var(--subtext);}
  .no-devices .icon{font-size:2.5rem;margin-bottom:10px;}
  .pulse{width:6px;height:6px;border-radius:50%;background:var(--primary);display:inline-block;animation:pulse 1.5s infinite;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.3;}}
  .desktop-only-flasher { display: inline-flex !important; }
  @media (max-width: 900px) { .desktop-only-flasher { display: none !important; } }
  @media (max-width: 600px) {
    .stats-bar{grid-template-columns:repeat(3, minmax(0, 1fr));gap:6px;}
    .stat-card{padding:8px 4px;}
    .stat-val{font-size:1.15rem;}
    .device-grid{grid-template-columns:1fr;gap:12px;}
    .device-card{padding:12px;}
  }
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
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <a href="/flash" target="_blank" class="desktop-only-flasher" style="align-items:center;gap:6px;background:rgba(56,189,248,0.15);border:1px solid #38bdf8;color:#38bdf8;padding:7px 14px;border-radius:8px;font-size:0.82rem;font-weight:700;text-decoration:none;transition:0.2s;">⚡ Nạp Firmware Web Flasher (PC)</a>
      <a href="/my-devices" target="_blank" style="display:inline-flex;align-items:center;gap:6px;background:rgba(34,197,94,0.15);border:1px solid #22c55e;color:#22c55e;padding:7px 12px;border-radius:8px;font-size:0.82rem;font-weight:700;text-decoration:none;">📱 Cổng Khách</a>
      <button type="button" onclick="toggleUsersModal()" style="display:inline-flex;align-items:center;gap:5px;background:rgba(168,85,247,0.15);border:1px solid #a855f7;color:#c084fc;padding:7px 12px;border-radius:8px;font-size:0.82rem;font-weight:700;cursor:pointer;">👥 Quản Lý Khách</button>
      <button type="button" onclick="changeAdminPassword()" style="display:inline-flex;align-items:center;gap:5px;background:rgba(227,179,65,0.15);border:1px solid #e3b341;color:#e3b341;padding:7px 12px;border-radius:8px;font-size:0.82rem;font-weight:700;cursor:pointer;transition:0.2s;" title="Đổi mật khẩu bảo vệ Admin">🔒 Đổi MK</button>
      <button type="button" onclick="logoutAdmin()" style="display:inline-flex;align-items:center;gap:5px;background:rgba(248,81,73,0.15);border:1px solid #f85149;color:#f85149;padding:7px 12px;border-radius:8px;font-size:0.82rem;font-weight:700;cursor:pointer;transition:0.2s;" title="Đăng xuất quản trị">🚪 Đăng Xuất</button>
      <div style="font-size:0.78rem;color:var(--subtext);" id="refresh-label">Cập nhật tự động</div>
    </div>
  </header>

  <div class="stats-bar">
    <div class="stat-card"><span class="stat-label">Tổng số thiết bị</span><span class="stat-val blue" id="stat-total">0</span></div>
    <div class="stat-card"><span class="stat-label">Trực tuyến (Online)</span><span class="stat-val green" id="stat-online">0</span></div>
    <div class="stat-card"><span class="stat-label">Ngoại tuyến (Offline)</span><span class="stat-val red" id="stat-offline">0</span></div>
  </div>

  <!-- CLOUD & TV BOX LIVE STATUS PANEL -->
  <div id="usage-panel" style="background:var(--surface);border:1px solid rgba(56,189,248,0.3);border-radius:12px;padding:16px 18px;margin-bottom:18px;box-shadow:0 4px 20px rgba(0,0,0,0.25);">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px;">
      <div style="font-weight:700;font-size:1rem;color:#38bdf8;display:flex;align-items:center;gap:8px;">
        <span style="font-size:1.2rem;">🖥️</span>
        <span>TRẠNG THÁI HỆ THỐNG TV BOX & CLOUDFLARE CLOUD</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span id="box-tunnel-pill" style="display:inline-flex;align-items:center;gap:6px;font-size:0.75rem;font-weight:700;padding:4px 10px;border-radius:20px;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.4);color:#22c55e;">
          <span style="width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;display:inline-block;"></span>
          Tunnel: ACTIVE 24/7
        </span>
        <div id="usage-date" style="font-size:0.75rem;color:var(--subtext);font-family:monospace;background:var(--surface2);padding:4px 10px;border-radius:6px;border:1px solid var(--border);">
          Đang cập nhật...
        </div>
      </div>
    </div>

    <!-- 4 Information Cards Grid -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-bottom:14px;">
      
      <!-- Card 1: TV Box Local -->
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:0.8rem;color:var(--subtext);font-weight:600;">📺 TV BOX SERVER</span>
          <span id="box-status-badge" style="font-size:0.68rem;font-weight:700;color:#22c55e;background:rgba(34,197,94,0.1);padding:2px 6px;border-radius:4px;">ONLINE</span>
        </div>
        <div style="font-size:1.15rem;font-weight:700;color:#fff;font-family:monospace;" id="box-ip-display">192.168.31.10:3001</div>
        <div style="font-size:0.72rem;color:var(--subtext);margin-top:4px;display:flex;justify-content:space-between;">
          <span>Uptime: <strong id="box-uptime-val" style="color:#38bdf8;">—</strong></span>
          <span>RAM: <strong id="box-ram-val" style="color:#22c55e;">—</strong></span>
        </div>
      </div>

      <!-- Card 2: Cloudflare Cloud -->
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:0.8rem;color:var(--subtext);font-weight:600;">☁️ CLOUDFLARE CLOUD</span>
          <span style="font-size:0.68rem;font-weight:700;color:#38bdf8;background:rgba(56,189,248,0.1);padding:2px 6px;border-radius:4px;">SSL SECURE</span>
        </div>
        <div style="font-size:1.15rem;font-weight:700;color:#38bdf8;font-family:monospace;word-break:break-all;">bms.lha.io.vn</div>
        <div style="font-size:0.72rem;color:var(--subtext);margin-top:4px;display:flex;justify-content:space-between;">
          <span>Trạm: <strong style="color:#f59e0b;">Cloudflare HKG</strong></span>
          <span>Tunnel: <strong style="color:#22c55e;">Không Giới Hạn</strong></span>
        </div>
      </div>

      <!-- Card 3: Devices Overview -->
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:0.8rem;color:var(--subtext);font-weight:600;">🔋 BỘ PIN & MẠCH BMS</span>
          <span id="devices-ratio-badge" style="font-size:0.68rem;font-weight:700;color:#22c55e;background:rgba(34,197,94,0.1);padding:2px 6px;border-radius:4px;">100% ONLINE</span>
        </div>
        <div style="display:align-items:baseline;gap:8px;">
          <span id="devices-online-num" style="font-size:1.4rem;font-weight:800;color:#22c55e;">2</span>
          <span style="font-size:0.82rem;color:var(--subtext);">đang hoạt động / <strong id="devices-total-num">2</strong> tổng số</span>
        </div>
        <div style="font-size:0.72rem;color:var(--subtext);margin-top:4px;">
          Độ trễ truyền nhận: <strong style="color:#38bdf8;">Realtime 600ms</strong>
        </div>
      </div>

      <!-- Card 4: System & Auto-Boot -->
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:0.8rem;color:var(--subtext);font-weight:600;">⚡ AUTO-BOOT & ĐỒNG BỘ</span>
          <span style="font-size:0.68rem;font-weight:700;color:#a855f7;background:rgba(168,85,247,0.1);padding:2px 6px;border-radius:4px;">TỰ ĐỘNG 24/7</span>
        </div>
        <div style="font-size:0.78rem;color:#e2e8f0;margin-top:3px;line-height:1.4;">
          • Tự chạy khi bật nguồn: <strong style="color:#22c55e;">BẬT (start-bms.sh)</strong><br>
          • Tự nhận code mới PC: <strong style="color:#22c55e;">BẬT (Watchdog 15s)</strong>
        </div>
      </div>

    </div>

    <!-- Quick Actions / Live Indicators Footer -->
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;padding-top:10px;border-top:1px solid var(--border);">
      <div style="font-size:0.75rem;color:var(--subtext);display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <span>🛡️ Quản lý: <strong id="box-users-txt" style="color:#fff;">3 tài khoản</strong></span>
        <span>•</span>
        <span>📦 Phiên bản: <strong id="box-node-txt" style="color:#38bdf8;">Node v24.18.0</strong></span>
        <span>•</span>
        <span>📡 Kênh dữ liệu: <strong style="color:#22c55e;">Local + Cloud Tunnel Dual-Mode</strong></span>
      </div>
      <div style="display:flex;gap:8px;">
        <button onclick="triggerQuickSync()" style="background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.4);color:#38bdf8;padding:5px 12px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
          🔄 Đồng Bộ Code Mới
        </button>
        <button onclick="triggerTunnelRestart()" style="background:rgba(168,85,247,0.15);border:1px solid rgba(168,85,247,0.4);color:#c084fc;padding:5px 12px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
          ⚡ Khởi Chạy Lại Tunnel
        </button>
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

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <div style="display:flex;flex-direction:column;gap:3px;flex:1.2;min-width:210px;">
          <span style="font-size:0.72rem;color:var(--subtext);font-weight:600;">1. Chọn Mục Tiêu Nạp:</span>
          <select id="ota-target-select" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:9px 12px;border-radius:8px;font-size:0.82rem;font-family:monospace;outline:none;">
            <option value="all">⚡ Tất cả thiết bị BMS (Broadcast All)</option>
            <option value="all_ble">📡 Tất cả thiết bị Bluetooth BLE</option>
            <option value="all_rs485">🔌 Tất cả thiết bị RS485 Modbus</option>
            <option value="all_balancer">⚡ Tất cả mạch Cân Bằng Balancer UART</option>
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:180px;">
          <span style="font-size:0.72rem;color:var(--subtext);font-weight:600;">2. Chọn Bản Firmware Nạp:</span>
          <select id="ota-fw-type-select" style="background:var(--surface2);border:1px solid #38bdf8;color:var(--text);padding:9px 12px;border-radius:8px;font-size:0.82rem;font-family:monospace;outline:none;font-weight:700;">
            <option value="auto">⚡ Tự Động (Theo loại máy)</option>
            <option value="ble">📡 Firmware BLE (v2.9.0-BLE)</option>
            <option value="rs485">🔌 Firmware RS485 (v2.9.2-RS485)</option>
            <option value="balancer">⚡ Firmware Balancer UART (v1.0.4-BALANCER)</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-end;padding-top:16px;">
          <button onclick="triggerOtaUpdate()" id="btn-trigger-ota" style="background:linear-gradient(135deg,#38bdf8,#0284c7);color:#070d14;border:none;padding:10px 16px;border-radius:8px;font-size:0.8rem;font-weight:800;cursor:pointer;white-space:nowrap;box-shadow:0 2px 8px rgba(56,189,248,0.3);">
            ⚡ Phát Lệnh Nạp OTA
          </button>
          <button onclick="clearAllPendingOta()" style="background:rgba(248,81,73,0.15);border:1px solid #f85149;color:#f85149;padding:10px 14px;border-radius:8px;font-size:0.8rem;font-weight:700;cursor:pointer;white-space:nowrap;">
            🧹 Hủy Lệnh Treo
          </button>
        </div>
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
      if (data) {
        let parts = [];
        if (data.ble && data.ble.version && data.ble.version !== 'none') {
          parts.push('📡 BLE: <b>' + data.ble.version + '</b> (' + (data.ble.size/1024).toFixed(0) + 'KB)');
        }
        if (data.rs485 && data.rs485.version && data.rs485.version !== 'none') {
          parts.push('🔌 RS485: <b>' + data.rs485.version + '</b> (' + (data.rs485.size/1024).toFixed(0) + 'KB)');
        }
        if (data.balancer && data.balancer.version && data.balancer.version !== 'none') {
          parts.push('⚡ BALANCER: <b>' + data.balancer.version + '</b> (' + (data.balancer.size/1024).toFixed(0) + 'KB)');
        }
        if (parts.length > 0) {
          badge.innerHTML = parts.join(' | ');
          badge.style.color = '#3fb950';
        } else if (data.version && data.version !== 'none') {
          badge.innerHTML = '📦 Cloud FW: <b>' + data.version + '</b> (' + (data.size / 1024).toFixed(0) + ' KB)';
          badge.style.color = '#3fb950';
        } else {
          badge.textContent = '📦 Chưa có Firmware trên Cloud';
          badge.style.color = '#8b949e';
        }
        const optBle = document.querySelector('#ota-fw-type-select option[value="ble"]');
        if (optBle && data.ble && data.ble.version && data.ble.version !== 'none') {
          optBle.textContent = '📡 Firmware BLE (' + data.ble.version + ')';
        }
        const optRs = document.querySelector('#ota-fw-type-select option[value="rs485"]');
        if (optRs && data.rs485 && data.rs485.version && data.rs485.version !== 'none') {
          optRs.textContent = '🔌 Firmware RS485 (' + data.rs485.version + ')';
        }
        const optBal = document.querySelector('#ota-fw-type-select option[value="balancer"]');
        if (optBal && data.balancer && data.balancer.version && data.balancer.version !== 'none') {
          optBal.textContent = '⚡ Firmware Balancer UART (' + data.balancer.version + ')';
        }
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
      const fname = (selectedFwFile.name || '').toLowerCase();
      let typeParam = '';
      if (fname.includes('balancer') || fname.includes('uart') || fname.includes('bal')) typeParam = 'balancer';
      else if (fname.includes('rs485') || fname.includes('modbus')) typeParam = 'rs485';
      else if (fname.includes('ble') || fname.includes('blue')) typeParam = 'ble';

      const uploadUrl = '/api/upload-firmware' + (typeParam ? ('?type=' + typeParam) : '');
      const defVer = (typeParam === 'balancer' ? 'v1.0.4-BALANCER' : (typeParam === 'rs485' ? 'v2.9.2-RS485' : (typeParam === 'ble' ? 'v2.9.0-BLE' : ('v' + Date.now()))));
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Firmware-Version': defVer,
          'X-Firmware-Type': typeParam
        },
        body: selectedFwFile
      });
      const data = await res.json();
      if (data.status === 'ok') {
        msg.style.background = 'rgba(63,185,80,0.15)';
        msg.style.color = '#3fb950';
        msg.textContent = '✅ Đã tải lên Cloud thành công [' + (data.type || 'FW') + ']! Version: ' + data.version + ' (' + (data.size/1024).toFixed(0) + ' KB)';
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
    const fwType = document.getElementById('ota-fw-type-select').value;
    const msg = document.getElementById('ota-status-msg');

    let fwLabel = (fwType === 'balancer') ? 'Mạch Cân Bằng Balancer UART' : ((fwType === 'rs485') ? 'RS485 Modbus' : ((fwType === 'ble') ? 'Bluetooth (BLE)' : 'Tự Động'));
    let targetLabel = (target === 'all_ble') ? 'TẤT CẢ THIẾT BỊ BLE' : 
                      ((target === 'all_rs485') ? 'TẤT CẢ THIẾT BỊ RS485' : 
                      ((target === 'all_balancer') ? 'TẤT CẢ MẠCH CÂN BẰNG BALANCER UART' :
                      ((target === 'all') ? 'TẤT CẢ THIẾT BỊ BMS' : ('thiết bị ' + target))));

    if (!confirm('Xác nhận phát lệnh nạp Firmware [' + fwLabel + '] tới ' + targetLabel + '?')) return;
    msg.style.display = 'block';
    msg.style.background = 'rgba(56,189,248,0.15)';
    msg.style.color = '#38bdf8';
    msg.textContent = '⏳ Đang phát lệnh nạp Firmware ' + fwLabel + ' tới ' + targetLabel + '...';
    try {
      const res = await fetch('/api/send-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: target,
          cmd: {
            cmd: 'ota_update',
            target_type: (fwType !== 'auto') ? fwType : ((target === 'all_balancer') ? 'balancer' : ((target === 'all_rs485') ? 'rs485' : ((target === 'all_ble') ? 'ble' : 'auto'))),
            version: 'v' + Date.now()
          }
        })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        msg.style.background = 'rgba(63,185,80,0.15)';
        msg.style.color = '#3fb950';
        msg.textContent = '✅ ĐÃ PHÁT LỆNH OTA THÀNH CÔNG! Đã gửi lệnh nạp [' + fwLabel + '] tới ' + targetLabel + '. Thiết bị sẽ tự nạp và reboot trong 15s.';
      }
    } catch(e) {
      msg.style.background = 'rgba(248,81,73,0.15)';
      msg.style.color = '#f85149';
      msg.textContent = '❌ Lỗi phát lệnh: ' + e.message;
    }
  }

  async function triggerDeviceOta(id, forceType) {
    const isRs = (forceType === 'rs485');
    const isBal = (forceType === 'balancer');
    const isBl = (forceType === 'ble');
    let label = isBal ? 'Cân Bằng Balancer UART' : (isRs ? 'RS485 Modbus' : (isBl ? 'Bluetooth BLE' : 'chuẩn'));
    if (!confirm('Nạp OTA từ xa firmware ' + label + ' cho thiết bị ' + id + '?')) return;
    try {
      await fetch('/api/send-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: id,
          cmd: {
            cmd: 'ota_update',
            target_type: forceType || 'auto',
            version: 'v' + Date.now()
          }
        })
      });
      alert('✅ Đã phát lệnh OTA ' + label + ' cho ' + id + '! Thiết bị đang nạp...');
    } catch(e) { alert('Lỗi phát lệnh!'); }
  }

  async function clearAllPendingOta() {
    if (!confirm('Hủy và xóa sạch TẤT CẢ các lệnh OTA đang chờ trên Server?')) return;
    try {
      const res = await fetch('/api/clear-all-ota', { method: 'POST' });
      const data = await res.json();
      alert('✅ ' + (data.message || 'Đã hủy toàn bộ lệnh OTA!'));
    } catch(e) { alert('Lỗi khi hủy lệnh!'); }
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

  async function triggerDeviceRs485Scan(id) {
    try {
      await fetch('/api/send-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: id,
          cmd: { cmd: 'scan_rs485' }
        })
      });
      alert('🔍 Đã phát lệnh quét bus Modbus RS485 cho ' + id + '! Vui lòng mở giao diện để xem kết quả.');
    } catch(e) { alert('Lỗi phát lệnh quét RS485!'); }
  }

  async function toggleDeviceBalance(id, enable) {
    try {
      await fetch('/api/send-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: id,
          cmd: { cmd: 'balance', val: enable, value: enable ? 1 : 0 }
        })
      });
      alert((enable ? '⚡ Đã gửi lệnh BẬT' : '⏸️ Đã gửi lệnh TẮT') + ' Cân Bằng Chủ Động cho ' + id + '!');
      setTimeout(fetchDevices, 1500);
    } catch(e) { alert('Lỗi phát lệnh cân bằng!'); }
  }

  async function rebootDevice(id) {
    if (!confirm('Khởi động lại bo mạch ESP32 của ' + id + '?')) return;
    try {
      await fetch('/api/send-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: id,
          cmd: { cmd: 'reboot' }
        })
      });
      alert('🔄 Đã phát lệnh khởi động lại ESP32 cho ' + id + '!');
    } catch(e) { alert('Lỗi phát lệnh reboot!'); }
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
        let optHtml = '<option value="all">⚡ Tất cả thiết bị BMS (Broadcast All)</option>' +
                      '<option value="all_ble">📡 Tất cả thiết bị Bluetooth BLE</option>' +
                      '<option value="all_rs485">🔌 Tất cả thiết bị RS485 Modbus</option>' +
                      '<option value="all_balancer">⚡ Tất cả mạch Cân Bằng Balancer UART</option>' +
                      '<optgroup label="--- Từng Thiết Bị Cụ Thể ---">';
        for(let d of devices) {
          const isBal = (d.conn_type === 'uart_lcd') || (d.conn_type === 'balancer') || (d.conn_type_num === 3) || (d.firmware_version && d.firmware_version.indexOf('BALANCER') !== -1) || (d.device_id && d.device_id.startsWith('JKBAL'));
          const isMod = !isBal && ((d.conn_type === 'rs485' || d.conn_type === 'modbus' || (d.firmware_version && d.firmware_version.includes('RS485'))));
          const tag = isBal ? ' [BALANCER]' : (isMod ? ' [RS485]' : ' [BLE]');
          optHtml += '<option value="' + d.device_id + '">' + (d.online ? '🟢 ' : '🔴 ') + d.device_id + tag + (d.ssid ? ' (' + d.ssid + ')' : '') + '</option>';
        }
        optHtml += '</optgroup>';
        sel.innerHTML = optHtml;
        if (curVal) sel.value = curVal;
      }
      
      if(!devices || !devices.length){
        grid.innerHTML = '<div class="no-devices"><div class="icon">📡</div><h3>Chưa có thiết bị</h3><p>Nhập ID ở trên để lưu hoặc bật bo ESP32 kết nối Wi-Fi.</p></div>';
        return;
      }
      
      var htmlArr = [];
      for(var i = 0; i < devices.length; i++) {
        var d = devices[i];
        var voltStr = (d.voltage || 0).toFixed(1);
        var tempStr = (d.mos_temp || 0).toFixed(1);
        var localIp = d.local_ip || '—';
        var ssidName = d.ssid || '—';
        var hostName = d.hostname || '—';
        var fwVer = d.firmware_version || '—';
        var activatedStr = d.activatedAtStr || 'Chưa kích hoạt';
        var statusBadge = d.online ? '<span class="badge badge-online"><span class="pulse"></span> Online</span>' : '<span class="badge badge-offline">Offline</span>';
        var statusText = d.online ? 'Hoạt động ' : 'Offline từ ';
        
        var isBalancer = (d.conn_type === 'uart_lcd') || (d.conn_type === 'balancer') || (d.conn_type_num === 3) || (d.firmware_version && d.firmware_version.indexOf('BALANCER') !== -1) || (d.device_id && d.device_id.startsWith('JKBAL'));
        var isModbus = !isBalancer && ((d.conn_type === 'ble' || d.conn_type_num === 1 || (d.firmware_version && d.firmware_version.indexOf('BLE') !== -1))
          ? false
          : ((d.conn_type === 'modbus') || (d.conn_type === 'rs485') || (d.conn_type_num === 2) || (d.firmware_version && d.firmware_version.indexOf('RS485') !== -1) || (d.active_bms_mac && String(d.active_bms_mac).startsWith('RS485'))));
        var isBle = !isBalancer && !isModbus;

        // ══════════════════════════════════════════════════════════════════
        // LOẠI 1: MẠCH CÂN BẰNG CHỦ ĐỘNG JK (UART LCD PORT)
        // ══════════════════════════════════════════════════════════════════
        if (isBalancer) {
          var deltaV = (d.delta_cell_voltage !== undefined && d.delta_cell_voltage !== null) ? Number(d.delta_cell_voltage).toFixed(3) : ((d.cell_diff_v !== undefined && d.cell_diff_v !== null) ? Number(d.cell_diff_v).toFixed(3) : '0.000');
          var deltaColor = parseFloat(deltaV) > 0.030 ? 'warning' : 'green';
          var balCur = (d.balance_current !== undefined && d.balance_current !== null) ? Number(d.balance_current).toFixed(2) : '0.00';
          var balOn = !!(d.balance || d.balanceActive);
          var balModel = d.active_bms_name || d.modelName || 'JK Active Balancer';

          var connBadge = '<span style="background:rgba(16,185,129,0.18);color:#10b981;border:1px solid rgba(16,185,129,0.45);font-size:0.65rem;padding:2px 7px;border-radius:4px;font-weight:800;letter-spacing:0.5px;margin-left:6px;vertical-align:middle;">⚡ CÂN BẰNG JK</span>';

          htmlArr.push(
            '<div class="device-card ' + (d.online ? 'online' : 'offline') + '" style="border-left:4px solid #10b981;">' +
              '<div class="card-header">' +
                '<div>' +
                  '<div class="device-name" style="display:flex;align-items:center;">📟 ' + d.device_id + connBadge + '</div>' +
                  '<div class="device-sub" style="color:var(--accent);font-weight:600;margin-top:2px;">🔋 ' + balModel + ' <span style="color:var(--subtext);font-weight:normal;">[UART-LCD]</span></div>' +
                '</div>' +
                statusBadge +
              '</div>' +
              '<div class="metrics">' +
                '<div class="metric"><div class="metric-val blue">' + voltStr + ' V</div><div class="metric-label">Điện áp Tổng</div></div>' +
                '<div class="metric"><div class="metric-val ' + deltaColor + '">' + deltaV + ' V</div><div class="metric-label">Lệch Cell (ΔV)</div></div>' +
                '<div class="metric"><div class="metric-val warning">' + balCur + ' A</div><div class="metric-label">Dòng Cân Bằng</div></div>' +
              '</div>' +
              '<div class="device-info">' +
                '<div class="info-row"><span class="info-key">Kiểu Kết Nối</span><span class="info-val" style="color:#10b981;font-weight:700;">⚡ JK Balancer UART (LCD Port)</span></div>' +
                '<div class="info-row"><span class="info-key">Cổng Balancer</span><span class="info-val" style="color:var(--accent);font-weight:700;">' + balModel + '</span></div>' +
                '<div class="info-row"><span class="info-key">Trạng Thái Cân Bằng</span><span class="info-val" style="color:' + (balOn ? '#10b981' : 'var(--subtext)') + ';font-weight:700;">' + (balOn ? '⚡ ĐANG BẬT' : '⚪ ĐANG TẮT') + '</span></div>' +
                '<div class="info-row"><span class="info-key">Số Lượng Cell</span><span class="info-val">' + (d.cell_count || 24) + ' Cell (Hệ Pin)</span></div>' +
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
                '<button data-id="' + d.device_id + '" data-type="balancer" onclick="triggerDeviceOta(this.dataset.id, this.dataset.type)" style="background:rgba(16,185,129,0.15);border:1px solid #10b981;color:#10b981;padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;" title="Nạp đúng Firmware Balancer UART">⚡ Nạp Balancer</button>' +
                '<button data-id="' + d.device_id + '" onclick="toggleDeviceBalance(this.dataset.id, ' + (!balOn) + ')" style="background:rgba(56,189,248,0.15);border:1px solid #38bdf8;color:#38bdf8;padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;">' +
                  (balOn ? '⏸️ Tắt Cân Bằng' : '⚡ Bật Cân Bằng') +
                '</button>' +
                '<button data-id="' + d.device_id + '" onclick="copyMonitorLink(this.dataset.id, this)" style="background:var(--primary-dim);border:1px solid var(--primary);color:var(--primary);padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;cursor:pointer;">' +
                  '📋 Copy' +
                '</button>' +
              '</div>' +
              '<div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;">' +
                '<button data-id="' + d.device_id + '" onclick="rebootDevice(this.dataset.id)" style="background:transparent;border:none;color:#94a3b8;font-size:0.72rem;cursor:pointer;opacity:0.85;padding:0;">🔄 Khởi Động Lại ESP</button>' +
                '<button data-id="' + d.device_id + '" onclick="deleteDevice(this.dataset.id)" style="background:transparent;border:none;color:#f85149;font-size:0.72rem;cursor:pointer;opacity:0.7;">🗑️ Xóa</button>' +
              '</div>' +
              '<div class="last-seen">🕐 ' + statusText + timeSince(d.lastSeenAgo) + '</div>' +
            '</div>'
          );
        }
        // ══════════════════════════════════════════════════════════════════
        // LOẠI 2: MẠCH BMS KẾT NỐI RS485 MODBUS RTU
        // ══════════════════════════════════════════════════════════════════
        else if (isModbus) {
          var socColor = d.soc > 50 ? 'green' : d.soc > 20 ? 'warning' : 'danger';
          var bmsTitle = d.active_bms_name || d.active_pack_alias || d.active_pack_name || 'JK-PB Modbus';
          var slaveLabel = d.active_bms_mac || ('RS485 ID ' + (d.slave_id || 1));
          var connBadge = '<span style="background:rgba(245,158,11,0.18);color:#f59e0b;border:1px solid rgba(245,158,11,0.45);font-size:0.65rem;padding:2px 7px;border-radius:4px;font-weight:800;letter-spacing:0.5px;margin-left:6px;vertical-align:middle;">🟠 MODBUS</span>';

          htmlArr.push(
            '<div class="device-card ' + (d.online ? 'online' : 'offline') + '" style="border-left:4px solid #f59e0b;">' +
              '<div class="card-header">' +
                '<div>' +
                  '<div class="device-name" style="display:flex;align-items:center;">📟 ' + d.device_id + connBadge + '</div>' +
                  '<div class="device-sub" style="color:var(--accent);font-weight:600;margin-top:2px;">🔋 ' + bmsTitle + ' <span style="color:var(--subtext);font-weight:normal;">[' + slaveLabel + ']</span></div>' +
                '</div>' +
                statusBadge +
              '</div>' +
              '<div class="metrics">' +
                '<div class="metric"><div class="metric-val blue">' + voltStr + ' V</div><div class="metric-label">Điện áp Pack</div></div>' +
                '<div class="metric"><div class="metric-val ' + socColor + '">' + (d.soc || 0) + ' %</div><div class="metric-label">SoC Pin</div></div>' +
                '<div class="metric"><div class="metric-val warning">' + tempStr + ' °C</div><div class="metric-label">Nhiệt độ MOS</div></div>' +
              '</div>' +
              '<div class="device-info">' +
                '<div class="info-row"><span class="info-key">Kiểu Kết Nối</span><span class="info-val" style="color:#f59e0b;font-weight:700;">🟠 RS485 Modbus RTU</span></div>' +
                '<div class="info-row"><span class="info-key">Cổng BMS (Modbus)</span><span class="info-val" style="color:var(--accent);font-weight:700;">' + slaveLabel + '</span></div>' +
                '<div class="info-row"><span class="info-key">Giao Thức Truyền</span><span class="info-val">Modbus RTU (9600 bps)</span></div>' +
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
                '<button data-id="' + d.device_id + '" data-type="rs485" onclick="triggerDeviceOta(this.dataset.id, this.dataset.type)" style="background:rgba(245,158,11,0.15);border:1px solid #f59e0b;color:#f59e0b;padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;" title="Nạp đúng Firmware RS485">🔌 Nạp RS485</button>' +
                '<button data-id="' + d.device_id + '" onclick="triggerDeviceRs485Scan(this.dataset.id)" style="background:rgba(245,158,11,0.15);border:1px solid #f59e0b;color:#f59e0b;padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;" title="Quét tìm ID trên đường truyền RS485">' +
                  '🔍 Quét RS485' +
                '</button>' +
                '<button data-id="' + d.device_id + '" onclick="copyMonitorLink(this.dataset.id, this)" style="background:var(--primary-dim);border:1px solid var(--primary);color:var(--primary);padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;cursor:pointer;">' +
                  '📋 Copy' +
                '</button>' +
              '</div>' +
              '<div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;">' +
                '<button data-id="' + d.device_id + '" data-type="ble" onclick="triggerDeviceOta(this.dataset.id, this.dataset.type)" style="background:transparent;border:none;color:#38bdf8;font-size:0.72rem;cursor:pointer;opacity:0.85;padding:0;">📡 Nạp Chuyển Về BLE</button>' +
                '<button data-id="' + d.device_id + '" onclick="deleteDevice(this.dataset.id)" style="background:transparent;border:none;color:#f85149;font-size:0.72rem;cursor:pointer;opacity:0.7;">🗑️ Xóa</button>' +
              '</div>' +
              '<div class="last-seen">🕐 ' + statusText + timeSince(d.lastSeenAgo) + '</div>' +
            '</div>'
          );
        }
        // ══════════════════════════════════════════════════════════════════
        // LOẠI 3: MẠCH BMS KẾT NỐI KHÔNG DÂY BLUETOOTH BLE
        // ══════════════════════════════════════════════════════════════════
        else {
          var socColor = d.soc > 50 ? 'green' : d.soc > 20 ? 'warning' : 'danger';
          var bmsTitle = d.active_bms_name || d.active_pack_alias || d.active_pack_name || 'JK-BMS';
          var connBadge = '<span style="background:rgba(56,189,248,0.18);color:#38bdf8;border:1px solid rgba(56,189,248,0.45);font-size:0.65rem;padding:2px 7px;border-radius:4px;font-weight:800;letter-spacing:0.5px;margin-left:6px;vertical-align:middle;">🔵 BLUETOOTH</span>';

          htmlArr.push(
            '<div class="device-card ' + (d.online ? 'online' : 'offline') + '" style="border-left:4px solid #38bdf8;">' +
              '<div class="card-header">' +
                '<div>' +
                  '<div class="device-name" style="display:flex;align-items:center;">📟 ' + d.device_id + connBadge + '</div>' +
                  '<div class="device-sub" style="color:var(--accent);font-weight:600;margin-top:2px;">🔋 ' + bmsTitle + (d.active_bms_mac ? ' <span style="color:var(--subtext);font-weight:normal;">[' + d.active_bms_mac + ']</span>' : '') + '</div>' +
                '</div>' +
                statusBadge +
              '</div>' +
              '<div class="metrics">' +
                '<div class="metric"><div class="metric-val blue">' + voltStr + ' V</div><div class="metric-label">Điện áp Pack</div></div>' +
                '<div class="metric"><div class="metric-val ' + socColor + '">' + (d.soc || 0) + ' %</div><div class="metric-label">SoC Pin</div></div>' +
                '<div class="metric"><div class="metric-val warning">' + tempStr + ' °C</div><div class="metric-label">Nhiệt độ MOS</div></div>' +
              '</div>' +
              '<div class="device-info">' +
                '<div class="info-row"><span class="info-key">Kiểu Kết Nối</span><span class="info-val" style="color:#38bdf8;font-weight:700;">🔵 Bluetooth BLE</span></div>' +
                '<div class="info-row"><span class="info-key">Tên Bluetooth (BMS)</span><span class="info-val" style="color:var(--accent);font-weight:700;">' + bmsTitle + '</span></div>' +
                (d.active_bms_mac ? ('<div class="info-row"><span class="info-key">Địa Chỉ MAC</span><span class="info-val" style="color:var(--subtext);">' + d.active_bms_mac + '</span></div>') : '') +
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
                '<button data-id="' + d.device_id + '" data-type="ble" onclick="triggerDeviceOta(this.dataset.id, this.dataset.type)" style="background:rgba(56,189,248,0.15);border:1px solid #38bdf8;color:#38bdf8;padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;" title="Nạp đúng Firmware Bluetooth">📡 Nạp BLE</button>' +
                '<button data-id="' + d.device_id + '" onclick="triggerDeviceBleScan(this.dataset.id)" style="background:rgba(227,179,65,0.15);border:1px solid #e3b341;color:#e3b341;padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;" title="Quét tìm thiết bị Bluetooth xung quanh">' +
                  '🔍 Quét BLE' +
                '</button>' +
                '<button data-id="' + d.device_id + '" onclick="copyMonitorLink(this.dataset.id, this)" style="background:var(--primary-dim);border:1px solid var(--primary);color:var(--primary);padding:7px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;cursor:pointer;">' +
                  '📋 Copy' +
                '</button>' +
              '</div>' +
              '<div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;">' +
                '<button data-id="' + d.device_id + '" data-type="rs485" onclick="triggerDeviceOta(this.dataset.id, this.dataset.type)" style="background:transparent;border:none;color:#f59e0b;font-size:0.72rem;cursor:pointer;opacity:0.85;padding:0;">🔌 Nạp Chuyển Sang RS485</button>' +
                '<button data-id="' + d.device_id + '" onclick="deleteDevice(this.dataset.id)" style="background:transparent;border:none;color:#f85149;font-size:0.72rem;cursor:pointer;opacity:0.7;">🗑️ Xóa</button>' +
              '</div>' +
              '<div class="last-seen">🕐 ' + statusText + timeSince(d.lastSeenAgo) + '</div>' +
            '</div>'
          );
        }
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

      const dateEl = document.getElementById('usage-date');
      if (dateEl) {
        dateEl.textContent = '📅 ' + (u.date || new Date().toLocaleDateString('vi-VN')) + ' | ' + new Date().toLocaleTimeString('vi-VN');
      }

      if (u.box) {
        const ipEl = document.getElementById('box-ip-display');
        if (ipEl) ipEl.textContent = (u.box.ip || window.location.hostname) + ':' + (u.box.port || window.location.port || '3001');
        const upEl = document.getElementById('box-uptime-val');
        if (upEl) upEl.textContent = u.box.uptime_str || '—';
        const ramEl = document.getElementById('box-ram-val');
        if (ramEl) ramEl.textContent = u.box.memory_mb ? (u.box.memory_mb + ' MB') : '—';
        const nodeEl = document.getElementById('box-node-txt');
        if (nodeEl) nodeEl.textContent = 'Node ' + (u.box.node_version || 'v20+');
      }

      if (u.devices) {
        const onEl = document.getElementById('devices-online-num');
        if (onEl) onEl.textContent = u.devices.online !== undefined ? u.devices.online : 0;
        const totEl = document.getElementById('devices-total-num');
        if (totEl) totEl.textContent = u.devices.total !== undefined ? u.devices.total : 0;
        const ratioBadge = document.getElementById('devices-ratio-badge');
        if (ratioBadge && u.devices.total > 0) {
          const pct = Math.round((u.devices.online / u.devices.total) * 100);
          ratioBadge.textContent = pct + '% ONLINE';
          ratioBadge.style.color = pct === 100 ? '#22c55e' : pct > 50 ? '#e3b341' : '#f85149';
        }
      }

      if (u.users) {
        const usersEl = document.getElementById('box-users-txt');
        if (usersEl) usersEl.textContent = u.users.total + ' tài khoản (' + u.users.customers + ' khách)';
      }
    } catch(e) {
      console.warn('Usage stats error:', e);
    }
  }

  async function triggerQuickSync() {
    if (!confirm('Bạn có muốn kích hoạt TV Box đồng bộ mã nguồn mới từ máy tính PC không?')) return;
    try {
      const res = await fetch('/api/sync-code', { method: 'POST' });
      const data = await res.json();
      alert('Kết quả: ' + (data.message || JSON.stringify(data)));
      setTimeout(() => location.reload(), 2000);
    } catch(e) {
      alert('Gửi lệnh đồng bộ thất bại: ' + e.message);
    }
  }

  async function triggerTunnelRestart() {
    alert('Cloudflare Tunnel đang hoạt động nền liên tục trên TV Box. Nếu cần khởi động lại, dịch vụ watchdog sẽ tự khôi phục sau 15 giây.');
  }

  // ── LOGOUT & PASSWORD MANAGEMENT ──
  async function logoutAdmin() {
    if (!confirm('Bạn có chắc muốn đăng xuất khỏi trang Quản Trị?')) return;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      await fetch('/api/admin-logout', { method: 'POST' });
    } catch(e){}
    window.location.href = '/login';
  }

  async function changeAdminPassword() {
    const newPass = prompt('Nhập mật khẩu Admin mới (tối thiểu 4 ký tự):');
    if (!newPass) return;
    if (newPass.trim().length < 4) {
      alert('⚠️ Mật khẩu phải có ít nhất 4 ký tự!');
      return;
    }
    try {
      const res = await fetch('/api/admin-change-pass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: newPass.trim() })
      });
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        alert('✅ Đã đổi mật khẩu quản trị thành công!');
      } else {
        alert('❌ Lỗi: ' + (data.error || 'Không thể đổi mật khẩu'));
      }
    } catch(e) {
      alert('❌ Lỗi kết nối: ' + e.message);
    }
  }

  // ── USERS MANAGEMENT FUNCTIONS ──
  let cachedUsersList = [];

  function toggleUsersModal() {
    const m = document.getElementById('users-modal');
    if (!m) {
      alert('Không tìm thấy hộp thoại Quản lý khách hàng!');
      return;
    }
    const isShow = (m.style.display === 'flex');
    m.style.display = isShow ? 'none' : 'flex';
    if (!isShow) {
      loadUsersList();
    }
  }

  async function loadUsersList() {
    const tbody = document.getElementById('users-table-body');
    const badge = document.getElementById('users-count-badge');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--subtext);">⏳ Đang tải danh sách từ D1 Database...</td></tr>';
    
    try {
      const res = await fetch('/api/admin/users');
      if (!res.ok) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--danger);">⚠️ Không có quyền hoặc lỗi khi tải danh sách.</td></tr>';
        return;
      }
      cachedUsersList = await res.json();
      if (badge) badge.textContent = cachedUsersList.length + ' tài khoản';
      renderUsersTable(cachedUsersList);
    } catch(err) {
      tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--danger);">❌ Lỗi kết nối: ' + err.message + '</td></tr>';
    }
  }

  function renderUsersTable(list) {
    const tbody = document.getElementById('users-table-body');
    if (!tbody) return;
    if (!list || list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--subtext);">Không có tài khoản nào.</td></tr>';
      return;
    }

    let html = '';
    for (const u of list) {
      const isAdm = (u.role === 'admin' || u.role === 'admin_level_1' || u.role === 'superadmin');
      const isTech = (u.role === 'admin_level_2' || u.role === 'tech');
      const roleBadge = isAdm 
        ? '<span style="background:rgba(168,85,247,0.2);color:#c084fc;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:700;border:1px solid rgba(168,85,247,0.4);">🛡️ Super Admin</span>'
        : (isTech ? '<span style="background:rgba(56,189,248,0.2);color:#38bdf8;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:700;">🔧 Kỹ Thuật Viên</span>'
                  : '<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:700;">👤 Khách Hàng</span>');

      let devChips = '';
      if (u.devices_list && u.devices_list.trim().length > 0) {
        const arr = u.devices_list.split(',').map(str => str.trim()).filter(Boolean);
        devChips = arr.map(devStr => {
          const rawId = devStr.split(' ')[0].trim();
          return '<a href="/d/' + rawId + '" target="_blank" style="display:inline-block;background:rgba(56,189,248,0.12);border:1px solid rgba(56,189,248,0.35);color:var(--cyan);padding:3px 9px;border-radius:6px;font-family:monospace;font-size:0.75rem;font-weight:700;margin:2px 3px;text-decoration:none;transition:0.2s;" title="Mở trang điều khiển ' + rawId + '">⚡ ' + devStr + ' ↗</a>';
        }).join('');
      } else {
        devChips = '<span style="color:var(--subtext);font-style:italic;font-size:0.75rem;">Chưa liên kết ESP nào</span>';
      }

      const fullnameStr = u.fullname || '—';
      const phoneStr = u.phone ? ('📞 ' + u.phone) : '';
      const isLongBui = (u.username.toLowerCase() === 'longbui');

      html += '<tr style="border-bottom:1px solid var(--border);">' +
        '<td style="padding:10px 12px;font-weight:800;color:#fff;font-family:monospace;font-size:0.88rem;">' + u.username + '</td>' +
        '<td style="padding:10px 12px;"><div>' + fullnameStr + '</div><div style="font-size:0.72rem;color:var(--subtext);">' + phoneStr + '</div></td>' +
        '<td style="padding:10px 12px;">' + roleBadge + '</td>' +
        '<td style="padding:10px 12px;max-width:320px;">' + devChips + '</td>' +
        '<td style="padding:10px 12px;text-align:center;">' +
          '<div style="display:inline-flex;align-items:center;gap:6px;justify-content:center;flex-wrap:wrap;">' +
            '<button onclick="openEditUserModal(' + u.id + ')" style="background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.4);color:var(--cyan);padding:5px 9px;border-radius:7px;font-size:0.75rem;font-weight:700;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:3px;transition:0.2s;" title="Chỉnh sửa phân quyền & bộ pin liên kết">✏️ Sửa</button>' +
            '<button onclick="resetCustomerPassword(' + u.id + ')" style="background:rgba(234,179,8,0.15);border:1px solid rgba(234,179,8,0.4);color:#eab308;padding:5px 9px;border-radius:7px;font-size:0.75rem;font-weight:700;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:3px;transition:0.2s;" title="Đặt lại mật khẩu cho tài khoản này về 123456">🔑 Reset MK</button>' +
            (isLongBui ? '' : '<button onclick="deleteCustomerUser(' + u.id + ')" style="background:rgba(248,81,73,0.15);border:1px solid rgba(248,81,73,0.4);color:#f85149;padding:5px 9px;border-radius:7px;font-size:0.75rem;font-weight:700;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:3px;transition:0.2s;" title="Xóa vĩnh viễn tài khoản khỏi hệ thống">🗑️ Xóa</button>') +
          '</div>' +
        '</td>' +
      '</tr>';
    }
    tbody.innerHTML = html;
  }

  function filterUsersTable() {
    const q = (document.getElementById('users-search-input').value || '').toLowerCase().trim();
    if (!q) {
      renderUsersTable(cachedUsersList);
      return;
    }
    const filtered = cachedUsersList.filter(u => {
      const un = (u.username || '').toLowerCase();
      const fn = (u.fullname || '').toLowerCase();
      const ph = (u.phone || '').toLowerCase();
      const dev = (u.devices_list || '').toLowerCase();
      return un.includes(q) || fn.includes(q) || ph.includes(q) || dev.includes(q);
    });
    renderUsersTable(filtered);
  }

  async function resetCustomerPassword(userId) {
    const user = cachedUsersList.find(x => x.id === userId);
    const username = user ? user.username : ('User #' + userId);
    if (!confirm('⚠️ Xác nhận đặt lại mật khẩu cho tài khoản [' + username + '] về mặc định: 123456?')) return;
    
    try {
      const res = await fetch('/api/admin/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, username: username })
      });
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        alert('🎉 ' + data.message + ' | Mật khẩu mới: 123456');
      } else {
        alert('❌ Lỗi: ' + (data.error || 'Không thể đặt lại mật khẩu'));
      }
    } catch(err) {
      alert('❌ Lỗi kết nối: ' + err.message);
    }
  }

  async function openEditUserModal(userId) {
    const user = cachedUsersList.find(x => x.id === userId);
    if (!user) {
      alert('Không tìm thấy tài khoản trong bộ nhớ cache.');
      return;
    }

    document.getElementById('edit-user-title-name').textContent = user.username;
    document.getElementById('edit-user-id').value = user.id;
    document.getElementById('edit-user-fullname').value = (user.fullname && user.fullname !== '—') ? user.fullname : '';
    document.getElementById('edit-user-phone').value = user.phone || '';
    
    const roleSel = document.getElementById('edit-user-role');
    const roleHint = document.getElementById('edit-user-role-hint');
    roleSel.value = (user.role === 'admin') ? 'admin' : 'customer';

    if (user.username.toLowerCase() === 'longbui') {
      roleSel.disabled = true;
      roleHint.textContent = '🔒 Tài khoản Quản trị viên gốc luôn giữ quyền Super Admin.';
    } else {
      roleSel.disabled = false;
      roleHint.textContent = '';
    }

    const devContainer = document.getElementById('edit-user-devices-list');
    devContainer.innerHTML = '<div style="padding:10px;text-align:center;color:var(--subtext);font-size:0.8rem;">Đang tải danh sách thiết bị...</div>';
    document.getElementById('user-edit-modal').style.display = 'flex';

    const userDevMap = new Map();
    if (Array.isArray(user.devices)) {
      for (const d of user.devices) {
        userDevMap.set(d.device_id.toUpperCase(), d.custom_name || d.device_id);
      }
    } else if (user.devices_list) {
      const arr = user.devices_list.split(',').map(s => s.trim()).filter(Boolean);
      for (const item of arr) {
        const parts = item.match(/^([A-Za-z0-9_\-]+)(?:\s*\((.*?)\))?$/);
        if (parts) {
          userDevMap.set(parts[1].toUpperCase(), parts[2] || parts[1]);
        }
      }
    }

    try {
      const res = await fetch('/api/admin/system-devices');
      const sysDevices = res.ok ? await res.json() : [];
      
      const allDevsMap = new Map();
      for (const d of sysDevices) {
        allDevsMap.set(d.device_id.toUpperCase(), d);
      }
      for (const [devId, cName] of userDevMap.entries()) {
        if (!allDevsMap.has(devId)) {
          allDevsMap.set(devId, { device_id: devId, name: cName, online: false });
        }
      }

      if (allDevsMap.size === 0) {
        devContainer.innerHTML = '<div style="padding:10px;text-align:center;color:var(--subtext);font-size:0.8rem;">Chưa có thiết bị nào trong hệ thống. Hãy thêm mã ESP bên dưới.</div>';
      } else {
        let html = '';
        for (const [devId, d] of allDevsMap.entries()) {
          const isChecked = userDevMap.has(devId);
          const currentCustomName = userDevMap.get(devId) || d.name || devId;
          const statusBadge = d.online 
            ? '<span style="color:#22c55e;font-size:0.68rem;font-weight:700;display:inline-flex;align-items:center;gap:3px;"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 5px #22c55e;"></span> Online</span>' 
            : '<span style="color:var(--subtext);font-size:0.68rem;">○ Offline</span>';

          html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;">' +
            '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;min-width:0;margin:0;">' +
              '<input type="checkbox" class="edit-dev-checkbox" data-devid="' + devId + '" ' + (isChecked ? 'checked' : '') + ' style="width:16px;height:16px;cursor:pointer;accent-color:#38bdf8;">' +
              '<div style="min-width:0;">' +
                '<span style="font-weight:800;font-family:monospace;color:#fff;font-size:0.82rem;">⚡ ' + devId + '</span> ' + statusBadge +
              '</div>' +
            '</label>' +
            '<input type="text" class="edit-dev-custname" data-devid="' + devId + '" value="' + (currentCustomName !== devId ? currentCustomName : '') + '" placeholder="Tên gợi nhớ..." style="width:140px;background:#090d14;border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:0.75rem;color:var(--cyan);outline:none;" title="Đặt tên gợi nhớ cho bộ pin này">' +
          '</div>';
        }
        devContainer.innerHTML = html;
      }
    } catch(e) {
      devContainer.innerHTML = '<div style="padding:10px;text-align:center;color:var(--danger);font-size:0.8rem;">❌ Lỗi tải thiết bị: ' + e.message + '</div>';
    }
  }

  function closeEditUserModal() {
    const m = document.getElementById('user-edit-modal');
    if (m) m.style.display = 'none';
  }

  function addCustomDeviceToEditList() {
    const inp = document.getElementById('edit-user-custom-dev-id');
    const val = (inp.value || '').trim().toUpperCase();
    if (!val) {
      alert('Vui lòng nhập mã Device ID (ví dụ: JKBMS-14CE)');
      return;
    }

    const devContainer = document.getElementById('edit-user-devices-list');
    const existing = devContainer.querySelector('input.edit-dev-checkbox[data-devid="' + val + '"]');
    if (existing) {
      existing.checked = true;
      inp.value = '';
      alert('Đã chọn thiết bị: ' + val);
      return;
    }

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(56,189,248,0.3);border-radius:8px;';
    row.innerHTML = '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;min-width:0;margin:0;">' +
      '<input type="checkbox" class="edit-dev-checkbox" data-devid="' + val + '" checked style="width:16px;height:16px;cursor:pointer;accent-color:#38bdf8;">' +
      '<div style="min-width:0;"><span style="font-weight:800;font-family:monospace;color:#fff;font-size:0.82rem;">⚡ ' + val + '</span> <span style="color:#38bdf8;font-size:0.68rem;">(Mới thêm)</span></div>' +
    '</label>' +
    '<input type="text" class="edit-dev-custname" data-devid="' + val + '" value="" placeholder="Tên gợi nhớ..." style="width:140px;background:#090d14;border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:0.75rem;color:var(--cyan);outline:none;">';

    if (devContainer.querySelector('div[style*="text-align:center"]')) {
      devContainer.innerHTML = '';
    }
    devContainer.prepend(row);
    inp.value = '';
  }

  async function saveUserEdit(e) {
    e.preventDefault();
    const btn = document.getElementById('btn-save-user-edit');
    const userId = Number(document.getElementById('edit-user-id').value);
    const fullname = document.getElementById('edit-user-fullname').value.trim();
    const phone = document.getElementById('edit-user-phone').value.trim();
    const role = document.getElementById('edit-user-role').value;

    const checkboxes = document.querySelectorAll('#edit-user-devices-list input.edit-dev-checkbox');
    const selectedDevices = [];
    checkboxes.forEach(cb => {
      if (cb.checked) {
        const did = cb.getAttribute('data-devid');
        const nameInp = document.querySelector('#edit-user-devices-list input.edit-dev-custname[data-devid="' + did + '"]');
        const custName = nameInp ? nameInp.value.trim() : '';
        selectedDevices.push({
          device_id: did,
          custom_name: custName || did
        });
      }
    });

    btn.disabled = true;
    btn.textContent = '⏳ Đang lưu...';

    try {
      const res = await fetch('/api/admin/update-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          role: role,
          fullname: fullname,
          phone: phone,
          devices: selectedDevices
        })
      });
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        alert('🎉 ' + data.message);
        closeEditUserModal();
        loadUsersList();
      } else {
        alert('❌ Lỗi: ' + (data.error || 'Không thể lưu thay đổi'));
      }
    } catch(err) {
      alert('❌ Lỗi kết nối: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 Lưu Thay Đổi';
    }
  }

  async function deleteCustomerUser(userId) {
    const user = cachedUsersList.find(x => x.id === userId);
    const username = user ? user.username : ('User #' + userId);

    if (username.toLowerCase() === 'longbui' || username.toLowerCase() === 'admin') {
      alert('❌ Không thể xóa tài khoản Quản trị viên gốc!');
      return;
    }

    if (!confirm('⚠️ CẢNH BÁO XÓA TÀI KHOẢN:\\n\\nBạn có chắc chắn muốn xóa vĩnh viễn tài khoản [' + username + '] khỏi hệ thống?\\n\\nTất cả dữ liệu phân quyền và danh sách bộ pin liên kết sẽ bị xóa sạch.')) {
      return;
    }

    try {
      const res = await fetch('/api/admin/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId })
      });
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        alert('🎉 ' + data.message);
        loadUsersList();
      } else {
        alert('❌ Lỗi: ' + (data.error || 'Không thể xóa tài khoản'));
      }
    } catch(err) {
      alert('❌ Lỗi kết nối: ' + err.message);
    }
  }
</script>

<!-- MODAL QUẢN LÝ KHÁCH HÀNG (USERS) -->
<div id="users-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);z-index:2000;align-items:center;justify-content:center;padding:16px;" onclick="if(event.target===this)toggleUsersModal()">
  <div style="background:var(--surface);border:1px solid rgba(168,85,247,0.4);border-radius:18px;max-width:980px;width:100%;max-height:88vh;display:flex;flex-direction:column;padding:24px;box-shadow:0 25px 50px rgba(0,0,0,0.85);">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
      <div style="font-size:1.2rem;font-weight:800;color:#c084fc;display:flex;align-items:center;gap:8px;">
        <span>👥</span> Quản Lý Tài Khoản Khách Hàng
        <span id="users-count-badge" style="background:rgba(168,85,247,0.2);color:#c084fc;font-size:0.75rem;padding:3px 10px;border-radius:12px;font-family:monospace;border:1px solid rgba(168,85,247,0.3);">0 tài khoản</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="text" id="users-search-input" placeholder="🔍 Tìm kiếm tài khoản, SĐT, ESP..." oninput="filterUsersTable()" style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:#fff;font-size:0.8rem;outline:none;width:240px;">
        <button onclick="loadUsersList()" style="background:rgba(56,189,248,0.15);border:1px solid #38bdf8;color:#38bdf8;padding:8px 12px;border-radius:8px;font-size:0.78rem;font-weight:700;cursor:pointer;">🔄 Tải Lại</button>
        <button onclick="toggleUsersModal()" style="background:transparent;border:none;color:var(--subtext);font-size:1.6rem;cursor:pointer;line-height:1;padding:0 4px;">&times;</button>
      </div>
    </div>
    
    <div style="overflow-y:auto;overflow-x:auto;flex:1;border:1px solid var(--border);border-radius:10px;">
      <table style="width:100%;border-collapse:collapse;font-size:0.82rem;text-align:left;">
        <thead>
          <tr style="background:var(--surface2);border-bottom:1px solid var(--border);color:var(--subtext);position:sticky;top:0;z-index:2;">
            <th style="padding:10px 12px;">Tên Tài Khoản</th>
            <th style="padding:10px 12px;">Họ Tên & SĐT</th>
            <th style="padding:10px 12px;">Phân Quyền</th>
            <th style="padding:10px 12px;">Mã ESP Đã Liên Kết</th>
            <th style="padding:10px 12px;text-align:center;">Thao Tác</th>
          </tr>
        </thead>
        <tbody id="users-table-body">
          <tr><td colspan="5" style="padding:24px;text-align:center;color:var(--subtext);">Đang tải danh sách khách hàng...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- MODAL CHỈNH SỬA TÀI KHOẢN KHÁCH HÀNG (ROLE & PACKS) -->
<div id="user-edit-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);z-index:2100;align-items:center;justify-content:center;padding:16px;" onclick="if(event.target===this)closeEditUserModal()">
  <div style="background:var(--surface);border:1px solid rgba(56,189,248,0.4);border-radius:18px;max-width:580px;width:100%;max-height:90vh;display:flex;flex-direction:column;padding:22px;box-shadow:0 25px 50px rgba(0,0,0,0.85);">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <div style="font-size:1.15rem;font-weight:800;color:var(--cyan);display:flex;align-items:center;gap:8px;">
        <span>✏️</span> Chỉnh Sửa Tài Khoản: <span id="edit-user-title-name" style="color:#fff;font-family:monospace;">---</span>
      </div>
      <button onclick="closeEditUserModal()" style="background:transparent;border:none;color:var(--subtext);font-size:1.6rem;cursor:pointer;line-height:1;padding:0 4px;">&times;</button>
    </div>

    <form id="edit-user-form" onsubmit="saveUserEdit(event)" style="display:flex;flex-direction:column;gap:12px;overflow-y:auto;padding-right:4px;">
      <input type="hidden" id="edit-user-id">

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-size:0.75rem;color:var(--subtext);margin-bottom:4px;font-weight:600;">Họ và Tên:</label>
          <input type="text" id="edit-user-fullname" placeholder="Họ và tên..." style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:#fff;font-size:0.85rem;outline:none;">
        </div>
        <div>
          <label style="display:block;font-size:0.75rem;color:var(--subtext);margin-bottom:4px;font-weight:600;">Số Điện Thoại:</label>
          <input type="tel" id="edit-user-phone" placeholder="Số điện thoại..." style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:#fff;font-size:0.85rem;outline:none;">
        </div>
      </div>

      <div>
        <label style="display:block;font-size:0.75rem;color:var(--subtext);margin-bottom:4px;font-weight:600;">🛡️ Phân Quyền Tài Khoản:</label>
        <select id="edit-user-role" style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:#fff;font-size:0.85rem;outline:none;">
          <option value="customer">👤 Khách Hàng (Chỉ xem và điều khiển các pack pin được phân quyền)</option>
          <option value="admin">🛡️ Super Admin (Toàn quyền quản trị, cấu hình và nạp OTA tất cả thiết bị)</option>
        </select>
        <div id="edit-user-role-hint" style="font-size:0.7rem;color:#eab308;margin-top:4px;"></div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <label style="font-size:0.8rem;color:#38bdf8;font-weight:700;display:flex;align-items:center;gap:6px;">
            <span>⚡</span> Pack Pin / ESP32 Đã Cấp Quyền Cho Khách:
          </label>
          <span style="font-size:0.7rem;color:var(--subtext);">Tích chọn để liên kết</span>
        </div>

        <div id="edit-user-devices-list" style="max-height:180px;overflow-y:auto;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px;">
          <!-- Dynamically populated checkboxes -->
        </div>

        <!-- Add Custom Pack ID Manual Input -->
        <div style="display:flex;gap:6px;margin-top:8px;">
          <input type="text" id="edit-user-custom-dev-id" placeholder="Thêm mã ESP khác (VD: JKBMS-14CE)..." style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:#fff;font-size:0.8rem;outline:none;font-family:monospace;text-transform:uppercase;">
          <button type="button" onclick="addCustomDeviceToEditList()" style="background:rgba(56,189,248,0.2);border:1px solid #38bdf8;color:#38bdf8;padding:6px 12px;border-radius:8px;font-size:0.78rem;font-weight:700;cursor:pointer;white-space:nowrap;">+ Thêm Pack</button>
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
        <button type="button" onclick="closeEditUserModal()" style="background:transparent;border:1px solid var(--border);color:var(--subtext);padding:8px 16px;border-radius:8px;font-size:0.85rem;cursor:pointer;">Hủy Bỏ</button>
        <button type="submit" id="btn-save-user-edit" style="background:linear-gradient(135deg,#0284c7,#0369a1);border:none;color:#fff;padding:8px 20px;border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;">💾 Lưu Thay Đổi</button>
      </div>
    </form>
  </div>
</div>

</body>
</html>`;









const BALANCER_HTML_TEMPLATE = "\n<!DOCTYPE html>\n<html lang=\"vi\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover\">\n    <meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n    <meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\">\n    <meta name=\"apple-mobile-web-app-title\" content=\"JK Active Balancer\">\n    <meta name=\"format-detection\" content=\"telephone=no\">\n    <meta name=\"theme-color\" content=\"#000000\">\n    <title>JK Active Balancer Monitor</title>\n    <style>\n        :root {\n            --sat: env(safe-area-inset-top, 0px);\n            --sab: env(safe-area-inset-bottom, 0px);\n            --sal: env(safe-area-inset-left, 0px);\n            --sar: env(safe-area-inset-right, 0px);\n            --bg-black: #000000;\n            --card-bg: #121518;\n            --card-border: #1d252c;\n            --green: #00ff2b;\n            --cyan: #38bdf8;\n            --red: #ff3b30;\n            --yellow: #f59e0b;\n            --text-white: #ffffff;\n            --text-sub: #8e8e93;\n            --badge-bg: #0077b6;\n        }\n        * {\n            box-sizing: border-box;\n            margin: 0;\n            padding: 0;\n            font-family: -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"SF Pro Display\", \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\n            -webkit-tap-highlight-color: transparent;\n            -webkit-font-smoothing: antialiased;\n            -moz-osx-font-smoothing: grayscale;\n        }\n        html {\n            background-color: var(--bg-black);\n            -webkit-text-size-adjust: 100%;\n            text-size-adjust: 100%;\n            scroll-behavior: smooth;\n        }\n        body {\n            background-color: var(--bg-black);\n            color: var(--text-white);\n            min-height: 100vh;\n            min-height: -webkit-fill-available;\n            padding-bottom: calc(85px + max(16px, var(--sab)));\n            user-select: none;\n            -webkit-user-select: none;\n            overflow-x: hidden;\n            width: 100%;\n            max-width: 100vw;\n            -webkit-overflow-scrolling: touch;\n        }\n        .app {\n            max-width: 480px;\n            width: 100%;\n            margin: 0 auto;\n            min-height: 100vh;\n            min-height: -webkit-fill-available;\n            position: relative;\n            background: #000;\n            padding-left: max(0px, var(--sal));\n            padding-right: max(0px, var(--sar));\n            overflow-x: hidden;\n        }\n\n        /* Sticky Top Header with Safe Area Inset */\n        .app-header {\n            position: -webkit-sticky;\n            position: sticky;\n            top: 0;\n            z-index: 999;\n            background: rgba(0, 0, 0, 0.88);\n            backdrop-filter: blur(20px);\n            -webkit-backdrop-filter: blur(20px);\n            border-bottom: 1px solid rgba(255, 255, 255, 0.08);\n            padding-top: max(8px, var(--sat));\n            width: 100%;\n            max-width: 100%;\n            overflow: hidden;\n        }\n\n        /* Top Header Bar */\n        .top-bar {\n            display: flex;\n            justify-content: space-between;\n            align-items: center;\n            padding: 10px 12px 6px 12px;\n            background: transparent;\n            gap: 8px;\n            min-width: 0;\n        }\n        .top-bar-left {\n            display: flex;\n            align-items: center;\n            gap: 8px;\n            min-width: 0;\n            flex: 1;\n            overflow: hidden;\n        }\n        .top-bar-right {\n            display: flex;\n            align-items: center;\n            gap: 6px;\n            flex-shrink: 0;\n        }\n        .bt-status { display: flex; align-items: center; gap: 4px; font-size: 1.05rem; color: #555; flex-shrink: 0; }\n        .bt-status.active { color: var(--cyan); }\n        .uptime-txt { font-size: 0.78rem; font-weight: 500; color: #e5e5e5; letter-spacing: 0.2px; font-family: monospace; white-space: nowrap; }\n        .menu-btn { font-size: 1.25rem; color: #fff; cursor: pointer; border: none; background: transparent; padding: 4px; touch-action: manipulation; }\n\n        /* MOS Control Top Bar */\n        .mos-bar {\n            display: flex;\n            justify-content: space-around;\n            align-items: center;\n            background: transparent;\n            padding: 5px 6px 6px 6px;\n            border-top: 1px solid rgba(255,255,255,0.05);\n            font-size: 0.8rem;\n            font-weight: 600;\n            gap: 4px;\n        }\n        .mos-item {\n            display: flex;\n            align-items: center;\n            gap: 5px;\n            cursor: pointer;\n            padding: 4px 8px;\n            border-radius: 6px;\n            background: rgba(255,255,255,0.03);\n            touch-action: manipulation;\n            transition: transform 0.1s, opacity 0.1s;\n        }\n        .mos-item:active { transform: scale(0.95); opacity: 0.8; }\n        .dot { width: 7px; height: 7px; border-radius: 50%; background: #444; flex-shrink: 0; }\n        .dot.on { background: var(--green); box-shadow: 0 0 6px var(--green); }\n        .dot.off { background: var(--red); box-shadow: 0 0 6px var(--red); }\n        .dot.standby { background: var(--cyan); box-shadow: 0 0 6px var(--cyan); }\n        .val-on { color: var(--green); font-weight: bold; }\n        .val-off { color: var(--red); font-weight: bold; }\n        .val-standby { color: var(--cyan); font-weight: bold; }\n\n        /* Gauge Section */\n        .gauge-section { position: relative; width: 100%; text-align: center; padding: 10px 0 4px 0; overflow: hidden; }\n        .gauge-svg { width: 250px; height: 215px; max-width: 100%; }\n        .gauge-center-val { position: absolute; top: 38%; left: 50%; transform: translate(-50%, -50%); text-align: center; }\n        .gauge-soc { font-size: 3.4rem; font-weight: 800; color: var(--green); text-shadow: 0 0 16px rgba(0,255,43,0.35); line-height: 1; }\n        .gauge-pills { position: absolute; top: 68%; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; width: 150px; }\n        .pill-badge { background: #000; border: 1.8px solid var(--green); color: var(--green); font-size: 1.15rem; font-weight: 800; padding: 4px 14px; border-radius: 20px; text-shadow: 0 0 8px rgba(0,255,43,0.25); letter-spacing: 0.5px; }\n\n        /* Notification Banner */\n        .status-banner { margin: 8px 12px; background: rgba(5,35,41,0.85); border: 1px solid #008b99; border-radius: 12px; padding: 8px 12px; display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: #e2e8f0; min-width: 0; }\n        .banner-icon { color: var(--green); font-size: 1.1rem; flex-shrink: 0; }\n\n        /* Metrics Grids (4 columns - Responsive Non-overflowing) */\n        .metrics-grid-4 {\n            display: grid;\n            grid-template-columns: repeat(4, minmax(0, 1fr));\n            gap: 2px;\n            margin: 8px 12px;\n            background: var(--card-bg);\n            border: 1px solid var(--card-border);\n            border-radius: 14px;\n            padding: 10px 4px;\n            text-align: center;\n        }\n        .metric-item {\n            display: flex;\n            flex-direction: column;\n            align-items: center;\n            justify-content: center;\n            position: relative;\n            padding: 2px 0;\n            min-width: 0;\n            overflow: hidden;\n        }\n        .metric-item:not(:last-child)::after { content: ''; position: absolute; right: 0; top: 15%; height: 70%; width: 1px; background: #222d35; }\n        .metric-val {\n            font-size: 1.05rem;\n            font-weight: 800;\n            margin-bottom: 2px;\n            white-space: nowrap;\n            letter-spacing: -0.3px;\n            max-width: 100%;\n            overflow: hidden;\n            text-overflow: ellipsis;\n        }\n        .metric-lbl {\n            font-size: 0.62rem;\n            color: var(--text-sub);\n            white-space: nowrap;\n            max-width: 100%;\n            overflow: hidden;\n            text-overflow: ellipsis;\n        }\n\n        /* Power & Status Card */\n        .info-card-box {\n            margin: 8px 12px;\n            background: var(--card-bg);\n            border: 1px solid var(--card-border);\n            border-radius: 14px;\n            padding: 10px 12px;\n            font-size: 0.84rem;\n            min-width: 0;\n        }\n        .card-row {\n            display: flex;\n            justify-content: space-between;\n            align-items: flex-start;\n            padding: 5px 0;\n            gap: 8px;\n            min-width: 0;\n        }\n        .card-row > span:first-child {\n            color: #94a3b8;\n            font-size: 0.82rem;\n            flex-shrink: 0;\n            max-width: 48%;\n            line-height: 1.3;\n        }\n        .card-row > strong, .card-row > span:last-child {\n            text-align: right;\n            word-break: break-word;\n            overflow-wrap: anywhere;\n            min-width: 0;\n            font-size: 0.82rem;\n            line-height: 1.3;\n        }\n        .card-divider { height: 1px; background: #222d35; margin: 6px 0; }\n\n        /* Real-time Detailed Status List */\n        .realtime-title {\n            color: var(--green);\n            font-size: 0.88rem;\n            font-weight: 700;\n            margin: 12px 14px 8px 14px;\n            display: flex;\n            align-items: center;\n            gap: 6px;\n        }\n        .realtime-grid {\n            display: grid;\n            grid-template-columns: repeat(2, minmax(0, 1fr));\n            gap: 6px 12px;\n            margin: 0 12px;\n            font-size: 0.8rem;\n        }\n        .rt-row {\n            display: flex;\n            justify-content: space-between;\n            align-items: center;\n            border-bottom: 1px solid #141a20;\n            padding-bottom: 4px;\n            min-width: 0;\n            gap: 4px;\n        }\n        .rt-lbl {\n            color: #8fa0ab;\n            font-size: 0.75rem;\n            white-space: nowrap;\n            overflow: hidden;\n            text-overflow: ellipsis;\n            min-width: 0;\n            flex-shrink: 1;\n        }\n        .rt-val {\n            color: var(--green);\n            font-weight: 700;\n            font-size: 0.78rem;\n            white-space: nowrap;\n            flex-shrink: 0;\n            text-align: right;\n        }\n        .unit-sup { font-size: 0.65rem; font-weight: normal; vertical-align: super; margin-left: 1px; }\n\n        /* Modern Section Headers */\n        .section-hdr { display: flex; justify-content: space-between; align-items: center; margin: 14px 12px 6px 12px; padding: 0 2px; }\n        .hdr-title-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; }\n        .hdr-icon-box { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; flex-shrink: 0; }\n        .hdr-icon-box.cell-icon { background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.35); color: #38bdf8; }\n        .hdr-icon-box.wire-icon { background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.35); color: #c084fc; }\n        .hdr-icon-box.prot-icon { background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.35); color: #34d399; }\n        .hdr-title { font-size: 0.88rem; font-weight: 700; color: #f1f5f9; line-height: 1.2; }\n        .hdr-subtitle { font-size: 0.68rem; color: #94a3b8; font-weight: 500; }\n        .hdr-badges { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }\n        .stat-pill { font-size: 0.64rem; font-weight: 700; padding: 2px 6px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, monospace; white-space: nowrap; }\n        .stat-pill.max-pill { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }\n        .stat-pill.min-pill { background: rgba(244, 63, 94, 0.15); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.3); }\n        .stat-pill.neutral-pill { background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.3); }\n\n        /* Authentic JK App Styling for Cell Voltages & Wire Resistance */\n        .jk-bat-summary {\n            display: flex;\n            justify-content: space-between;\n            align-items: center;\n            flex-wrap: wrap;\n            gap: 4px 10px;\n            padding: 8px 14px 2px 14px;\n            font-size: 0.84rem;\n            font-weight: 700;\n            color: #ffffff;\n        }\n        .jk-bat-summary > span {\n            display: inline-flex;\n            align-items: center;\n        }\n        .jk-bat-summary .jk-dot, .jk-section-title .jk-dot {\n            display: inline-block;\n            width: 7px;\n            height: 7px;\n            border-radius: 50%;\n            background: #00ff2b;\n            box-shadow: 0 0 6px rgba(0, 255, 43, 0.6);\n            margin-right: 6px;\n            flex-shrink: 0;\n        }\n        .jk-bat-summary .unit, .jk-section-title .unit { color: #00ff2b; font-weight: 600; }\n        .jk-bat-summary .val { color: #00ff2b; font-family: -apple-system, BlinkMacSystemFont, \"SF Pro Display\", monospace; font-size: 0.92rem; font-weight: 700; }\n        .jk-divider { height: 1px; background: #1c2630; margin: 8px 14px; }\n\n        .jk-section-title {\n            color: #ffffff;\n            font-size: 0.88rem;\n            font-weight: 700;\n            margin: 10px 14px 6px 14px;\n            display: flex;\n            align-items: center;\n            gap: 2px;\n        }\n        .jk-section-title .colon { color: #ffffff; margin-left: 2px; }\n\n        .jk-grid-3 {\n            display: grid;\n            grid-template-columns: repeat(3, minmax(0, 1fr));\n            column-gap: 4px;\n            row-gap: 8px;\n            margin: 8px 10px 12px 10px;\n        }\n        .jk-cell-item {\n            display: flex;\n            align-items: center;\n            gap: 3px;\n            background: transparent;\n            border: none;\n            padding: 0;\n            min-height: 20px;\n            min-width: 0;\n            overflow: hidden;\n        }\n        .jk-num-badge {\n            background: #14556b;\n            color: #5eead4;\n            min-width: 18px;\n            height: 18px;\n            padding: 0 2px;\n            border-radius: 4px;\n            display: inline-flex;\n            align-items: center;\n            justify-content: center;\n            font-size: 0.68rem;\n            font-weight: 700;\n            font-family: -apple-system, BlinkMacSystemFont, monospace;\n            flex-shrink: 0;\n        }\n        .jk-val-txt {\n            font-size: 0.88rem;\n            font-weight: 700;\n            color: #00ff2b;\n            font-family: -apple-system, BlinkMacSystemFont, \"SF Pro Display\", monospace;\n            font-variant-numeric: tabular-nums;\n            letter-spacing: -0.3px;\n            line-height: 1;\n            white-space: nowrap;\n            overflow: hidden;\n            text-overflow: clip;\n            flex-shrink: 1;\n            min-width: 0;\n        }\n        .jk-val-txt.min { color: #ff0033; }\n        .jk-val-txt.max { color: #00e5ff; }\n        .jk-bal-tag {\n            font-size: 0.58rem;\n            margin-left: 1px;\n            flex-shrink: 0;\n            white-space: nowrap;\n        }\n\n        /* Protection Grid - Chu\u1ea9n Zin JK Active Balancer */\n        .protection-grid {\n            display: grid;\n            grid-template-columns: repeat(2, minmax(0, 1fr));\n            gap: 6px;\n            margin: 8px 12px 14px 12px;\n        }\n        .prot-item {\n            background: var(--card-bg);\n            border: 1px solid var(--card-border);\n            border-radius: 8px;\n            padding: 6px 8px;\n            display: flex;\n            align-items: center;\n            justify-content: space-between;\n            font-size: 0.78rem;\n        }\n        .prot-lbl { color: #aaa; }\n        .prot-badge { padding: 2px 7px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; }\n        .prot-badge.ok { background: rgba(0, 255, 43, 0.15); color: var(--green); border: 1px solid rgba(0,255,43,0.3); }\n        .prot-badge.alarm { background: rgba(255, 59, 48, 0.25); color: var(--red); border: 1px solid var(--red); animation: pulseAlert 1s infinite; }\n        @keyframes pulseAlert { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }\n\n        /* Tab Content Display */\n        .tab-content { display: none; }\n        .tab-content.active { display: block; }\n\n        /* Settings Card Form Elements */\n        .sett-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; padding: 16px; margin: 12px 14px; }\n        .form-group { margin-bottom: 14px; }\n        label { display: block; font-size: 0.82rem; color: var(--text-sub); margin-bottom: 6px; font-weight: 500; }\n        input, select, textarea {\n            width: 100%;\n            padding: 12px 14px;\n            border-radius: 10px;\n            border: 1px solid #2a343d;\n            background: #090c0e;\n            color: #fff;\n            font-size: 16px !important; /* CRITICAL: Ng\u0103n iOS Safari t\u1ef1 zoom khi focus */\n            -webkit-appearance: none;\n            appearance: none;\n            outline: none;\n            -webkit-user-select: text !important;\n            user-select: text !important;\n            transition: border-color 0.2s, box-shadow 0.2s;\n            box-sizing: border-box;\n        }\n        input:focus, select:focus, textarea:focus {\n            border-color: var(--cyan);\n            box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.25);\n        }\n        input::placeholder { color: #555; }\n        .selectable, #lbl-monitor-url, #lbl-wifi-ip, #lbl-ble-mac, #head-sn, [onclick*=\"select\"], input[readonly] {\n            -webkit-user-select: text !important;\n            user-select: text !important;\n        }\n        button.btn {\n            width: 100%;\n            min-height: 44px;\n            padding: 12px 16px;\n            border: none;\n            border-radius: 10px;\n            background: linear-gradient(135deg, #0284c7, #0369a1);\n            color: #fff;\n            font-weight: 700;\n            cursor: pointer;\n            font-size: 0.95rem;\n            margin-top: 6px;\n            display: inline-flex;\n            align-items: center;\n            justify-content: center;\n            gap: 6px;\n            touch-action: manipulation;\n            transition: transform 0.1s ease, opacity 0.1s ease;\n        }\n        button.btn:active, .btn-sec:active { transform: scale(0.97); opacity: 0.85; }\n        button.btn-sec { background: rgba(255,255,255,0.08); border: 1px solid #2a343d; }\n        .list-item { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #090c0e; border-radius: 10px; margin-bottom: 8px; border: 1px solid #1e262c; }\n        .list-item button { min-height: 36px; touch-action: manipulation; }\n\n        /* Bottom Nav Bar with Safe Area Inset */\n        .bottom-nav {\n            position: fixed;\n            bottom: 0;\n            left: 50%;\n            transform: translateX(-50%);\n            width: 100%;\n            max-width: 480px;\n            background: rgba(10, 14, 18, 0.88);\n            backdrop-filter: blur(20px);\n            -webkit-backdrop-filter: blur(20px);\n            border-top: 1px solid rgba(255, 255, 255, 0.08);\n            display: flex;\n            justify-content: space-around;\n            padding-top: 6px;\n            padding-bottom: max(14px, var(--sab));\n            padding-left: var(--sal);\n            padding-right: var(--sar);\n            z-index: 1000;\n        }\n        .nav-btn {\n            display: flex;\n            flex-direction: column;\n            align-items: center;\n            color: #71717a;\n            font-size: 0.72rem;\n            font-weight: 600;\n            cursor: pointer;\n            border: none;\n            background: transparent;\n            width: 33%;\n            padding: 4px 0;\n            touch-action: manipulation;\n            transition: color 0.15s ease, transform 0.1s ease;\n        }\n        .nav-btn:active { transform: scale(0.92); }\n        .nav-btn.active { color: var(--green); }\n        .nav-icon { font-size: 1.3rem; margin-bottom: 2px; }\n    \n        .btn-ok {\n            background: #222;\n            color: var(--green);\n            border: 1px solid var(--green);\n            padding: 5px 12px;\n            border-radius: 6px;\n            font-weight: 800;\n            font-size: 0.82rem;\n            cursor: pointer;\n            transition: all 0.15s ease;\n        }\n        .btn-ok:hover { background: var(--green); color: #000; }\n        .btn-ok:active { transform: scale(0.92); }\n\n    </style>\n</head>\n<body>\n    <div class=\"app\">\n        <!-- STICKY TOP HEADER (PROTECTED FROM PHONE STATUS BAR) -->\n        <header class=\"app-header\">\n            <!-- TOP HEADER BAR -->\n            <div class=\"top-bar\">\n                <div class=\"top-bar-left\">\n                    <a id=\"cloud-back-btn\" href=\"/\" style=\"display:none; color:var(--text-sub); text-decoration:none; font-size:1.15rem; padding:2px 8px; margin-right:6px; font-weight:bold; border-radius:6px; background:rgba(255,255,255,0.08); align-items:center; line-height:1;\" title=\"Quay l\u1ea1i Danh S\u00e1ch Thi\u1ebft B\u1ecb\">\u2190</a>\n                    <div id=\"bt-icon-head\" class=\"bt-status active\" title=\"Connection Status\">\u26a1</div>\n                    <div style=\"min-width:0; flex:1; overflow:hidden;\">\n                        <div style=\"font-weight:bold; font-size:0.92rem; color:#fff; line-height:1.2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;\">\n                            <span id=\"head-bms-name\">JK Active Balancer</span>\n                            <span id=\"head-device-id\" style=\"color:var(--yellow); font-size:0.78rem; font-weight:800; margin-left:4px;\">(ID: #1)</span>\n                        </div>\n                        <div id=\"head-sn\" style=\"font-size:0.68rem; color:var(--text-sub); font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;\">SN: \u2014</div>\n                        <div id=\"esp-online-badge\" style=\"font-size:0.68rem; font-weight:700; color:#00ff2b; display:flex; align-items:center; gap:4px; margin-top:2px;\">\n                            <span id=\"esp-online-dot\" style=\"display:inline-block; width:6px; height:6px; border-radius:50%; background:#00ff2b; box-shadow:0 0 5px #00ff2b;\"></span>\n                            <span id=\"esp-online-txt\">ESP Online</span>\n                        </div>\n                    </div>\n                </div>\n                <div class=\"top-bar-right\">\n                    <div id=\"uptime-display\" class=\"uptime-txt\" title=\"Th\u1eddi gian ho\u1ea1t \u0111\u1ed9ng c\u1ee7a m\u1ea1ch c\u00e2n b\u1eb1ng (Time On)\">Time On: 3d 11h 00m 00s</div>\n                    <button class=\"menu-btn\" onclick=\"showTab('tab-settings', document.getElementById('nav-sett'))\">\u2630</button>\n                </div>\n            </div>\n\n            <!-- BALANCER CONTROLS TOP BAR -->\n            <div class=\"mos-bar\" style=\"justify-content:center; padding:6px 14px;\">\n                <div class=\"mos-item\" onclick=\"toggleBalance()\" style=\"cursor:pointer; flex:1; max-width:280px; justify-content:center;\">\n                    <span style=\"font-weight:700;\">\u2696\ufe0f C\u00e2n B\u1eb1ng (Balance)</span>\n                    <div id=\"dot-balance\" class=\"dot on\"></div>\n                    <span id=\"txt-balance\" class=\"val-on\">ON</span>\n                </div>\n            </div>\n        </header>\n\n        <!-- ==================== TAB 1: HOME (DASHBOARD) ==================== -->\n        <div id=\"tab-home\" class=\"tab-content active\">\n            <!-- CIRCULAR GAUGE WIDGET (DELTA VOLTAGE & PACK STATUS) -->\n            <div class=\"gauge-section\" style=\"text-align:center; padding:10px 0;\">\n                <svg class=\"gauge-svg\" viewBox=\"0 0 200 185\" style=\"width:250px; height:230px; margin:0 auto; display:block;\">\n                    <defs>\n                        <linearGradient id=\"gaugeGrad\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">\n                            <stop offset=\"0%\" stop-color=\"#00e5ff\"/>\n                            <stop offset=\"100%\" stop-color=\"#00ff2b\"/>\n                        </linearGradient>\n                        <filter id=\"neonGlow\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"140%\">\n                            <feGaussianBlur stdDeviation=\"2.5\" result=\"blur\"/>\n                            <feMerge>\n                                <feMergeNode in=\"blur\"/>\n                                <feMergeNode in=\"SourceGraphic\"/>\n                            </feMerge>\n                        </filter>\n                    </defs>\n                    <!-- Background Track Arc (240 deg, R=68) -->\n                    <path d=\"M 41.1,110 A 68,68 0 1,1 158.9,110\" fill=\"none\" stroke=\"#141c22\" stroke-width=\"12\" stroke-linecap=\"round\"/>\n                    <!-- Dotted Guide Ring -->\n                    <circle cx=\"100\" cy=\"76\" r=\"54\" fill=\"none\" stroke=\"#222f38\" stroke-width=\"1\" stroke-dasharray=\"2 4\"/>\n                    <!-- Active Balance Delta Arc (Length = 284.8) -->\n                    <path id=\"gauge-arc\" d=\"M 41.1,110 A 68,68 0 1,1 158.9,110\" fill=\"none\" stroke=\"url(#gaugeGrad)\" stroke-width=\"12\" stroke-linecap=\"round\" stroke-dasharray=\"284.8 350\" stroke-dashoffset=\"284.8\" style=\"transition: stroke-dashoffset 0.6s ease;\" filter=\"url(#neonGlow)\"/>\n\n                    <!-- Label above Delta -->\n                    <text x=\"100\" y=\"50\" text-anchor=\"middle\" dominant-baseline=\"central\" fill=\"#8e8e93\" font-size=\"10\" font-weight=\"700\" font-family=\"-apple-system, sans-serif\" letter-spacing=\"1\">\u0110\u1ed8 L\u1ec6CH CELL</text>\n\n                    <!-- Center Delta mV Text -->\n                    <text id=\"home-soc-txt\" x=\"100\" y=\"76\" text-anchor=\"middle\" dominant-baseline=\"central\" fill=\"#00ff2b\" font-size=\"34\" font-weight=\"900\" font-family=\"-apple-system, sans-serif\" filter=\"url(#neonGlow)\">0 mV</text>\n\n                    <!-- Subtitle below Delta -->\n                    <text id=\"home-delta-sub\" x=\"100\" y=\"100\" text-anchor=\"middle\" dominant-baseline=\"central\" fill=\"#38bdf8\" font-size=\"11\" font-weight=\"700\" font-family=\"-apple-system, sans-serif\">\u0394: 0.000 V</text>\n\n                    <!-- Pill 1: Total Pack Voltage Badge -->\n                    <g transform=\"translate(100, 126)\">\n                        <rect x=\"-70\" y=\"-12\" width=\"140\" height=\"24\" rx=\"12\" fill=\"#000000\" stroke=\"#00ff2b\" stroke-width=\"1.8\"/>\n                        <text id=\"home-v-pill\" x=\"0\" y=\"1\" text-anchor=\"middle\" dominant-baseline=\"central\" fill=\"#00ff2b\" font-size=\"13\" font-weight=\"800\" font-family=\"-apple-system, sans-serif\">T\u1ed5ng: 0.00 V</text>\n                    </g>\n\n                    <!-- Pill 2: Balancing Current Badge -->\n                    <g transform=\"translate(100, 156)\">\n                        <rect x=\"-70\" y=\"-12\" width=\"140\" height=\"24\" rx=\"12\" fill=\"#000000\" stroke=\"#38bdf8\" stroke-width=\"1.8\"/>\n                        <text id=\"home-a-pill\" x=\"0\" y=\"1\" text-anchor=\"middle\" dominant-baseline=\"central\" fill=\"#38bdf8\" font-size=\"13\" font-weight=\"800\" font-family=\"-apple-system, sans-serif\">D\u00f2ng C\u00e2n: 0.00 A</text>\n                    </g>\n                </svg>\n            </div>\n\n            <!-- STATUS NOTIFICATION BANNER -->\n            <div id=\"status-banner\" class=\"status-banner\">\n                <span id=\"banner-icon\" class=\"banner-icon\">\u2714</span>\n                <span id=\"banner-msg\">The battery is functioning properly.</span>\n            </div>\n\n\n\n            <!-- KEY METRICS GRID 1 (4 Columns) -->\n            <div class=\"metrics-grid-4\">\n                <div class=\"metric-item\">\n                    <div id=\"m-high-v\" class=\"metric-val\" style=\"color:var(--cyan);\">0.000</div>\n                    <div class=\"metric-lbl\">High Cell(V):</div>\n                </div>\n                <div class=\"metric-item\">\n                    <div id=\"m-low-v\" class=\"metric-val\" style=\"color:var(--red);\">0.000</div>\n                    <div class=\"metric-lbl\">Low Cell(V):</div>\n                </div>\n                <div class=\"metric-item\">\n                    <div id=\"m-diff-v\" class=\"metric-val\" style=\"color:var(--green);\">0.000</div>\n                    <div class=\"metric-lbl\">Volt.-Diff(V):</div>\n                </div>\n                <div class=\"metric-item\">\n                    <div id=\"m-bal-a\" class=\"metric-val\" style=\"color:var(--green);\">0.000</div>\n                    <div class=\"metric-lbl\">Bal.-Curr.(A):</div>\n                </div>\n            </div>\n\n            <!-- KEY METRICS GRID 2 (NO TEMPERATURE) -->\n            <div class=\"metrics-grid-4\">\n                <div class=\"metric-item\">\n                    <div id=\"m-cell-avg\" class=\"metric-val\" style=\"color:var(--green);\">0.000</div>\n                    <div class=\"metric-lbl\">Cell AVG(V):</div>\n                </div>\n                <div class=\"metric-item\">\n                    <div id=\"m-cap-ah\" class=\"metric-val\" style=\"color:var(--cyan);\">0S</div>\n                    <div class=\"metric-lbl\">S\u1ed1 Cell Pin:</div>\n                </div>\n                <div class=\"metric-item\">\n                    <div id=\"m-cell-min-badge\" class=\"metric-val\" style=\"color:var(--red);\">#0</div>\n                    <div class=\"metric-lbl\">Low Cell:</div>\n                </div>\n                <div class=\"metric-item\">\n                    <div id=\"m-soh\" class=\"metric-val\" style=\"color:var(--green);\">0.000 \u03a9</div>\n                    <div class=\"metric-lbl\">Tr\u1edf D\u00e2y TB:</div>\n                </div>\n            </div>\n\n            <!-- ACTIVE BALANCER STATUS CARD (NO TEMPERATURE) -->\n            <div class=\"info-card-box\" style=\"margin-bottom:20px;\">\n                <div class=\"card-row\">\n                    <span>\u26a1 D\u00f2ng C\u00e2n B\u1eb1ng: <strong id=\"card-curr-val\" style=\"color:var(--cyan); margin-left:4px;\">0.000 A</strong></span>\n                    <span>\ud83d\udd0b D\u1ea3i Ho\u1ea1t \u0110\u1ed9ng: <strong style=\"color:var(--green); margin-left:4px;\">1S - 24S (Auto)</strong></span>\n                </div>\n                <div class=\"card-divider\"></div>\n                <div class=\"card-row\">\n                    <span>\ud83d\udd3b Cell Th\u1ea5p Nh\u1ea5t: <strong id=\"card-cell-min\" style=\"color:var(--red); margin-left:4px;\">\u2014</strong></span>\n                    <span>\ud83d\udd3a Cell Cao Nh\u1ea5t: <strong id=\"card-cell-max\" style=\"color:var(--cyan); margin-left:4px;\">\u2014</strong></span>\n                </div>\n                <div class=\"card-divider\"></div>\n                <div class=\"card-row\">\n                    <span>\ud83d\udd52 Tr\u1ea1ng Th\u00e1i: <strong id=\"card-status-txt\" style=\"color:var(--green); margin-left:4px;\">\u0110ang C\u00e2n B\u1eb1ng</strong></span>\n                    <span>\ud83d\udd0c C\u1ed5ng Giao Ti\u1ebfp: <strong id=\"card-port-txt\" style=\"color:var(--cyan); margin-left:4px;\">UART TTL (C\u1ed5ng LCD JK)</strong></span>\n                </div>\n            </div>\n        </div>\n\n        <!-- ==================== TAB 2: STATUS (REALTIME & CELLS) ==================== -->\n        <div id=\"tab-status\" class=\"tab-content\">\n            <div class=\"realtime-title\">\ud83d\udfe2 \u2022 Th\u00f4ng S\u1ed1 Ho\u1ea1t \u0110\u1ed9ng C\u00e2n B\u1eb1ng Realtime</div>\n            <div class=\"realtime-grid\">\n                <div class=\"rt-row\"><span class=\"rt-lbl\">T\u1ed5ng \u0110i\u1ec7n \u00c1p Pack:</span><span class=\"rt-val\" id=\"rt-bat-v\" style=\"color:var(--green); font-weight:700;\">0.00 V</span></div>\n                <div class=\"rt-row\"><span class=\"rt-lbl\">\u0110i\u1ec7n \u00c1p TB (Cell AVG):</span><span class=\"rt-val\" id=\"rt-avg\" style=\"color:var(--green); font-weight:700;\">0.000 V</span></div>\n\n                <div class=\"rt-row\"><span class=\"rt-lbl\">\u0110\u1ed9 L\u1ec7ch Cell (Delta):</span><span class=\"rt-val\" id=\"rt-diff\" style=\"color:var(--green); font-weight:700;\">0 mV (0.000 V)</span></div>\n                <div class=\"rt-row\"><span class=\"rt-lbl\">D\u00f2ng C\u00e2n B\u1eb1ng:</span><span class=\"rt-val\" id=\"rt-balcurr\" style=\"color:var(--cyan); font-weight:700;\">0.000 A</span></div>\n\n                <div class=\"rt-row\"><span class=\"rt-lbl\">Cell Th\u1ea5p Nh\u1ea5t (Min):</span><span class=\"rt-val\" id=\"rt-min-cell\" style=\"color:var(--red); font-weight:700;\">\u2014</span></div>\n                <div class=\"rt-row\"><span class=\"rt-lbl\">Cell Cao Nh\u1ea5t (Max):</span><span class=\"rt-val\" id=\"rt-max-cell\" style=\"color:var(--cyan); font-weight:700;\">\u2014</span></div>\n\n                <div class=\"rt-row\"><span class=\"rt-lbl\">S\u1ed1 Cell C\u00e0i \u0110\u1eb7t:</span><span class=\"rt-val\" id=\"rt-cell-count\" style=\"font-weight:700;\">0S</span></div>\n                <div class=\"rt-row\"><span class=\"rt-lbl\">C\u00f4ng T\u1eafc C\u00e2n B\u1eb1ng:</span><span id=\"rt-balancer\" class=\"rt-val\" style=\"color:var(--green); font-weight:700;\">B\u1eacT (ON)</span></div>\n                <div class=\"rt-row\"><span class=\"rt-lbl\">\u0110\u1ed9 L\u1ec7ch B\u1eaft \u0110\u1ea7u C\u00e2n:</span><span class=\"rt-val\" id=\"rt-delta-v\" style=\"color:var(--green); font-weight:700;\">0.003 V (3 mV)</span></div>\n                <div class=\"rt-row\"><span class=\"rt-lbl\">D\u00f2ng C\u00e2n T\u1ed1i \u0110a:</span><span class=\"rt-val\" id=\"rt-max-bal-curr\" style=\"color:var(--cyan); font-weight:700;\">4.0 A</span></div>\n\n                <div class=\"rt-row\"><span class=\"rt-lbl\">Tr\u1edf D\u00e2y Nh\u1ecf Nh\u1ea5t:</span><span class=\"rt-val\" id=\"rt-min-wire\" style=\"font-weight:700;\">0.000 \u03a9</span></div>\n                <div class=\"rt-row\"><span class=\"rt-lbl\">Tr\u1edf D\u00e2y L\u1edbn Nh\u1ea5t:</span><span class=\"rt-val\" id=\"rt-max-wire\" style=\"font-weight:700;\">0.000 \u03a9</span></div>\n\n                <div class=\"rt-row\"><span class=\"rt-lbl\">Tr\u1edf D\u00e2y Trung B\u00ecnh:</span><span class=\"rt-val\" id=\"rt-avg-wire\" style=\"font-weight:700;\">0.000 \u03a9</span></div>\n                <div class=\"rt-row\"><span class=\"rt-lbl\">\u0110\u1ecba Ch\u1ec9 Thi\u1ebft B\u1ecb (ID):</span><span class=\"rt-val\" id=\"rt-device-addr\" style=\"color:var(--yellow); font-weight:700;\">#1</span></div>\n                <div class=\"rt-row\"><span class=\"rt-lbl\">Th\u1eddi Gian Ho\u1ea1t \u0110\u1ed9ng (Time On):</span><span class=\"rt-val\" id=\"rt-runtime\" style=\"font-weight:700;\">3d 11h</span></div>\n            </div>\n\n\n\n            <div class=\"jk-section-title\"><span class=\"jk-dot\"></span>Cell Voltages <span class=\"unit\">(V)</span> <span class=\"colon\">:</span></div>\n            <div id=\"cells-grid-3\" class=\"jk-grid-3\"></div>\n\n            <div class=\"jk-divider\"></div>\n\n            <div class=\"jk-section-title\"><span class=\"jk-dot\"></span>Balance Wire Resistance <span class=\"unit\">(\u03a9)</span> <span class=\"colon\">:</span></div>\n            <div id=\"wire-grid-3\" class=\"jk-grid-3\"></div>\n\n            <div class=\"jk-divider\"></div>\n\n\n\n            <div class=\"realtime-title\" style=\"margin-top:18px;\">\ud83d\udccb \u2022 Th\u00f4ng Tin M\u1ea1ch C\u00e2n B\u1eb1ng (Device Information) :</div>\n            <div class=\"info-card-box\" style=\"margin-bottom:16px;\">\n                <div class=\"card-row\"><span>M\u1ea1ch C\u00e2n B\u1eb1ng:</span><strong id=\"dev-info-model\" style=\"color:var(--cyan)\">JK Active Balancer (1S - 24S)</strong></div>\n                <div class=\"card-row\"><span>M\u00e3 Thi\u1ebft B\u1ecb (ID):</span><strong id=\"dev-info-sn\" style=\"color:#fff; font-family:monospace;\">\u2014</strong></div>\n                <div class=\"card-row\"><span>Ph\u1ea7n C\u1ee9ng (HW):</span><strong id=\"dev-info-hw\" style=\"color:#fff\">JK-B1A24S / JK-B2A24S</strong></div>\n                <div class=\"card-row\"><span>B\u1ea3n Firmware ESP:</span><strong id=\"dev-info-sw\" style=\"color:var(--green)\">v1.0.0-BALANCER-LCD</strong></div>\n                <div class=\"card-row\"><span>Chu\u1ea9n Giao Ti\u1ebfp:</span><strong id=\"dev-info-family\" style=\"color:var(--green)\">DWIN DGUS TTL (C\u1ed5ng LCD JK)</strong></div>\n\n            </div>\n        </div>\n\n        <!-- ==================== TAB 3: SETTINGS (BLE & WIFI CONFIG) ==================== -->\n        <div id=\"tab-settings\" class=\"tab-content\">\n            <!-- CLAIM CODE CARD (FOR EASY ACCOUNT BINDING) -->\n            <div class=\"sett-card\" id=\"claim-card\" style=\"background:linear-gradient(135deg,rgba(2,132,199,0.15),rgba(15,23,42,0.9));border:1px solid var(--cyan);box-shadow:0 0 15px rgba(56,189,248,0.2);margin-bottom:14px;border-radius:12px;padding:14px;\">\n                <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;\">\n                    <h3 style=\"color:var(--cyan);font-size:1rem;margin:0;\">\ud83d\udd11 M\u00e3 Li\u00ean K\u1ebft T\u00e0i Kho\u1ea3n</h3>\n                    <span style=\"font-size:0.75rem;background:rgba(56,189,248,0.2);color:var(--cyan);padding:2px 8px;border-radius:10px;font-weight:700;\">D\u00e1n v\u00e0o App Web</span>\n                </div>\n                <div style=\"font-size:0.8rem;color:var(--text-sub);margin-bottom:10px;line-height:1.4;\">\n                    Sao ch\u00e9p m\u00e3 n\u00e0y \u0111\u1ec3 li\u00ean k\u1ebft m\u1ea1ch c\u00e2n b\u1eb1ng v\u00e0o t\u00e0i kho\u1ea3n c\u1ee7a b\u1ea1n tr\u00ean App Web (<strong style=\"color:#fff;\">bms.lha.io.vn</strong>):\n                </div>\n                <div style=\"display:flex;align-items:center;gap:8px;\">\n                    <input id=\"lbl-claim-code\" type=\"text\" readonly\n                        style=\"flex:1;background:#000;border:1px solid #38bdf8;color:#00ff2b;font-family:monospace;font-size:1.15rem;font-weight:800;letter-spacing:2px;text-align:center;padding:8px 10px;border-radius:8px;cursor:pointer;outline:none;\"\n                        onclick=\"this.select()\"\n                        value=\"\u0110ang l\u1ea5y m\u00e3...\">\n                    <button onclick=\"copyClaimCode()\" style=\"background:linear-gradient(135deg,#0284c7,#0369a1);color:#fff;border:none;border-radius:8px;padding:9px 16px;font-size:0.85rem;font-weight:700;cursor:pointer;white-space:nowrap;box-shadow:0 2px 8px rgba(2,132,199,0.4);\">\ud83d\udccb Sao Ch\u00e9p</button>\n                </div>\n                <div id=\"claim-code-copied\" style=\"display:none;color:var(--green);font-size:0.78rem;margin-top:6px;text-align:center;font-weight:700;\">\u2705 \u0110\u00e3 sao ch\u00e9p m\u00e3 li\u00ean k\u1ebft!</div>\n            </div>\n\n            <!-- OFFICIAL JK BALANCER SETTINGS CARD -->\n            <div class=\"sett-card\" style=\"margin-bottom:14px; border:1px solid rgba(0,255,43,0.3); background:rgba(10,18,14,0.85); border-radius:12px; padding:14px;\">\n                <h3 style=\"color:var(--green); margin-bottom:14px; font-size:1.05rem; display:flex; align-items:center; gap:8px;\">\n                    <span>\u2699\ufe0f</span> Th\u00f4ng S\u1ed1 M\u1ea1ch C\u00e2n B\u1eb1ng (JK Balancer Settings)\n                </h3>\n                \n                <div style=\"font-size:0.75rem; color:#8e8e93; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; font-weight:700;\">\ud83d\udfe2 Core Parameters</div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:8px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#fff; font-size:0.88rem;\">Cell Count(s):</span>\n                    <div style=\"display:flex; align-items:center; gap:8px;\">\n                        <input type=\"number\" id=\"inp-cell-count\" min=\"2\" max=\"24\" value=\"6\" style=\"width:70px; background:#000; border:1px solid #444; color:var(--green); font-weight:800; font-family:monospace; text-align:center; padding:5px 6px; border-radius:6px; font-size:0.95rem;\">\n                        <button onclick=\"saveBalancerParam('set_cell_count', 'inp-cell-count')\" class=\"btn-ok\">OK</button>\n                    </div>\n                </div>\n\n                <div style=\"font-size:0.75rem; color:#8e8e93; text-transform:uppercase; letter-spacing:0.5px; margin:14px 0 6px; font-weight:700;\">\ud83d\udd3b Active Balancer</div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:8px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#fff; font-size:0.88rem;\">Balancer (C\u00f4ng t\u1eafc c\u00e2n b\u1eb1ng):</span>\n                    <button id=\"btn-bal-toggle-sett\" onclick=\"toggleBalance()\" style=\"background:#222; border:1px solid #444; color:var(--yellow); font-weight:800; padding:6px 18px; border-radius:14px; cursor:pointer; font-size:0.85rem;\">OFF</button>\n                </div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:8px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#fff; font-size:0.88rem;\">Bal. Delta Volt.(V):</span>\n                    <div style=\"display:flex; align-items:center; gap:8px;\">\n                        <input type=\"number\" id=\"inp-bal-delta\" step=\"0.001\" min=\"0.001\" max=\"1.000\" value=\"0.003\" style=\"width:70px; background:#000; border:1px solid #444; color:var(--green); font-weight:800; font-family:monospace; text-align:center; padding:5px 6px; border-radius:6px; font-size:0.95rem;\">\n                        <button onclick=\"saveBalancerParam('set_delta_volt', 'inp-bal-delta')\" class=\"btn-ok\">OK</button>\n                    </div>\n                </div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:8px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#fff; font-size:0.88rem;\">Max. Bal. Current(A):</span>\n                    <div style=\"display:flex; align-items:center; gap:8px;\">\n                        <input type=\"number\" id=\"inp-bal-max-curr\" step=\"0.1\" min=\"0.1\" max=\"5.0\" value=\"0.5\" style=\"width:70px; background:#000; border:1px solid #444; color:var(--green); font-weight:800; font-family:monospace; text-align:center; padding:5px 6px; border-radius:6px; font-size:0.95rem;\">\n                        <button onclick=\"saveBalancerParam('set_max_current', 'inp-bal-max-curr')\" class=\"btn-ok\">OK</button>\n                    </div>\n                </div>\n\n                <div style=\"font-size:0.75rem; color:#8e8e93; text-transform:uppercase; letter-spacing:0.5px; margin:14px 0 6px; font-weight:700;\">\ud83d\udd3b Data and Communication</div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:8px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#fff; font-size:0.88rem;\">Device Address:</span>\n                    <div style=\"display:flex; align-items:center; gap:8px;\">\n                        <input type=\"number\" id=\"inp-bal-addr\" min=\"1\" max=\"247\" value=\"1\" style=\"width:70px; background:#000; border:1px solid #444; color:var(--green); font-weight:800; font-family:monospace; text-align:center; padding:5px 6px; border-radius:6px; font-size:0.95rem;\">\n                        <button onclick=\"saveBalancerParam('set_device_address', 'inp-bal-addr')\" class=\"btn-ok\">OK</button>\n                    </div>\n                </div>\n\n                <div style=\"font-size:0.75rem; color:#8e8e93; text-transform:uppercase; letter-spacing:0.5px; margin:14px 0 6px; font-weight:700;\">\ud83d\udd3b Factory & Information (JiKong Balancer)</div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:6px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#8e8e93; font-size:0.82rem;\">Volt Calibration(V):</span>\n                    <strong id=\"bal-cfg-volt-calib\" style=\"color:var(--green); font-family:monospace; font-size:0.88rem;\">23.41 V</strong>\n                </div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:6px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#8e8e93; font-size:0.82rem;\">Vendor ID:</span>\n                    <strong id=\"bal-about-vendor\" style=\"color:var(--green); font-family:monospace; font-size:0.88rem;\">JK_B5A24S</strong>\n                </div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:6px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#8e8e93; font-size:0.82rem;\">Serial Number:</span>\n                    <strong id=\"bal-about-sn\" style=\"color:var(--green); font-family:monospace; font-size:0.88rem;\">604130F0293</strong>\n                </div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:6px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#8e8e93; font-size:0.82rem;\">Hardware Version:</span>\n                    <strong id=\"bal-about-hw\" style=\"color:#fff; font-family:monospace; font-size:0.88rem;\">V11U</strong>\n                </div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:6px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#8e8e93; font-size:0.82rem;\">Software Version:</span>\n                    <strong id=\"bal-about-sw\" style=\"color:var(--green); font-family:monospace; font-size:0.88rem;\">V11.57</strong>\n                </div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:6px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#8e8e93; font-size:0.82rem;\">Power-on Times:</span>\n                    <strong id=\"bal-about-power-on\" style=\"color:var(--green); font-family:monospace; font-size:0.88rem;\">\u2014</strong>\n                </div>\n                <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:6px; background:rgba(0,0,0,0.5); border-radius:8px;\">\n                    <span style=\"color:#8e8e93; font-size:0.82rem;\">First On Date:</span>\n                    <strong id=\"bal-about-first-on\" style=\"color:var(--green); font-family:monospace; font-size:0.88rem;\">\u2014</strong>\n                </div>\n            </div>\n\n            <!-- WIFI CONFIG & STATUS -->\n            <div class=\"sett-card\" id=\"wifi-card\">\n                <h3 style=\"color:var(--cyan); margin-bottom:10px; font-size:1rem;\">\ud83d\udce1 Tr\u1ea1ng Th\u00e1i Wi-Fi & M\u1ea1ng</h3>\n                \n                <!-- CONNECTED VIEW (Default when already connected) -->\n                <div id=\"wifi-connected-view\" style=\"display:block;\">\n                    <div class=\"list-item\" style=\"display:flex; justify-content:space-between; align-items:center; padding:12px; margin-bottom:10px; border-left:4px solid var(--green); background:rgba(15,23,42,0.7);\">\n                        <div>\n                            <div style=\"font-weight:700; font-size:0.95rem; color:#fff;\" id=\"lbl-wifi-ssid\">\ud83d\udcf6 \u0110ang ki\u1ec3m tra...</div>\n                            <div style=\"font-size:0.8rem; color:var(--text-sub); margin-top:3px;\">IP: <span id=\"lbl-wifi-ip\" style=\"color:var(--cyan); font-family:monospace;\">\u2014</span></div>\n                        </div>\n                        <div style=\"text-align:right;\">\n                            <span class=\"cell-badge\" style=\"background:rgba(63,185,80,0.2); color:var(--green); border:1px solid var(--green); width:auto; padding:3px 8px; font-size:0.75rem; border-radius:12px;\" id=\"lbl-wifi-status\">\u25cf \u0110ang k\u1ebft n\u1ed1i</span>\n                            <div style=\"font-size:0.72rem; color:var(--text-sub); margin-top:4px;\" id=\"lbl-wifi-rssi\">T\u00edn hi\u1ec7u: \u2014</div>\n                        </div>\n                    </div>\n                    <!-- Monitor URL card -->\n                    <div id=\"monitor-url-card\" style=\"display:block; margin-top:10px; background:rgba(0,119,182,0.12); border:1px solid #0077b6; border-radius:10px; padding:10px 12px;\">\n                        <div style=\"font-size:0.75rem; color:var(--text-sub); margin-bottom:5px;\">\ud83c\udf10 Link xem BMS t\u1eeb xa (Cloud Monitor):</div>\n                        <div style=\"display:flex; align-items:center; gap:8px;\">\n                            <input id=\"lbl-monitor-url\" type=\"text\" readonly\n                                style=\"flex:1; background:#000; border:1px solid #333; color:var(--cyan); font-family:monospace; font-size:0.78rem; padding:6px 10px; border-radius:7px; cursor:pointer; outline:none;\"\n                                onclick=\"this.select()\"\n                                value=\"https://bms.lha.io.vn/d/JKBMS-C4CA\">\n                            <button onclick=\"copyMonitorUrl()\" style=\"background:var(--badge-bg); color:#fff; border:none; border-radius:7px; padding:6px 12px; font-size:0.8rem; cursor:pointer; white-space:nowrap;\">\ud83d\udccb Copy</button>\n                        </div>\n                        <div id=\"monitor-url-copied\" style=\"display:none; color:var(--green); font-size:0.75rem; margin-top:4px; text-align:center;\">\u2705 \u0110\u00e3 sao ch\u00e9p!</div>\n                    </div>\n                    <div style=\"display:flex; gap:8px; margin-top:10px;\">\n                        <button class=\"btn btn-sec\" onclick=\"toggleWifiForm(true)\" style=\"flex:1;\">\ud83d\udd04 \u0110\u1ed5i / C\u00e0i Wi-Fi Kh\u00e1c</button>\n                        <button onclick=\"resetWifi()\" class=\"btn btn-sec\" style=\"flex:1; border-color:var(--red); color:var(--red);\">\u267b\ufe0f Reset Wi-Fi</button>\n                    </div>\n                </div>\n\n                <!-- CONFIGURATION FORM (Hidden by default when connected; shown in AP mode, on reset, or when clicking '\u0110\u1ed5i Wi-Fi') -->\n                <div id=\"wifi-config-view\" style=\"display:none; margin-top:10px;\">\n                    <button class=\"btn btn-sec\" onclick=\"scanWifi()\">\ud83d\udd04 Qu\u00e9t M\u1ea1ng Wi-Fi Xung Quanh</button>\n                    <div id=\"wifi-list\" style=\"margin-top:8px;\"></div>\n\n                    <form id=\"cfg-form\" onsubmit=\"saveConfig(event)\" style=\"margin-top:10px;\">\n                        <div class=\"form-group\">\n                            <label>T\u00ean M\u1ea1ng Wi-Fi (SSID)</label>\n                            <input type=\"text\" id=\"ssid\" required placeholder=\"T\u00ean Wi-Fi\">\n                        </div>\n                        <div class=\"form-group\">\n                            <label>M\u1eadt Kh\u1ea9u Wi-Fi</label>\n                            <input type=\"password\" id=\"pass\" placeholder=\"M\u1eadt kh\u1ea9u\">\n                        </div>\n                        <input type=\"hidden\" id=\"mqtt_srv\" value=\"192.168.1.100\">\n                        <input type=\"hidden\" id=\"mqtt_port\" value=\"1883\">\n                        <div style=\"display:flex; gap:8px;\">\n                            <button type=\"submit\" id=\"btn-save-wifi\" class=\"btn\" style=\"flex:1;\">\ud83d\udcbe L\u01b0u & K\u1ebft N\u1ed1i</button>\n                            <button type=\"button\" class=\"btn btn-sec\" onclick=\"toggleWifiForm(false)\" style=\"flex:1;\" id=\"btn-cancel-wifi\">H\u1ee7y B\u1ecf</button>\n                        </div>\n                        <div id=\"wifi-msg\" style=\"margin-top:8px; font-size:0.8rem; text-align:center;\"></div>\n                    </form>\n                    <button onclick=\"resetWifi()\" class=\"btn btn-sec\" style=\"border-color:var(--red); color:var(--red); margin-top:12px;\">\u267b\ufe0f Reset C\u00e0i \u0110\u1eb7t Wi-Fi V\u1ec1 M\u1eb7c \u0110\u1ecbnh</button>\n                </div>\n            </div>\n\n\n\n            <!-- LOCAL OTA UPDATE -->\n            <div class=\"sett-card\">\n                <h3 style=\"color:var(--cyan); margin-bottom:8px; font-size:1rem;\">\u2699\ufe0f N\u1ea1p Firmware M\u1edbi (Local OTA)</h3>\n                <div class=\"form-group\">\n                    <label>Ch\u1ecdn file firmware (.bin):</label>\n                    <input type=\"file\" id=\"ota-file\" accept=\".bin\">\n                </div>\n                <button class=\"btn\" onclick=\"uploadFirmwareOTA()\">\ud83d\ude80 B\u1eaft \u0110\u1ea7u N\u1ea1p OTA</button>\n                <div id=\"ota-progress-box\" style=\"display:none; margin-top:12px; text-align:center;\">\n                    <p id=\"ota-status-text\" style=\"color:var(--cyan); font-size:0.85rem;\">\u0110ang n\u1ea1p...</p>\n                    <div style=\"background:#222; border-radius:8px; height:10px; margin-top:6px; overflow:hidden;\">\n                        <div id=\"ota-bar\" style=\"background:var(--green); height:100%; width:0%;\"></div>\n                    </div>\n                </div>\n            </div>\n        </div>\n\n        <!-- BOTTOM NAVIGATION BAR -->\n        <div class=\"bottom-nav\">\n            <button id=\"nav-status\" class=\"nav-btn\" onclick=\"showTab('tab-status', this)\">\n                <span class=\"nav-icon\">\ud83c\udf9b\ufe0f</span>\n                <span>Status</span>\n            </button>\n            <button id=\"nav-home\" class=\"nav-btn active\" onclick=\"showTab('tab-home', this)\">\n                <span class=\"nav-icon\">\ud83c\udfe0</span>\n                <span>Home</span>\n            </button>\n            <button id=\"nav-sett\" class=\"nav-btn\" onclick=\"showTab('tab-settings', this)\">\n                <span class=\"nav-icon\">\u2699\ufe0f</span>\n                <span>Settings</span>\n            </button>\n        </div>\n    </div>\n\n        <script>\n\n        let _cloudDevId = (window._cloudDevId && typeof window._cloudDevId === 'string') ? window._cloudDevId : '';\n        if (!_cloudDevId) {\n            const p = window.location.pathname;\n            if (p.includes('/d/')) {\n                _cloudDevId = p.split('/d/')[1].split('/')[0].split('?')[0];\n            } else if (p.includes('/device/')) {\n                _cloudDevId = p.split('/device/')[1].split('/')[0].split('?')[0];\n            }\n        }\n        const _isCloud = !!_cloudDevId || \n                         window.location.hostname.endsWith('lha.io.vn') || \n                         window.location.hostname.includes('workers.dev') || \n                         window.location.hostname.includes('pages.dev');\n\n        async function fetchClaimCode() {\n            const inp = document.getElementById('lbl-claim-code');\n            if (!inp) return;\n            if (inp.value && inp.value !== '\u0110ang l\u1ea5y m\u00e3...' && inp.value.length >= 4) return;\n            try {\n                if (!_isCloud) {\n                    const res = await fetch('/api/claim-code');\n                    if (res.ok) {\n                        const d = await res.json();\n                        if (d && d.claim_code) {\n                            inp.value = d.claim_code;\n                            return;\n                        }\n                    }\n                    const res2 = await fetch('/api/settings');\n                    if (res2.ok) {\n                        const s = await res2.json();\n                        if (s && s.claim_code) {\n                            inp.value = s.claim_code;\n                            return;\n                        }\n                    }\n                } else if (_cloudDevId) {\n                    const res = await fetch(`/api/devices?device_id=${encodeURIComponent(_cloudDevId)}&_t=${Date.now()}`);\n                    if (res.ok) {\n                        const d = await res.json();\n                        let item = d;\n                        if (Array.isArray(d)) item = d[0];\n                        else if (d.Devices && Array.isArray(d.Devices)) item = d.Devices[0];\n                        else if (d.devices && Array.isArray(d.devices)) item = d.devices[0];\n                        if (item && item.claim_code) {\n                            inp.value = item.claim_code;\n                            return;\n                        }\n                    }\n                }\n            } catch(e) {\n                console.warn('[ClaimCode] Fetch error:', e);\n            }\n        }\n\n        window.addEventListener('DOMContentLoaded', () => {\n            if (_isCloud) {\n                const btn = document.getElementById('cloud-back-btn');\n                if (btn) btn.style.display = 'inline-flex';\n            }\n        });\n\n        \n        async function saveBalancerParam(cmdName, inputId, btn) {\n            const el = document.getElementById(inputId);\n            if (!el) return;\n            const val = parseFloat(el.value);\n            if (isNaN(val)) return alert('Gi\u00e1 tr\u1ecb kh\u00f4ng h\u1ee3p l\u1ec7!');\n            let origTxt = 'OK';\n            if (btn) {\n                origTxt = btn.textContent;\n                btn.textContent = '\u23f3';\n                btn.disabled = true;\n            }\n            try {\n                if (_isCloud) {\n                    const devId = _cloudDevId || 'JKBMS-C4CA';\n                    await fetch('/api/send-command', {\n                        method: 'POST',\n                        headers: {'Content-Type': 'application/json'},\n                        body: JSON.stringify({ device_id: devId, cmd: { cmd: cmdName, val: val, value: val } })\n                    });\n                } else {\n                    await fetch('/api/command', {\n                        method: 'POST',\n                        headers: {'Content-Type': 'application/json'},\n                        body: JSON.stringify({ cmd: cmdName, val: val, value: val })\n                    });\n                }\n                showConnectToast('\u2705 \u0110\u00e3 l\u01b0u c\u00e0i \u0111\u1eb7t ' + val + '!');\n                if (btn) {\n                    btn.textContent = '\u2705';\n                    setTimeout(() => { btn.textContent = origTxt; btn.disabled = false; }, 1500);\n                }\n                setTimeout(fetchTelemetry, 600);\n            } catch(e) {\n                alert('L\u1ed7i g\u1eedi c\u00e0i \u0111\u1eb7t: ' + e.message);\n                if (btn) { btn.textContent = origTxt; btn.disabled = false; }\n            }\n        }\n\n        async function toggleBalance() {\n            const curVal = (window._lastTelemetry && window._lastTelemetry.balance !== undefined) ? window._lastTelemetry.balance : ((window._lastTelemetry && window._lastTelemetry.balanceActive !== undefined) ? window._lastTelemetry.balanceActive : false);\n            const newVal = !curVal;\n            try {\n                if (_isCloud && _cloudDevId) {\n                    await fetch('/api/send-command', {\n                        method: 'POST',\n                        headers: {'Content-Type': 'application/json'},\n                        body: JSON.stringify({ device_id: _cloudDevId, cmd: { cmd: 'balance', val: newVal, value: newVal ? 1 : 0 } })\n                    });\n                } else {\n                    await fetch('/api/command', {\n                        method: 'POST',\n                        headers: {'Content-Type': 'application/json'},\n                        body: JSON.stringify({ cmd: 'balance', val: newVal, value: newVal ? 1 : 0 })\n                    });\n                }\n                if (window._lastTelemetry) {\n                    window._lastTelemetry.balance = newVal;\n                    window._lastTelemetry.balanceActive = newVal;\n                }\n                updateMosDot('balance', newVal);\n                const btnSw = document.getElementById('btn-bal-toggle-sett');\n                if (btnSw) {\n                    btnSw.textContent = newVal ? 'ON' : 'OFF';\n                    btnSw.style.color = newVal ? 'var(--green)' : 'var(--yellow)';\n                }\n                setTimeout(fetchTelemetry, 600);\n            } catch(e) {\n                console.error('Toggle balance error:', e);\n            }\n        }\n\n        let currentPacks = [];\n        let mosStates = { charge_mos: true, discharge_mos: true, balance: true };\n        let mosCmdLockMs = 0;\n        let _wasConnected = null;\n\n        function showConnectToast(bmsName) {\n            let toast = document.getElementById('connect-toast');\n            if (!toast) {\n                toast = document.createElement('div');\n                toast.id = 'connect-toast';\n                toast.style.cssText = 'position:fixed; top:70px; left:50%; transform:translateX(-50%) translateY(-20px); background:linear-gradient(135deg,rgba(0,255,43,0.18),rgba(0,229,255,0.18)); border:1px solid var(--green); border-radius:12px; padding:12px 20px; z-index:9999; font-size:0.9rem; font-weight:700; color:#fff; text-align:center; box-shadow:0 0 24px rgba(0,255,43,0.3); opacity:0; transition:all 0.4s ease; max-width:320px; width:90%;';\n                document.body.appendChild(toast);\n            }\n            toast.innerHTML = '\ud83d\udd0b \u0110\u00e3 k\u1ebft n\u1ed1i BMS JK<br><span style=\"color:var(--green); font-size:0.82rem; font-weight:500;\">' + bmsName + '</span><br><span style=\"color:var(--cyan); font-size:0.75rem;\">\u0110ang nh\u1eadn d\u1eef li\u1ec7u pin...</span>';\n            toast.style.opacity = '1';\n            toast.style.transform = 'translateX(-50%) translateY(0)';\n            setTimeout(() => {\n                toast.style.opacity = '0';\n                toast.style.transform = 'translateX(-50%) translateY(-20px)';\n            }, 4000);\n        }\n\n        function showTab(id, btn) {\n            const tabs = ['tab-home', 'tab-status', 'tab-settings'];\n            tabs.forEach(tId => {\n                const el = document.getElementById(tId);\n                if (el) {\n                    el.style.display = 'none';\n                    el.classList.remove('active');\n                }\n            });\n            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));\n\n            const targetEl = document.getElementById(id);\n            if (targetEl) {\n                targetEl.style.display = 'block';\n                targetEl.classList.add('active');\n            }\n            if (btn) btn.classList.add('active');\n            if (id === 'tab-settings') fetchClaimCode();\n            if (id === 'tab-home' || id === 'tab-status' || id === 'tab-settings') fetchTelemetry();\n            window.scrollTo({ top: 0, behavior: 'instant' });\n        }\n\n        // \u2500\u2500 DOM Cache & Fast Dirty-Set \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n        const $ = id => document.getElementById(id);\n        const _el = {};\n        function _c(id) { return _el[id] || (_el[id] = $(id)); }\n        function _set(id, val) {\n            const el = _c(id);\n            if (el) {\n                const s = String(val);\n                if (el.textContent !== s) el.textContent = s;\n            }\n        }\n\n        // \u2500\u2500 State Tracking \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n        let _lastCellHash  = '';\n        let _lastResistHash = '';\n        let _lastErrMask  = -1;\n        let _lastCellCnt  = 0;\n        let _lastConnState = null;\n        let _pollActive = false;\n\n        const PROT_ITEMS = [\n            { bit: 0,  desc: \"L\u1ec7ch tr\u1edf d\u00e2y\" },\n            { bit: 1,  desc: \"Qu\u00e1 nhi\u1ec7t MOS\" },\n            { bit: 2,  desc: \"L\u1ec7ch s\u1ed1 cell\" },\n            { bit: 4,  desc: \"Pin \u0111\u00e3 s\u1ea1c \u0111\u1ea7y\" },\n            { bit: 5,  desc: \"Qu\u00e1 \u00e1p pack\" },\n            { bit: 6,  desc: \"Qu\u00e1 d\u00f2ng s\u1ea1c\" },\n            { bit: 7,  desc: \"Ng\u1eafn m\u1ea1ch s\u1ea1c\" },\n            { bit: 8,  desc: \"Qu\u00e1 nhi\u1ec7t s\u1ea1c\" },\n            { bit: 9,  desc: \"Qu\u00e1 l\u1ea1nh s\u1ea1c\" },\n            { bit: 11, desc: \"Th\u1ea5p \u00e1p cell\" },\n            { bit: 12, desc: \"Th\u1ea5p \u00e1p pack\" },\n            { bit: 13, desc: \"Qu\u00e1 d\u00f2ng x\u1ea3\" },\n            { bit: 14, desc: \"Ng\u1eafn m\u1ea1ch x\u1ea3\" },\n            { bit: 15, desc: \"Qu\u00e1 nhi\u1ec7t x\u1ea3\" },\n            { bit: 19, desc: \"M\u1eadt kh\u1ea9u m\u1eb7c \u0111\u1ecbnh\" },\n            { bit: 27, desc: \"Qu\u00e1 l\u1ea1nh x\u1ea3\" }\n        ];\n\n        let _consecutiveFailures = 0;\n        async function fetchTelemetry() {\n            if (_pollActive) return;\n            _pollActive = true;\n            const controller = new AbortController();\n            const timeoutId = setTimeout(() => controller.abort(), 6000);\n            try {\n                let fetchUrl = '/api/telemetry';\n                if (_isCloud) {\n                    const devIdToFetch = _cloudDevId || 'JKBMS-C4CA';\n                    fetchUrl = `/api/devices?device_id=${encodeURIComponent(devIdToFetch)}&watch=1&_t=${Date.now()}`;\n                }\n                const res = await fetch(fetchUrl, { signal: controller.signal });\n                clearTimeout(timeoutId);\n                if (!res.ok) throw new Error('HTTP ' + res.status);\n                const rawText = await res.text();\n                const cleanText = rawText.replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]/g, '');\n                let jsonParsed = JSON.parse(cleanText);\n                let d = jsonParsed;\n                if (Array.isArray(d)) d = d[0];\n                else if (d.Devices && Array.isArray(d.Devices)) d = d.Devices[0];\n                else if (d.devices && Array.isArray(d.devices)) d = d.devices[0];\n\n                if (!d) throw new Error('D\u1eef li\u1ec7u r\u1ed7ng');\n\n                // Normalize fields between Cloud (snake_case) and Local (camelCase)\n                if (d.totalVoltage === undefined && d.voltage !== undefined) d.totalVoltage = d.voltage;\n                if (d.deltaCellVoltage === undefined && d.delta_cell_voltage !== undefined) d.deltaCellVoltage = d.delta_cell_voltage;\n                if (d.balanceCurrent === undefined && d.balance_current !== undefined) d.balanceCurrent = d.balance_current;\n                if (d.balanceActive === undefined && d.balance_active !== undefined) d.balanceActive = d.balance_active;\n                if (d.balanceActive === undefined && d.balance !== undefined) d.balanceActive = d.balance;\n                if (!d.cells && d.cell_voltages) d.cells = d.cell_voltages;\n                if (!d.cellResistances && d.cell_resistances) d.cellResistances = d.cell_resistances;\n                if (d.minCellVoltage === undefined && d.min_cell_voltage !== undefined) d.minCellVoltage = d.min_cell_voltage;\n                if (d.maxCellVoltage === undefined && d.max_cell_voltage !== undefined) d.maxCellVoltage = d.max_cell_voltage;\n                if (d.avgCellVoltage === undefined && d.avg_cell_voltage !== undefined) d.avgCellVoltage = d.avg_cell_voltage;\n                if (d.cellCount === undefined && d.cell_count !== undefined) d.cellCount = d.cell_count;\n                if (d.minCellNum === undefined && d.min_cell_num !== undefined) d.minCellNum = d.min_cell_num;\n                if (d.maxCellNum === undefined && d.max_cell_num !== undefined) d.maxCellNum = d.max_cell_num;\n                if (d.serialNumber === undefined && d.serial_number !== undefined) d.serialNumber = d.serial_number;\n                if (d.modelName === undefined && d.model_name !== undefined) d.modelName = d.model_name;\n                if (d.vendorId === undefined && d.vendor_id !== undefined) d.vendorId = d.vendor_id;\n                if (d.hardwareVersion === undefined && d.hardware_version !== undefined) d.hardwareVersion = d.hardware_version;\n                if (d.softwareVersion === undefined && d.software_version !== undefined) d.softwareVersion = d.software_version;\n                if (d.balDeltaVolt === undefined && d.bal_delta_volt !== undefined) d.balDeltaVolt = d.bal_delta_volt;\n                if (d.maxBalCurrent === undefined && d.max_bal_current !== undefined) d.maxBalCurrent = d.max_bal_current;\n                if (d.deviceAddress === undefined && d.device_address !== undefined) d.deviceAddress = d.device_address;\n                if (d.balStartVolt === undefined && d.bal_start_volt !== undefined) d.balStartVolt = d.bal_start_volt;\n                window._lastTelemetry = d;\n                _consecutiveFailures = 0;\n\n                // Update ESP / Cloud Online Badge\n                const dot = _c('esp-online-dot');\n                const txt = _c('esp-online-txt');\n                const badge = _c('esp-online-badge');\n                if (dot && txt && badge) {\n                    if (_isCloud) {\n                        const isLive = (d.online !== false);\n                        dot.style.background = isLive ? '#00ff2b' : '#ff3b30';\n                        dot.style.boxShadow = isLive ? '0 0 5px #00ff2b' : 'none';\n                        txt.textContent = isLive ? 'Cloud Online' : `Offline (${d.lastSeenAgo || 0}s)`;\n                        badge.style.color = isLive ? '#00ff2b' : '#ff3b30';\n                    } else {\n                        dot.style.background = '#00ff2b';\n                        dot.style.boxShadow = '0 0 5px #00ff2b';\n                        txt.textContent = 'ESP Online';\n                        badge.style.color = '#00ff2b';\n                    }\n                }\n\n                // Update Official Balancer Settings Card\n                \n                // Define isConn for entire telemetry update scope\n                const isConn = !_isCloud\n                    ? (d.connected === true || d.connected === undefined)\n                    : (d.online !== false && (d.lastSeenAgo === undefined || d.lastSeenAgo < 60));\n\n                // Update inputs if user not actively typing\n                const inpCell = document.getElementById('inp-cell-count');\n                if (inpCell && document.activeElement !== inpCell && d.cellCount) inpCell.value = d.cellCount;\n                const inpDelta = document.getElementById('inp-bal-delta');\n                if (inpDelta && document.activeElement !== inpDelta && d.balDeltaVolt) inpDelta.value = d.balDeltaVolt;\n                const inpMaxC = document.getElementById('inp-bal-max-curr');\n                if (inpMaxC && document.activeElement !== inpMaxC && d.maxBalCurrent) inpMaxC.value = d.maxBalCurrent;\n                const inpAddr = document.getElementById('inp-bal-addr');\n                if (inpAddr && document.activeElement !== inpAddr && d.deviceAddress !== undefined) inpAddr.value = d.deviceAddress;\n                _set('bal-cfg-volt-calib', isConn && d.totalVoltage ? `${d.totalVoltage.toFixed(2)} V` : '23.41 V');\n\n                const monCard = _c('monitor-url-card');\n                if (monCard) monCard.style.display = 'block';\n                const monInput = _c('lbl-monitor-url');\n                const curDevId = d.device_id || _cloudDevId || 'JKBMS-C4CA';\n                if (monInput) monInput.value = 'https://bms.lha.io.vn/d/' + curDevId;\n\n                const claimInput = _c('lbl-claim-code');\n                if (claimInput && d.claim_code) {\n                    claimInput.value = d.claim_code;\n                }\n\n                const isBalSw = (d.balance !== undefined) ? !!d.balance : (d.balance_switch !== undefined ? !!d.balance_switch : !!d.balanceActive);\n                const curBalA = (d.balanceCurrent !== undefined && d.balanceCurrent > 0) ? d.balanceCurrent : (d.balance_current !== undefined && d.balance_current > 0 ? d.balance_current : 0);\n                const isBalAct = (d.balance_active !== undefined) ? !!d.balance_active : (isBalSw && curBalA > 0.02);\n                window._lastBalAct = isBalAct;\n                window._lastBalCur = curBalA;\n\n                const btnBalSett = _c('btn-bal-toggle-sett');\n                if (btnBalSett) {\n                    btnBalSett.textContent = isBalSw ? 'ON' : 'OFF';\n                    btnBalSett.style.color = isBalSw ? 'var(--green)' : 'var(--yellow)';\n                    btnBalSett.style.background = isBalSw ? 'rgba(0,255,43,0.15)' : '#222';\n                    btnBalSett.style.borderColor = isBalSw ? 'var(--green)' : '#444';\n                }\n                const balSwEl = _c('bal-cfg-switch');\n                if (balSwEl) {\n                    balSwEl.textContent = isBalSw ? 'ON' : 'OFF';\n                    balSwEl.style.color = isBalSw ? 'var(--green)' : 'var(--yellow)';\n                }\n                const dDelta = (d.balDeltaVolt !== undefined && d.balDeltaVolt > 0) ? d.balDeltaVolt : 0.003;\n                _set('bal-cfg-delta', `${dDelta.toFixed(3)} V (${Math.round(dDelta * 1000)} mV)`);\n                const dMaxCurr = (d.maxBalCurrent !== undefined && d.maxBalCurrent > 0) ? d.maxBalCurrent : 0.5;\n                _set('bal-cfg-max-curr', `${dMaxCurr.toFixed(1)} A`);\n                _set('bal-cfg-address', d.deviceAddress !== undefined ? `${d.deviceAddress}` : '1');\n\n                _set('bal-cfg-volt-calib', isConn && d.totalVoltage ? `${d.totalVoltage.toFixed(2)} V` : '23.41 V');\n                _set('bal-about-vendor', d.vendorId || d.modelName || 'JK_B5A24S');\n                _set('bal-about-sn', d.serialNumber || '604130F0293');\n                _set('bal-about-hw', d.hardwareVersion || 'V11U');\n                _set('bal-about-sw', d.softwareVersion || 'V11.57');\n                _set('bal-about-power-on', d.power_on_count ? `${d.power_on_count} l\u1ea7n` : '15 l\u1ea7n');\n                _set('bal-about-first-on', (d.activated_at && d.activated_at.length > 0) ? d.activated_at : '27/09/2026');\n\n                // isConn already initialized above\n\n                // \u2500\u2500 Connection Header Icon \u2500\u2500\n                const btIcon = _c('bt-icon-head');\n                if (btIcon) {\n                    if (d.conn_type === 2) {\n                        btIcon.textContent = '\ud83d\udd0c';\n                    } else if (d.conn_type === 1) {\n                        btIcon.textContent = '\ud83d\udcf6';\n                    } else {\n                        btIcon.textContent = '\u26d4';\n                    }\n                    const hasActive = btIcon.classList.contains('active');\n                    if (isConn && !hasActive) btIcon.classList.add('active');\n                    else if (!isConn && hasActive) btIcon.classList.remove('active');\n                }\n\n                // \u2500\u2500 Cumulative Total Runtime (Time On) \u2500\u2500 \u01afu ti\u00ean d\u00f9ng chu\u1ed7i \u0111\u00e3 format t\u1eeb server\n                let fmtRuntime = '';\n                if (d.total_runtime_formatted && d.total_runtime_formatted.length > 2) {\n                    // Server tr\u1ea3 v\u1ec1 d\u1ea1ng \"3D 13h 28m\" -> hi\u1ec3n th\u1ecb tr\u1ef1c ti\u1ebfp\n                    fmtRuntime = d.total_runtime_formatted;\n                } else {\n                    const rawSec = (d.totalRuntimeSec && d.totalRuntimeSec > 0) ? d.totalRuntimeSec : ((d.total_runtime_sec && d.total_runtime_sec > 0) ? d.total_runtime_sec : (d.uptimeSec || 0));\n                    const days = Math.floor(rawSec / 86400);\n                    const hours = Math.floor((rawSec % 86400) / 3600);\n                    const mins = Math.floor((rawSec % 3600) / 60);\n                    const ss = rawSec % 60;\n                    fmtRuntime = `${days}d ${hours.toString().padStart(2,'0')}h ${mins.toString().padStart(2,'0')}m ${ss.toString().padStart(2,'0')}s`;\n                }\n                _set('uptime-display', 'Time On: ' + fmtRuntime);\n\n                // \u2500\u2500 Active Balancer Delta Gauge \u2500\u2500\n                const deltaMv = isConn ? Math.round((d.deltaCellVoltage || 0) * 1000) : 0;\n                _set('home-soc-txt', isConn ? `${deltaMv} mV` : '0 mV');\n                _set('home-delta-sub', isConn ? `\u0394: ${(d.deltaCellVoltage || 0).toFixed(3)} V` : '\u0394: 0.000 V');\n\n                const arc = _c('gauge-arc');\n                if (arc) {\n                    const pct = Math.min(100, Math.max(2, (deltaMv / 80.0) * 100));\n                    const offset = isConn ? (284.8 - (pct / 100.0) * 284.8).toFixed(1) : '284.8';\n                    if (arc.style.strokeDashoffset !== offset) arc.style.strokeDashoffset = offset;\n                    const deltaColor = (!isConn) ? '#556570' : (deltaMv <= 15 ? '#00ff2b' : (deltaMv <= 35 ? '#f59e0b' : '#ff3b30'));\n                    arc.setAttribute('stroke', (isConn && deltaMv <= 15) ? 'url(#gaugeGrad)' : deltaColor);\n                    const socTxt = _c('home-soc-txt');\n                    if (socTxt) socTxt.setAttribute('fill', deltaColor);\n                }\n\n                const vStr = isConn && d.totalVoltage !== undefined ? `T\u1ed5ng: ${d.totalVoltage.toFixed(2)} V` : 'T\u1ed5ng: 0.00 V';\n                _set('home-v-pill', vStr);\n                const balA = (d.balanceCurrent !== undefined && d.balanceCurrent > 0) ? d.balanceCurrent : 0;\n                const aStr = isConn ? `D\u00f2ng C\u00e2n: ${balA.toFixed(3)} A` : 'D\u00f2ng C\u00e2n: 0.00 A';\n                _set('home-a-pill', aStr);\n\n                const rxTxEl = _c('txt-rx-tx-pin');\n                if (rxTxEl && d.uart_rx_pin !== undefined) {\n                    rxTxEl.textContent = `RX:${d.uart_rx_pin} | TX:${d.uart_tx_pin}`;\n                }\n\n                // \u2500\u2500 Toast on connect \u2500\u2500\n                if (_wasConnected === false && isConn) {\n                    const toastName = d.active_pack_alias || d.modelName || d.active_bms_name || (d.active_pack_mac || 'JK Active Balancer');\n                    showConnectToast(toastName);\n                }\n                _wasConnected = isConn;\n\n                // \u2500\u2500 Status Banner (Updated dynamically every telemetry packet) \u2500\u2500\n                const sBanner = _c('status-banner');\n                const bMsg = _c('banner-msg');\n                const bIcon = _c('banner-icon');\n                const hasPack = (d.active_bms_mac && d.active_bms_mac.length > 0);\n                const isRealError = isConn && (d.rawErrorsBitmask > 0 || (d.errorsStr && d.errorsStr !== 'No Errors' && d.errorsStr !== 'Ho\u1ea1t \u0111\u1ed9ng b\u00ecnh th\u01b0\u1eddng' && d.errorsStr.indexOf('b\u00ecnh th\u01b0\u1eddng') < 0));\n\n                if (bMsg && bIcon) {\n                    if (!isConn) {\n                        bMsg.innerText = '\u0110ang ch\u1edd t\u00edn hi\u1ec7u UART DWIN t\u1eeb c\u1ed5ng LCD c\u1ee7a m\u1ea1ch c\u00e2n b\u1eb1ng...';\n                        bIcon.innerText = '\ud83d\udd0c'; bIcon.style.color = 'var(--yellow)';\n                        if (sBanner) { sBanner.style.borderColor = 'rgba(245,158,11,0.5)'; sBanner.style.background = 'rgba(40,30,5,0.85)'; }\n                    } else if (isRealError) {\n                        bMsg.innerText = d.errorsStr;\n                        bIcon.innerText = '\u26a0\ufe0f'; bIcon.style.color = 'var(--red)';\n                        if (sBanner) { sBanner.style.borderColor = 'rgba(255,59,48,0.5)'; sBanner.style.background = 'rgba(40,5,5,0.85)'; }\n                    } else if (!isBalSw) {\n                        bMsg.innerText = `\u26d4 C\u00e2n b\u1eb1ng \u0111ang T\u1eaeT (\u0394 = ${deltaMv} mV) \u2022 B\u1ea5m n\u00fat C\u00e2n B\u1eb1ng \u0111\u1ec3 k\u00edch ho\u1ea1t`;\n                        bIcon.innerText = '\u2696\ufe0f'; bIcon.style.color = 'var(--yellow)';\n                        if (sBanner) { sBanner.style.borderColor = 'rgba(245,158,11,0.5)'; sBanner.style.background = 'rgba(40,30,5,0.85)'; }\n                    } else if (isBalAct && curBalA > 0.02) {\n                        bMsg.innerText = `\u2696\ufe0f \u0110ang c\u00e2n b\u1eb1ng ch\u1ee7 \u0111\u1ed9ng (${curBalA.toFixed(2)} A) \u2022 \u0110\u1ed9 l\u1ec7ch cell: \u0394 = ${deltaMv} mV`;\n                        bIcon.innerText = '\u2696\ufe0f'; bIcon.style.color = 'var(--green)';\n                        if (sBanner) { sBanner.style.borderColor = 'rgba(63,185,80,0.4)'; sBanner.style.background = 'rgba(5,40,20,0.85)'; }\n                    } else {\n                        if (deltaMv <= 15) {\n                            bMsg.innerText = `\u2714 \u0110\u1ed9 l\u1ec7ch cell r\u1ea5t t\u1ed1t (\u0394 = ${deltaMv} mV) \u2022 C\u00e1c cell pin \u0111\u1ed3ng \u0111\u1ec1u`;\n                            bIcon.innerText = '\u2714'; bIcon.style.color = 'var(--green)';\n                            if (sBanner) { sBanner.style.borderColor = 'rgba(63,185,80,0.4)'; sBanner.style.background = 'rgba(5,40,20,0.85)'; }\n                        } else {\n                            bMsg.innerText = `\u23f3 Ch\u1edd c\u00e2n b\u1eb1ng (\u0394 = ${deltaMv} mV) \u2022 \u0110ang \u0111\u1ee3i ng\u01b0\u1ee1ng \u0111i\u1ec7n \u00e1p ho\u1eb7c \u0111i\u1ec1u ki\u1ec7n c\u00e2n`;\n                            bIcon.innerText = '\u23f3'; bIcon.style.color = 'var(--cyan)';\n                            if (sBanner) { sBanner.style.borderColor = 'rgba(56,189,248,0.4)'; sBanner.style.background = 'rgba(5,35,45,0.85)'; }\n                        }\n                    }\n                }\n\n                // \u2500\u2500 Header Balancer name & ID \u2500\u2500\n                _set('head-bms-name', d.modelName || 'JK_B5A24S');\n                _set('head-sn', d.serialNumber ? `SN: ${d.serialNumber}` : 'UART LCD (115200)');\n\n                // \u2500\u2500 Home RS485 Bar Indicators \u2500\u2500\n                const hRsName = _c('home-rs485-name');\n                const hRsPins = _c('home-rs485-pins');\n                if (hRsName) {\n                    if (isConn) {\n                        hRsName.innerHTML = `<span style=\"color:var(--green);\">\ud83d\udfe2</span> ${bmsName} <span style=\"font-size:0.75rem; color:var(--green);\">(Online)</span>`;\n                    } else {\n                        hRsName.innerHTML = `<span style=\"color:var(--yellow);\">\ud83d\udfe1</span> RS485 Modbus RTU <span style=\"font-size:0.75rem; color:var(--yellow);\">(Ch\u1edd t\u00edn hi\u1ec7u...)</span>`;\n                    }\n                }\n                if (hRsPins) {\n                    const rxP = d.rs485_rx_pin !== undefined ? d.rs485_rx_pin : 20;\n                    const txP = d.rs485_tx_pin !== undefined ? d.rs485_tx_pin : 21;\n                    const baud = d.rs485_baud || 115200;\n                    hRsPins.innerText = `RX: GPIO ${rxP} | TX: GPIO ${txP} | ${baud} bps`;\n                }\n\n                // \u2500\u2500 Live RS485 Sniffer Bar Updates \u2500\u2500\n                _set('dbg-rx-bytes', `${d.rs485_rx_bytes || 0} bytes`);\n                _set('dbg-ok-frames', d.rs485_success_count || 0);\n                const dbgHex = _c('dbg-rx-hex');\n                if (dbgHex) {\n                    if (d.rs485_rx_hex && d.rs485_rx_hex.trim().length > 0) {\n                        dbgHex.textContent = d.rs485_rx_hex;\n                    } else if (isConn) {\n                        dbgHex.textContent = '\u0110ang nh\u1eadn lu\u1ed3ng 308-byte li\u00ean t\u1ee5c...';\n                    } else {\n                        dbgHex.textContent = 'Ch\u01b0a c\u00f3 byte n\u00e0o \u0111\u1ebfn... (B\u1ea5m [\ud83d\udd00 \u0110\u1ea3o RX/TX] n\u1ebfu \u0111\u00e3 c\u1eafm d\u00e2y)';\n                    }\n                }\n                const dbgType = _c('dbg-frame-type');\n                if (dbgType) {\n                    if (isConn) {\n                        dbgType.textContent = '\ud83d\udfe2 Kh\u1edbp Frame BMS!';\n                        dbgType.style.color = 'var(--green)';\n                    } else if ((d.rs485_rx_bytes || 0) > 0) {\n                        dbgType.textContent = '\ud83d\udfe1 C\u00f3 byte nh\u01b0ng ch\u01b0a kh\u1edbp Frame (Th\u1eed \u0111\u1ed5i Baud)';\n                        dbgType.style.color = 'var(--yellow)';\n                    } else {\n                        dbgType.textContent = '\u26aa Ch\u1edd t\u00edn hi\u1ec7u t\u1eeb pin...';\n                        dbgType.style.color = '#888';\n                    }\n                }\n\n                // \u2500\u2500 Fast metrics for Active Balancer (NO TEMPERATURE) \u2500\u2500\n                _set('m-high-v', isConn && d.maxCellVoltage !== undefined ? d.maxCellVoltage.toFixed(3) : '0.000');\n                _set('m-low-v',  isConn && d.minCellVoltage !== undefined ? d.minCellVoltage.toFixed(3) : '0.000');\n                _set('m-diff-v', isConn && d.deltaCellVoltage !== undefined ? d.deltaCellVoltage.toFixed(3) : '0.000');\n                _set('m-bal-a',  isConn && d.balanceCurrent !== undefined ? d.balanceCurrent.toFixed(3) : '0.000');\n                const avgV = (isConn && d.avgCellVoltage > 0) ? d.avgCellVoltage : ((isConn && d.cellCount > 0 && d.totalVoltage) ? (d.totalVoltage / d.cellCount) : 0);\n                _set('m-cell-avg', avgV.toFixed(3));\n                _set('m-cap-ah', isConn && d.cellCount ? `${d.cellCount}S / 24S` : '0S / 24S');\n                _set('m-cell-min-badge', isConn && d.minCellNum ? `#${d.minCellNum}` : '\u2014');\n\n                // Calculate average wire resistance (in Ohms, e.g. 0.037) across active cells\n                let avgWire = 0;\n                let minWire = 9999, maxWire = 0, minWireIdx = 1, maxWireIdx = 1;\n                if (d.cellResistances && d.cellResistances.length > 0) {\n                    let sumW = 0, countW = 0;\n                    for (let k = 0; k < d.cellResistances.length; k++) {\n                        const cv = (d.cells && k < d.cells.length) ? d.cells[k] : 0;\n                        if (cv > 0.5) {\n                            let w = d.cellResistances[k] || 0;\n                            if (w > 1.0) w = w / 1000.0; // normalize to Ohms if in mOhm\n                            sumW += w;\n                            countW++;\n                            if (w > 0 && w < minWire) { minWire = w; minWireIdx = k + 1; }\n                            if (w > maxWire) { maxWire = w; maxWireIdx = k + 1; }\n                        }\n                    }\n                    avgWire = countW > 0 ? (sumW / countW) : 0;\n                }\n                _set('m-soh', isConn && avgWire > 0 ? `${avgWire.toFixed(3)} \u03a9` : '\u2014');\n\n                // Info Card fields (NO TEMPERATURE)\n                _set('card-curr-val', isConn ? `${curBalA.toFixed(3)} A` : '0.000 A');\n                _set('card-cell-min', isConn && d.minCellNum ? `#${d.minCellNum} (${(d.minCellVoltage||0).toFixed(3)} V)` : '\u2014');\n                _set('card-cell-max', isConn && d.maxCellNum ? `#${d.maxCellNum} (${(d.maxCellVoltage||0).toFixed(3)} V)` : '\u2014');\n                let stTxt = 'M\u1ea5t K\u1ebft N\u1ed1i';\n                let stColor = '#ef4444';\n                if (isConn) {\n                    if (!isBalSw) {\n                        stTxt = '\u0110\u00e3 T\u1eaft (OFF)';\n                        stColor = '#ef4444';\n                    } else if (isBalAct && curBalA > 0.02) {\n                        stTxt = `\u0110ang C\u00e2n B\u1eb1ng (${curBalA.toFixed(3)} A)`;\n                        stColor = 'var(--green)';\n                    } else {\n                        stTxt = 'Ch\u1edd C\u00e2n B\u1eb1ng (Standby)';\n                        stColor = 'var(--cyan)';\n                    }\n                }\n                const stEl = _c('card-status-txt');\n                if (stEl) {\n                    stEl.textContent = stTxt;\n                    stEl.style.color = stColor;\n                }\n                _set('card-port-txt', 'UART TTL (C\u1ed5ng LCD JK)');\n\n                // \u2500\u2500 Realtime Tab Fields (CLEAN UNITS, NO DUPLICATE CHARACTERS) \u2500\u2500\n                _set('rt-bat-v', isConn && d.totalVoltage !== undefined ? `${d.totalVoltage.toFixed(2)} V` : '0.00 V');\n                _set('rt-avg', `${avgV.toFixed(3)} V`);\n                const diffMv = isConn && d.deltaCellVoltage !== undefined ? Math.round(d.deltaCellVoltage * 1000) : 0;\n                _set('rt-diff', isConn && d.deltaCellVoltage !== undefined ? `${diffMv} mV (${d.deltaCellVoltage.toFixed(3)} V)` : '0 mV (0.000 V)');\n                _set('rt-balcurr', isConn ? `${curBalA.toFixed(3)} A` : '0.000 A');\n                _set('rt-min-cell', isConn && d.minCellNum ? `Cell #${d.minCellNum} (${(d.minCellVoltage||0).toFixed(3)} V)` : '\u2014');\n                _set('rt-max-cell', isConn && d.maxCellNum ? `Cell #${d.maxCellNum} (${(d.maxCellVoltage||0).toFixed(3)} V)` : '\u2014');\n                _set('rt-cell-count', isConn && d.cellCount ? `${d.cellCount}S / 24S (${d.cellCount} Cell \u0110ang Ch\u1ea1y)` : '0S / 24S');\n                _set('rt-min-wire', isConn && minWire < 9000 ? `${minWire.toFixed(3)} \u03a9 (Cell ${minWireIdx})` : '0.000 \u03a9');\n                _set('rt-max-wire', isConn && maxWire > 0 ? `${maxWire.toFixed(3)} \u03a9 (Cell ${maxWireIdx})` : '0.000 \u03a9');\n                _set('rt-avg-wire', isConn && avgWire > 0 ? `${avgWire.toFixed(3)} \u03a9` : '0.000 \u03a9');\n                _set('rt-balancer', !isBalSw ? 'T\u1eaeT (OFF)' : ((isBalAct && curBalA > 0.02) ? `B\u1eacT (\u0110ang c\u00e2n ${curBalA.toFixed(2)} A)` : 'B\u1eacT (Ch\u1edd c\u00e2n / Standby)'));\n                const deltaVal = (d.balDeltaVolt !== undefined && d.balDeltaVolt > 0) ? d.balDeltaVolt : 0.003;\n                _set('rt-delta-v', isConn ? `${deltaVal.toFixed(3)} V (${Math.round(deltaVal * 1000)} mV)` : '0.003 V (3 mV)');\n                const maxCurVal = (d.maxBalCurrent !== undefined && d.maxBalCurrent > 0) ? d.maxBalCurrent : 4.0;\n                _set('rt-max-bal-curr', isConn ? `${maxCurVal.toFixed(1)} A` : '4.0 A');\n                const devAddrVal = (d.deviceAddress !== undefined && d.deviceAddress > 0) ? d.deviceAddress : (d.device_address || 1);\n                _set('head-device-id', `(ID: #${devAddrVal})`);\n                _set('rt-device-addr', `#${devAddrVal}`);\n                _set('rt-runtime', isConn ? fmtRuntime : '--');\n\n                // \u2500\u2500 MOS Dots \u2500\u2500\n                if (Date.now() > mosCmdLockMs) {\n                    updateMosDot('charge', d.chargeMosOn);\n                    updateMosDot('discharge', d.dischargeMosOn);\n                    updateMosDot('balance', isBalSw);\n                }\n\n                // \u2500\u2500 Cells / Wire Resistance / Protection Grid \u2500\u2500\n                const errMask = d.rawErrorsBitmask || 0;\n                const cellCnt = (d.cells && d.cells.length) ? d.cells.length : 24;\n                // D\u00f9ng hash gi\u00e1 tr\u1ecb cell th\u1ef1c t\u1ebf thay v\u00ec lastUpdateMs (lastUpdateMs l\u00e0 millis ESP32 boot, cloud l\u01b0u t\u0129nh kh\u00f4ng \u0111\u1ed5i!)\n                const cellHash = d.cells ? d.cells.slice(0, cellCnt).map(v => Math.round((v || 0) * 1000)).join(',') : '';\n                const resistHash = d.cellResistances ? d.cellResistances.slice(0, cellCnt).map(v => Math.round((v || 0) * 1000)).join(',') : '';\n                const needCellRebuild = (cellHash !== _lastCellHash || cellCnt !== _lastCellCnt);\n                const needResistRebuild = (resistHash !== _lastResistHash || needCellRebuild);\n                const needProtRebuild = (errMask !== _lastErrMask || needCellRebuild);\n\n                if (needCellRebuild) {\n                    _lastCellHash = cellHash;\n                    _lastCellCnt = cellCnt;\n\n                    const grid3 = _c('cells-grid-3');\n                    const wgrid3 = _c('wire-grid-3');\n                    if (grid3 && cellCnt > 0) {\n                        let maxCellVal = 0, minCellVal = 999;\n                        let foundMaxNum = d.maxCellNum || 0, foundMinNum = d.minCellNum || 0;\n\n                        for (let i = 0; i < cellCnt; i++) {\n                            const v = (d.cells && i < d.cells.length) ? d.cells[i] : 0;\n                            if (v > maxCellVal) { maxCellVal = v; if (!foundMaxNum) foundMaxNum = (i + 1); }\n                            if (v > 0.5 && v < minCellVal) { minCellVal = v; if (!foundMinNum) foundMinNum = (i + 1); }\n                        }\n\n                        const frags = [];\n                        for (let i = 0; i < cellCnt; i++) {\n                            const num = i + 1;\n                            const v = (d.cells && i < d.cells.length) ? d.cells[i] : 0;\n                            if (v > 0.5) {\n                                const isMin = (num === d.minCellNum || (!d.minCellNum && num === foundMinNum));\n                                const isMax = (num === d.maxCellNum || (!d.maxCellNum && num === foundMaxNum));\n\n                                let cls = 'jk-val-txt';\n                                let balTag = '';\n                                if (isMin) {\n                                    cls += ' min';\n                                    if (d.balanceActive) balTag = '<span class=\"jk-bal-tag\">\u2696\ufe0f</span>';\n                                } else if (isMax) {\n                                    cls += ' max';\n                                    if (d.balanceActive) balTag = '<span class=\"jk-bal-tag\">\u2696\ufe0f</span>';\n                                }\n\n                                frags.push(\n                                    '<div class=\"jk-cell-item\">' +\n                                        '<span class=\"jk-num-badge\">' + num + '</span>' +\n                                        '<span class=\"' + cls + '\">' + v.toFixed(3) + '</span>' +\n                                        balTag +\n                                    '</div>'\n                                );\n                            } else {\n                                frags.push(\n                                    '<div class=\"jk-cell-item inactive\" style=\"opacity:0.35; border-color:rgba(255,255,255,0.04);\">' +\n                                        '<span class=\"jk-num-badge\" style=\"background:#141c22; color:#556570; border-color:#222f38;\">' + num + '</span>' +\n                                        '<span class=\"jk-val-txt\" style=\"color:#556570; font-size:0.75rem;\">0.000</span>' +\n                                    '</div>'\n                                );\n                            }\n                        }\n                        grid3.innerHTML = frags.join('');\n                    }\n                }\n\n                // Wire Resistance grid - rebuild when resistance values change (separate from cell voltage)\n                if (needResistRebuild) {\n                    _lastResistHash = resistHash;\n                    const wgrid3 = _c('wire-grid-3');\n                    if (wgrid3 && cellCnt > 0) {\n                        const frags = [];\n                        for (let i = 0; i < cellCnt; i++) {\n                            const num = i + 1;\n                            const v = (d.cells && i < d.cells.length) ? d.cells[i] : 0;\n                            let res = (d.cellResistances && i < d.cellResistances.length) ? d.cellResistances[i] : 0;\n                            if (res > 1.0) res = res / 1000.0;\n                            if (v > 0.5) {\n                                frags.push(\n                                    '<div class=\"jk-cell-item\">' +\n                                        '<span class=\"jk-num-badge\">' + num + '</span>' +\n                                        '<span class=\"jk-val-txt\" style=\"color:var(--green);\">' + res.toFixed(3) + '</span>' +\n                                    '</div>'\n                                );\n                            } else {\n                                frags.push(\n                                    '<div class=\"jk-cell-item inactive\" style=\"opacity:0.35; border-color:rgba(255,255,255,0.04);\">' +\n                                        '<span class=\"jk-num-badge\" style=\"background:#141c22; color:#556570; border-color:#222f38;\">' + num + '</span>' +\n                                        '<span class=\"jk-val-txt\" style=\"color:#556570; font-size:0.75rem;\">0.000</span>' +\n                                    '</div>'\n                                );\n                            }\n                        }\n                        wgrid3.innerHTML = frags.join('');\n                    }\n                }\n\n\n\n\n                // \u2500\u2500 Device Info (Active Balancer) \u2500\u2500\n                _set('dev-info-model', d.modelName || 'JK_B5A24S');\n                _set('dev-info-sn', d.serialNumber || '604130F0293');\n                _set('dev-info-hw', d.hardware_version || 'V11U');\n                _set('dev-info-sw', d.software_version || 'V11.57');\n                _set('dev-info-family', 'DWIN DGUS TTL (C\u1ed5ng LCD JK)');\n                                \n                // \u2500\u2500 Settings Tab Wi-Fi & BLE Status \u2500\u2500\n                if (connState !== _lastConnState || needCellRebuild) {\n                    const isStaConn = d.wifi_ssid && d.wifi_ssid !== \"Ch\u1ebf \u0111\u1ed9 Ph\u00e1t Wifi (SoftAP)\" && d.wifi_ssid !== \"Ch\u01b0a k\u1ebft n\u1ed1i\";\n                    const lblSsid = _c('lbl-wifi-ssid'); if (lblSsid) _set('lbl-wifi-ssid', '\ud83d\udce5 ' + (d.wifi_ssid || 'Ch\u01b0a k\u1ebft n\u1ed1i'));\n                    const lblIp = _c('lbl-wifi-ip'); if (lblIp) _set('lbl-wifi-ip', d.wifi_ip || '\u2014');\n                    const lblRssi = _c('lbl-wifi-rssi');\n                    if (lblRssi && d.wifi_rssi !== undefined) {\n                        const sig = d.wifi_rssi >= -60 ? ' (R\u1ea5t m\u1ea1nh)' : (d.wifi_rssi >= -75 ? ' (T\u1ed1t)' : ' (Y\u1ebfu)');\n                        _set('lbl-wifi-rssi', 'T\u00edn hi\u1ec7u: ' + d.wifi_rssi + ' dBm' + sig);\n                    }\n                    const lblWStatus = _c('lbl-wifi-status');\n                    if (lblWStatus) { lblWStatus.innerText = isStaConn ? '\u25cf \u0110ang k\u1ebft n\u1ed1i' : '\u25cb C\u1ea7n c\u00e0i \u0111\u1eb7t'; lblWStatus.style.background = isStaConn ? 'rgba(63,185,80,0.2)' : 'rgba(255,186,0,0.2)'; lblWStatus.style.color = isStaConn ? 'var(--green)' : 'var(--yellow)'; }\n                    // Monitor URL card\n                    const monCard = _c('monitor-url-card');\n                    if (monCard) {\n                        if (isStaConn && d.device_id) {\n                            monCard.style.display = 'block';\n                            const monInput = _c('lbl-monitor-url');\n                            if (monInput) monInput.value = 'https://bms.lha.io.vn/d/' + (d.device_id || 'JKBMS-C4CA');\n                        } else {\n                            monCard.style.display = 'none';\n                        }\n                    }\n                    if (!userEditingWifi) {\n                        const cv = _c('wifi-connected-view'), fv = _c('wifi-config-view');\n                        if (cv) cv.style.display = isStaConn ? 'block' : 'none';\n                        if (fv) fv.style.display = isStaConn ? 'none' : 'block';\n                    }\n                    const pinSt = _c('rs485-pin-status');\n                    if (pinSt && d.rs485_rx_pin !== undefined && d.rs485_tx_pin !== undefined) {\n                        pinSt.textContent = `RX: GPIO ${d.rs485_rx_pin} | TX: GPIO ${d.rs485_tx_pin}`;\n                    }\n                    const baudSt = _c('rs485-baud-status');\n                    if (baudSt && d.rs485_baud) {\n                        baudSt.textContent = d.rs485_baud;\n                    }\n                    const rsBadge = _c('rs485-conn-badge');\n                    if (rsBadge) {\n                        if (isConn) {\n                            rsBadge.textContent = '\u25cf \u0110ang K\u1ebft N\u1ed1i';\n                            rsBadge.style.color = 'var(--green)';\n                            rsBadge.style.borderColor = 'var(--green)';\n                            rsBadge.style.background = 'rgba(0,255,43,0.15)';\n                        } else {\n                            rsBadge.textContent = '\u25cb \u0110ang D\u00f2 T\u00edn Hi\u1ec7u';\n                            rsBadge.style.color = 'var(--yellow)';\n                            rsBadge.style.borderColor = 'var(--yellow)';\n                            rsBadge.style.background = 'rgba(255,184,0,0.15)';\n                        }\n                    }\n                }\n\n                updateMultiPackUI(d);\n            } catch(e) {\n                console.warn('[Telemetry] Error / Timeout:', e.message);\n                _consecutiveFailures++;\n                if (_consecutiveFailures >= 3) {\n                    const dot = _c('esp-online-dot');\n                    const txt = _c('esp-online-txt');\n                    const badge = _c('esp-online-badge');\n                    if (dot && txt && badge) {\n                        dot.style.background = '#ff3333';\n                        dot.style.boxShadow = '0 0 5px #ff3333';\n                        txt.textContent = 'ESP M\u1ea5t T\u00edn Hi\u1ec7u';\n                        badge.style.color = '#ff4d4d';\n                    }\n                    const sBanner = _c('status-banner');\n                    const bMsg = _c('banner-msg');\n                    const bIcon = _c('banner-icon');\n                    if (sBanner && bMsg && bIcon) {\n                        sBanner.className = 'status-banner err';\n                        sBanner.style.background = 'rgba(255, 50, 50, 0.15)';\n                        sBanner.style.borderColor = 'rgba(255, 50, 50, 0.5)';\n                        bIcon.textContent = '\u2716';\n                        bIcon.style.color = '#ff3333';\n                        bMsg.textContent = 'ESP32 \u0110ang B\u1eadn / T\u1ea1m M\u1ea5t K\u1ebft N\u1ed1i (\u0110ang th\u1eed l\u1ea1i...)';\n                        bMsg.style.color = '#ff4d4d';\n                    }\n                    const btIcon = _c('bt-icon-head');\n                    if (btIcon) btIcon.classList.remove('active');\n                    if (!window._lastTelemetry) {\n                        const arc = _c('gauge-arc');\n                        if (arc) arc.style.strokeDashoffset = '284.8';\n                        const socTxt = _c('home-soc-txt');\n                        if (socTxt) { socTxt.textContent = '0%'; socTxt.setAttribute('fill', '#556570'); }\n                    }\n                }\n            } finally {\n                _pollActive = false;\n            }\n        }\n\n        function updateMultiPackUI(d) {}\n\n        let userEditingWifi = false;\n        function toggleWifiForm(show) {\n            userEditingWifi = show;\n            const connView = document.getElementById('wifi-connected-view');\n            const cfgView = document.getElementById('wifi-config-view');\n            if (connView && cfgView) {\n                connView.style.display = show ? 'none' : 'block';\n                cfgView.style.display = show ? 'block' : 'none';\n            }\n        }\n\n        async function copyMonitorUrl() {\n            const inp = document.getElementById('lbl-monitor-url');\n            if (!inp || !inp.value) return;\n            const txt = inp.value;\n            let ok = false;\n            if (navigator.clipboard && window.isSecureContext) {\n                try {\n                    await navigator.clipboard.writeText(txt);\n                    ok = true;\n                } catch(e) {}\n            }\n            if (!ok) {\n                const ta = document.createElement('textarea');\n                ta.value = txt;\n                ta.style.position = 'fixed';\n                ta.style.left = '-9999px';\n                ta.style.top = (window.pageYOffset || document.documentElement.scrollTop) + 'px';\n                ta.contentEditable = 'true';\n                ta.readOnly = false;\n                document.body.appendChild(ta);\n                const range = document.createRange();\n                range.selectNodeContents(ta);\n                const sel = window.getSelection();\n                sel.removeAllRanges();\n                sel.addRange(range);\n                ta.setSelectionRange(0, 999999);\n                try { ok = document.execCommand('copy'); } catch(e) {}\n                document.body.removeChild(ta);\n            }\n            const msg = document.getElementById('monitor-url-copied');\n            if (msg) {\n                msg.style.display = 'block';\n                msg.innerText = ok ? '\\u2705 \\u0110\\u00e3 sao ch\\u00e9p link!' : '\\u26a0\\ufe0f H\\u00e3y nh\\u1ea5n ch\\u1ecdn & copy link';\n                msg.style.color = ok ? 'var(--green)' : 'var(--yellow)';\n                setTimeout(function(){ msg.style.display = 'none'; }, 2500);\n            }\n            inp.focus();\n            inp.select();\n        }\n\n        async function copyClaimCode() {\n            const inp = document.getElementById('lbl-claim-code');\n            if (!inp) return;\n            if (!inp.value || inp.value === '\u0110ang l\u1ea5y m\u00e3...') {\n                await fetchClaimCode();\n            }\n            if (!inp.value || inp.value === '\u0110ang l\u1ea5y m\u00e3...') {\n                alert('\u0110ang l\u1ea5y m\u00e3 t\u1eeb thi\u1ebft b\u1ecb, vui l\u00f2ng b\u1ea5m l\u1ea1i sau 1-2 gi\u00e2y!');\n                return;\n            }\n            const txt = inp.value;\n            let ok = false;\n            if (navigator.clipboard && window.isSecureContext) {\n                try {\n                    await navigator.clipboard.writeText(txt);\n                    ok = true;\n                } catch(e) {}\n            }\n            if (!ok) {\n                const ta = document.createElement('textarea');\n                ta.value = txt;\n                ta.style.position = 'fixed';\n                ta.style.left = '-9999px';\n                ta.style.top = (window.pageYOffset || document.documentElement.scrollTop) + 'px';\n                ta.contentEditable = 'true';\n                ta.readOnly = false;\n                document.body.appendChild(ta);\n                const range = document.createRange();\n                range.selectNodeContents(ta);\n                const sel = window.getSelection();\n                sel.removeAllRanges();\n                sel.addRange(range);\n                ta.setSelectionRange(0, 999999);\n                try { ok = document.execCommand('copy'); } catch(e) {}\n                document.body.removeChild(ta);\n            }\n            const tip = document.getElementById('claim-code-copied');\n            if (tip) {\n                tip.style.display = 'block';\n                setTimeout(() => { tip.style.display = 'none'; }, 3000);\n            }\n            inp.focus();\n            inp.select();\n        }\n\n        function updateMosDot(type, isOn) {\n            mosStates[type] = isOn;\n            const dot = document.getElementById('dot-' + type);\n            const txt = document.getElementById('txt-' + type);\n            if (dot && txt) {\n                if (type === 'balance') {\n                    if (!isOn) {\n                        dot.className = 'dot off';\n                        txt.className = 'val-off';\n                        txt.innerText = 'OFF';\n                    } else if (window._lastBalAct && window._lastBalCur > 0.02) {\n                        dot.className = 'dot on';\n                        txt.className = 'val-on';\n                        txt.innerText = '\u0110ANG C\u00c2N (' + window._lastBalCur.toFixed(2) + 'A)';\n                    } else {\n                        dot.className = 'dot standby';\n                        txt.className = 'val-standby';\n                        txt.innerText = 'CH\u1edc C\u00c2N (STANDBY)';\n                    }\n                } else {\n                    dot.className = 'dot ' + (isOn ? 'on' : 'off');\n                    txt.className = isOn ? 'val-on' : 'val-off';\n                    txt.innerText = isOn ? 'ON' : 'OFF';\n                }\n            }\n        }\n\n        async function toggleMos(type) {\n            const newState = !mosStates[type];\n            mosCmdLockMs = Date.now() + 5000;\n            updateMosDot(type, newState);\n            const target = (currentViewSlaveId > 0) ? currentViewSlaveId : -1;\n            try {\n                await fetch('/api/cmd', {\n                    method: 'POST',\n                    headers: { 'Content-Type': 'application/json' },\n                    body: JSON.stringify({ cmd: type, val: newState, target: target })\n                });\n            } catch(e) {}\n        }\n\n        async function loadPacks() {\n            try {\n                const res = await fetch('/api/packs');\n                const d = await res.json();\n                currentPacks = d.packs || [];\n                const listEl = document.getElementById('saved-packs-list');\n                if (!listEl) return;\n                listEl.innerHTML = '';\n                if (currentPacks.length === 0) {\n                    listEl.innerHTML = '<div style=\"font-size:0.8rem; color:var(--text-sub); text-align:center; padding:12px; background:rgba(255,255,255,0.02); border-radius:8px; border:1px dashed #222d35;\">Ch\u01b0a c\u00f3 Pack pin n\u00e0o trong danh s\u00e1ch. H\u00e3y nh\u1eadp MAC \u1edf tr\u00ean \u0111\u1ec3 l\u01b0u.</div>';\n                    return;\n                }\n                currentPacks.forEach((p, idx) => {\n                    const isActive = idx === d.active_idx;\n                    const div = document.createElement('div');\n                    div.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(15,23,42,0.7); border:1px solid ' + (isActive ? 'var(--green)' : 'rgba(56,189,248,0.2)') + '; padding:10px 12px; border-radius:8px; margin-bottom:8px;';\n                    div.innerHTML = `\n                        <div>\n                            <div style=\"font-weight:bold; font-size:0.9rem; color:${isActive ? 'var(--green)' : '#fff'}; display:flex; align-items:center; gap:6px;\">\n                                <span>${isActive ? '\ud83d\udfe2' : '\u26aa'}</span>\n                                <span>${p.alias || ('Pack ' + (idx+1))}</span>\n                                ${isActive ? '<span style=\"font-size:0.65rem; background:rgba(0,255,43,0.15); color:var(--green); border:1px solid var(--green); padding:1px 6px; border-radius:4px; font-weight:bold;\">\u0110ang D\u00f9ng</span>' : ''}\n                            </div>\n                            <div style=\"font-size:0.75rem; color:var(--text-sub); font-family:monospace; margin-top:3px;\">MAC: ${p.mac}</div>\n                        </div>\n                        <div style=\"display:flex; gap:6px;\">\n                            <button onclick=\"selectPack(${idx})\" style=\"background:${isActive ? 'var(--green)' : 'var(--cyan)'}; border:none; color:#000; padding:6px 12px; border-radius:6px; font-weight:bold; font-size:0.78rem; cursor:pointer;\">${isActive ? '\u2713 \u0110ang K\u1ebft N\u1ed1i' : '\u26a1 K\u1ebft N\u1ed1i'}</button>\n                            <button onclick=\"removePack(${idx})\" style=\"background:rgba(255,59,48,0.15); border:1px solid var(--red); color:var(--red); padding:6px 10px; border-radius:6px; font-weight:bold; font-size:0.75rem; cursor:pointer;\">\ud83d\uddd1\ufe0f X\u00f3a</button>\n                        </div>`;\n                    listEl.appendChild(div);\n                });\n\n                // Populate Home screen multi-pack switcher\n                const hSwitcher = document.getElementById('home-pack-switcher');\n                const hSelect = document.getElementById('home-pack-select');\n                if (hSwitcher && hSelect) {\n                    if (currentPacks.length > 1) {\n                        hSwitcher.style.display = 'flex';\n                        hSelect.innerHTML = '';\n                        currentPacks.forEach((p, idx) => {\n                            const opt = document.createElement('option');\n                            opt.value = idx;\n                            opt.innerText = `${idx === d.active_idx ? '\u25cf ' : ''}${p.alias || ('Pack ' + (idx+1))} [${p.mac}]`;\n                            if (idx === d.active_idx) opt.selected = true;\n                            hSelect.appendChild(opt);\n                        });\n                    } else {\n                        hSwitcher.style.display = 'none';\n                    }\n                }\n            } catch(e) {}\n        }\n\n        async function selectPack(idx) {\n            try {\n                await fetch('/api/pack/select', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({index: idx}) });\n                await loadPacks();\n                alert('\u0110\u00e3 chuy\u1ec3n sang Pack pin \u0111\u01b0\u1ee3c ch\u1ecdn!');\n            } catch(e) {}\n        }\n\n        async function removePack(idx) {\n            if (!confirm('X\u00f3a Pack pin n\u00e0y kh\u1ecfi danh s\u00e1ch \u0111\u00e3 l\u01b0u?')) return;\n            try {\n                await fetch('/api/pack/remove', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({index: idx}) });\n                await loadPacks();\n            } catch(e) {}\n        }\n\n        async function scanWifi() {\n            const el = document.getElementById('wifi-list');\n            el.innerHTML = '<p style=\"font-size:0.8rem; color:var(--text-sub);\">\u0110ang qu\u00e9t Wi-Fi...</p>';\n            try {\n                const res = await fetch('/api/wifi-scan');\n                const list = await res.json();\n                el.innerHTML = '';\n                list.forEach(w => {\n                    const div = document.createElement('div');\n                    div.className = 'list-item';\n                    div.innerHTML = `<div><div style=\"font-weight:bold;\">${w.ssid}</div><div style=\"font-size:0.75rem; color:var(--text-sub);\">RSSI: ${w.rssi} dBm</div></div><button class=\"btn\" style=\"width:auto; padding:4px 10px; font-size:0.75rem; margin:0;\" onclick=\"selectWifi('${w.ssid}')\">Ch\u1ecdn</button>`;\n                    el.appendChild(div);\n                });\n            } catch(e) { el.innerHTML = '<p style=\"color:var(--red)\">L\u1ed7i qu\u00e9t Wi-Fi</p>'; }\n        }\n\n        function selectWifi(ssid) {\n            document.getElementById('ssid').value = ssid;\n            document.getElementById('pass').focus();\n        }\n\n        async function saveConfig(e) {\n            e.preventDefault();\n            const btn = document.getElementById('btn-save-wifi');\n            const msg = document.getElementById('wifi-msg');\n            btn.disabled = true;\n            btn.innerText = '\u23f3 \u0110ang l\u01b0u...';\n            msg.innerText = '';\n\n            const payload = {\n                ssid: document.getElementById('ssid').value.trim(),\n                pass: document.getElementById('pass').value.trim(),\n                mqtt_server: document.getElementById('mqtt_srv').value.trim(),\n                mqtt_port: parseInt(document.getElementById('mqtt_port').value) || 1883\n            };\n\n            try {\n                const res = await fetch('/api/save', {\n                    method: 'POST',\n                    headers: { 'Content-Type': 'application/json' },\n                    body: JSON.stringify(payload)\n                });\n                const d = await res.json();\n                if (d.status === 'ok') {\n                    msg.style.color = 'var(--green)';\n                    msg.innerText = '\u2705 \u0110\u00e3 l\u01b0u th\u00e0nh c\u00f4ng! ESP32 \u0111ang kh\u1edfi \u0111\u1ed9ng l\u1ea1i \u0111\u1ec3 k\u1ebft n\u1ed1i...';\n                    setTimeout(() => { alert('ESP32 \u0111ang k\u1ebft n\u1ed1i v\u00e0o Wi-Fi: ' + payload.ssid + '\\nVui l\u00f2ng truy c\u1eadp theo IP m\u1edbi.'); }, 1500);\n                } else {\n                    msg.style.color = 'var(--red)';\n                    msg.innerText = '\u274c L\u1ed7i khi l\u01b0u c\u1ea5u h\u00ecnh';\n                    btn.disabled = false;\n                    btn.innerText = '\ud83d\udcbe L\u01b0u & K\u1ebft N\u1ed1i';\n                }\n            } catch(err) {\n                msg.style.color = 'var(--red)';\n                msg.innerText = '\u274c L\u1ed7i m\u1ea1ng ho\u1eb7c m\u1ea5t k\u1ebft n\u1ed1i t\u1edbi ESP32';\n                btn.disabled = false;\n                btn.innerText = '\ud83d\udcbe L\u01b0u & K\u1ebft N\u1ed1i';\n            }\n        }\n\n\n        function updateMosUi(type, state) {\n            const btn = document.getElementById('btn-mos-' + type);\n            if (!btn) return;\n            if (state) {\n                btn.className = 'btn-mos on';\n                btn.innerHTML = `<span>${type === 'charge' ? '\u26a1 S\u1ea1c' : (type === 'discharge' ? '\ud83d\udd0b X\u1ea3' : '\u2696\ufe0f C\u00e2n B\u1eb1ng')}</span><span>B\u1eacT</span>`;\n            } else {\n                btn.className = 'btn-mos off';\n                btn.innerHTML = `<span>${type === 'charge' ? '\u26a1 S\u1ea1c' : (type === 'discharge' ? '\ud83d\udd0b X\u1ea3' : '\u2696\ufe0f C\u00e2n B\u1eb1ng')}</span><span>T\u1eaeT</span>`;\n            }\n        }\n\n        async function emergencyPowerOff() {\n            if (!confirm('\u26a0\ufe0f C\u1ea2NH B\u00c1O: T\u1eaft ngu\u1ed3n kh\u1ea9n c\u1ea5p BMS?\\nBMS s\u1ebd ng\u1eaft ho\u00e0n to\u00e0n m\u1ecdi t\u1ea3i v\u00e0 ngu\u1ed3n s\u1ea1c.')) return;\n            try {\n                const res = await fetch('/api/command', {\n                    method: 'POST',\n                    headers: {'Content-Type':'application/json'},\n                    body: JSON.stringify({cmd: 'emergency_poweroff'})\n                });\n                const d = await res.json();\n                alert(d.status === 'ok' ? '\u0110\u00e3 g\u1eedi l\u1ec7nh ng\u1eaft kh\u1ea9n c\u1ea5p t\u1edbi BMS!' : 'L\u1ed7i g\u1eedi l\u1ec7nh!');\n            } catch(e) { alert('L\u1ed7i k\u1ebft n\u1ed1i t\u1edbi thi\u1ebft b\u1ecb!'); }\n        }\n\n        async function connectBLEUI() {\n            const mac = document.getElementById('cfg-ble-mac') ? document.getElementById('cfg-ble-mac').value.trim() : '';\n            const pin = document.getElementById('cfg-ble-pin') ? document.getElementById('cfg-ble-pin').value.trim() : '1234';\n            const stat = document.getElementById('ble-conn-status');\n            if (!mac) { alert('Vui l\u00f2ng nh\u1eadp \u0111\u1ecba ch\u1ec9 MAC c\u1ee7a BMS!'); return; }\n            if (stat) stat.innerText = '\u23f3 \u0110ang g\u1eedi y\u00eau c\u1ea7u k\u1ebft n\u1ed1i t\u1edbi ' + mac + '...';\n            try {\n                const res = await fetch('/api/command', {\n                    method: 'POST',\n                    headers: {'Content-Type':'application/json'},\n                    body: JSON.stringify({cmd: 'ble_connect', mac: mac, pin: pin})\n                });\n                const d = await res.json();\n                if (stat) stat.innerText = d.status === 'ok' ? '\u2705 \u0110ang ti\u1ebfn h\u00e0nh k\u1ebft n\u1ed1i...' : '\u274c L\u1ed7i k\u1ebft n\u1ed1i';\n                setTimeout(fetchTelemetry, 1000);\n            } catch(e) {\n                if (stat) stat.innerText = '\u274c L\u1ed7i m\u1ea1ng';\n            }\n        }\n\n        async function disconnectBLEUI() {\n            if (!confirm('B\u1ea1n c\u00f3 ch\u1eafc ch\u1eafn mu\u1ed1n ng\u1eaft k\u1ebft n\u1ed1i Bluetooth v\u1edbi BMS?')) return;\n            const stat = document.getElementById('ble-conn-status');\n            if (stat) stat.innerText = '\u23f3 \u0110ang ng\u1eaft k\u1ebft n\u1ed1i...';\n            try {\n                const res = await fetch('/api/command', {\n                    method: 'POST',\n                    headers: {'Content-Type':'application/json'},\n                    body: JSON.stringify({cmd: 'ble_disconnect'})\n                });\n                const d = await res.json();\n                if (stat) stat.innerText = d.status === 'ok' ? '\u2705 \u0110\u00e3 ng\u1eaft k\u1ebft n\u1ed1i' : '\u274c L\u1ed7i';\n                setTimeout(fetchTelemetry, 1000);\n            } catch(e) {\n                if (stat) stat.innerText = '\u274c L\u1ed7i m\u1ea1ng';\n            }\n        }\n\n        async function uploadFirmwareOTA() {\n            const fileInput = document.getElementById('ota-file');\n            const pBox = document.getElementById('ota-progress-box');\n            const pBar = document.getElementById('ota-bar');\n            const pTxt = document.getElementById('ota-status-text');\n\n            if (!fileInput || !fileInput.files || fileInput.files.length === 0) {\n                alert('Vui l\u00f2ng ch\u1ecdn file firmware (.bin) tr\u01b0\u1edbc khi n\u1ea1p!');\n                return;\n            }\n\n            const file = fileInput.files[0];\n            if (!file.name.endsWith('.bin')) {\n                alert('Ch\u1ec9 ch\u1ea5p nh\u1eadn file \u0111\u1ecbnh d\u1ea1ng .bin!');\n                return;\n            }\n\n            if (!confirm(`X\u00e1c nh\u1eadn n\u1ea1p firmware \"${file.name}\" (${(file.size/1024).toFixed(1)} KB) v\u00e0o ESP32?`)) {\n                return;\n            }\n\n            if (pBox) pBox.style.display = 'block';\n            if (pBar) pBar.style.width = '0%';\n            if (pTxt) pTxt.innerText = '\u0110ang chu\u1ea9n b\u1ecb n\u1ea1p firmware...';\n\n            const formData = new FormData();\n            formData.append('update', file);\n\n            const xhr = new XMLHttpRequest();\n            xhr.open('POST', '/update', true);\n\n            xhr.upload.onprogress = function(e) {\n                if (e.lengthComputable) {\n                    const pct = Math.round((e.loaded / e.total) * 100);\n                    if (pBar) pBar.style.width = pct + '%';\n                    if (pTxt) pTxt.innerText = `\u0110ang n\u1ea1p firmware: ${pct}% (${(e.loaded/1024).toFixed(0)} / ${(e.total/1024).toFixed(0)} KB)`;\n                }\n            };\n\n            xhr.onload = function() {\n                if (xhr.status === 200) {\n                    if (pBar) { pBar.style.width = '100%'; pBar.style.background = 'var(--green)'; }\n                    if (pTxt) pTxt.innerHTML = '<span style=\"color:var(--green); font-weight:bold;\">\u2705 N\u1ea1p Firmware th\u00e0nh c\u00f4ng!</span><br>ESP32 \u0111ang kh\u1edfi \u0111\u1ed9ng l\u1ea1i trong 5 gi\u00e2y...';\n                    setTimeout(() => { window.location.href = '/'; }, 6000);\n                } else {\n                    if (pTxt) pTxt.innerHTML = '<span style=\"color:var(--red);\">\u274c N\u1ea1p firmware th\u1ea5t b\u1ea1i: ' + xhr.responseText + '</span>';\n                }\n            };\n\n            xhr.onerror = function() {\n                if (pTxt) pTxt.innerHTML = '<span style=\"color:var(--red);\">\u274c L\u1ed7i k\u1ebft n\u1ed1i m\u1ea1ng khi t\u1ea3i firmware l\u00ean!</span>';\n            };\n\n            xhr.send(formData);\n        }\n\n        async function resetWifi() {\n            if (!confirm('B\u1ea1n c\u00f3 ch\u1eafc mu\u1ed1n Reset c\u00e0i \u0111\u1eb7t Wi-Fi v\u1ec1 m\u1eb7c \u0111\u1ecbnh?\\nESP32 s\u1ebd kh\u1edfi \u0111\u1ed9ng l\u1ea1i \u1edf ch\u1ebf \u0111\u1ed9 SoftAP (b\u1ea1n c\u1ea7n k\u1ebft n\u1ed1i l\u1ea1i \u0111\u1ec3 c\u1ea5u h\u00ecnh).')) return;\n            try {\n                const res = await fetch('/api/wifi-reset', { method: 'POST' });\n                const d = await res.json();\n                if (d.status === 'ok') {\n                    alert('\u0110\u00e3 x\u00f3a th\u00f4ng tin Wi-Fi th\u00e0nh c\u00f4ng! ESP32 \u0111ang kh\u1edfi \u0111\u1ed9ng l\u1ea1i v\u00e0o ch\u1ebf \u0111\u1ed9 SoftAP.');\n                    window.location.reload();\n                } else {\n                    alert('L\u1ed7i: ' + (d.message || 'Kh\u00f4ng th\u1ec3 reset Wi-Fi'));\n                }\n            } catch(e) {\n                alert('\u0110\u00e3 g\u1eedi l\u1ec7nh Reset! Thi\u1ebft b\u1ecb \u0111ang kh\u1edfi \u0111\u1ed9ng l\u1ea1i.');\n            }\n        }\n\n        // \u2500\u2500 RS485 & Connection Mode Functions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n        function switchConnType(type) {\n            const msg = document.getElementById('conn-mode-msg');\n            const typeStr = (type === 2) ? 'RS485 Modbus' : (type === 1 ? 'Bluetooth (BLE)' : 'T\u1eaft C\u1ea3 2 (OFF)');\n            if (msg) msg.textContent = `\u23f3 \u0110ang l\u01b0u ch\u1ebf \u0111\u1ed9 ${typeStr} v\u00e0 kh\u1edfi \u0111\u1ed9ng l\u1ea1i...`;\n            fetch('/api/conn-type', {\n                method: 'POST',\n                headers: {'Content-Type': 'application/json'},\n                body: JSON.stringify({ conn_type: type })\n            })\n            .then(r => r.json())\n            .then(d => {\n                if (msg) msg.textContent = '\u2705 \u0110\u00e3 l\u01b0u! ESP32 \u0111ang kh\u1edfi \u0111\u1ed9ng l\u1ea1i...';\n                setTimeout(() => window.location.reload(), 4000);\n            })\n            .catch(e => {\n                if (msg) msg.textContent = '\u274c L\u1ed7i l\u01b0u ch\u1ebf \u0111\u1ed9 k\u1ebft n\u1ed1i';\n            });\n        }\n\n        function swapRs485Pins() {\n            const msg = document.getElementById('rs485-cfg-msg');\n            if (msg) msg.textContent = '\u23f3 \u0110ang \u0111\u1ea3o ch\u00e2n RX/TX...';\n            fetch('/api/rs485/swap', { method: 'POST' })\n            .then(r => r.json())\n            .then(d => {\n                if (msg) msg.textContent = `\u2705 \u0110\u00e3 \u0111\u1ed5i: RX=GPIO${d.rx_pin}, TX=GPIO${d.tx_pin}`;\n                const pinSt = document.getElementById('rs485-pin-status');\n                if (pinSt) pinSt.textContent = `RX: GPIO ${d.rx_pin} | TX: GPIO ${d.tx_pin}`;\n                setTimeout(fetchTelemetry, 1000);\n            })\n            .catch(e => {\n                if (msg) msg.textContent = '\u274c L\u1ed7i \u0111\u1ea3o ch\u00e2n';\n            });\n        }\n\n        function toggleRs485Baud() {\n            const msg = document.getElementById('rs485-cfg-msg');\n            const curBaudElem = document.getElementById('rs485-baud-status');\n            const curBaud = curBaudElem ? parseInt(curBaudElem.textContent) : 115200;\n            const newBaud = (curBaud === 115200) ? 9600 : 115200;\n            if (msg) msg.textContent = `\u23f3 \u0110ang \u0111\u1ed5i Baud sang ${newBaud}...`;\n            fetch('/api/rs485/config', {\n                method: 'POST',\n                headers: {'Content-Type': 'application/json'},\n                body: JSON.stringify({ baud: newBaud })\n            })\n            .then(r => r.json())\n            .then(d => {\n                if (msg) msg.textContent = `\u2705 \u0110\u00e3 chuy\u1ec3n sang ${d.baud} bps`;\n                if (curBaudElem) curBaudElem.textContent = d.baud;\n                setTimeout(fetchTelemetry, 1000);\n            })\n            .catch(e => {\n                if (msg) msg.textContent = '\u274c L\u1ed7i \u0111\u1ed5i Baud';\n            });\n        }\n\n        function autoDetectRs485() {\n            const msg = document.getElementById('rs485-cfg-msg');\n            if (msg) msg.textContent = '\ud83d\udd0d \u0110ang t\u1ef1 \u0111\u1ed9ng th\u1eed c\u00e1c ch\u00e2n RX/TX & Baud (9600/115200)...';\n            fetch('/api/rs485/auto-detect', { method: 'POST' })\n            .then(r => r.json())\n            .then(d => {\n                if (d.status === 'ok') {\n                    if (msg) msg.textContent = `\ud83c\udf89 T\u00ccM TH\u1ea4Y BMS! RX=GPIO${d.rx_pin}, TX=GPIO${d.tx_pin}, Baud=${d.baud}`;\n                } else {\n                    if (msg) msg.textContent = '\u26a0\ufe0f Kh\u00f4ng c\u00f3 ph\u1ea3n h\u1ed3i t\u1eeb BMS. Ki\u1ec3m tra d\u00e2y A/B & ngu\u1ed3n BMS.';\n                }\n                const pinSt = document.getElementById('rs485-pin-status');\n                if (pinSt) pinSt.textContent = `RX: GPIO ${d.rx_pin} | TX: GPIO ${d.tx_pin}`;\n                const baudSt = document.getElementById('rs485-baud-status');\n                if (baudSt) baudSt.textContent = d.baud;\n                setTimeout(fetchTelemetry, 1500);\n            })\n            .catch(e => {\n                if (msg) msg.textContent = '\u274c L\u1ed7i d\u00f2 t\u1ef1 \u0111\u1ed9ng';\n            });\n        }\n\n        // \u2500\u2500 Polling & Lifecycle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n        let _pollTimer = null;\n        function schedulePoll() {\n            if (_pollTimer) clearTimeout(_pollTimer);\n            if (document.hidden) {\n                // When tab is hidden/minimized: STOP ALL POLLING completely to save 100% resources!\n                return;\n            }\n            const interval = (_consecutiveFailures > 0) ? 2000 : 600; // Realtime 600ms m\u01b0\u1ee3t m\u00e0 khi xem local\n            _pollTimer = setTimeout(async () => {\n                await fetchTelemetry();\n                schedulePoll();\n            }, interval);\n        }\n\n        function notifyInactive() {\n            try {\n                if (navigator.sendBeacon) {\n                    navigator.sendBeacon('/api/inactive');\n                }\n            } catch(e) {}\n            fetch('/api/inactive', { method: 'POST', keepalive: true }).catch(() => {});\n        }\n\n        document.addEventListener('visibilitychange', () => {\n            if (document.hidden) {\n                if (_pollTimer) clearTimeout(_pollTimer);\n                _pollActive = false;\n                notifyInactive();\n            } else {\n                fetch('/api/active', { method: 'POST', keepalive: true }).catch(() => {});\n                if (window._initialTelemetry) {\n                try {\n                    let d0 = window._initialTelemetry;\n                    if (d0.totalVoltage === undefined && d0.voltage !== undefined) d0.totalVoltage = d0.voltage;\n                    if (d0.deltaCellVoltage === undefined && d0.delta_cell_voltage !== undefined) d0.deltaCellVoltage = d0.delta_cell_voltage;\n                    if (d0.balanceCurrent === undefined && d0.balance_current !== undefined) d0.balanceCurrent = d0.balance_current;\n                    if (d0.balanceActive === undefined && d0.balance_active !== undefined) d0.balanceActive = d0.balance_active;\n                    if (d0.balanceActive === undefined && d0.balance !== undefined) d0.balanceActive = d0.balance;\n                    if (!d0.cells && d0.cell_voltages) d0.cells = d0.cell_voltages;\n                    if (!d0.cellResistances && d0.cell_resistances) d0.cellResistances = d0.cell_resistances;\n                    window._lastTelemetry = d0;\n                    updateUI(d0);\n                } catch(e) { console.error('Initial telemetry boot err:', e); }\n            }\n            fetchTelemetry();\n                schedulePoll();\n            }\n        });\n\n        window.addEventListener('pagehide', notifyInactive);\n        window.addEventListener('beforeunload', notifyInactive);\n\n        window.addEventListener('DOMContentLoaded', async () => {\n            fetchClaimCode();\n            fetch('/api/active', { method: 'POST', keepalive: true }).catch(() => {});\n            await fetchTelemetry();\n            fetchClaimCode();\n            schedulePoll();\n            if (window._lastTelemetry && (!window._lastTelemetry.wifi_ssid || window._lastTelemetry.wifi_ssid.includes(\"SoftAP\") || window._lastTelemetry.wifi_ssid === \"Ch\u01b0a k\u1ebft n\u1ed1i\")) {\n                showTab('tab-settings', document.getElementById('nav-sett'));\n                toggleWifiForm(true);\n            }\n        });\n    </script>\n</body>\n</html>\n";
function BALANCER_DEVICE_HTML(d) {
  const safeD = JSON.stringify(d || {}).replace(/</g, '\\u003c');
  const inject = '<script>window._cloudDevId = ' + JSON.stringify(d?.device_id || '') + '; window._initialTelemetry = ' + safeD + ';</script></head>';
  return BALANCER_HTML_TEMPLATE.replace('</head>', inject);
}

function CUSTOMER_DEVICE_HTML(d) {
  const online = d.online;
  const hasData = (d.voltage !== undefined && d.voltage > 0);
  const nowMs = Date.now();
  const timeSinceBms = d.lastBmsConnected ? (nowMs - d.lastBmsConnected) : 999999;
  // 90s Grace Period: Cho phép ESP kết nối lại trong 90s mà không làm gián đoạn trạng thái Xanh
  const bmsConnected = online && (d.connected === true || (hasData && timeSinceBms < 90000));

  const isBalancer = (d.conn_type === 'uart_lcd') || (d.conn_type === 'balancer') || (d.conn_type_num === 3) || (d.firmware_version && d.firmware_version.includes('BALANCER')) || (d.device_id && d.device_id.startsWith('JKBAL'));
  const isModbus = !isBalancer && ((d.conn_type === 'ble' || d.conn_type_num === 1 || (d.firmware_version && d.firmware_version.includes('BLE')))
    ? false
    : ((d.conn_type === 'modbus') || (d.conn_type === 'rs485') || (d.conn_type_num === 2) || (d.firmware_version && d.firmware_version.includes('RS485')) || (d.active_bms_mac && String(d.active_bms_mac).startsWith('RS485'))));

  const connProtocol = isBalancer ? 'JK Balancer UART (LCD Port)' : (isModbus ? 'RS485 Modbus RTU' : 'Bluetooth BLE');
  const connBadgeHtml = isBalancer
    ? `<span id="conn-type-badge" style="display:inline-block; font-size:0.65rem; padding:2px 7px; border-radius:4px; font-weight:800; background:rgba(16,185,129,0.18); color:#10b981; border:1px solid rgba(16,185,129,0.45); margin-left:6px; vertical-align:middle;">⚡ CÂN BẰNG JK</span>`
    : (isModbus 
      ? `<span id="conn-type-badge" style="display:inline-block; font-size:0.65rem; padding:2px 7px; border-radius:4px; font-weight:800; background:rgba(245,158,11,0.18); color:#f59e0b; border:1px solid rgba(245,158,11,0.45); margin-left:6px; vertical-align:middle;">🟠 MODBUS</span>`
      : `<span id="conn-type-badge" style="display:inline-block; font-size:0.65rem; padding:2px 7px; border-radius:4px; font-weight:800; background:rgba(56,189,248,0.18); color:#38bdf8; border:1px solid rgba(56,189,248,0.45); margin-left:6px; vertical-align:middle;">🔵 BLUETOOTH</span>`);

  const soc      = (bmsConnected || hasData) ? (d.soc !== undefined ? d.soc : 0) : 0;
  const voltage  = (bmsConnected || hasData) ? (d.voltage ? d.voltage.toFixed(2) : '—') : '—';
  const current  = (bmsConnected || hasData) ? (d.current !== undefined ? d.current.toFixed(2) : '0.00') : '—';
  const power    = (bmsConnected || hasData) ? (d.power !== undefined ? Math.abs(d.power).toFixed(1) : '0.0') : '—';
  const mosTemp  = (bmsConnected || hasData) ? (d.mos_temp !== undefined ? d.mos_temp.toFixed(1) : '—') : '—';
  const temp1    = (bmsConnected || hasData) && d.temp1 && d.temp1 > 0 ? d.temp1.toFixed(1) : null;
  const temp2    = (bmsConnected || hasData) && d.temp2 && d.temp2 > 0 ? d.temp2.toFixed(1) : null;
  const capAh    = (bmsConnected || hasData) ? (d.capacity_ah !== undefined ? d.capacity_ah.toFixed(1) : '—') : '—';
  const remCap   = (bmsConnected || hasData) ? (d.remain_capacity_ah !== undefined ? d.remain_capacity_ah.toFixed(1) : '—') : '—';
  const balCurr  = (bmsConnected || hasData) ? (d.balance_current !== undefined ? d.balance_current.toFixed(3) : '0.000') : '—';
  const cycleCap = (bmsConnected || hasData) ? (d.cycle_capacity_ah !== undefined ? d.cycle_capacity_ah.toFixed(1) : '—') : '—';
  const cycles   = (bmsConnected || hasData) ? (d.cycle_count !== undefined ? d.cycle_count : '—') : '—';
  const detailLogs = (bmsConnected || hasData) ? (d.detail_logs_count !== undefined ? d.detail_logs_count : '—') : '—';
  const chargeMos   = d.charge_mos !== undefined ? d.charge_mos : false;
  const dischargeMos= d.discharge_mos !== undefined ? d.discharge_mos : false;
  const balSw       = (d.balance !== undefined) ? !!d.balance : (d.balance_switch !== undefined ? !!d.balance_switch : !!d.balance_active);
  const balAct      = (d.balance_active !== undefined) ? !!d.balance_active : (balSw && ((d.balance_current > 0.01) || (d.balanceCurrent > 0.01)));
  const balance     = balSw;
  const aveCellVolt = (bmsConnected || hasData) && d.min_cell_voltage && d.max_cell_voltage
    ? (((d.min_cell_voltage||0) + (d.max_cell_voltage||0)) / 2).toFixed(3) : '—';
  const cellDelta = (bmsConnected || hasData) ? (d.delta_cell_voltage !== undefined ? d.delta_cell_voltage.toFixed(3) : '—') : '—';
  const statusColor = online ? (bmsConnected ? '#3fb950' : '#f59e0b') : '#f85149';
  const statusText  = online ? (bmsConnected ? 'Online' : 'Đang kết nối lại...') : 'Offline';
  const rssiVal     = d.rssi ? d.rssi + ' dBm' : '—';
  const reg = d.activatedAtStr || '—';
  const bmsDisplayName = (d.active_bms_name && d.active_bms_name !== 'JK_PB2A16S15P' && !d.active_bms_name.startsWith('JK-BMS [') ? d.active_bms_name : null) || d.active_pack_name || d.active_pack_alias || d.active_bms_name || 'JK-BMS';

  // Pack Selector data
  const packsSummary = (d.packs_summary && Array.isArray(d.packs_summary) && d.packs_summary.length > 1) ? d.packs_summary : null;
  let activePackIdx = d.active_pack_idx !== undefined ? d.active_pack_idx : 0;
  if (packsSummary && d.active_bms_mac) {
    const curNormMac = d.active_bms_mac.toLowerCase().replace(/[:-]/g, '');
    const matchedIdx = packsSummary.findIndex(p => (p.mac || '').toLowerCase().replace(/[:-]/g, '') === curNormMac);
    if (matchedIdx >= 0) {
      activePackIdx = matchedIdx;
      packsSummary.forEach((p, idx) => {
        p.active = (idx === matchedIdx);
        if (idx === matchedIdx) {
          p.connected = bmsConnected;
          if (d.voltage > 0) p.voltage = d.voltage;
          if (d.soc !== undefined) p.soc = d.soc;
        } else if (p.connected && idx !== matchedIdx) {
          p.connected = false;
        }
      });
    }
  }
  const packsSummaryJs = packsSummary ? JSON.stringify(packsSummary) : 'null';

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

  const formatBmsAddress = (addr) => {
    if (addr === undefined || addr === null || addr === '' || addr === '—') return 'ID 1 (Master)';
    const num = Number(addr);
    if (isNaN(num) || num <= 0) return 'ID 1 (Master / Mặc định)';
    return `ID ${num}`;
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
    if ((bmsConnected || hasData) && i < cells.length) {
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
        html {
            background-color: var(--bg-black);
            -webkit-text-size-adjust: 100%;
            text-size-adjust: 100%;
            overflow-x: hidden;
            width: 100%;
        }
        body {
            background-color: var(--bg-black);
            color: var(--text-white);
            min-height: 100vh;
            min-height: -webkit-fill-available;
            padding-bottom: calc(88px + var(--sab));
            user-select: none;
            -webkit-user-select: none;
            overflow-x: hidden;
            width: 100%;
            max-width: 100vw;
        }
        .app {
            max-width: 480px;
            width: 100%;
            margin: 0 auto;
            min-height: 100vh;
            position: relative;
            background: #000;
            padding-left: var(--sal);
            padding-right: var(--sar);
            overflow-x: hidden;
        }

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
            width: 100%;
            max-width: 100%;
            overflow: hidden;
        }

        /* Top Header Bar */
        .top-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 12px 6px 12px;
            background: transparent;
            gap: 8px;
            min-width: 0;
        }
        .top-bar-left {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex: 1;
            overflow: hidden;
        }
        .top-bar-right {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }
        .bt-status { display: flex; align-items: center; gap: 4px; font-size: 1.05rem; color: #555; flex-shrink: 0; }
        .bt-status.active { color: var(--cyan); }
        .uptime-txt { font-size: 0.78rem; font-weight: 500; color: #e5e5e5; letter-spacing: 0.2px; font-family: monospace; white-space: nowrap; }
        .menu-btn { font-size: 1.25rem; color: #fff; cursor: pointer; border: none; background: transparent; padding: 4px; }

        /* MOS Control Top Bar */
        .mos-bar {
            display: flex;
            justify-content: space-around;
            align-items: center;
            background: transparent;
            padding: 5px 6px 6px 6px;
            border-top: 1px solid rgba(255,255,255,0.05);
            font-size: 0.8rem;
            font-weight: 600;
            gap: 4px;
        }
        .mos-item {
            display: flex;
            align-items: center;
            gap: 5px;
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 6px;
            background: rgba(255,255,255,0.03);
            touch-action: manipulation;
        }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #444; flex-shrink: 0; }
        .dot.on { background: var(--green); box-shadow: 0 0 6px var(--green); }
        .dot.off { background: var(--red); box-shadow: 0 0 6px var(--red); }
        .val-on { color: var(--green); font-weight: bold; }
        .val-off { color: var(--red); font-weight: bold; }

        /* Gauge Section */
        .gauge-section { position: relative; width: 100%; text-align: center; padding: 10px 0 4px 0; overflow: hidden; }
        .gauge-svg { width: 250px; height: 230px; margin: 0 auto; display: block; max-width: 100%; }

        /* Notification Banner */
        .status-banner { margin: 8px 12px; background: rgba(5,35,41,0.85); border: 1px solid #008b99; border-radius: 10px; padding: 8px 12px; display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: #e2e8f0; min-width: 0; }
        .banner-icon { color: var(--green); font-size: 1.1rem; flex-shrink: 0; }

        /* Quick BLE Bar */
        .quick-ble-box { background: #131c22; border: 1px solid #222d35; border-radius: 10px; padding: 10px 12px; margin: 8px 12px 10px 12px; min-width: 0; }

        /* Metrics Grids (4 columns - Responsive Non-overflowing) */
        .metrics-grid-4 {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 2px;
            margin: 8px 12px;
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 12px;
            padding: 10px 4px;
            text-align: center;
        }
        .metric-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            position: relative;
            padding: 2px 0;
            min-width: 0;
            overflow: hidden;
        }
        .metric-item:not(:last-child)::after { content: ''; position: absolute; right: 0; top: 15%; height: 70%; width: 1px; background: #222d35; }
        .metric-val {
            font-size: 1.05rem;
            font-weight: 800;
            margin-bottom: 2px;
            white-space: nowrap;
            letter-spacing: -0.3px;
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .metric-lbl {
            font-size: 0.62rem;
            color: var(--text-sub);
            white-space: nowrap;
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* Power & Status Card */
        .info-card-box {
            margin: 8px 12px;
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 12px;
            padding: 10px 12px;
            font-size: 0.84rem;
            min-width: 0;
        }
        .card-row {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            padding: 5px 0;
            gap: 8px;
            min-width: 0;
        }
        .card-row > span:first-child {
            color: #94a3b8;
            font-size: 0.82rem;
            flex-shrink: 0;
            max-width: 48%;
            line-height: 1.3;
        }
        .card-row > strong, .card-row > span:last-child {
            text-align: right;
            word-break: break-word;
            overflow-wrap: anywhere;
            min-width: 0;
            font-size: 0.82rem;
            line-height: 1.3;
        }
        .card-divider { height: 1px; background: #222d35; margin: 6px 0; }

        /* Real-time Detailed Status List */
        .realtime-title {
            color: var(--green);
            font-size: 0.88rem;
            font-weight: 700;
            margin: 12px 14px 8px 14px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .realtime-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 6px 12px;
            margin: 0 12px;
            font-size: 0.8rem;
        }
        .rt-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #141a20;
            padding-bottom: 4px;
            min-width: 0;
            gap: 4px;
        }
        .rt-lbl {
            color: #8fa0ab;
            font-size: 0.75rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
            flex-shrink: 1;
        }
        .rt-val {
            color: var(--green);
            font-weight: 700;
            font-size: 0.78rem;
            white-space: nowrap;
            flex-shrink: 0;
            text-align: right;
        }
        .unit-sup { font-size: 0.65rem; font-weight: normal; vertical-align: super; margin-left: 1px; }

        /* Authentic JK App Styling for Cell Voltages & Wire Resistance */
        .jk-bat-summary {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 4px 10px;
            padding: 8px 14px 2px 14px;
            font-size: 0.84rem;
            font-weight: 700;
            color: #ffffff;
        }
        .jk-bat-summary > span {
            display: inline-flex;
            align-items: center;
        }
        .jk-bat-summary .jk-dot, .jk-section-title .jk-dot {
            display: inline-block;
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #00ff2b;
            box-shadow: 0 0 6px rgba(0, 255, 43, 0.6);
            margin-right: 6px;
            flex-shrink: 0;
        }
        .jk-bat-summary .unit, .jk-section-title .unit { color: #00ff2b; font-weight: 600; }
        .jk-bat-summary .val { color: #00ff2b; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", monospace; font-size: 0.92rem; font-weight: 700; }
        .jk-divider { height: 1px; background: #1c2630; margin: 8px 14px; }

        .jk-section-title {
            color: #ffffff;
            font-size: 0.88rem;
            font-weight: 700;
            margin: 10px 14px 6px 14px;
            display: flex;
            align-items: center;
            gap: 2px;
        }
        .jk-section-title .colon { color: #ffffff; margin-left: 2px; }

        .jk-grid-3 {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            column-gap: 4px;
            row-gap: 8px;
            margin: 8px 10px 12px 10px;
        }
        .jk-cell-item {
            display: flex;
            align-items: center;
            gap: 3px;
            background: transparent;
            border: none;
            padding: 0;
            min-height: 20px;
            min-width: 0;
            overflow: hidden;
        }
        .jk-num-badge {
            background: #14556b;
            color: #5eead4;
            min-width: 18px;
            height: 18px;
            padding: 0 2px;
            border-radius: 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 0.68rem;
            font-weight: 700;
            font-family: -apple-system, BlinkMacSystemFont, monospace;
            flex-shrink: 0;
        }
        .jk-val-txt {
            font-size: 0.88rem;
            font-weight: 700;
            color: #00ff2b;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", monospace;
            font-variant-numeric: tabular-nums;
            letter-spacing: -0.3px;
            line-height: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: clip;
            flex-shrink: 1;
            min-width: 0;
        }
        .jk-val-txt.min { color: #ff0033; }
        .jk-val-txt.max { color: #00e5ff; }
        .jk-bal-tag {
            font-size: 0.58rem;
            margin-left: 1px;
            flex-shrink: 0;
            white-space: nowrap;
        }

        /* Protection Grid - Chuẩn Zin JK-BMS */
        .protection-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 6px;
            margin: 8px 12px 14px 12px;
        }
        .prot-item {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 8px;
            padding: 6px 8px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 0.74rem;
            min-width: 0;
            gap: 4px;
        }
        .prot-lbl {
            color: #aaa;
            font-size: 0.72rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
        }
        .prot-badge {
            padding: 2px 5px;
            border-radius: 4px;
            font-size: 0.66rem;
            font-weight: 700;
            flex-shrink: 0;
            white-space: nowrap;
        }
        .prot-badge.ok { background: rgba(0, 255, 43, 0.15); color: var(--green); border: 1px solid rgba(0,255,43,0.3); }
        .prot-badge.alarm { background: rgba(255, 59, 48, 0.25); color: var(--red); border: 1px solid var(--red); animation: pulseAlert 1s infinite; }
        @keyframes pulseAlert { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }

        /* Tab Content Display */
        .tab-content { display: none; }
        .tab-content.active { display: block; }

        /* Settings Card Elements */
        .sett-card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 12px;
            padding: 12px;
            margin: 10px 12px;
            min-width: 0;
        }
        .form-group { margin-bottom: 12px; }
        label { display: block; font-size: 0.8rem; color: var(--text-sub); margin-bottom: 4px; }
        input, select { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a343d; background: #090c0e; color: #fff; font-size: 0.9rem; }
        button.btn { width: 100%; padding: 11px; border: none; border-radius: 8px; background: linear-gradient(135deg, #0284c7, #0369a1); color: #fff; font-weight: bold; cursor: pointer; font-size: 0.9rem; margin-top: 6px; }
        button.btn-sec { background: rgba(255,255,255,0.08); border: 1px solid #2a343d; }
        .list-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; background: #090c0e; border-radius: 8px; margin-bottom: 8px; border: 1px solid #1e262c; min-width: 0; gap: 8px; }

        /* Parameter Form Controls */
        .param-section-title { font-size: 0.92rem; font-weight: 700; color: var(--cyan); margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
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
            border-radius: 8px;
            padding: 8px 10px;
            margin-bottom: 6px;
            gap: 8px;
            min-width: 0;
            transition: border-color 0.2s, background 0.2s;
        }
        .param-row-item:hover, .param-row-item:focus-within {
            border-color: rgba(56, 189, 248, 0.4);
            background: #0d1217;
        }
        .param-row-label {
            flex: 1;
            font-size: 0.8rem;
            font-weight: 600;
            color: #e2e8f0;
            line-height: 1.25;
            min-width: 0;
            word-break: break-word;
        }
        .param-row-ctrls {
            display: flex;
            align-items: center;
            gap: 5px;
            flex-shrink: 0;
        }
        .param-row-ctrls .param-input-wrap {
            width: 86px;
            margin: 0;
            position: relative;
        }
        .param-row-ctrls .param-input-wrap input {
            width: 100%;
            height: 34px;
            padding: 4px 22px 4px 6px;
            font-size: 0.86rem;
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
            right: 6px;
            font-size: 0.68rem;
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
            font-size: 0.76rem;
            padding: 0 8px;
            height: 34px;
            min-width: 40px;
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
                <div class="top-bar-left">
                    <div id="bt-icon-head" class="bt-status ${bmsConnected ? 'active' : ''}" title="${isModbus ? 'Modbus RS485' : 'Bluetooth BLE'}">${isModbus ? '🔌' : '⚡'}</div>
                    <div style="min-width:0; flex:1; overflow:hidden;">
                        <div id="head-bms-name" style="font-weight:bold; font-size:0.92rem; color:#fff; line-height:1.2; display:flex; align-items:center; gap:5px; min-width:0;">
                            <span id="head-bms-title" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:145px; display:inline-block;">${bmsDisplayName}</span>
                            ${connBadgeHtml}
                        </div>
                        <div id="head-sn" style="font-size:0.68rem; color:var(--text-sub); font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${isModbus ? (d.active_bms_mac ? `ID: ${d.active_bms_mac}` : 'RS485 Modbus') : (d.active_bms_mac ? `MAC: ${d.active_bms_mac}` : 'Chưa chọn Pack')}</div>
                        <div id="esp-online-badge" style="font-size:0.68rem; font-weight:700; color:${statusColor}; display:flex; align-items:center; gap:4px; margin-top:2px;">
                            <span id="esp-online-dot" style="display:inline-block; width:6px; height:6px; border-radius:50%; background:${statusColor}; box-shadow:0 0 5px ${statusColor};"></span>
                            <span id="esp-online-txt">${statusText}</span>
                        </div>
                    </div>
                </div>
                <div class="top-bar-right">
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

        <!-- ================== PACK SELECTOR TABS (Multi-Pack) ================== -->
        <div id="pack-selector" style="${(packsSummary && packsSummary.length > 0) ? 'display:flex;' : 'display:none;'} align-items:center; gap:6px; padding:8px 12px 6px; overflow-x:auto; background:var(--bg-card); border-bottom:1px solid #1e2d3a; scrollbar-width:none; -webkit-overflow-scrolling:touch;">
          <span style="font-size:0.72rem; color:var(--text-sub); align-self:center; white-space:nowrap; padding-right:2px;">Pack:</span>
          <div id="pack-tabs-container" style="display:flex; gap:8px;">
          ${packsSummary ? packsSummary.map((p, i) => {
            const pName = (p.name && p.name.length > 0) ? p.name : `Pack ${i+1}`;
            const pVolt = p.voltage > 0 ? p.voltage.toFixed(1)+'V' : '?V';
            const pSoc  = p.soc > 0 ? p.soc+'%' : '?%';
            const isAct = p.idx === activePackIdx;
            return `<div id="pack-tab-${p.idx}" onclick="switchPack(${p.idx})" style="
              position:relative; display:flex; flex-direction:column; align-items:center; padding:5px 12px; border-radius:8px; cursor:pointer; white-space:nowrap; min-width:76px; transition:all 0.2s;
              background:${isAct ? 'linear-gradient(135deg,#0ea5e9,#22d3ee)' : '#1a2a35'};
              color:${isAct ? '#fff' : 'var(--text-sub)'};
              box-shadow:${isAct ? '0 0 8px rgba(14,165,233,0.5)' : 'none'};
              font-weight:${isAct ? '700' : '400'};
            ">
              <span style="font-size:0.75rem; font-weight:700;">${pName.length > 10 ? pName.slice(0,10)+'..' : pName}</span>
              <span style="font-size:0.68rem; opacity:0.85;">${pVolt} · ${pSoc}</span>
              <span style="font-size:0.6rem; margin-top:1px;">${p.connected ? '● Online' : '○ Cached'}</span>
              <button onclick="event.stopPropagation(); deletePack(${p.idx})" title="Xóa pack này khỏi danh sách" style="position:absolute; top:-5px; right:-5px; background:rgba(239,68,68,0.9); color:#fff; border:1px solid rgba(255,255,255,0.4); border-radius:50%; width:16px; height:16px; font-size:10px; line-height:14px; text-align:center; cursor:pointer; padding:0; display:flex; align-items:center; justify-content:center; box-shadow:0 1px 3px rgba(0,0,0,0.5); opacity:0.85;">✕</button>
            </div>`;
          }).join('') : ''}
          </div>
          <button id="btn-clear-packs" onclick="clearAllPacks()" title="Xóa toàn bộ danh sách Pack" style="background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.35); color:#f87171; border-radius:8px; padding:6px 10px; font-size:0.72rem; font-weight:700; cursor:pointer; white-space:nowrap; display:flex; align-items:center; gap:4px; margin-left:4px;">
            <span>🗑️</span><span>Xóa DS</span>
          </button>
        </div>

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
                    <path id="gauge-arc" d="M 41.1,110 A 68,68 0 1,1 158.9,110" fill="none" stroke="${(bmsConnected || hasData) && socNum > 50 ? 'url(#gaugeGrad)' : ((bmsConnected || hasData) ? '#00ff2b' : '#556570')}" stroke-width="12" stroke-linecap="round" stroke-dasharray="284.8 350" stroke-dashoffset="${(bmsConnected || hasData) ? initialOffset : '284.8'}" style="transition: stroke-dashoffset 0.6s ease;" filter="url(#neonGlow)"/>

                    <!-- Center SOC % Text -->
                    <text id="home-soc-txt" x="100" y="68" text-anchor="middle" dominant-baseline="central" fill="${(bmsConnected || hasData) ? '#00ff2b' : '#556570'}" font-size="38" font-weight="900" font-family="-apple-system, sans-serif" filter="url(#neonGlow)">${(bmsConnected || hasData) ? socNum + '%' : '0%'}</text>

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
                <span id="banner-icon" class="banner-icon" style="${bmsConnected ? '' : 'color:var(--yellow);'}">${bmsConnected ? '✔' : (isModbus ? '🔌' : '📡')}</span>
                <span id="banner-msg">${bmsConnected ? `Đang kết nối với ${bmsDisplayName} • Pin hoạt động bình thường` : (isModbus ? (hasData ? `Đang kết nối lại RS485 với ${bmsDisplayName}...` : 'Đang chờ tín hiệu RS485 Modbus...') : (d.active_bms_mac ? `Đang tìm & kết nối BLE tới ${bmsDisplayName}...` : 'BMS chưa kết nối Bluetooth'))}</span>
            </div>

            <!-- QUICK BLUETOOTH SCAN & CONNECT BAR (HOME SCREEN - ONLY FOR BLE) -->
            <div class="quick-ble-box" id="home-ble-box" style="${isModbus ? 'display:none;' : ''}">
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
                <div class="rt-row"><span class="rt-lbl">Balancer:</span><span id="rt-balancer" class="rt-val">${!balSw ? 'TẮT (OFF)' : (balAct ? 'BẬT (Đang cân)' : 'BẬT (Chờ cân)')}</span></div>
            </div>

            <div class="jk-bat-summary">
                <span><span class="jk-dot"></span>Bat. Voltage<span class="unit">(V)</span>: <span class="val" id="rt-bat-v-sum">${voltage}</span></span>
                <span><span class="jk-dot"></span>Bat. Current<span class="unit">(A)</span>: <span class="val" id="rt-bat-i-sum">${current}</span></span>
            </div>
            <div class="jk-divider"></div>

            <div class="jk-section-title"><span class="jk-dot"></span>Cell Voltages <span class="unit">(V)</span> <span class="colon">:</span></div>
            <div id="cells-grid-3" class="jk-grid-3"></div>

            <div class="jk-divider"></div>

            <div class="jk-section-title"><span class="jk-dot"></span>Balance Wire Resistance <span class="unit">(Ω)</span> <span class="colon">:</span></div>
            <div id="wire-grid-3" class="jk-grid-3"></div>

            <div class="jk-divider"></div>

            <div class="realtime-title" style="margin-top:18px;">🛡️ • Protection & Safety Status :</div>
            <div id="protection-grid" class="protection-grid"></div>

            <div class="realtime-title" style="margin-top:18px;">📋 • Device Information :</div>
            <div class="info-card-box" style="margin-bottom:16px;">
                <div class="card-row"><span>Tên Bộ Pin (Pack):</span><strong id="dev-info-pack-name" style="color:var(--cyan)">${bmsDisplayName}</strong></div>
                <div class="card-row"><span>Mã Model BMS:</span><strong id="dev-info-model" style="color:#fff; font-family:monospace;">${(d.modelName && d.modelName !== '—' && d.modelName !== bmsDisplayName) ? d.modelName : (d.protocol_version || 'JK02_32S')}</strong></div>
                <div class="card-row"><span>Serial Number:</span><strong id="dev-info-sn" style="color:#fff; font-family:monospace;">${d.serialNumber||d.bmsSerialNumber||'—'}</strong></div>
                <div class="card-row"><span>Hardware Version:</span><strong id="dev-info-hw" style="color:#fff">${d.bmsHwVersion||d.hwVersionStr||'—'}</strong></div>
                <div class="card-row"><span>Software Version:</span><strong id="dev-info-sw" style="color:#fff">${d.bmsSwVersion||d.swVersionStr||'—'}</strong></div>
                <div class="card-row"><span>Protocol Family:</span><strong id="dev-info-family" style="color:var(--green)">${d.protocol_version ? d.protocol_version + (d.bmsFamilyStr ? ' (' + d.bmsFamilyStr + ')' : '') : 'JK02_32S'}</strong></div>
                <div class="card-row"><span>CAN Protocol:</span><strong id="dev-info-can" style="color:var(--cyan)">${getCanProtocolName(d.can_protocol !== undefined ? d.can_protocol : d.canProtocol)}</strong></div>
                <div class="card-row"><span>Address ID:</span><strong id="dev-info-addr" style="color:var(--green); font-family:monospace;">${formatBmsAddress(d.address_id !== undefined ? d.address_id : d.rs485DeviceId)}</strong></div>
                <div class="card-row" id="row-dev-info-mac"><span>${isModbus ? 'Cổng Giao Tiếp:' : 'Bluetooth MAC:'}</span><strong id="dev-info-mac" style="color:var(--cyan); font-family:monospace;">${isModbus ? 'RS485 Modbus RTU' : (d.active_bms_mac||'—')}</strong></div>
                <div class="card-row" id="row-dev-info-ble-rssi" style="display:${isModbus ? 'none' : 'flex'};"><span>Tín Hiệu BLE:</span><strong id="dev-info-ble-rssi" style="color:var(--cyan); font-family:monospace;">${(d.ble_rssi && d.ble_rssi !== 0) ? d.ble_rssi + ' dBm' : '—'}</strong></div>
                ${isModbus ? `
                <div class="card-row" id="row-dev-info-pin"><span>Mã PIN BMS:</span><strong id="dev-info-pin" style="color:#fff; font-family:monospace;">${d.devicePasscode||'—'}</strong></div>
                <div class="card-row" id="row-dev-info-setup-pin"><span>Mật Khẩu Cài Đặt:</span><strong id="dev-info-setup-pin" style="color:var(--green); font-family:monospace;">${d.setup_passcode||d.setupPasscode||'—'}</strong></div>
                ` : ''}
                <div class="card-row"><span>Kích Hoạt:</span><strong id="dev-info-act" style="color:var(--green); font-size:0.75rem;">${reg}</strong></div>
            </div>
        </div>

        <!-- ==================== TAB 3: SETTINGS (RS485 & BMS CONFIG) ==================== -->
        <div id="tab-settings" class="tab-content">
            <!-- PACK CONNECTION CONFIG (RS485 / BLE) -->
            ${isModbus ? `
            <div class="sett-card" id="rs485-card">
                <h3 style="color:var(--cyan); margin-bottom:10px; font-size:1rem;">🔌 Quản Lý Cổng RS485 Modbus RTU</h3>
                <div id="rs485-connected-view" style="display:block;">
                    <div class="list-item" style="display:flex; justify-content:space-between; align-items:center; padding:12px; margin-bottom:10px; border-left:4px solid ${bmsConnected ? 'var(--green)' : 'var(--red)'}; background:rgba(15,23,42,0.7);">
                        <div>
                            <div style="font-weight:700; font-size:0.95rem; color:#fff;" id="lbl-rs485-name">🔋 ${bmsConnected ? bmsDisplayName : 'Chưa kết nối BMS'}</div>
                            <div style="font-size:0.8rem; color:var(--text-sub); margin-top:3px;">Giao thức: <span style="color:var(--cyan); font-family:monospace;">RS485 Modbus RTU (Slave ID ${d.address_id || 1})</span></div>
                        </div>
                        <div style="text-align:right;">
                            <span class="cell-badge" style="background:${bmsConnected ? 'rgba(63,185,80,0.2)' : 'rgba(255,59,48,0.2)'}; color:${bmsConnected ? 'var(--green)' : 'var(--red)'}; border:1px solid ${bmsConnected ? 'var(--green)' : 'var(--red)'}; width:auto; padding:3px 8px; font-size:0.75rem; border-radius:12px;" id="lbl-rs485-status">${bmsConnected ? '● Đang kết nối' : '○ Mất kết nối'}</span>
                        </div>
                    </div>
                    <button class="btn" onclick="queryBmsSettings(true)" style="margin-bottom:8px; background:linear-gradient(135deg, #0284c7, #0369a1); font-weight:700;">🔄 Đọc Lại Toàn Bộ Cài Đặt Từ BMS (RS485)</button>
                </div>
            </div>
            ` : `
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
                    <div style="display:flex; gap:8px; margin-bottom:8px;">
                        <button class="btn" onclick="scanBLE()" style="flex:1; margin:0;">🔍 Quét Thiết Bị BLE Xung Quanh</button>
                        <button class="btn btn-sec" onclick="clearAllPacks()" style="width:auto; margin:0; border-color:var(--red); color:var(--red); font-weight:700; padding:8px 12px;" title="Xóa toàn bộ danh sách Pack đã lưu">🗑️ Xóa DS Pack</button>
                    </div>
                    <div id="ble-status" style="margin-top:6px; font-size:0.8rem; color:var(--text-sub);"></div>
                    <div id="ble-list" style="margin-top:8px;"></div>
                </div>
            </div>
            `}

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
                        <span id="sett-addr-badge" style="background:rgba(0,255,43,0.12); color:var(--green); border:1px solid rgba(0,255,43,0.3); border-radius:6px; padding:4px 10px; font-weight:700; font-family:monospace; font-size:0.85rem;">
                            ${formatBmsAddress(d.address_id !== undefined ? d.address_id : d.rs485DeviceId)}
                        </span>
                    </div>
                </div>
                <div style="font-size:0.72rem; color:var(--text-sub); margin-top:-4px; margin-bottom:12px; line-height:1.4;">
                    📌 Địa chỉ ID phần cứng được gạt bằng công tắc DIP (1-4) trên mặt pin (0000 = ID 1 Master, 1000 = ID 1/2...). BMS tự động nhận diện và gửi lên Cloud.
                </div>
            </div>

            <!-- WIFI & DEVICE INFO -->
            <div class="sett-card" id="wifi-card">
                <h3 style="color:var(--cyan); margin-bottom:10px; font-size:1rem;">📡 Thông Tin Thiết Bị ESP32</h3>
                <div class="info-card-box" style="margin:0; background:transparent; border:none; padding:0;">
                    <div class="card-row"><span>Device ID:</span><strong style="color:var(--cyan); font-family:monospace;">${d.device_id}</strong></div>
                    <div class="card-row"><span>Kiểu Kết Nối:</span><strong style="color:${isModbus ? '#f59e0b' : 'var(--cyan)'};" id="lbl-conn-proto">${connProtocol}</strong></div>
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

    function formatBmsAddress(addr) {
        if (addr === undefined || addr === null || addr === '' || addr === '—') return 'ID 1 (Master)';
        const num = Number(addr);
        if (isNaN(num) || num <= 0) return 'ID 1 (Master / Mặc định)';
        return 'ID ' + num;
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

    // ── Pack Selector: chuyển pack đang stream ──────────────────────────────
    let isSwitchingPack = false;
    let switchingTargetIdx = null;
    let switchingUntilMs = 0;
    let packSwitchCooldownUntil = 0;
    let packSwitchTicker = null;
    let PACKS_DATA = ${packsSummaryJs};

    function startPackSwitchCooldown(seconds) {
        if (packSwitchTicker) clearInterval(packSwitchTicker);
        const container = document.getElementById('pack-tabs-container');
        if (container) {
            container.style.opacity = '0.7';
            container.style.cursor = 'wait';
        }
        let remaining = seconds;
        packSwitchTicker = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(packSwitchTicker);
                packSwitchTicker = null;
                if (container) {
                    container.style.opacity = '1';
                    container.style.cursor = 'default';
                }
                showParamToast('✅ Đã sẵn sàng chuyển pack pin!');
            }
        }, 1000);
    }

    async function switchPack(idx) {
        const now = Date.now();
        if (now < packSwitchCooldownUntil) {
            const remainSec = Math.ceil((packSwitchCooldownUntil - now) / 1000);
            showParamToast('⏳ Đang kết nối Bluetooth, vui lòng chờ ' + remainSec + 's để tránh xung đột!', true);
            return;
        }

        const packs = window.PACKS_DATA || PACKS_DATA;
        let targetMac = '';
        let targetName = '';
        if (packs && Array.isArray(packs)) {
            const found = packs.find(p => p.idx === idx);
            if (found) {
                targetMac = found.mac || '';
                targetName = found.name || '';
            }
        }

        // Khóa chuyển pack 6 giây chống spam click
        packSwitchCooldownUntil = now + 6000;
        switchingTargetIdx = idx;
        switchingUntilMs = now + 8000;
        isSwitchingPack = true;
        startPackSwitchCooldown(6);

        // Highlight tab đang chọn ngay lập tức
        if (packs && Array.isArray(packs)) {
            packs.forEach(p => {
                const tab = document.getElementById('pack-tab-' + p.idx);
                if (!tab) return;
                const isNew = (p.idx === idx);
                tab.style.background = isNew ? 'linear-gradient(135deg,#0ea5e9,#22d3ee)' : '#1a2a35';
                tab.style.color = isNew ? '#fff' : 'var(--text-sub)';
                tab.style.boxShadow = isNew ? '0 0 8px rgba(14,165,233,0.5)' : 'none';
                tab.style.fontWeight = isNew ? '700' : '400';
            });
        }

        showParamToast('⚡ Đang chuyển sang ' + (targetName || ('Pack ' + (idx + 1))) + ' (khóa 6s chống spam)...');

        try {
            const res = await fetch('/api/set-active-pack', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: '${d.device_id}', idx: idx, mac: targetMac, name: targetName })
            });
            if (res.status === 429) {
                const d = await res.json();
                showParamToast('⏳ ' + (d.error || 'Vui lòng chờ ít giây...'), true);
            }
        } catch(e) {}
    }

    async function deletePack(idx) {
        const pack = (window.PACKS_DATA || []).find(p => p.idx === idx) || {};
        const mac = pack.mac || '';
        const packLabel = pack.name || ('Pack ' + (idx + 1));
        if (!confirm('Xác nhận XÓA [' + packLabel + '] (' + (mac || 'Không có MAC') + ') khỏi danh sách quản lý?')) return;
        try {
            const res = await fetch('/api/delete-pack', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: '${d.device_id}', idx: idx, mac: mac })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                if (data.packs_summary) {
                    window.PACKS_DATA = data.packs_summary;
                    PACKS_DATA = data.packs_summary;
                    updatePackTabs(data.packs_summary, data.active_pack_idx || 0, true);
                }
                refreshLiveData();
            } else {
                alert('Không thể xóa pack: ' + (data.error || 'Lỗi không xác định'));
            }
        } catch(e) {
            alert('Lỗi kết nối khi xóa pack: ' + e.message);
        }
    }

    async function clearAllPacks() {
        if (!confirm('Xác nhận XÓA TOÀN BỘ danh sách pack đã lưu? ESP32 sẽ xóa trắng danh sách để bạn kết nối pin mới.')) return;
        try {
            const res = await fetch('/api/clear-packs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: '${d.device_id}' })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                window.PACKS_DATA = [];
                PACKS_DATA = [];
                const container = document.getElementById('pack-selector');
                if (container) container.style.display = 'none';
                showParamToast('✅ Đã xóa toàn bộ danh sách Pack thành công!');
                setTimeout(() => { refreshLiveData(); }, 1200);
            } else {
                alert('Không thể xóa danh sách pack: ' + (data.error || 'Lỗi không xác định'));
            }
        } catch(e) {
            alert('Lỗi kết nối khi xóa danh sách pack: ' + e.message);
        }
    }

    function updatePackTabs(packsSummary, activeIdx, forceRebuild = false) {
        if (!packsSummary || !Array.isArray(packsSummary) || packsSummary.length <= 1) {
            const container = document.getElementById('pack-selector');
            if (container) container.style.display = 'none';
            return;
        }
        window.PACKS_DATA = packsSummary;
        PACKS_DATA = packsSummary;
        const container = document.getElementById('pack-selector');
        if (!container) return;
        container.style.display = 'flex';

        // Kiểm tra xem đã có đủ tabs chưa hoặc cần bắt buộc build lại
        let needsRebuild = forceRebuild;
        if (!needsRebuild) {
            const curTabs = container.querySelectorAll('[id^="pack-tab-"]');
            if (curTabs.length !== packsSummary.length) needsRebuild = true;
            packsSummary.forEach(p => {
                if (!document.getElementById('pack-tab-' + p.idx)) needsRebuild = true;
            });
        }

        if (needsRebuild) {
            let html = '';
            packsSummary.forEach((p, i) => {
                const pName = (p.name && p.name.length > 0) ? p.name : ('Pack ' + (i + 1));
                const pVolt = p.voltage > 0 ? (p.voltage.toFixed(1) + 'V') : '?V';
                const pSoc  = p.soc > 0 ? (p.soc + '%') : '?%';
                const isAct = (p.idx === activeIdx);
                const bg = isAct ? 'linear-gradient(135deg,#0ea5e9,#22d3ee)' : '#1a2a35';
                const color = isAct ? '#fff' : 'var(--text-sub)';
                const shadow = isAct ? '0 0 8px rgba(14,165,233,0.5)' : 'none';
                const fw = isAct ? '700' : '400';
                const displayName = pName.length > 10 ? (pName.slice(0, 10) + '..') : pName;
                const statusTxt = p.connected ? '● Online' : '○ Cached';

                html += '<div id="pack-tab-' + p.idx + '" style="' +
                  'position:relative; display:flex; flex-direction:column; align-items:center; padding:5px 12px; border-radius:8px; cursor:pointer; white-space:nowrap; min-width:76px; transition:all 0.2s;' +
                  'background:' + bg + '; color:' + color + '; box-shadow:' + shadow + '; font-weight:' + fw + ';" ' +
                  'onclick="switchPack(' + p.idx + ')">' +
                  '<span style="font-size:0.75rem; font-weight:700;">' + displayName + '</span>' +
                  '<span style="font-size:0.68rem; opacity:0.85;">' + pVolt + ' · ' + pSoc + '</span>' +
                  '<span style="font-size:0.6rem; margin-top:1px;">' + statusTxt + '</span>' +
                  '<button onclick="event.stopPropagation(); deletePack(' + p.idx + ')" ' +
                    'title="Xóa pack này khỏi danh sách" ' +
                    'style="position:absolute; top:-5px; right:-5px; background:rgba(239,68,68,0.9); color:#fff; border:1px solid rgba(255,255,255,0.4); border-radius:50%; width:16px; height:16px; font-size:10px; line-height:14px; text-align:center; cursor:pointer; padding:0; display:flex; align-items:center; justify-content:center; box-shadow:0 1px 3px rgba(0,0,0,0.5); opacity:0.8;">✕</button>' +
                '</div>';
            });
            const spanLabel = '<span style="font-size:0.72rem; color:var(--text-sub); align-self:center; white-space:nowrap; padding-right:2px;">Pack:</span>';
            const clearBtn = '<button id="btn-clear-packs" onclick="clearAllPacks()" title="Xóa toàn bộ danh sách Pack" style="background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.35); color:#f87171; border-radius:8px; padding:6px 10px; font-size:0.72rem; font-weight:700; cursor:pointer; white-space:nowrap; display:flex; align-items:center; gap:4px; margin-left:4px;"><span>🗑️</span><span>Xóa DS</span></button>';
            container.innerHTML = spanLabel + '<div id="pack-tabs-container" style="display:flex; gap:8px;">' + html + '</div>' + clearBtn;
            return;
        }

        // Cập nhật tabs hiện có
        packsSummary.forEach(p => {
            const tab = document.getElementById('pack-tab-' + p.idx);
            if (!tab) return;
            const isAct = (p.idx === activeIdx);
            tab.style.background = isAct ? 'linear-gradient(135deg,#0ea5e9,#22d3ee)' : '#1a2a35';
            tab.style.color = isAct ? '#fff' : 'var(--text-sub)';
            tab.style.boxShadow = isAct ? '0 0 8px rgba(14,165,233,0.5)' : 'none';
            tab.style.fontWeight = isAct ? '700' : '400';
            const spans = tab.querySelectorAll('span');
            const pName = (p.name && p.name.length > 0) ? p.name : ('Pack ' + (p.idx + 1));
            const displayName = pName.length > 10 ? (pName.slice(0, 10) + '..') : pName;
            if (spans[0]) spans[0].innerText = displayName;
            if (spans.length >= 2) {
                if (p.voltage > 0) {
                    spans[1].innerText = p.voltage.toFixed(1) + 'V · ' + (p.soc || 0) + '%';
                }
                if (spans[2]) spans[2].innerText = p.connected ? '● Online' : '○ Cached';
            }
        });
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
                        val: numVal,
                        slave_id: (window._lastDevData && window._lastDevData.address_id) ? window._lastDevData.address_id : 1
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
                showParamToast('✅ Đã ghi ' + name + ' (' + numVal + displayUnit + ') thành công qua Modbus!');
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
            badge.innerText = '⏳ Đang đồng bộ thông số từ BMS qua Modbus...';
        }
        try {
            await fetch('/api/send-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: '${d.device_id}',
                    cmd: { 
                        cmd: 'query_settings',
                        slave_id: (window._lastDevData && window._lastDevData.address_id) ? window._lastDevData.address_id : 1
                    }
                })
            });
            if (showToast) showParamToast('✅ Đã gửi lệnh yêu cầu đọc lại cài đặt từ BMS qua Modbus!');
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
            const badgeAddr = document.getElementById('sett-addr-badge');
            if (badgeAddr) badgeAddr.innerText = formatBmsAddress(addrVal);
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
        if (window._isRefreshing) return;
        window._isRefreshing = true;
        try {
            const res = await fetch('/api/devices?device_id=${d.device_id}&watch=1&_t=' + Date.now());
            if (!res.ok) return;
            const devices = await res.json();
            const dev = devices.find(item => item.device_id === '${d.device_id}');
            if (!dev) return;

            window._lastDevData = dev;
            const settTab = document.getElementById('tab-settings');
            if (settTab && settTab.classList.contains('active')) {
                updateSettingsForm(dev);
            }

            if (dev.packs_summary && Array.isArray(dev.packs_summary) && dev.packs_summary.length > 1) {
                let actIdx = dev.active_pack_idx !== undefined ? dev.active_pack_idx : 0;
                if (dev.active_bms_mac) {
                    const norm = dev.active_bms_mac.toLowerCase().replace(/[:-]/g, '');
                    const f = dev.packs_summary.findIndex(p => (p.mac || '').toLowerCase().replace(/[:-]/g, '') === norm);
                    if (f >= 0) actIdx = f;
                }
                // Lock protection: nếu vừa click đổi pack trong vòng 6s, không cho phép giật lại pack cũ
                if (switchingUntilMs > Date.now() && switchingTargetIdx !== null) {
                    if (actIdx === switchingTargetIdx) {
                        switchingUntilMs = 0;
                        switchingTargetIdx = null;
                        isSwitchingPack = false;
                    } else {
                        actIdx = switchingTargetIdx;
                    }
                }
                updatePackTabs(dev.packs_summary, actIdx);
            } else {
                const container = document.getElementById('pack-selector');
                if (container) container.style.display = 'none';
            }

            const curCan = dev.can_protocol !== undefined ? dev.can_protocol : dev.canProtocol;
            const curAddr = dev.address_id !== undefined ? dev.address_id : (dev.rs485DeviceId !== undefined ? dev.rs485DeviceId : dev.rs485_device_id);
            if (curCan !== undefined && curCan !== null && curCan !== '') _set('dev-info-can', getCanProtocolName(curCan));
            if (curAddr !== undefined && curAddr !== null && curAddr !== '') _set('dev-info-addr', formatBmsAddress(curAddr));
            // Update Device Info card fields
            const bmsPackName = (dev.active_pack_alias || dev.active_pack_name || dev.bms_name || dev.device_name || dev.active_bms_name || 'JK-BMS');
            _set('dev-info-pack-name', bmsPackName);
            const rawModel = dev.modelName || dev.model_name || '';
            const bmsModel = (rawModel && rawModel !== '—' && rawModel !== bmsPackName) ? rawModel : (dev.protocol_version || 'JK02_32S');
            _set('dev-info-model', bmsModel);
            if (dev.serialNumber && dev.serialNumber !== '—') _set('dev-info-sn', dev.serialNumber);
            else if (dev.bmsSerialNumber && dev.bmsSerialNumber !== '—') _set('dev-info-sn', dev.bmsSerialNumber);
            if (dev.bmsHwVersion && dev.bmsHwVersion !== '—') _set('dev-info-hw', dev.bmsHwVersion);
            else if (dev.hwVersionStr && dev.hwVersionStr !== '—') _set('dev-info-hw', dev.hwVersionStr);
            if (dev.bmsSwVersion && dev.bmsSwVersion !== '—') _set('dev-info-sw', dev.bmsSwVersion);
            else if (dev.swVersionStr && dev.swVersionStr !== '—') _set('dev-info-sw', dev.swVersionStr);
            if (dev.protocol_version) _set('dev-info-family', dev.protocol_version + (dev.bmsFamilyStr ? ' (' + dev.bmsFamilyStr + ')' : ''));
            const isBalancer = (dev.conn_type === 'uart_lcd') || (dev.conn_type === 'balancer') || (dev.conn_type_num === 3) || (dev.firmware_version && dev.firmware_version.includes('BALANCER')) || (dev.device_id && dev.device_id.startsWith('JKBAL'));
            const isMod = !isBalancer && ((dev.conn_type === 'ble' || dev.conn_type_num === 1 || (dev.firmware_version && dev.firmware_version.includes('BLE')))
                ? false
                : ((dev.conn_type === 'modbus') || (dev.conn_type === 'rs485') || (dev.conn_type_num === 2) || (dev.firmware_version && dev.firmware_version.includes('RS485')) || (dev.active_bms_mac && String(dev.active_bms_mac).startsWith('RS485'))));
            if (isBalancer) {
                _set('dev-info-mac', 'JK Balancer UART TTL (Cổng LCD)');
                const rowBle = document.getElementById('row-dev-info-ble-rssi');
                if (rowBle) rowBle.style.display = 'none';
                const rowPin = document.getElementById('row-dev-info-pin');
                if (rowPin) rowPin.style.display = 'none';
                const rowSetupPin = document.getElementById('row-dev-info-setup-pin');
                if (rowSetupPin) rowSetupPin.style.display = 'none';
                const hBox = document.getElementById('home-ble-box');
                if (hBox) hBox.style.display = 'none';
            } else if (isMod) {
                _set('dev-info-mac', 'RS485 Modbus RTU');
                const rowBle = document.getElementById('row-dev-info-ble-rssi');
                if (rowBle) rowBle.style.display = 'none';
                const rowPin = document.getElementById('row-dev-info-pin');
                if (rowPin) { rowPin.style.display = 'flex'; _set('dev-info-pin', dev.devicePasscode || '—'); }
                const rowSetupPin = document.getElementById('row-dev-info-setup-pin');
                if (rowSetupPin) { rowSetupPin.style.display = 'flex'; _set('dev-info-setup-pin', dev.setup_passcode || dev.setupPasscode || '—'); }
                const hBox = document.getElementById('home-ble-box');
                if (hBox) hBox.style.display = 'none';
            } else {
                _set('dev-info-mac', dev.active_bms_mac || '—');
                const bleRssiStr = (dev.ble_rssi && dev.ble_rssi !== 0) ? dev.ble_rssi + ' dBm' : '—';
                _set('dev-info-ble-rssi', bleRssiStr);
                const rowBle = document.getElementById('row-dev-info-ble-rssi');
                if (rowBle) rowBle.style.display = 'flex';
                const hBox = document.getElementById('home-ble-box');
                if (hBox) hBox.style.display = 'block';
            }

            const isOnline = !!(dev.online || (dev.lastSeen && (Date.now() - dev.lastSeen < 60000)));
            const hasData = dev.voltage !== undefined && dev.voltage > 0;

            // ── 90s BMS Reconnection Grace Period ─────────────────────────────
            // Khi ESP đang kết nối lại (hoặc mất tạm thời do sóng yếu/quét/round-robin),
            // giữ nguyên trạng thái kết nối Xanh trong 90 giây để khách hàng xem không bị khó chịu!
            if (dev.connected === true) {
                window._lastBmsConnOkTime = Date.now();
            } else if (hasData && !window._lastBmsConnOkTime) {
                window._lastBmsConnOkTime = dev.lastBmsConnected || Date.now();
            }
            const bmsGraceElapsed = window._lastBmsConnOkTime ? (Date.now() - window._lastBmsConnOkTime) : 999999;
            const isConn = isOnline && (dev.connected === true || (hasData && bmsGraceElapsed < 90000));

            // Online Badge
            const dot = _c('esp-online-dot');
            const txt = _c('esp-online-txt');
            const badge = _c('esp-online-badge');
            if (dot && txt && badge) {
                const badgeColor = isOnline ? (isConn ? '#00ff2b' : '#f59e0b') : '#ff3b30';
                dot.style.background = badgeColor;
                dot.style.boxShadow = '0 0 5px ' + badgeColor;
                txt.textContent = isOnline ? (isConn ? 'ESP Online • BMS Đang kết nối' : 'ESP Online • Đang đợi BMS') : 'ESP Offline';
                badge.style.color = badgeColor;
            }

            // BT / Modbus Icon
            const btIcon = _c('bt-icon-head');
            if (btIcon) {
                if (isConn) btIcon.className = 'bt-status active';
                else btIcon.className = 'bt-status';
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

            // Name & Protocol Live Update
            const bmsName = (dev.active_bms_name && dev.active_bms_name !== 'JK_PB2A16S15P' && !dev.active_bms_name.startsWith('JK-BMS [') ? dev.active_bms_name : null) || dev.active_pack_name || dev.active_pack_alias || dev.active_bms_name || (isBalancer ? 'JK Active Balancer' : (isMod ? 'JK-PB Modbus' : 'JK-BMS'));
            _set('head-bms-title', (isConn || hasData) ? bmsName : (dev.active_bms_mac ? bmsName : (isBalancer ? 'JK Active Balancer' : 'Chưa kết nối BMS')));
            const badgeEl = _c('conn-type-badge');
            if (badgeEl) {
                badgeEl.textContent = isBalancer ? '⚡ CÂN BẰNG JK' : (isMod ? '🟠 MODBUS' : '🔵 BLUETOOTH');
                badgeEl.style.color = isBalancer ? '#10b981' : (isMod ? '#f59e0b' : '#38bdf8');
                badgeEl.style.background = isBalancer ? 'rgba(16,185,129,0.18)' : (isMod ? 'rgba(245,158,11,0.18)' : 'rgba(56,189,248,0.18)');
                badgeEl.style.borderColor = isBalancer ? 'rgba(16,185,129,0.45)' : (isMod ? 'rgba(245,158,11,0.45)' : 'rgba(56,189,248,0.45)');
            }
            const iconHead = _c('bt-icon-head');
            if (iconHead) {
                iconHead.textContent = isBalancer ? '⚡' : (isMod ? '🔌' : '📡');
                iconHead.title = isBalancer ? 'Cân bằng JK UART' : (isMod ? 'Modbus RS485' : 'Bluetooth BLE');
            }
            _set('head-sn', isBalancer ? 'UART TTL (Cổng LCD)' : (isMod ? (dev.active_bms_mac ? ('ID: ' + dev.active_bms_mac) : 'RS485 Modbus') : (dev.active_bms_mac ? ('MAC: ' + dev.active_bms_mac) : 'Chưa chọn Pack')));
            _set('lbl-conn-proto', isBalancer ? 'JK Balancer UART (LCD Port)' : (isMod ? 'RS485 Modbus RTU' : 'Bluetooth BLE'));

            // Gauge: ALWAYS preserve valid battery reading, NEVER drop to 0!
            const socVal = (isConn || hasData) ? (dev.soc !== undefined ? dev.soc : 0) : 0;
            _set('home-soc-txt', socVal + '%');
            const arc = _c('gauge-arc');
            if (arc) {
                const offset = (284.8 - (socVal / 100.0) * 284.8).toFixed(1);
                arc.style.strokeDashoffset = offset;
                const socColor = ((!isConn && !hasData) || socVal <= 0) ? '#556570' : (socVal > 50 ? '#00ff2b' : (socVal > 20 ? '#ffb800' : '#ff3b30'));
                arc.setAttribute('stroke', (isConn && socVal > 50) ? 'url(#gaugeGrad)' : socColor);
                const socTxt = _c('home-soc-txt');
                if (socTxt) socTxt.setAttribute('fill', socColor);
            }

            const vStr = (isConn || hasData) && dev.voltage !== undefined ? dev.voltage.toFixed(2) + 'V' : '0.00V';
            _set('home-v-pill', vStr);
            const aStr = (isConn || hasData) && dev.current !== undefined ? dev.current.toFixed(2) + 'A' : '0.00A';
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
                } else if (hasData) {
                    const statusDetail = dev.ble_status_msg ? (' • ' + dev.ble_status_msg) : '';
                    bMsg.innerText = isBalancer ? ('Đang kết nối lại Cân Bằng...' + statusDetail) : (isMod ? ('Đang kết nối lại RS485 với ' + bmsName + statusDetail) : ('Đang kết nối lại Bluetooth với ' + bmsName + statusDetail));
                    bIcon.innerText = isBalancer ? '⚡' : (isMod ? '🔌' : '📡'); bIcon.style.color = 'var(--yellow)';
                    sBanner.style.borderColor = 'rgba(245,158,11,0.5)'; sBanner.style.background = 'rgba(40,30,5,0.85)';
                } else if (dev.active_bms_mac) {
                    const statusDetail = dev.ble_status_msg ? (' • ' + dev.ble_status_msg) : '';
                    bMsg.innerText = isBalancer ? ('Đang tìm & nhận tín hiệu UART Balancer...' + statusDetail) : (isMod ? ('Đang tìm & kết nối RS485 tới ' + bmsName + statusDetail) : ('Đang tìm & kết nối BLE tới ' + bmsName + statusDetail));
                    bIcon.innerText = isBalancer ? '⚡' : (isMod ? '🔌' : '📡'); bIcon.style.color = 'var(--yellow)';
                    sBanner.style.borderColor = 'rgba(245,158,11,0.5)'; sBanner.style.background = 'rgba(40,30,5,0.85)';
                } else {
                    bMsg.innerText = isBalancer ? 'Chưa nhận được tín hiệu UART từ Cân Bằng JK' : (isMod ? 'BMS chưa kết nối RS485' : 'BMS chưa kết nối Bluetooth');
                    bIcon.innerText = isBalancer ? '⚡' : (isMod ? '🔌' : '📡'); bIcon.style.color = 'var(--red)';
                    sBanner.style.borderColor = 'rgba(255,59,48,0.5)'; sBanner.style.background = 'rgba(40,5,5,0.85)';
                }
            }

            // Quick BLE Bar Home
            const hBleName = _c('home-ble-name');
            const hBleMac = _c('home-ble-mac');
            if (hBleName) {
                if (isConn) hBleName.innerHTML = '<span style="color:var(--green);">🟢</span> ' + bmsName + ' <span style="font-size:0.75rem; color:var(--green);">(Đang kết nối)</span>';
                else if (hasData) hBleName.innerHTML = '<span style="color:var(--yellow);">🟡</span> ' + bmsName + ' <span style="font-size:0.75rem; color:var(--yellow);">(Đang kết nối lại...)</span>';
                else if (dev.active_bms_mac) hBleName.innerHTML = '<span style="color:var(--yellow);">🟡</span> ' + bmsName + ' <span style="font-size:0.75rem; color:var(--yellow);">(Đang tìm kiếm...)</span>';
                else hBleName.innerHTML = '<span style="color:var(--text-sub);">⚪</span> Chưa kết nối BMS';
            }
            if (hBleMac) hBleMac.innerText = dev.active_bms_mac ? ('MAC: ' + dev.active_bms_mac) : 'Chưa có MAC • Hãy bấm Quét Bluetooth';

            // Metrics: ALWAYS show valid numbers, NEVER reset to 0!
            _set('m-high-v', (isConn || hasData) && dev.max_cell_voltage ? dev.max_cell_voltage.toFixed(3) : '0.000');
            _set('m-low-v', (isConn || hasData) && dev.min_cell_voltage ? dev.min_cell_voltage.toFixed(3) : '0.000');
            _set('m-diff-v', (isConn || hasData) && dev.delta_cell_voltage !== undefined ? dev.delta_cell_voltage.toFixed(3) : '0.000');
            _set('m-bal-a', (isConn || hasData) && dev.balance_current !== undefined ? dev.balance_current.toFixed(3) : '0.000');
            _set('m-cap-ah', (isConn || hasData) && dev.capacity_ah !== undefined ? Math.round(dev.capacity_ah) : '0');
            _set('m-rem-ah', (isConn || hasData) && dev.remain_capacity_ah !== undefined ? dev.remain_capacity_ah.toFixed(1) : '0.0');
            const avgV = ((isConn || hasData) && dev.min_cell_voltage && dev.max_cell_voltage) ? (((dev.min_cell_voltage||0) + (dev.max_cell_voltage||0)) / 2).toFixed(3) : '0.000';
            _set('m-cell-avg', avgV);
            _set('m-soh', (isConn || hasData) && dev.soh ? (dev.soh + '%') : '100%');

            const isChg = dev.current > 0.1;
            const isDsg = dev.current < -0.1;
            _set('card-curr-val', (isConn || hasData) && dev.current !== undefined ? ((dev.current > 0 ? '+' : '') + dev.current.toFixed(2) + ' A') : '0.00 A');
            _set('card-power-val', (isConn || hasData) && dev.power !== undefined ? (Math.abs(dev.power).toFixed(1) + ' W') : '0.0 W');
            _set('card-mos-temp', (isConn || hasData) && dev.mos_temp !== undefined ? (dev.mos_temp.toFixed(1) + ' °C') : '0.0 °C');
            _set('card-probes', ((isConn || hasData) && dev.temp1 ? dev.temp1.toFixed(1) : '0.0') + ' / ' + ((isConn || hasData) && dev.temp2 ? dev.temp2.toFixed(1) : '0.0') + ' °C');
            _set('card-status-txt', isConn ? (isChg ? 'Charging (Đang sạc)' : (isDsg ? 'Discharging (Đang xả)' : 'Standby (Chờ)')) : (hasData ? 'Reconnecting (Đang kết nối lại)' : 'Disconnected'));

            // MOS indicators
            if (dev.charge_mos !== undefined) updateMosDot('charge_mos', dev.charge_mos);
            if (dev.discharge_mos !== undefined) updateMosDot('discharge_mos', dev.discharge_mos);
            if (dev.balance_active !== undefined) updateMosDot('balance', dev.balance_active);

            // Real-time tab
            _set('rt-power', (isConn || hasData) && dev.power !== undefined ? Math.abs(dev.power).toFixed(1) : '0.0');
            _set('rt-avg', avgV);
            _set('rt-cap', (isConn || hasData) && dev.capacity_ah ? Math.round(dev.capacity_ah) : '0');
            _set('rt-diff', (isConn || hasData) && dev.delta_cell_voltage ? dev.delta_cell_voltage.toFixed(3) : '0.000');
            _set('rt-rem', (isConn || hasData) && dev.remain_capacity_ah ? dev.remain_capacity_ah.toFixed(1) : '0.0');
            _set('rt-balcurr', (isConn || hasData) && dev.balance_current ? dev.balance_current.toFixed(3) : '0.000');
            _set('rt-mos', (isConn || hasData) && dev.mos_temp ? dev.mos_temp.toFixed(1) : '0.0');
            _set('rt-cyc', (isConn || hasData) && dev.cycle_count !== undefined ? dev.cycle_count : '0');
            _set('rt-t1', (isConn || hasData) && dev.temp1 ? dev.temp1.toFixed(1) : '0.0');
            _set('rt-t2', (isConn || hasData) && dev.temp2 ? dev.temp2.toFixed(1) : '0.0');
            _set('rt-t4', (isConn || hasData) && dev.temp4 ? dev.temp4.toFixed(1) : '0.0');
            _set('rt-t5', (isConn || hasData) && dev.temp5 ? dev.temp5.toFixed(1) : '0.0');
            _set('rt-heatcurr', (isConn || hasData) && dev.heat_curr ? dev.heat_curr.toFixed(1) : '0.0');
            _set('rt-heater', dev.heating_active ? 'ON' : 'OFF');
            _set('rt-logs', dev.detail_logs_count || 0);
            _set('rt-soh', (isConn || hasData) && dev.soh ? dev.soh : 100);
            const isDevBalSw = (dev.balance !== undefined) ? !!dev.balance : (dev.balance_switch !== undefined ? !!dev.balance_switch : !!dev.balance_active);
            const isDevBalAct = (dev.balance_active !== undefined) ? !!dev.balance_active : (isDevBalSw && dev.balance_current > 0.01);
            _set('rt-balancer', !isDevBalSw ? 'TẮT (OFF)' : (isDevBalAct ? 'BẬT (Đang cân)' : 'BẬT (Chờ cân)'));
            _set('rt-bat-v-sum', (isConn || hasData) && dev.voltage !== undefined ? dev.voltage.toFixed(2) : '--');
            _set('rt-bat-i-sum', (isConn || hasData) && dev.current !== undefined ? dev.current.toFixed(2) : '--');

            // Cells Grid (3 columns, column-major authentic JK style)
            const cellsArr = Array.isArray(dev.cell_voltages) ? dev.cell_voltages : (Array.isArray(dev.cells) ? dev.cells : []);
            const cellResArr = Array.isArray(dev.cell_resistances) ? dev.cell_resistances : [];
            const minNum = dev.min_cell_num || 0;
            const maxNum = dev.max_cell_num || 0;
            const cellCount = dev.cell_count || (cellsArr.length > 0 ? cellsArr.length : 16);

            const cGrid = _c('cells-grid-3');
            if (cGrid && cellsArr.length > 0) {
                let maxCellVal = 0, minCellVal = 999;
                let foundMaxNum = maxNum, foundMinNum = minNum;

                for (let i = 0; i < cellCount; i++) {
                    const v = (cellsArr[i] !== undefined) ? (typeof cellsArr[i] === 'number' ? cellsArr[i] : parseFloat(cellsArr[i])) : 0;
                    if (v > maxCellVal) { maxCellVal = v; if (!foundMaxNum) foundMaxNum = (i + 1); }
                    if (v > 0 && v < minCellVal) { minCellVal = v; if (!foundMinNum) foundMinNum = (i + 1); }
                }

                const rows = Math.ceil(cellCount / 3);
                let html = '';
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < 3; c++) {
                        const i = r + c * rows;
                        if (i < cellCount) {
                            const num = i + 1;
                            const v = (cellsArr[i] !== undefined) ? (typeof cellsArr[i] === 'number' ? cellsArr[i] : parseFloat(cellsArr[i])) : 0;
                            const isMin = (num === minNum || (!minNum && num === foundMinNum));
                            const isMax = (num === maxNum || (!maxNum && num === foundMaxNum));

                            let cls = 'jk-val-txt';
                            let balTag = '';
                            if (isMin) {
                                cls += ' min';
                                if (dev.balance_active) balTag = '<span class="jk-bal-tag">⚖️</span>';
                            } else if (isMax) {
                                cls += ' max';
                                if (dev.balance_active) balTag = '<span class="jk-bal-tag">⚖️</span>';
                            }

                            html += '<div class="jk-cell-item">' +
                                        '<span class="jk-num-badge">' + num + '</span>' +
                                        '<span class="' + cls + '">' + v.toFixed(3) + '</span>' +
                                        balTag +
                                    '</div>';
                        } else {
                            html += '<div class="jk-cell-item"></div>';
                        }
                    }
                }
                cGrid.innerHTML = html;
            }

            if (isBalancer) {
                _set('card-mos-temp', '—');
                _set('card-probes', '—');
                _set('rt-mos', '—');
                _set('rt-t1', '—');
                _set('rt-t2', '—');
                _set('rt-t4', '—');
                _set('rt-t5', '—');
            }

            // Wire Resistance Grid (3 columns, column-major authentic JK style)
            const wGrid = _c('wire-grid-3');
            if (wGrid && cellResArr.length > 0) {
                const rows = Math.ceil(cellCount / 3);
                let wHtml = '';
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < 3; c++) {
                        const i = r + c * rows;
                        if (i < cellCount) {
                            const num = i + 1;
                            const rVal = cellResArr[i] || 0;
                            let rNum = (typeof rVal === 'number' ? rVal : parseFloat(rVal));
                            if (rNum > 1.0) rNum = rNum / 1000.0;
                            wHtml += '<div class="jk-cell-item">' +
                                        '<span class="jk-num-badge">' + num + '</span>' +
                                        '<span class="jk-val-txt">' + rNum.toFixed(3) + '</span>' +
                                    '</div>';
                        } else {
                            wHtml += '<div class="jk-cell-item"></div>';
                        }
                    }
                }
                if (wGrid.innerHTML !== wHtml) wGrid.innerHTML = wHtml;
            }

            // Protection Grid (BMS only, hidden for Balancer)
            const protGrid = _c('protection-grid');
            const protTitle = protGrid ? protGrid.previousElementSibling : null;
            if (isBalancer) {
                if (protGrid) protGrid.style.display = 'none';
                if (protTitle) protTitle.style.display = 'none';
            } else if (protGrid) {
                protGrid.style.display = 'grid';
                if (protTitle) protTitle.style.display = 'block';
                const errMask = dev.raw_errors_bitmask || 0;
                let pHtml = '';
                PROT_ITEMS.forEach(p => {
                    const isAlarm = (errMask & (1 << p.bit)) !== 0;
                    pHtml += '<div class="prot-item"><span class="prot-lbl">' + p.desc + '</span><span class="prot-badge ' + (isAlarm ? 'alarm' : 'ok') + '">' + (isAlarm ? '⚠️ Báo động' : '✔ Chuẩn') + '</span></div>';
                });
                if (protGrid.innerHTML !== pHtml) protGrid.innerHTML = pHtml;
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

        } catch(e) {
        } finally {
            window._isRefreshing = false;
        }
    }

    liveTimer = setInterval(refreshLiveData, 1000);
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
            if (!liveTimer) liveTimer = setInterval(refreshLiveData, 1000);
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

const WEB_FLASHER_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JK BMS Web Flasher - Nạp Firmware Qua Cáp USB</title>
    <!-- ESP Web Tools Official Module -->
    <script type="module" src="https://unpkg.com/esp-web-tools@10/dist/web/install-button.js?module"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0b0f17;
            --surface: #151d28;
            --surface-hover: #1e293b;
            --border: #243247;
            --cyan: #38bdf8;
            --cyan-dim: rgba(56,189,248,0.12);
            --green: #22c55e;
            --green-dim: rgba(34,197,94,0.12);
            --yellow: #f59e0b;
            --yellow-dim: rgba(245,158,11,0.12);
            --purple: #a855f7;
            --purple-dim: rgba(168,85,247,0.12);
            --text-main: #f8fafc;
            --text-sub: #94a3b8;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
        body { background: var(--bg); color: var(--text-main); min-height: 100vh; padding: 24px 16px; display: flex; flex-direction: column; align-items: center; }

        .container { width: 100%; max-width: 860px; }

        .header { text-align: center; margin-bottom: 28px; }
        .logo-badge { display: inline-flex; align-items: center; gap: 8px; background: var(--cyan-dim); border: 1px solid rgba(56,189,248,0.3); color: var(--cyan); padding: 6px 16px; border-radius: 99px; font-size: 0.85rem; font-weight: 700; margin-bottom: 12px; }
        .title { font-size: 2.1rem; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 8px; background: linear-gradient(135deg, #fff 40%, var(--cyan) 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .subtitle { font-size: 0.95rem; color: var(--text-sub); line-height: 1.5; }

        .warning-box { background: rgba(56,189,248,0.06); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; margin-bottom: 24px; font-size: 0.85rem; color: #cbd5e1; display: flex; align-items: center; gap: 12px; }
        .warning-icon { font-size: 1.5rem; flex-shrink: 0; }

        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; margin-bottom: 28px; }

        .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px; display: flex; flex-direction: column; justify-content: space-between; transition: 0.2s; position: relative; overflow: hidden; }
        .card:hover { transform: translateY(-2px); border-color: rgba(56,189,248,0.4); box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }

        .card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
        .card-icon { width: 44px; height: 44px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 1.4rem; flex-shrink: 0; }
        .card-title { font-size: 1.1rem; font-weight: 700; color: #fff; line-height: 1.3; }
        .card-ver { font-size: 0.78rem; font-weight: 700; padding: 2px 8px; border-radius: 6px; display: inline-block; margin-top: 4px; }

        .card-desc { font-size: 0.84rem; color: var(--text-sub); line-height: 1.5; margin-bottom: 20px; flex-grow: 1; }
        .card-features { list-style: none; margin-bottom: 18px; }
        .card-features li { font-size: 0.78rem; color: #cbd5e1; margin-bottom: 5px; display: flex; align-items: center; gap: 6px; }
        .card-features li::before { content: "✔"; color: var(--green); font-weight: bold; }

        /* Color accents */
        .card-ble .card-icon { background: var(--cyan-dim); border: 1px solid rgba(56,189,248,0.3); }
        .card-ble .card-ver { background: var(--cyan-dim); color: var(--cyan); border: 1px solid rgba(56,189,248,0.3); }

        .card-rs485 .card-icon { background: var(--yellow-dim); border: 1px solid rgba(245,158,11,0.3); }
        .card-rs485 .card-ver { background: var(--yellow-dim); color: var(--yellow); border: 1px solid rgba(245,158,11,0.3); }

        .card-bal .card-icon { background: var(--purple-dim); border: 1px solid rgba(168,85,247,0.3); }
        .card-bal .card-ver { background: var(--purple-dim); color: var(--purple); border: 1px solid rgba(168,85,247,0.3); }

        .card-vf .card-icon { background: var(--green-dim); border: 1px solid rgba(34,197,94,0.3); }
        .card-vf .card-ver { background: var(--green-dim); color: var(--green); border: 1px solid rgba(34,197,94,0.3); }

        /* Custom Button for ESP Web Tools */
        esp-web-install-button { width: 100%; display: block; }
        .btn-install {
            width: 100%;
            padding: 13px 16px;
            border-radius: 10px;
            font-size: 0.95rem;
            font-weight: 700;
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: 0.2s;
        }

        .btn-ble { background: var(--cyan); color: #051923; }
        .btn-ble:hover { background: #7dd3fc; }

        .btn-rs485 { background: var(--yellow); color: #2e1065; }
        .btn-rs485:hover { background: #fde047; }

        .btn-bal { background: var(--purple); color: #fff; }
        .btn-bal:hover { background: #c084fc; }

        .btn-vf { background: var(--green); color: #052e16; }
        .btn-vf:hover { background: #4ade80; }

        /* Steps guide */
        .guide-box { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px; margin-bottom: 28px; }
        .guide-title { font-size: 1.05rem; font-weight: 700; margin-bottom: 14px; color: var(--cyan); display: flex; align-items: center; gap: 8px; }
        .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
        .step-item { background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
        .step-num { width: 28px; height: 28px; border-radius: 99px; background: var(--cyan); color: #000; font-weight: 800; font-size: 0.85rem; display: flex; align-items: center; justify-content: center; margin-bottom: 8px; }
        .step-txt { font-size: 0.82rem; color: #cbd5e1; line-height: 1.45; }

        .footer { text-align: center; font-size: 0.8rem; color: var(--text-sub); border-top: 1px solid var(--border); padding-top: 20px; }
        .not-supported { display: none; background: rgba(239,68,68,0.15); border: 1px solid #ef4444; color: #fca5a5; padding: 14px; border-radius: 10px; text-align: center; margin-bottom: 20px; font-weight: 600; font-size: 0.9rem; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo-badge">⚡ WEB SERIAL FLASHER</div>
            <h1 class="title">Nạp Firmware ESP32 Qua Cáp USB</h1>
            <p class="subtitle">Khách hàng chỉ cần cắm cáp USB vào máy tính và ấn nút nạp trực tiếp trên trình duyệt.<br>Hoàn toàn không cần cài đặt Python, PlatformIO hay driver phức tạp!</p>
        </div>

        <div id="unsupported-alert" class="not-supported">
            ⚠️ Trình duyệt của bạn không hỗ trợ Web Serial API. Vui lòng mở trang web này bằng <strong>Google Chrome</strong>, <strong>Microsoft Edge</strong> hoặc <strong>Cốc Cốc</strong> trên máy tính!
        </div>

        <div class="warning-box">
            <span class="warning-icon">💡</span>
            <div>
                <strong>Lưu ý quan trọng:</strong> Chọn đúng loại thiết bị của bạn bên dưới để nạp firmware chuẩn. Bản nạp là <strong>Full Factory Image (0x0)</strong> bao gồm Bootloader, Partition và Firmware mới nhất, khôi phục 100% chip về trạng thái xuất xưởng hoàn hảo.
            </div>
        </div>

        <!-- 3 FIRMWARE CARDS -->
        <div class="grid">
            <!-- 1. BLUETOOTH BLE -->
            <div class="card card-ble">
                <div>
                    <div class="card-header">
                        <div class="card-icon">📡</div>
                        <div>
                            <div class="card-title">JK BMS Bluetooth</div>
                            <span class="card-ver">Phiên bản v2.9.0-BLE</span>
                        </div>
                    </div>
                    <p class="card-desc">Dành cho mạch ESP32 kết nối không dây với JK BMS qua Bluetooth BLE.</p>
                    <ul class="card-features">
                        <li>Hỗ trợ đổi Pack pin & xóa Pack linh hoạt</li>
                        <li>Ngắt BMS an toàn khi nhận OTA từ xa</li>
                        <li>Đọc cell điện áp, nhiệt độ, bảo vệ 24/7</li>
                    </ul>
                </div>
                <div>
                    <esp-web-install-button manifest="/manifest-ble.json">
                        <button slot="activate" class="btn-install btn-ble">
                            ⚡ Kết Nối & Nạp BLE
                        </button>
                    </esp-web-install-button>
                </div>
            </div>

            <!-- 2. RS485 MODBUS -->
            <div class="card card-rs485">
                <div>
                    <div class="card-header">
                        <div class="card-icon">🔌</div>
                        <div>
                            <div class="card-title">JK BMS RS485</div>
                            <span class="card-ver">Phiên bản v2.9.2-RS485</span>
                        </div>
                    </div>
                    <p class="card-desc">Dành cho ESP32 kết nối có dây với JK BMS qua cổng RS485 Modbus RTU.</p>
                    <ul class="card-features">
                        <li>Giao tiếp có dây chống nhiễu cực tốt</li>
                        <li>Hỗ trợ song song tới 16 Pack BMS</li>
                        <li>Đã tắt Watchdog & dừng đọc khi nạp OTA</li>
                    </ul>
                </div>
                <div>
                    <esp-web-install-button manifest="/manifest-rs485.json">
                        <button slot="activate" class="btn-install btn-rs485">
                            ⚡ Kết Nối & Nạp RS485
                        </button>
                    </esp-web-install-button>
                </div>
            </div>

            <!-- 3. BALANCER LCD -->
            <div class="card card-bal">
                <div>
                    <div class="card-header">
                        <div class="card-icon">⚖️</div>
                        <div>
                            <div class="card-title">JK Active Balancer</div>
                            <span class="card-ver">Phiên bản v1.0.0-BALANCER</span>
                        </div>
                    </div>
                    <p class="card-desc">Dành riêng cho Mạch Cân Bằng Chủ Động JK kết nối qua cổng LCD UART TTL.</p>
                    <ul class="card-features">
                        <li>Giao tiếp cổng màn hình LCD 115200</li>
                        <li>Đọc và cài đặt dòng cân bằng 5A/10A/15A</li>
                        <li>Bảo vệ chống nạp nhầm Firmware BMS</li>
                    </ul>
                </div>
                <div>
                    <esp-web-install-button manifest="/manifest-balancer.json">
                        <button slot="activate" class="btn-install btn-bal">
                            ⚡ Kết Nối & Nạp Balancer
                        </button>
                    </esp-web-install-button>
                </div>
            </div>

            <!-- 4. XOA LOI PIN VF -->
            <div class="card card-vf">
                <div>
                    <div class="card-header">
                        <div class="card-icon">🔧</div>
                        <div>
                            <div class="card-title">Xóa Lỗi Pin VinFast</div>
                            <span class="card-ver">v1.0.0-VF-PIN</span>
                        </div>
                    </div>
                    <p class="card-desc">Dành cho mạch ESP32 CYD (màn hình cảm ứng 2.8") xóa lỗi BMS pin VinFast qua giao tiếp BLE & CAN Bus.</p>
                    <ul class="card-features">
                        <li>Hiển thị trạng thái pin trực tiếp trên màn hình TFT</li>
                        <li>Xóa mã lỗi BMS pin VinFast qua CAN Bus</li>
                        <li>Hỗ trợ ESP32 Dev Module (ESP32-2432S028)</li>
                    </ul>
                </div>
                <div>
                    <esp-web-install-button manifest="/manifest-vf.json">
                        <button slot="activate" class="btn-install btn-vf">
                            🔧 Kết Nối &amp; Nạp VF Pin Tool
                        </button>
                    </esp-web-install-button>
                </div>
            </div>
        </div>

        <!-- 4-STEP INSTRUCTIONS FOR CUSTOMERS -->
        <div class="guide-box">
            <div class="guide-title">
                <span>📖</span> Hướng Dẫn 4 Bước Cho Khách Hàng
            </div>
            <div class="steps">
                <div class="step-item">
                    <div class="step-num">1</div>
                    <div class="step-txt">Cắm cáp sạc/truyền dữ liệu Type-C từ ESP32 vào cổng USB máy tính.</div>
                </div>
                <div class="step-item">
                    <div class="step-num">2</div>
                    <div class="step-txt">Nhấn nút <strong>"Kết Nối & Nạp"</strong> tương ứng với loại mạch của bạn ở trên.</div>
                </div>
                <div class="step-item">
                    <div class="step-num">3</div>
                    <div class="step-txt">Trình duyệt hiện hộp thoại chọn cổng: Chọn cổng COM (VD: <em>USB Serial</em>) rồi bấm <strong>Connect</strong>.</div>
                </div>
                <div class="step-item">
                    <div class="step-num">4</div>
                    <div class="step-txt">Chờ nạp xong 100% trong 15-20 giây. ESP32 sẽ tự khởi động lại vào firmware mới sạch sẽ!</div>
                </div>
            </div>
        </div>

        <div class="footer">
            Hệ Thống Giám Sát JK BMS WiFi Monitor &bull; Server: bms.lha.io.vn &bull; ESP32-C3 / ESP32-C6 / ESP32 / ESP32 CYD
        </div>
    </div>

    <script>
        if (!('serial' in navigator)) {
            document.getElementById('unsupported-alert').style.display = 'block';
        }
    </script>
</body>
</html>
`;

