// auth_manager.js - Quản lý tài khoản, phiên đăng nhập và phân quyền thiết bị cho JK BMS
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, 'users.json');

// In-memory state
let db = {
  users: [],
  user_devices: [],
  bind_tokens: [],
  sessions: {}
};

// Rate limiter cho đăng nhập sai
const loginAttempts = new Map(); // ip -> { count, lockedUntil }

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hashHex = crypto.createHash('sha256').update(password + ':' + salt).digest('hex');
  return { hashHex, saltHex: salt };
}

function loadUsersDb() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      db = JSON.parse(raw);
      if (!Array.isArray(db.users)) db.users = [];
      if (!Array.isArray(db.user_devices)) db.user_devices = [];
      if (!Array.isArray(db.bind_tokens)) db.bind_tokens = [];
      if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
    }
  } catch (e) {
    console.error('[Auth] Lỗi đọc users.json:', e.message);
  }

  // Đảm bảo luôn có tài khoản Admin mặc định
  let admin = db.users.find(u => u.role === 'admin' || u.username === 'longbui' || u.username === 'admin');
  if (!admin) {
    const { hashHex, saltHex } = hashPassword('anhkun123');
    admin = {
      id: 1,
      username: 'longbui',
      password_hash: hashHex,
      salt: saltHex,
      role: 'admin',
      fullname: 'Long Bùi (Admin)',
      phone: '',
      created_at: Date.now()
    };
    db.users.push(admin);
    saveUsersDb();
    console.log('[Auth] Đã khởi tạo tài khoản Admin mặc định: longbui');
  }
}

function saveUsersDb() {
  try {
    const tmp = USERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, USERS_FILE);
  } catch (e) {
    console.error('[Auth] Lỗi lưu users.json:', e.message);
  }
}

// Khởi tạo ngay khi load module
loadUsersDb();

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 30 * 24 * 3600 * 1000; // 30 ngày
  db.sessions[token] = { userId, expiresAt };
  saveUsersDb();
  return token;
}

function getAuthenticatedUser(req) {
  let token = null;
  // 1. Kiểm tra cookie
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/session_token=([a-f0-9]+)/);
  if (match) token = match[1];

  // 2. Kiểm tra header Authorization
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      token = parts[1];
    }
  }

  if (!token || !db.sessions[token]) return null;

  const session = db.sessions[token];
  if (session.expiresAt < Date.now()) {
    delete db.sessions[token];
    saveUsersDb();
    return null;
  }

  const user = db.users.find(u => u.id === session.userId);
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    fullname: user.fullname || user.username,
    phone: user.phone || ''
  };
}

function verifyAdminAuth(req) {
  const user = getAuthenticatedUser(req);
  if (user && user.role === 'admin') return true;

  // Hỗ trợ admin_token hoặc password cookie cũ
  const cookieHeader = req.headers.cookie || '';
  if (cookieHeader.includes('admin_token=')) return true;

  return false;
}

// Đăng ký tài khoản khách hàng mới
function registerUser(body) {
  const username = (body.username || '').trim();
  const password = (body.password || '').trim();
  const fullname = (body.fullname || '').trim();
  const phone = (body.phone || '').trim();

  if (!username || username.length < 3 || username.length > 30) {
    throw new Error('Tên đăng nhập phải từ 3 đến 30 ký tự');
  }
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(username)) {
    throw new Error('Tên đăng nhập chỉ gồm chữ, số, dấu gạch dưới (_) hoặc gạch ngang (-)');
  }
  if (!password || password.length < 6) {
    throw new Error('Mật khẩu phải có ít nhất 6 ký tự');
  }

  const existing = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (existing) {
    throw new Error('Tên đăng nhập này đã được sử dụng. Vui lòng chọn tên khác!');
  }

  const maxId = db.users.reduce((m, u) => Math.max(m, u.id || 0), 0);
  const { hashHex, saltHex } = hashPassword(password);
  const newUser = {
    id: maxId + 1,
    username,
    password_hash: hashHex,
    salt: saltHex,
    role: 'customer',
    fullname: fullname || username,
    phone,
    created_at: Date.now()
  };

  db.users.push(newUser);
  saveUsersDb();

  const sessionToken = createSession(newUser.id);
  return {
    user: { id: newUser.id, username: newUser.username, role: newUser.role, fullname: newUser.fullname },
    sessionToken
  };
}

