-- Student Marks Indexed Table
-- Final indexed marks storage for confirmed mark submissions

CREATE TABLE IF NOT EXISTS student_marks_indexed (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    class_level TEXT NOT NULL,
    subject TEXT NOT NULL,
    term_id TEXT NOT NULL,
    marks_json TEXT DEFAULT '{}', -- JSON object: { "CA1": 15, "Exam": 55 }
    total_score DECIMAL(5,2) DEFAULT 0,
    teacher_comment TEXT,
    principal_comment TEXT,
    attendance_present INTEGER,
    attendance_total INTEGER,
    submission_id TEXT,
    confirmed_by_teacher BOOLEAN DEFAULT 0,
    status TEXT DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'CONFIRMED', 'RELEASED', 'ARCHIVED')),
    ca1 DECIMAL(5,2) DEFAULT 0,
    ca2 DECIMAL(5,2) DEFAULT 0,
    midterm DECIMAL(5,2) DEFAULT 0,
    exam DECIMAL(5,2) DEFAULT 0,
    manual_entry INTEGER DEFAULT 0,
    manual_notes TEXT,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(student_id) REFERENCES students(student_id),
    FOREIGN KEY(teacher_id) REFERENCES users(id),
    FOREIGN KEY(submission_id) REFERENCES mark_submissions(id),
    UNIQUE(school_id, student_id, subject, term_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_student_marks_indexed_student ON student_marks_indexed(student_id);
CREATE INDEX IF NOT EXISTS idx_student_marks_indexed_teacher ON student_marks_indexed(teacher_id);
CREATE INDEX IF NOT EXISTS idx_student_marks_indexed_subject ON student_marks_indexed(subject);
CREATE INDEX IF NOT EXISTS idx_student_marks_indexed_term ON student_marks_indexed(term_id);
CREATE INDEX IF NOT EXISTS idx_student_marks_indexed_class ON student_marks_indexed(class_level);
