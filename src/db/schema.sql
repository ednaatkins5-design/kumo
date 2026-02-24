CREATE TABLE IF NOT EXISTS schools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    admin_phone TEXT NOT NULL,
    whatsapp_number TEXT, -- The WhatsApp phone number used for pairing code connection
    connected_whatsapp_jid TEXT, -- ✅ The WhatsApp JID (number) this school's bot is connected to for multi-tenancy routing
    config_json TEXT DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    role TEXT CHECK(role IN ('admin', 'teacher', 'parent')) NOT NULL,
    name TEXT,
    school_id TEXT NOT NULL,
    password_hash TEXT,
    email TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    UNIQUE(phone, school_id)
);

CREATE TABLE IF NOT EXISTS students (
    student_id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    name TEXT NOT NULL,
    class_level TEXT NOT NULL,
    parent_access_code TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

CREATE TABLE IF NOT EXISTS student_guardians (
    student_id TEXT NOT NULL,
    guardian_phone TEXT NOT NULL,
    relationship TEXT,
    PRIMARY KEY(student_id, guardian_phone),
    FOREIGN KEY(student_id) REFERENCES students(student_id)
);

CREATE TABLE IF NOT EXISTS teacher_access_tokens (
    token TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    school_id TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    is_revoked BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(teacher_id) REFERENCES users(id),
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    payer_phone TEXT NOT NULL,
    amount DECIMAL NOT NULL,
    currency TEXT DEFAULT 'NGN',
    status TEXT CHECK(status IN ('pending_review', 'confirmed', 'rejected')) NOT NULL,
    pop_image_path TEXT NOT NULL,
    reviewed_by TEXT,
    review_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(student_id) REFERENCES students(student_id),
    FOREIGN KEY(reviewed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS academic_drafts (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    class_level TEXT NOT NULL,
    raw_image_path TEXT NOT NULL,
    ocr_data TEXT NOT NULL,
    status TEXT CHECK(status IN ('draft', 'teacher_confirmed', 'admin_locked')) NOT NULL,
    locked_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    user_id TEXT, -- Present if known user (no FK constraint to allow null)
    from_phone TEXT NOT NULL,
    type TEXT NOT NULL,
    body TEXT,
    media_path TEXT,
    context TEXT, -- Agent context (PA, TA, SA)
    timestamp BIGINT NOT NULL,
    action_performed TEXT,
    action_status TEXT,
    is_internal INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

CREATE TABLE IF NOT EXISTS academic_terms (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    term_name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actor_phone TEXT NOT NULL,
    action TEXT NOT NULL,
    target_resource TEXT NOT NULL,
    details TEXT
);
