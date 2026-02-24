-- SCHEMA FOR VOICE SESSIONS AND MULTIMODAL CONTINUITY

CREATE TABLE IF NOT EXISTS voice_sessions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT UNIQUE, -- From ElevenLabs
    school_id TEXT NOT NULL,
    user_id TEXT,
    from_phone TEXT NOT NULL,
    agent_type TEXT DEFAULT 'PA',
    status TEXT DEFAULT 'initiated', -- initiated, active, completed, failed
    summary_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_conv_id ON voice_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_voice_user_phone ON voice_sessions(from_phone);
