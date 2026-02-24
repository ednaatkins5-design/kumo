-- PDF Document Storage and Tracking

CREATE TABLE IF NOT EXISTS pdf_documents (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT,
    document_type TEXT CHECK(document_type IN ('attendance', 'marks_sheet', 'registration', 'batch_report_cards', 'student_report_card', 'broadsheet')) NOT NULL,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT DEFAULT 'application/pdf',
    document_hash TEXT, -- SHA256 for verification
    status TEXT CHECK(status IN ('generated', 'sent', 'confirmed', 'rejected')) DEFAULT 'generated',
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

-- Marks Data Entry (links marks to subjects and teachers)
CREATE TABLE IF NOT EXISTS marks_data_entry (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    class_level TEXT NOT NULL,
    term_id TEXT NOT NULL,
    assessment_total DECIMAL(5,2) DEFAULT 20,  -- CA1 + CA2 (typical 20 marks)
    midterm_total DECIMAL(5,2) DEFAULT 20,     -- Midterm test (typical 20 marks)
    exam_total DECIMAL(5,2) DEFAULT 60,        -- Final exam (typical 60 marks)
    total_score DECIMAL(5,2) GENERATED ALWAYS AS (assessment_total + midterm_total + exam_total) STORED,
    pdf_document_id TEXT,
    status TEXT CHECK(status IN ('draft', 'submitted', 'confirmed', 'finalized')) DEFAULT 'draft',
    submission_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id),
    FOREIGN KEY(pdf_document_id) REFERENCES pdf_documents(id)
);

-- Individual Student Mark Entry (detailed)
CREATE TABLE IF NOT EXISTS student_mark_entry (
    id TEXT PRIMARY KEY,
    marks_data_entry_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    ca1 DECIMAL(5,2) DEFAULT 0,      -- First Continuous Assessment
    ca2 DECIMAL(5,2) DEFAULT 0,      -- Second Continuous Assessment
    assessment_score DECIMAL(5,2) GENERATED ALWAYS AS (ca1 + ca2) STORED,
    midterm_score DECIMAL(5,2) DEFAULT 0,
    exam_score DECIMAL(5,2) DEFAULT 0,
    total_score DECIMAL(5,2) GENERATED ALWAYS AS (assessment_score + midterm_score + exam_score) STORED,
    grade TEXT,  -- A, B, C, D, F etc
    status TEXT CHECK(status IN ('draft', 'submitted', 'confirmed')) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(marks_data_entry_id) REFERENCES marks_data_entry(id),
    FOREIGN KEY(student_id) REFERENCES students(student_id)
);

-- Attendance Data Entry
CREATE TABLE IF NOT EXISTS attendance_data_entry (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    class_level TEXT NOT NULL,
    marked_date TEXT NOT NULL,
    term_id TEXT NOT NULL,
    pdf_document_id TEXT,
    status TEXT CHECK(status IN ('draft', 'submitted', 'confirmed', 'finalized')) DEFAULT 'draft',
    submission_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id),
    FOREIGN KEY(pdf_document_id) REFERENCES pdf_documents(id)
);

-- Individual Student Attendance Entry
CREATE TABLE IF NOT EXISTS student_attendance_entry (
    id TEXT PRIMARY KEY,
    attendance_data_entry_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    present BOOLEAN NOT NULL,
    notes TEXT,
    status TEXT CHECK(status IN ('draft', 'submitted', 'confirmed')) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(attendance_data_entry_id) REFERENCES attendance_data_entry(id),
    FOREIGN KEY(student_id) REFERENCES students(student_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_pdf_documents_teacher ON pdf_documents(teacher_id);
CREATE INDEX IF NOT EXISTS idx_pdf_documents_status ON pdf_documents(status);
CREATE INDEX IF NOT EXISTS idx_pdf_documents_type ON pdf_documents(document_type);
CREATE INDEX IF NOT EXISTS idx_marks_data_entry_subject ON marks_data_entry(subject_id);
CREATE INDEX IF NOT EXISTS idx_marks_data_entry_teacher ON marks_data_entry(teacher_id);
CREATE INDEX IF NOT EXISTS idx_marks_data_entry_term ON marks_data_entry(term_id);
CREATE INDEX IF NOT EXISTS idx_student_mark_entry_student ON student_mark_entry(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_data_entry_teacher ON attendance_data_entry(teacher_id);
CREATE INDEX IF NOT EXISTS idx_attendance_data_entry_date ON attendance_data_entry(marked_date);
