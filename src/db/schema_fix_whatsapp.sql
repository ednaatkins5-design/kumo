-- Add all missing WhatsApp connection columns to schools table
DO $$
BEGIN
    -- whatsapp_connection_status
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'schools' AND column_name = 'whatsapp_connection_status') THEN
        ALTER TABLE schools ADD COLUMN whatsapp_connection_status TEXT DEFAULT 'disconnected';
    END IF;
    
    -- connected_whatsapp_jid
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'schools' AND column_name = 'connected_whatsapp_jid') THEN
        ALTER TABLE schools ADD COLUMN connected_whatsapp_jid TEXT;
    END IF;
    
    -- whatsapp_number
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'schools' AND column_name = 'whatsapp_number') THEN
        ALTER TABLE schools ADD COLUMN whatsapp_number TEXT;
    END IF;
    
    -- qr_refresh_count
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'schools' AND column_name = 'qr_refresh_count') THEN
        ALTER TABLE schools ADD COLUMN qr_refresh_count INTEGER DEFAULT 0;
    END IF;
    
    -- qr_refresh_locked_until
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'schools' AND column_name = 'qr_refresh_locked_until') THEN
        ALTER TABLE schools ADD COLUMN qr_refresh_locked_until TIMESTAMP;
    END IF;
    
    -- last_connection_at
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'schools' AND column_name = 'last_connection_at') THEN
        ALTER TABLE schools ADD COLUMN last_connection_at TIMESTAMP;
    END IF;
END $$;
