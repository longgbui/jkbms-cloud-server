CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  data TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  cmd TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS ble_results (
  device_id TEXT PRIMARY KEY,
  results TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  device_id TEXT PRIMARY KEY,
  last_active INTEGER
);

-- Table: users (Lưu trữ tài khoản bảo mật)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT DEFAULT 'customer', -- 'admin' hoặc 'customer'
  fullname TEXT,
  phone TEXT,
  created_at INTEGER NOT NULL
);

-- Table: user_devices (Quyền sở hữu thiết bị của khách hàng)
CREATE TABLE IF NOT EXISTS user_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  custom_name TEXT,
  permission TEXT DEFAULT 'owner',
  linked_at INTEGER NOT NULL,
  UNIQUE(user_id, device_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Table: bind_tokens (Token liên kết tự động khi ESP cấu hình Wi-Fi)
CREATE TABLE IF NOT EXISTS bind_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Table: user_sessions (Phiên đăng nhập Web)
CREATE TABLE IF NOT EXISTS user_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_devices_uid ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_did ON user_devices(device_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_uid ON user_sessions(user_id);
