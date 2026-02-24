-- TERMINAL REPORTS SCHEMA
-- Stores synthesized per-student terminal aggregates and AI remarks

CREATE TABLE IF NOT EXISTS terminal_reports (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    class_level TEXT NOT NULL,
    term_id TEXT NOT NULL,
    total_aggregate REAL,
    average_score REAL,
    teacher_remarks TEXT,
    principal_remarks TEXT,
    position TEXT,
    total_students INTEGER,
    days_present INTEGER DEFAULT 0,
    days_open INTEGER DEFAULT 0,
    status TEXT DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'RELEASED', 'PUBLISHED', 'ARCHIVED')),
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(school_id, student_id, term_id)
);

-- Index for fast lookup during bulk generation
CREATE INDEX IF NOT EXISTS idx_terminal_reports_lookup ON terminal_reports(school_id, class_level, term_id);
