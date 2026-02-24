-- Escalation Focus Management Schema
-- Tracks which escalation an admin is currently attending to
-- Prevents overlapping context issues when multiple escalations are pending

CREATE TABLE IF NOT EXISTS admin_focus_state (
    admin_phone TEXT PRIMARY KEY,
    locked_escalation_id TEXT,
    school_id TEXT NOT NULL,
    last_interaction BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(locked_escalation_id) REFERENCES escalations(id),
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_focus_escalation ON admin_focus_state(locked_escalation_id);
CREATE INDEX IF NOT EXISTS idx_admin_focus_school ON admin_focus_state(school_id);
