-- Fix messages table: remove user_id foreign key constraint to allow NULL values
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_user_id_fkey;
