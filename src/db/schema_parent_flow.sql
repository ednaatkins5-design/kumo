-- ============================================================================
-- SCHEMA: Parent Flow - Registration, Identification, Token Management
-- ============================================================================
-- 
-- This schema enables:
-- 1. Admin registers parents during student upload
-- 2. System tracks "identified" parents (registered by admin)
-- 3. Unknown parents can provide tokens for specific student access
-- 4. 24-hour token expiration
-- 5. Parent-to-children mapping for multi-child support
--

-- Step 1: Track PA WhatsApp number per school (for multi-tenancy)
-- Each school has its own PA WhatsApp number that parents message
ALTER TABLE schools ADD COLUMN pa_phone TEXT;

-- Step 2: Parent Registry - Official parents registered by admin
-- When admin uploads a student with parent info, parent goes here
CREATE TABLE IF NOT EXISTS parent_registry (
    parent_id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    parent_phone TEXT NOT NULL,
    parent_name TEXT NOT NULL,
    parent_access_token TEXT UNIQUE NOT NULL,  -- PAT-KUMO-ABC123DEF456
    token_generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    token_expires_at DATETIME NOT NULL,  -- 24 hours from registration
    is_active BOOLEAN DEFAULT 1,
    created_by_admin_phone TEXT,  -- Which admin registered (for audit)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    UNIQUE(school_id, parent_phone)  -- One parent per school per phone
);

-- Step 3: Parent-to-Children Mapping
-- Links identified parent to all their children
-- Multiple children per parent is supported
CREATE TABLE IF NOT EXISTS parent_children_mapping (
    parent_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    school_id TEXT NOT NULL,
    linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(parent_id, student_id),
    FOREIGN KEY(parent_id) REFERENCES parent_registry(parent_id),
    FOREIGN KEY(student_id) REFERENCES students(student_id),
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Step 4: Token Access Log (audit trail for unknown parent token usage)
CREATE TABLE IF NOT EXISTS parent_token_access_log (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    parent_phone TEXT NOT NULL,
    school_id TEXT NOT NULL,
    student_accessed TEXT NOT NULL,  -- Which student they tried to access
    access_result TEXT CHECK(access_result IN ('SUCCESS', 'INVALID_TOKEN', 'EXPIRED', 'INVALID_STUDENT')) NOT NULL,
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Step 5: Indexes for performance
CREATE INDEX IF NOT EXISTS idx_parent_registry_school_phone ON parent_registry(school_id, parent_phone);
CREATE INDEX IF NOT EXISTS idx_parent_registry_token ON parent_registry(parent_access_token);
CREATE INDEX IF NOT EXISTS idx_parent_registry_active ON parent_registry(is_active, token_expires_at);
CREATE INDEX IF NOT EXISTS idx_parent_children_student ON parent_children_mapping(student_id);
CREATE INDEX IF NOT EXISTS idx_parent_children_parent ON parent_children_mapping(parent_id);
CREATE INDEX IF NOT EXISTS idx_parent_token_log_token ON parent_token_access_log(token);
CREATE INDEX IF NOT EXISTS idx_parent_token_log_phone ON parent_token_access_log(parent_phone);
