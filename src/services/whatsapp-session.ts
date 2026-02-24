import DatabaseManager from '../db/index';
import { logger } from '../utils/logger';
import { ENV } from '../config/env';

/**
 * Store WhatsApp session in database instead of filesystem
 * Works with both SQLite and PostgreSQL
 */
export class WhatsAppSessionService {
    /**
     * Save session data to database
     */
    async saveSession(schoolId: string, sessionData: any): Promise<void> {
        const adapter = DatabaseManager.getInstance();
        const sessionStr = JSON.stringify(sessionData);

        try {
            if (ENV.DB_TYPE === 'postgres') {
                await adapter.run(
                    `INSERT INTO whatsapp_sessions (id, school_id, session_data, created_at, updated_at)
                     VALUES ($1, $2, $3, NOW(), NOW())
                     ON CONFLICT(id) DO UPDATE SET
                     session_data = $3, updated_at = NOW()`,
                    [schoolId, schoolId, sessionStr]
                );
            } else {
                await adapter.run(
                    `INSERT INTO whatsapp_sessions (id, school_id, session_data, created_at, updated_at)
                     VALUES (?, ?, ?, datetime('now'), datetime('now'))
                     ON CONFLICT(id) DO UPDATE SET
                     session_data = ?, updated_at = datetime('now')`,
                    [schoolId, schoolId, sessionStr, sessionStr]
                );
            }
            logger.info({ schoolId }, 'WhatsApp session saved to database');
        } catch (err) {
            logger.error({ err, schoolId }, 'Failed to save WhatsApp session');
            throw err;
        }
    }

    /**
     * Load session from database
     */
    async loadSession(schoolId: string): Promise<any> {
        const adapter = DatabaseManager.getInstance();
        
        try {
            const row = await adapter.get<{ session_data: string }>(
                'SELECT session_data FROM whatsapp_sessions WHERE school_id = ?',
                [schoolId]
            );

            if (!row) return null;

            try {
                return JSON.parse(row.session_data);
            } catch (err) {
                logger.warn({ err, schoolId }, 'Failed to parse session data');
                return null;
            }
        } catch (err) {
            logger.error({ err, schoolId }, 'Failed to load WhatsApp session');
            return null;
        }
    }

    /**
     * Delete session from database
     */
    async deleteSession(schoolId: string): Promise<void> {
        const adapter = DatabaseManager.getInstance();
        
        try {
            await adapter.run('DELETE FROM whatsapp_sessions WHERE school_id = ?', [schoolId]);
            logger.info({ schoolId }, 'WhatsApp session deleted');
        } catch (err) {
            logger.error({ err, schoolId }, 'Failed to delete WhatsApp session');
            throw err;
        }
    }

    /**
     * Check if session exists
     */
    async sessionExists(schoolId: string): Promise<boolean> {
        const adapter = DatabaseManager.getInstance();
        
        try {
            const row = await adapter.get<{ id: string }>(
                'SELECT id FROM whatsapp_sessions WHERE school_id = ? LIMIT 1',
                [schoolId]
            );
            return !!row;
        } catch (err) {
            logger.error({ err, schoolId }, 'Failed to check session existence');
            return false;
        }
    }
}

export const whatsappSessionService = new WhatsAppSessionService();
