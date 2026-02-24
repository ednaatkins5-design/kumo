-- WhatsApp Session Storage Schema
-- Compatible with both SQLite and PostgreSQL

CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    session_data TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_school_id ON whatsapp_sessions(school_id);
