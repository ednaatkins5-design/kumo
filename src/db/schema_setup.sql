-- Setup State Tracking
CREATE TABLE IF NOT EXISTS setup_state (
    school_id TEXT PRIMARY KEY,
    current_step TEXT NOT NULL,
    completed_steps TEXT DEFAULT '[]', -- JSON array
    pending_steps TEXT DEFAULT '[]',    -- JSON array
    is_active BOOLEAN DEFAULT 1,
    config_draft TEXT DEFAULT '{}',    -- JSON object
    last_interaction BIGINT,
    updated_at BIGINT,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Add setup_status to schools if not exists
-- NOTE: This column is already added in schema_amendments.sql
-- ALTER TABLE schools ADD COLUMN setup_status TEXT DEFAULT 'PENDING_SETUP';
-- Commented out to prevent duplicate column error
