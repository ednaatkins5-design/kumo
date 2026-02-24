-- Add missing WhatsApp connection columns to schools table
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'schools' AND column_name = 'whatsapp_connection_status') THEN
        ALTER TABLE schools ADD COLUMN whatsapp_connection_status TEXT DEFAULT 'disconnected';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'schools' AND column_name = 'connected_whatsapp_jid') THEN
        ALTER TABLE schools ADD COLUMN connected_whatsapp_jid TEXT;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'schools' AND column_name = 'whatsapp_number') THEN
        ALTER TABLE schools ADD COLUMN whatsapp_number TEXT;
    END IF;
END $$;
