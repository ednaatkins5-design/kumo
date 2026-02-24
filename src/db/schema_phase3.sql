-- Subject Metadata
CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT, -- e.g., MTH, ENG
    aliases TEXT, -- JSON array of strings e.g. ["Maths", "Mathematics"]
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Granular Marks
CREATE TABLE IF NOT EXISTS student_marks (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    term_id TEXT NOT NULL, -- e.g., "2025-T1"
    marks_json TEXT DEFAULT '{}', -- JSON object storing custom pillars: { "CA1": 15, "Project": 20, ... }
    total_score DECIMAL(5,2) DEFAULT 0, -- Sum of pillars, updated by application logic
    is_locked BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(student_id) REFERENCES students(student_id),
    FOREIGN KEY(subject_id) REFERENCES subjects(id),
    UNIQUE(student_id, subject_id, term_id)
);

-- Aggregated Term Results (for fast reporting & ranking)
CREATE TABLE IF NOT EXISTS term_results (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    term_id TEXT NOT NULL,
    class_level TEXT NOT NULL,
    total_score DECIMAL(10,2) DEFAULT 0,
    average_score DECIMAL(5,2) DEFAULT 0,
    position INTEGER, -- Rank in class
    total_students INTEGER,
    status TEXT CHECK(status IN ('draft', 'locked', 'released')) DEFAULT 'draft',
    report_card_path TEXT, -- Path to signed PDF
    locked_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(student_id) REFERENCES students(student_id),
    UNIQUE(student_id, term_id)
);

-- Trait Definitions (Affective & Psychomotor)
CREATE TABLE IF NOT EXISTS trait_definitions (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    category TEXT CHECK(category IN ('affective', 'psychomotor')) NOT NULL,
    name TEXT NOT NULL, -- e.g., "Punctuality", "Neatness"
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Student Trait Ratings
CREATE TABLE IF NOT EXISTS student_trait_ratings (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    term_id TEXT NOT NULL,
    trait_id TEXT NOT NULL,
    rating INTEGER CHECK(rating BETWEEN 1 AND 5),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(student_id) REFERENCES students(student_id),
    FOREIGN KEY(trait_id) REFERENCES trait_definitions(id),
    UNIQUE(student_id, term_id, trait_id)
);
