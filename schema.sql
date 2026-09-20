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
