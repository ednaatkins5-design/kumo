-- Teacher Confirmation & Amendment Tracking for Academic Marks

-- Mark submission tracking (from TA OCR or manual entry)
CREATE TABLE IF NOT EXISTS mark_submissions (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    class_level TEXT NOT NULL,
    term_id TEXT NOT NULL,
    submission_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    raw_image_path TEXT, -- Path to original mark sheet image if uploaded
    status TEXT CHECK(status IN ('DRAFT', 'PENDING_TEACHER_CONFIRMATION', 'CONFIRMED', 'REJECTED')) DEFAULT 'DRAFT',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id),
    FOREIGN KEY(subject_id) REFERENCES subjects(id)
);

-- Individual mark entries within a submission (extracted marks before confirmation)
CREATE TABLE IF NOT EXISTS submission_marks (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    ca1 DECIMAL(5,2),
    ca2 DECIMAL(5,2),
    midterm DECIMAL(5,2),
    exam DECIMAL(5,2),
    total DECIMAL(5,2),
    status TEXT CHECK(status IN ('DRAFT', 'CONFIRMED', 'CORRECTED')) DEFAULT 'DRAFT',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(submission_id) REFERENCES mark_submissions(id),
    FOREIGN KEY(student_id) REFERENCES students(student_id)
);

-- Teacher confirmation audit trail
CREATE TABLE IF NOT EXISTS teacher_confirmation_logs (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    action TEXT CHECK(action IN ('VIEWED', 'CONFIRMED', 'REJECTED', 'REQUESTED_CORRECTION')) NOT NULL,
    details TEXT, -- JSON with correction details if applicable
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(submission_id) REFERENCES mark_submissions(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_mark_submissions_status ON mark_submissions(status);
CREATE INDEX IF NOT EXISTS idx_mark_submissions_term ON mark_submissions(term_id);
CREATE INDEX IF NOT EXISTS idx_mark_submissions_teacher ON mark_submissions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_submission_marks_status ON submission_marks(status);
CREATE INDEX IF NOT EXISTS idx_teacher_confirmation_submission ON teacher_confirmation_logs(submission_id);
