-- Add missing WhatsApp connection columns to schools table
ALTER TABLE schools ADD COLUMN IF NOT EXISTS whatsapp_connection_status TEXT DEFAULT 'disconnected';
ALTER TABLE schools ADD COLUMN IF NOT EXISTS connected_whatsapp_jid TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;