// Đăng nhập
function loginUser(body, clientIp) {
  const now = Date.now();
  const attempt = loginAttempts.get(clientIp);
  if (attempt && attempt.lockedUntil && attempt.lockedUntil > now) {
    const waitMins = Math.ceil((attempt.lockedUntil - now) / 60000);
    throw new Error('Quá nhiều lần thử sai. Tạm khóa trong ' + waitMins + ' phút để bảo vệ hệ thống.');
  }

  const username = (body.username || '').trim();
  const password = (body.password || '').trim();

  if (!username || !password) {
    throw new Error('Vui lòng nhập tên đăng nhập và mật khẩu');
  }

  // 1. Kiểm tra tài khoản trong users.json
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (user) {
    const check = hashPassword(password, user.salt);
    if (check.hashHex === user.password_hash) {
      loginAttempts.delete(clientIp);
      const sessionToken = createSession(user.id);
      return {
        user: { id: user.id, username: user.username, role: user.role, fullname: user.fullname || user.username },
        sessionToken
      };
    }
  }

  // 2. Fallback đăng nhập trực tiếp quyền admin
  if ((username.toLowerCase() === 'admin' || username.toLowerCase() === 'longbui') && password === 'anhkun123') {
    let admin = db.users.find(u => u.role === 'admin');
    const uid = admin ? admin.id : 1;
    loginAttempts.delete(clientIp);
    const sessionToken = createSession(uid);
    return {
      user: { id: uid, username: 'longbui', role: 'admin', fullname: 'Long Bùi (Admin)' },
      sessionToken
    };
  }

  // Sai thông tin -> tăng đếm
  const curr = loginAttempts.get(clientIp) || { count: 0, lockedUntil: 0 };
  curr.count = (curr.count || 0) + 1;
  if (curr.count >= 5) {
    curr.lockedUntil = now + 15 * 60 * 1000;
    loginAttempts.set(clientIp, curr);
    throw new Error('Sai thông tin 5 lần. Tạm khóa 15 phút để bảo vệ tài khoản!');
  }
  loginAttempts.set(clientIp, curr);
  throw new Error('Tài khoản hoặc mật khẩu không chính xác (còn ' + (5 - curr.count) + ' lần thử)');
}

// Lấy danh sách người dùng cho Admin
function getAdminUsersList() {
  return db.users.map(u => {
    const linked = db.user_devices.filter(d => d.user_id === u.id);
    const devicesList = linked.map(d => d.device_id + (d.custom_name && d.custom_name !== d.device_id ? ` (${d.custom_name})` : '')).join(', ');
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      fullname: u.fullname || '—',
      phone: u.phone || '',
      created_at: u.created_at,
      device_count: linked.length,
      devices_list: devicesList
    };
  });
}

// Reset mật khẩu khách về 123456
function resetPasswordToDefault(userId, targetUsername) {
  let user = null;
  if (userId) user = db.users.find(u => u.id === Number(userId));
  if (!user && targetUsername) user = db.users.find(u => u.username.toLowerCase() === targetUsername.toLowerCase());

  if (!user) throw new Error('Không tìm thấy tài khoản người dùng');
  if (user.role === 'admin' && user.username.toLowerCase() === 'longbui') {
    // Vẫn cho reset về 123456 hoặc anhkun123
  }

  const { hashHex, saltHex } = hashPassword('123456');
  user.password_hash = hashHex;
  user.salt = saltHex;
  saveUsersDb();

  return { message: `Đã đặt lại mật khẩu cho tài khoản [${user.username}] về mặc định: 123456` };
}

