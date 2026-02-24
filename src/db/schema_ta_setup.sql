-- TA Agent Setup and Management Tables

-- Teacher TA setup state tracking
CREATE TABLE IF NOT EXISTS ta_setup_state (
    teacher_id TEXT NOT NULL,
    school_id TEXT NOT NULL,
    assigned_class TEXT,
    current_step TEXT,
    completed_steps TEXT DEFAULT '[]', -- JSON array
    is_active BOOLEAN DEFAULT 1,
    config_draft TEXT DEFAULT '{}', -- JSON object
    extracted_students TEXT DEFAULT '[]', -- JSON array
    subjects TEXT DEFAULT '[]', -- JSON array
    workload_json TEXT DEFAULT '{}', -- JSON object: { "Class Name": ["Subject1", "Subject2"] }
    progress_percentage INTEGER DEFAULT 0, -- Setup progress (0-100)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP DEFAULT NULL, -- When teacher finalized setup and became operational
    PRIMARY KEY(teacher_id, school_id),
    FOREIGN KEY(teacher_id) REFERENCES users(id),
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Student information (simplified for TA agent)
CREATE TABLE IF NOT EXISTS student_info (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    name TEXT NOT NULL,
    class_level TEXT NOT NULL,
    date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Mapping of students to classes (for teacher)
CREATE TABLE IF NOT EXISTS class_student_mapping (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    class_level TEXT NOT NULL,
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    roll_number TEXT,
    extraction_source TEXT CHECK(extraction_source IN ('VISION', 'MANUAL')) DEFAULT 'VISION',
    term_id TEXT NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    unified_id TEXT,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id),
    FOREIGN KEY(student_id) REFERENCES student_info(id)
);

-- Student attendance records
CREATE TABLE IF NOT EXISTS student_attendance_records (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    class_level TEXT NOT NULL,
    marked_date TEXT NOT NULL, -- YYYY-MM-DD
    present BOOLEAN NOT NULL,
    term_id TEXT NOT NULL,
    manual_entry INTEGER DEFAULT 0,
    manual_notes TEXT,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id),
    FOREIGN KEY(student_id) REFERENCES student_info(id)
);

-- Broadsheet data storage (actual marks matrix)
CREATE TABLE IF NOT EXISTS student_broadsheet (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    class_level TEXT NOT NULL,
    term_id TEXT NOT NULL,
    subjects TEXT NOT NULL, -- JSON array
    broadsheet_data TEXT NOT NULL, -- JSON object
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id)
);

-- Broadsheet assignments for operational tracking
CREATE TABLE IF NOT EXISTS broadsheet_assignments (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    subjects TEXT NOT NULL, -- JSON array of subjects
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_ta_setup_state_teacher ON ta_setup_state(teacher_id);
CREATE INDEX IF NOT EXISTS idx_ta_setup_state_school ON ta_setup_state(school_id);
CREATE INDEX IF NOT EXISTS idx_student_info_school ON student_info(school_id);
CREATE INDEX IF NOT EXISTS idx_student_info_class ON student_info(class_level);
CREATE INDEX IF NOT EXISTS idx_class_student_mapping_class ON class_student_mapping(class_level);
CREATE INDEX IF NOT EXISTS idx_class_student_mapping_teacher ON class_student_mapping(teacher_id);
CREATE INDEX IF NOT EXISTS idx_student_attendance_records_student ON student_attendance_records(student_id);
CREATE INDEX IF NOT EXISTS idx_student_attendance_records_date ON student_attendance_records(marked_date);
CREATE INDEX IF NOT EXISTS idx_student_attendance_records_term ON student_attendance_records(term_id);
CREATE INDEX IF NOT EXISTS idx_broadsheet_assignments_teacher ON broadsheet_assignments(teacher_id);
CREATE INDEX IF NOT EXISTS idx_broadsheet_assignments_school ON broadsheet_assignments(school_id);
