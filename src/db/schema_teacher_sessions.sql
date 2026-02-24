-- Teacher Sessions Table
-- Tracks active token-based sessions for teachers
-- When a teacher authenticates with their access token, a session is created
-- Session expires after 4 hours of initial creation
CREATE TABLE IF NOT EXISTS teacher_sessions (
    session_id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    school_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    teacher_name TEXT,
    
    -- Session lifecycle
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    context_json TEXT, -- Unified context storage
    
    FOREIGN KEY(teacher_id) REFERENCES users(id),
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_teacher_sessions_token ON teacher_sessions(token);
CREATE INDEX IF NOT EXISTS idx_teacher_sessions_teacher_id ON teacher_sessions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_teacher_sessions_school_id ON teacher_sessions(school_id);
CREATE INDEX IF NOT EXISTS idx_teacher_sessions_expires_at ON teacher_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_teacher_sessions_active ON teacher_sessions(is_active, expires_at);

-- Session Memory Table
-- Stores all messages during an active teacher session
CREATE TABLE IF NOT EXISTS session_memory (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    school_id TEXT NOT NULL,
    user_id TEXT,
    from_phone TEXT NOT NULL,
    
    -- Message content
    type TEXT NOT NULL DEFAULT 'text',
    body TEXT,
    media_path TEXT,
    
    -- Context and action tracking
    context TEXT,
    timestamp BIGINT NOT NULL,
    
    -- Action tracking for consistency
    action_performed TEXT,
    action_status TEXT,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY(session_id) REFERENCES teacher_sessions(session_id) ON DELETE CASCADE,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Create indexes for session_memory
CREATE INDEX IF NOT EXISTS idx_session_memory_session_id ON session_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_session_memory_timestamp ON session_memory(timestamp);
CREATE INDEX IF NOT EXISTS idx_session_memory_from_phone ON session_memory(from_phone);
CREATE INDEX IF NOT EXISTS idx_session_memory_session_timestamp ON session_memory(session_id, timestamp DESC);
