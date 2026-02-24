-- Migration: Add admin_decision persistence columns to escalations table
-- Allows tracking of admin decisions and notes for escalation resolution

-- Add admin_decision column if it doesn't exist
ALTER TABLE escalations ADD COLUMN admin_decision TEXT CHECK(admin_decision IN ('APPROVE', 'DENY', 'CLARIFY', 'REQUEST_CORRECTION'));

-- Add admin_instruction column for detailed notes
ALTER TABLE escalations ADD COLUMN admin_instruction TEXT;

-- Add resolved_at timestamp
ALTER TABLE escalations ADD COLUMN resolved_at BIGINT;

-- Add resolved_by to track who made the decision
ALTER TABLE escalations ADD COLUMN resolved_by TEXT;

-- Add admin_decision_at for precise decision timestamp
ALTER TABLE escalations ADD COLUMN admin_decision_at TIMESTAMP;

-- Create an index on admin_decision for quick filtering
CREATE INDEX IF NOT EXISTS idx_escalations_admin_decision ON escalations(admin_decision);

-- Create an index on resolved_at for timeline queries
CREATE INDEX IF NOT EXISTS idx_escalations_resolved_at ON escalations(resolved_at);
