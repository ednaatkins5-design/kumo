-- Add missing WhatsApp connection columns to schools table
-- Using separate statements that will fail silently if column exists
ALTER TABLE schools ADD COLUMN whatsapp_connection_status TEXT DEFAULT 'disconnected';
ALTER TABLE schools ADD COLUMN connected_whatsapp_jid TEXT;
ALTER TABLE schools ADD COLUMN whatsapp_number TEXT;
ALTER TABLE schools ADD COLUMN qr_refresh_count INTEGER DEFAULT 0;
ALTER TABLE schools ADD COLUMN qr_refresh_locked_until TIMESTAMP;
ALTER TABLE schools ADD COLUMN last_connection_at TIMESTAMP;
