-- Post-Setup Amendment & Confirmation System

CREATE TABLE IF NOT EXISTS amendment_requests (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    requested_by TEXT NOT NULL, -- Admin phone or user ID
    amendment_type TEXT CHECK(amendment_type IN ('GRADING', 'TERMS', 'FEES', 'SUBJECTS', 'TEACHERS')) NOT NULL,
    payload TEXT NOT NULL, -- JSON string detailing the proposed change
    impact_scope TEXT CHECK(impact_scope IN ('FUTURE_ONLY', 'CURRENT_TERM', 'HISTORICAL')) NOT NULL,
    status TEXT CHECK(status IN ('DRAFT', 'AWAITING_CONFIRMATION', 'APPROVED', 'REJECTED')) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

CREATE TABLE IF NOT EXISTS amendment_audit_log (
    id TEXT PRIMARY KEY,
    amendment_id TEXT NOT NULL,
    action_taken TEXT NOT NULL, -- e.g., CREATED, CONFIRMED, REJECTED, CANCELLED
    actor_role TEXT CHECK(actor_role IN ('SA', 'SYSTEM')) NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    FOREIGN KEY(amendment_id) REFERENCES amendment_requests(id)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_amendment_school_status ON amendment_requests(school_id, status);

-- Teacher Profile Enhancements
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN assigned_class TEXT;

-- Student & Parent Unification
ALTER TABLE students ADD COLUMN parent_id TEXT;

CREATE TABLE IF NOT EXISTS parent_access_tokens (
    token TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    school_id TEXT NOT NULL,
    term_id TEXT NOT NULL, -- Access is per term
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(parent_id) REFERENCES users(id),
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

CREATE INDEX IF NOT EXISTS idx_pat_parent_term ON parent_access_tokens(parent_id, term_id);

-- School Group Integration
ALTER TABLE schools ADD COLUMN whatsapp_group_link TEXT;
ALTER TABLE schools ADD COLUMN whatsapp_group_jid TEXT;
ALTER TABLE schools ADD COLUMN connected_whatsapp_jid TEXT;

-- School Type & Grading Configuration
ALTER TABLE schools ADD COLUMN school_type TEXT DEFAULT 'SECONDARY';
ALTER TABLE schools ADD COLUMN grading_config TEXT DEFAULT '{}';
ALTER TABLE schools ADD COLUMN setup_status TEXT DEFAULT 'PENDING_SETUP';
ALTER TABLE schools ADD COLUMN active_term TEXT DEFAULT 'current';
-- Update academic_drafts table to support new marks submission flow
-- Only add columns if they don't exist

ALTER TABLE academic_drafts ADD COLUMN term_id TEXT DEFAULT 'current';
ALTER TABLE academic_drafts ADD COLUMN marks_json TEXT DEFAULT '{}';
ALTER TABLE academic_drafts ADD COLUMN raw_images_json TEXT DEFAULT '[]';
ALTER TABLE academic_drafts ADD COLUMN observed_students_json TEXT DEFAULT '[]';
ALTER TABLE academic_drafts ADD COLUMN expected_students_json TEXT DEFAULT '[]';
ALTER TABLE academic_drafts ADD COLUMN verification_pdf_id TEXT;
ALTER TABLE academic_drafts ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;

-- Drop old columns that are no longer used
-- ALTER TABLE academic_drafts DROP COLUMN raw_image_path;
-- ALTER TABLE academic_drafts DROP COLUMN ocr_data;

-- Update status check constraint values
-- Note: SQLite doesn't support ALTER TABLE for CHECK constraints directly
-- This would require table recreation in production

CREATE INDEX IF NOT EXISTS idx_academic_drafts_teacher_term ON academic_drafts(teacher_id, term_id);
CREATE INDEX IF NOT EXISTS idx_academic_drafts_subject_class ON academic_drafts(subject, class_level);

-- WhatsApp pairing code phone number
ALTER TABLE schools ADD COLUMN whatsapp_number TEXT;
