-- Temporal Access for Teachers using external devices
CREATE TABLE IF NOT EXISTS temporal_access (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL, -- The WhatsApp number being used
    user_id TEXT NOT NULL, -- The Teacher ID
    school_id TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

CREATE INDEX IF NOT EXISTS idx_temporal_phone_expiry ON temporal_access(phone, expires_at);