// Liên kết thiết bị cho khách hàng
function linkDevice(userId, deviceId, customName, pin, getDeviceFn) {
  deviceId = (deviceId || '').trim();
  customName = (customName || '').trim();
  pin = (pin || '').trim();

  if (!deviceId) throw new Error('Vui lòng nhập Device ID (ví dụ: JKBMS-ACCA)');

  if (typeof getDeviceFn === 'function') {
    const dev = getDeviceFn(deviceId);
    if (dev && dev.devicePasscode && dev.devicePasscode.length >= 4 && pin) {
      if (dev.devicePasscode !== pin) {
        throw new Error('Mã PIN thiết bị không đúng');
      }
    }
  }

  const existing = db.user_devices.find(d => d.user_id === userId && d.device_id === deviceId);
  if (existing) {
    existing.custom_name = customName || deviceId;
  } else {
    db.user_devices.push({
      user_id: userId,
      device_id: deviceId,
      custom_name: customName || deviceId,
      permission: 'owner',
      linked_at: Date.now()
    });
  }
  saveUsersDb();
  return { message: `Đã liên kết thiết bị ${deviceId} thành công!` };
}

// Hủy liên kết thiết bị
function unlinkDevice(userId, deviceId, isAdmin, targetUserId) {
  deviceId = (deviceId || '').trim();
  if (isAdmin && targetUserId) {
    db.user_devices = db.user_devices.filter(d => !(d.user_id === Number(targetUserId) && d.device_id === deviceId));
  } else if (isAdmin && !targetUserId) {
    db.user_devices = db.user_devices.filter(d => d.device_id !== deviceId);
  } else {
    db.user_devices = db.user_devices.filter(d => !(d.user_id === userId && d.device_id === deviceId));
  }
  saveUsersDb();
  return { message: 'Đã hủy liên kết thiết bị' };
}

// Lấy danh sách thiết bị của User (kèm dữ liệu telemetry trực tiếp)
function getUserDevices(user, getDeviceFn, allDevicesMap) {
  if (user.role === 'admin') {
    // Admin thấy tất cả thiết bị
    const list = [];
    for (const [id, dev] of allDevicesMap.entries()) {
      list.push(dev);
    }
    return list;
  }

  // Khách chỉ thấy thiết bị được liên kết
  const linked = db.user_devices.filter(d => d.user_id === user.id);
  const list = [];
  for (const item of linked) {
    const dev = typeof getDeviceFn === 'function' ? getDeviceFn(item.device_id) : null;
    if (dev) {
      dev.custom_name = item.custom_name || item.device_id;
      list.push(dev);
    } else {
      list.push({
        device_id: item.device_id,
        custom_name: item.custom_name || item.device_id,
        online: false,
        connected: false,
        voltage: 0,
        soc: 0
      });
    }
  }
  return list;
}

// Tạo Token liên kết nhanh
function createBindToken(userId) {
  const token = crypto.randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = Date.now() + 60 * 60 * 1000; // 1 giờ
  db.bind_tokens.push({ token, userId, expiresAt });
  saveUsersDb();
  return { token, expiresAt };
}

// ESP32 gọi auto-bind khi kết nối Wi-Fi
function autoBindDevice(deviceId, bindToken) {
  deviceId = (deviceId || '').trim();
  bindToken = (bindToken || '').trim().toUpperCase();

  const rec = db.bind_tokens.find(b => b.token === bindToken);
  if (!rec) throw new Error('Mã liên kết không hợp lệ hoặc không tồn tại');
  if (rec.expiresAt < Date.now()) throw new Error('Mã liên kết đã hết hạn');

  const existing = db.user_devices.find(d => d.user_id === rec.userId && d.device_id === deviceId);
  if (!existing) {
    db.user_devices.push({
      user_id: rec.userId,
      device_id: deviceId,
      custom_name: deviceId,
      permission: 'owner',
      linked_at: Date.now()
    });
    saveUsersDb();
  }

  return { message: `Thiết bị ${deviceId} đã tự động liên kết thành công!` };
}

module.exports = {
  loadUsersDb,
  saveUsersDb,
  hashPassword,
  createSession,
  getAuthenticatedUser,
  verifyAdminAuth,
  registerUser,
  loginUser,
  getAdminUsersList,
  resetPasswordToDefault,
  linkDevice,
  unlinkDevice,
  getUserDevices,
  createBindToken,
  autoBindDevice
};
