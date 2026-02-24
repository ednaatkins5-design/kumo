-- File Storage Schema
-- Comprehensive file metadata tracking for enterprise-grade storage

CREATE TABLE IF NOT EXISTS file_storage (
    id TEXT PRIMARY KEY,
    file_id TEXT UNIQUE NOT NULL,
    school_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_type TEXT CHECK(file_type IN ('image', 'pdf', 'document', 'audio')) NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    checksum TEXT NOT NULL, -- SHA256 for integrity verification
    storage_path TEXT NOT NULL, -- Physical path or S3 URI
    is_archived BOOLEAN DEFAULT 0,
    archived_at DATETIME,
    archive_reason TEXT,
    uploaded_at DATETIME NOT NULL,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Moderation Logs - Community management
CREATE TABLE IF NOT EXISTS moderation_logs (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    message_id TEXT,
    message_author TEXT, -- Phone number of author
    message_content TEXT,
    action_type TEXT CHECK(action_type IN ('DELETED', 'WARNED', 'FLAGGED', 'ESCALATED')) NOT NULL,
    reason TEXT,
    logged_by TEXT,
    moderation_note TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Group Agent Context - Per-school community state
CREATE TABLE IF NOT EXISTS ga_context (
    id TEXT PRIMARY KEY,
    school_id TEXT UNIQUE NOT NULL,
    last_pulse_morning DATETIME,
    last_pulse_afternoon DATETIME,
    last_pulse_evening DATETIME,
    member_count INTEGER DEFAULT 0,
    is_in_emergency_mode BOOLEAN DEFAULT 0,
    emergency_reason TEXT,
    emergency_started_at DATETIME,
    active_announcements TEXT, -- JSON array of active announcements
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Conversation Memory - For multi-turn context
CREATE TABLE IF NOT EXISTS conversation_memory (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    agent TEXT NOT NULL, -- 'PA', 'TA', 'SA', 'GA'
    user_phone TEXT NOT NULL,
    user_id TEXT,
    message_role TEXT CHECK(message_role IN ('user', 'assistant')) NOT NULL,
    message_content TEXT NOT NULL,
    message_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    context_snapshot TEXT, -- JSON snapshot of context at time of message
    action_performed TEXT,
    action_status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Agent Memory Snapshots - Periodic summaries for efficiency
CREATE TABLE IF NOT EXISTS agent_memory_snapshots (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    user_phone TEXT NOT NULL,
    user_id TEXT,
    summary_content TEXT NOT NULL, -- LLM-generated summary
    message_count_included INTEGER,
    time_period_start DATETIME,
    time_period_end DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Digital Signatures - PDF signing records
CREATE TABLE IF NOT EXISTS pdf_signatures (
    id TEXT PRIMARY KEY,
    signature_id TEXT UNIQUE NOT NULL,
    document_id TEXT NOT NULL,
    school_id TEXT NOT NULL,
    signer_name TEXT NOT NULL,
    signer_role TEXT CHECK(signer_role IN ('teacher', 'admin', 'school')) NOT NULL,
    signer_phone TEXT NOT NULL,
    timestamp DATETIME NOT NULL,
    document_hash TEXT NOT NULL,
    signature_hash TEXT NOT NULL,
    certificate_thumbprint TEXT,
    is_valid BOOLEAN DEFAULT 1,
    revocation_reason TEXT,
    revoked_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_file_storage_school ON file_storage(school_id);
CREATE INDEX IF NOT EXISTS idx_file_storage_user ON file_storage(user_id);
CREATE INDEX IF NOT EXISTS idx_file_storage_checksum ON file_storage(checksum);
CREATE INDEX IF NOT EXISTS idx_file_storage_expires_at ON file_storage(expires_at) WHERE is_archived = 0;

CREATE INDEX IF NOT EXISTS idx_moderation_logs_school ON moderation_logs(school_id);
CREATE INDEX IF NOT EXISTS idx_moderation_logs_timestamp ON moderation_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_moderation_logs_author ON moderation_logs(message_author);

CREATE INDEX IF NOT EXISTS idx_ga_context_school ON ga_context(school_id);

CREATE INDEX IF NOT EXISTS idx_conversation_memory_school_agent ON conversation_memory(school_id, agent);
CREATE INDEX IF NOT EXISTS idx_conversation_memory_user ON conversation_memory(user_phone, school_id);
CREATE INDEX IF NOT EXISTS idx_conversation_memory_timestamp ON conversation_memory(message_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_agent_memory_snapshots_school_agent ON agent_memory_snapshots(school_id, agent);
CREATE INDEX IF NOT EXISTS idx_agent_memory_snapshots_user ON agent_memory_snapshots(user_phone);

CREATE INDEX IF NOT EXISTS idx_pdf_signatures_school ON pdf_signatures(school_id);
CREATE INDEX IF NOT EXISTS idx_pdf_signatures_document ON pdf_signatures(document_id);
CREATE INDEX IF NOT EXISTS idx_pdf_signatures_signer ON pdf_signatures(signer_phone);
