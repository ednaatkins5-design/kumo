-- Mark Submission Workflow Tracking
-- Tracks the approval/rejection workflow for teacher-submitted mark sheets
-- Links to PDF documents and provides admin approval status

CREATE TABLE IF NOT EXISTS mark_submission_workflow (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    pdf_id TEXT,
    subject TEXT NOT NULL,
    class_level TEXT NOT NULL,
    term_id TEXT,
    student_count INTEGER DEFAULT 0,
    teacher_phone TEXT,
    escalation_id TEXT,
    
    -- Workflow Status
    current_status TEXT CHECK(current_status IN (
        'SUBMITTED',                -- Teacher submitted via TA
        'UNDER_ADMIN_REVIEW',       -- Admin reviewing
        'AWAITING_CORRECTION',      -- Admin requested corrections
        'HUMAN_APPROVED',           -- Admin approved
        'ADMIN_REJECTED',           -- Admin rejected
        'FINALIZED'                 -- Marks finalized and indexed
    )) DEFAULT 'SUBMITTED',
    
    -- Admin Decision Details
    admin_decision TEXT CHECK(admin_decision IN ('APPROVE', 'REQUEST_CORRECTION', 'REJECT')),
    admin_decision_notes TEXT,
    admin_phone TEXT,
    admin_decision_at TIMESTAMP,
    
    -- Timestamps
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id),
    FOREIGN KEY(pdf_id) REFERENCES pdf_documents(id)
);

-- Update pdf_documents table to include new statuses for mark sheet workflow
-- Note: This alters the existing constraint, so we use ALTER approach (if supported)
-- Otherwise, ensure your application handles these statuses:
-- - 'ADMIN_APPROVED' (marks approved by admin, ready for finalization)
-- - 'RETURNED_FOR_CORRECTION' (marks returned for teacher to fix)
-- - 'AWAITING_ADMIN_REVIEW' (marks awaiting SA admin review)
-- - 'ADMIN_REJECTED' (marks rejected by admin, workflow ended)
-- - 'FINALIZED' (marks finalized, indexed to student records)

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_mark_submission_workflow_school ON mark_submission_workflow(school_id);
CREATE INDEX IF NOT EXISTS idx_mark_submission_workflow_teacher ON mark_submission_workflow(teacher_id);
CREATE INDEX IF NOT EXISTS idx_mark_submission_workflow_status ON mark_submission_workflow(current_status);
CREATE INDEX IF NOT EXISTS idx_mark_submission_workflow_pdf ON mark_submission_workflow(pdf_id);
CREATE INDEX IF NOT EXISTS idx_mark_submission_workflow_term ON mark_submission_workflow(term_id);
