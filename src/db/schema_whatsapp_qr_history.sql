-- WhatsApp QR History Table
CREATE TABLE IF NOT EXISTS whatsapp_qr_history (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    qr_generated_at BIGINT DEFAULT (floor(extract(epoch from now()) * 1000)),
    connection_status TEXT DEFAULT 'pending',
    qr_data TEXT,
    FOREIGN KEY (school_id) REFERENCES schools(id)
);

CREATE INDEX IF NOT EXISTS idx_qr_history_school ON whatsapp_qr_history(school_id, qr_generated_at DESC);

-- Add indexes for schools connection status
CREATE INDEX IF NOT EXISTS idx_schools_connection_status ON schools(whatsapp_connection_status);
CREATE INDEX IF NOT EXISTS idx_schools_admin_phone ON schools(admin_phone);
