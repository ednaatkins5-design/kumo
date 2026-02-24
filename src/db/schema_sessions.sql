-- Persistent Session Storage

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    role TEXT CHECK(role IN ('parent', 'teacher', 'admin')) NOT NULL,
    context TEXT DEFAULT '{}', -- JSON
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, phone)
);

-- Token usage tracking
CREATE TABLE IF NOT EXISTS token_access_logs (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    phone TEXT NOT NULL,
    user_id TEXT,
    access_type TEXT CHECK(access_type IN ('TEACHER_TOKEN', 'PARENT_TOKEN', 'TEMPORAL')) NOT NULL,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    revoked_at DATETIME,
    is_active BOOLEAN DEFAULT 1,
    details TEXT -- JSON
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_token_access_token ON token_access_logs(token);
CREATE INDEX IF NOT EXISTS idx_token_access_active ON token_access_logs(is_active);
