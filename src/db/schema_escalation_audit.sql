-- Escalation Audit Log (Decision Chain Tracking)
-- Tracks when key events happen in escalation lifecycle
-- Provides timeline for SA to understand escalation history

CREATE TABLE IF NOT EXISTS escalation_audit_log (
    id TEXT PRIMARY KEY,
    escalation_id TEXT NOT NULL,
    school_id TEXT NOT NULL,
    
    -- Timeline Events
    event_type TEXT NOT NULL CHECK(event_type IN (
        'ESCALATION_CREATED',
        'ADMIN_NOTIFIED',
        'ADMIN_RESPONSE_RECORDED',
        'DECISION_MADE',
        'ORIGIN_AGENT_RESUMED',
        'ESCALATION_RESOLVED'
    )),
    
    -- Event metadata
    event_timestamp BIGINT NOT NULL,
    admin_phone TEXT,
    origin_agent TEXT CHECK(origin_agent IN ('PA', 'TA', 'GA')),
    
    -- Context
    decision_summary TEXT,  -- What was decided (for DECISION_MADE events)
    context_data TEXT,      -- JSON blob with additional event context
    
    -- Tracking
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY(escalation_id) REFERENCES escalations(id),
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Index for quick lookup of escalation timeline
CREATE INDEX IF NOT EXISTS idx_audit_escalation ON escalation_audit_log(escalation_id);
CREATE INDEX IF NOT EXISTS idx_audit_school ON escalation_audit_log(school_id);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON escalation_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_admin ON escalation_audit_log(admin_phone);
