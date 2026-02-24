-- WhatsApp Multi-Connection Schema - Safe Migration
-- Add columns one by one with error handling

-- Add connected_whatsapp_jid if not exists
CREATE TABLE IF NOT EXISTS schools_backup AS SELECT id, name, admin_phone, connected_whatsapp_jid, config_json, created_at, setup_status FROM schools;
DROP TABLE schools;
CREATE TABLE schools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    admin_phone TEXT NOT NULL,
    admin_name TEXT,
    connected_whatsapp_jid TEXT,
    config_json TEXT DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    setup_status TEXT DEFAULT 'PENDING_SETUP',
    whatsapp_connection_status TEXT DEFAULT 'disconnected',
    qr_refresh_count INTEGER DEFAULT 0,
    qr_refresh_locked_until TIMESTAMP,
    last_connection_at TIMESTAMP
);
INSERT INTO schools SELECT * FROM schools_backup WHERE NOT EXISTS (SELECT 1 FROM schools);
DROP TABLE schools_backup;
