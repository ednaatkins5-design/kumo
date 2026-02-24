-- Phase 5: Action-Aware Memory & Semantic Snapshots

-- Update messages table to be action-aware
ALTER TABLE messages ADD COLUMN action_performed TEXT;
ALTER TABLE messages ADD COLUMN action_status TEXT;
ALTER TABLE messages ADD COLUMN is_internal INTEGER DEFAULT 0;

-- Semantic Memory Table
CREATE TABLE IF NOT EXISTS memory_snapshots (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    embedding JSON NOT NULL, -- Stored as a JSON array of floats
    message_count INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_mem_user ON memory_snapshots(user_id);
