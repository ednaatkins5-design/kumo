-- Fix timestamp columns to use BIGINT instead of INTEGER for PostgreSQL
-- Timestamp in milliseconds can exceed INTEGER max value (2,147,483,647)

-- Messages table
ALTER TABLE messages ALTER COLUMN timestamp TYPE BIGINT;

-- Teacher sessions
ALTER TABLE teacher_sessions ALTER COLUMN created_at TYPE BIGINT;
ALTER TABLE teacher_sessions ALTER COLUMN expires_at TYPE BIGINT;
ALTER TABLE teacher_sessions ALTER COLUMN last_activity TYPE BIGINT;

-- Session memory
ALTER TABLE session_memory ALTER COLUMN timestamp TYPE BIGINT;
ALTER TABLE session_memory ALTER COLUMN created_at TYPE BIGINT;

-- Student attendance records
ALTER TABLE student_attendance_records ALTER COLUMN recorded_at TYPE BIGINT;

-- Broadsheet assignments
ALTER TABLE broadsheet_assignments ALTER COLUMN generated_at TYPE BIGINT;

-- Student info
ALTER TABLE student_info ALTER COLUMN date_added TYPE BIGINT;

-- Temporal access
ALTER TABLE temporal_access ALTER COLUMN expires_at TYPE BIGINT;
ALTER TABLE temporal_access ALTER COLUMN created_at TYPE BIGINT;

-- Parent access tokens
ALTER TABLE parent_access_tokens ALTER COLUMN expires_at TYPE BIGINT;
ALTER TABLE parent_access_tokens ALTER COLUMN created_at TYPE BIGINT;

-- Setup state
ALTER TABLE setup_state ALTER COLUMN last_interaction TYPE BIGINT;
ALTER TABLE setup_state ALTER COLUMN updated_at TYPE BIGINT;

-- TA setup state
ALTER TABLE ta_setup_state ALTER COLUMN created_at TYPE BIGINT;
ALTER TABLE ta_setup_state ALTER COLUMN updated_at TYPE BIGINT;
ALTER TABLE ta_setup_state ALTER COLUMN completed_at TYPE BIGINT;

-- Teacher access tokens
ALTER TABLE teacher_access_tokens ALTER COLUMN created_at TYPE BIGINT;
ALTER TABLE teacher_access_tokens ALTER COLUMN expires_at TYPE BIGINT;
