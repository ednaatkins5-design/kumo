-- Escalation System Database Schema (Refactored for Pause/Resume)
-- Treats escalation as conversational context handoff, not one-way transfer
-- Supports multi-turn authority dialogue and natural resumption

-- ============================================================================
-- ESCALATIONS TABLE
-- Stores escalation events (pause point, authority needed, context)
-- ============================================================================
CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    origin_agent TEXT NOT NULL CHECK(origin_agent IN ('PA', 'TA', 'GA')),
    escalation_type TEXT NOT NULL,
    priority TEXT NOT NULL CHECK(priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    
    -- Conversation context
    school_id TEXT NOT NULL,
    from_phone TEXT NOT NULL,
    session_id TEXT NOT NULL,
    user_name TEXT,
    user_role TEXT CHECK(user_role IN ('parent', 'teacher', 'student', 'unknown')),
    
    -- Pause/Resume tracking (NEW - core to reversibility)
    pause_message_id TEXT NOT NULL,        -- Message ID where escalation paused
    escalation_state TEXT DEFAULT 'PAUSED' CHECK(escalation_state IN ('PAUSED', 'AWAITING_CLARIFICATION', 'APPROVED', 'DENIED', 'RESOLVED', 'FAILED')),
    round_number INTEGER DEFAULT 1,        -- Multi-turn escalations (1, 2, 3...)
    awaiting_clarification_from TEXT,      -- 'ADMIN' if waiting for admin response, 'AGENT' if waiting for agent follow-up
    
    -- Why escalation was needed
    reason TEXT NOT NULL,
    what_agent_needed TEXT,                -- What authority/clarity did original agent need?
    
    -- Full context (not summary) - passed to authority agent
    context TEXT DEFAULT '{}',             -- Student/session data
    conversation_summary TEXT,             -- Key points from conversation before escalation
    
    -- Tracking
    status TEXT DEFAULT 'ESCALATED' CHECK(status IN ('ESCALATED', 'IN_AUTHORITY', 'AUTHORITY_RESPONDED', 'RESUMED', 'RESOLVED', 'CLOSED')),
    timestamp BIGINT NOT NULL,
    resumed_at BIGINT,                     -- When original agent resumed
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- ============================================================================
-- ESCALATION_ROUND_LOG TABLE
-- Tracks each round of authority dialogue for multi-turn escalations
-- ============================================================================
CREATE TABLE IF NOT EXISTS escalation_round_log (
    id TEXT PRIMARY KEY,
    escalation_id TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    
    -- Authority agent's response
    authority_request TEXT NOT NULL,       -- What authority asked for (can be clarification or decision)
    authority_type TEXT NOT NULL CHECK(authority_type IN ('CLARIFICATION_REQUEST', 'NEEDS_DECISION', 'DECISION_MADE')),
    authority_response TEXT NOT NULL,
    
    -- Back to original agent
    agent_response TEXT,                   -- Agent's clarification or final message
    agent_response_message_id TEXT,        -- Link to message in messages table
    
    -- Metadata
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY(escalation_id) REFERENCES escalations(id)
);

-- ============================================================================
-- MESSAGES TABLE ENHANCEMENTS (added as migration)
-- These fields should be added to existing messages table:
--   escalation_round INTEGER         -- Which round of escalation (for multi-turn)
--   is_authority_response BOOLEAN    -- Whether message is from authority agent
--   escalation_id TEXT               -- Link to escalation if part of one
-- ============================================================================

-- ============================================================================
-- SESSIONS TABLE ENHANCEMENTS (added as migration)
-- These fields should be added to existing sessions table:
--   current_escalation_id TEXT       -- If session is in escalation
--   escalation_stage TEXT            -- ACTIVE, AWAITING_AUTHORITY, RESOLVED, FAILED
-- ============================================================================


-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Escalations table indexes
CREATE INDEX IF NOT EXISTS idx_escalations_school ON escalations(school_id);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
CREATE INDEX IF NOT EXISTS idx_escalations_state ON escalations(escalation_state);
CREATE INDEX IF NOT EXISTS idx_escalations_priority ON escalations(priority);
CREATE INDEX IF NOT EXISTS idx_escalations_session ON escalations(session_id);
CREATE INDEX IF NOT EXISTS idx_escalations_origin_agent ON escalations(origin_agent);

-- Escalation round log indexes
CREATE INDEX IF NOT EXISTS idx_round_log_escalation ON escalation_round_log(escalation_id);
CREATE INDEX IF NOT EXISTS idx_round_log_round ON escalation_round_log(escalation_id, round_number);
CREATE INDEX IF NOT EXISTS idx_round_log_timestamp ON escalation_round_log(timestamp);
