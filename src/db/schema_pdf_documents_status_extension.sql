-- PDF Documents Status Extension for Mark Sheet Approval Workflow
-- Adds new status values to support the mark sheet approval and correction flow

-- This migration extends the pdf_documents table status values
-- New statuses added:
-- - 'AWAITING_ADMIN_REVIEW' : PDF sent to admin for approval/rejection
-- - 'ADMIN_APPROVED' : Admin approved the mark sheet
-- - 'RETURNED_FOR_CORRECTION' : Admin returned marks to teacher for correction
-- - 'ADMIN_REJECTED' : Admin rejected the mark sheet (workflow ended)
-- - 'FINALIZED' : Marks have been indexed to student records

-- SQLite does not support direct ALTER TABLE on CHECK constraints,
-- so existing applications should handle the new statuses at the application level.
-- 
-- For a fresh database or migration, use the updated schema:
CREATE TABLE IF NOT EXISTS pdf_documents_updated (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT,
    document_type TEXT CHECK(document_type IN ('attendance', 'marks_sheet', 'registration')) NOT NULL,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT DEFAULT 'application/pdf',
    document_hash TEXT,
    status TEXT CHECK(status IN (
        'generated',
        'sent',
        'confirmed',
        'rejected',
        'AWAITING_ADMIN_REVIEW',
        'ADMIN_APPROVED',
        'RETURNED_FOR_CORRECTION',
        'ADMIN_REJECTED',
        'FINALIZED'
    )) DEFAULT 'generated',
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sent_to_phone TEXT,
    sent_at TIMESTAMP,
    confirmed_by_teacher BOOLEAN DEFAULT 0,
    confirmed_at TIMESTAMP,
    confirmation_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id)
);

-- NOTE: If upgrading existing database:
-- 1. SQLite doesn't support dropping CHECK constraints directly
-- 2. Application code should validate status values
-- 3. Run this migration by:
--    a) Creating pdf_documents_updated table (above)
--    b) Copying data: INSERT INTO pdf_documents_updated SELECT * FROM pdf_documents
--    c) Dropping old table: DROP TABLE pdf_documents
--    d) Renaming: ALTER TABLE pdf_documents_updated RENAME TO pdf_documents
--    e) Recreating indexes (see schema_pdf_storage_marks.sql)
-- 
-- OR: Keep existing schema and handle new status values at application level
