-- Test Schema - Adds missing columns for comprehensive tests

-- Fees configuration column
ALTER TABLE schools ADD COLUMN fees_config TEXT DEFAULT '{}';

-- Ensure parent_registry table exists for tests
CREATE TABLE IF NOT EXISTS parent_registry (
    parent_id TEXT PRIMARY KEY,
    parent_phone TEXT NOT NULL,
    parent_name TEXT,
    school_id TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Ensure parent_children_mapping table exists for tests
CREATE TABLE IF NOT EXISTS parent_children_mapping (
    parent_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    relationship TEXT DEFAULT 'parent',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(parent_id, student_id),
    FOREIGN KEY(student_id) REFERENCES students(student_id)
);

-- Ensure escalations table exists for tests
CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    escalation_type TEXT NOT NULL,
    origin_agent TEXT NOT NULL,
    priority TEXT DEFAULT 'MEDIUM',
    school_id TEXT NOT NULL,
    from_phone TEXT NOT NULL,
    session_id TEXT NOT NULL,
    pause_message_id TEXT NOT NULL,
    user_name TEXT,
    user_role TEXT,
    reason TEXT,
    what_agent_needed TEXT,
    context TEXT,
    status TEXT DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Ensure fee_transactions table exists for tests
CREATE TABLE IF NOT EXISTS fee_transactions (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT,
    parent_id TEXT,
    payer_phone TEXT NOT NULL,
    amount DECIMAL NOT NULL,
    currency TEXT DEFAULT 'NGN',
    status TEXT DEFAULT 'pending',
    payment_method TEXT,
    reference TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_escalations_school_status ON escalations(school_id, status);
CREATE INDEX IF NOT EXISTS idx_escalations_origin ON escalations(origin_agent, escalation_type);
