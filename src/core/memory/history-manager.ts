import { db } from '../../db';
import { ActionAwareMessage } from './types';
import { logger } from '../../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface MaskingConfig {
    phoneNumberPattern: RegExp;
    studentNamePattern: RegExp;
    paymentPattern: RegExp;
    transactionIdPattern: RegExp;
    accessTokenPatterns: RegExp[];
}

export const DEFAULT_MASKING_CONFIG: MaskingConfig = {
    phoneNumberPattern: /\+?[0-9]{10,15}/g,
    studentNamePattern: /(?:student|learner|pupil)[:\s]+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})/gi,
    paymentPattern: /(?:₦|Naira|naira)?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?\s*(?:naira|ngn)?/gi,
    transactionIdPattern: /(?:transaction|ref|payment|txn)[-_\s]?(?:id)?[:\s]+([A-Z0-9]{6,20})/gi,
    accessTokenPatterns: [
        /KUMO-[A-Z0-9]+/gi,
        /(?:Bearer|Token|Auth)[:\s]+([A-Za-z0-9\-_.]{10,})/gi,
        /(?:api[_-]?key|apikey|secret)[:\s]+([A-Za-z0-9]{16,})/gi,
        /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g
    ]
};

export class HistoryManager {
    private static maskingConfig: MaskingConfig = { ...DEFAULT_MASKING_CONFIG };

    static configureMasking(config: Partial<MaskingConfig>): void {
        this.maskingConfig = { ...this.maskingConfig, ...config };
    }

    private static maskSensitiveData(content: string): string {
        let masked = content;

        masked = masked.replace(this.maskingConfig.phoneNumberPattern, '[REDACTED_PHONE]');

        masked = masked.replace(this.maskingConfig.paymentPattern, '[REDACTED_AMOUNT]');

        masked = masked.replace(this.maskingConfig.transactionIdPattern, '[REDACTED_TXN_ID]');

        masked = masked.replace(this.maskingConfig.studentNamePattern, (match, name) =>
            match.replace(name, '[REDACTED_NAME]')
        );

        for (const pattern of this.maskingConfig.accessTokenPatterns) {
            masked = masked.replace(pattern, '[REDACTED_ACCESS_TOKEN]');
        }

        return masked;
    }

    static async recordMessage(
        schoolId: string,
        userId: string | undefined,
        fromPhone: string,
        context: string,
        msg: { type: string, body: any, mediaPath?: string, timestamp: number, source?: string },
        actionInfo?: { action: string, status: string }
    ): Promise<void> {
        let bodyStr = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body);

        const isInternal = bodyStr?.startsWith('SYSTEM COMMAND:') || 
                          bodyStr?.startsWith('SYSTEM EVENT:') || 
                          msg.source === 'system_internal';

        const sql = `
            INSERT INTO messages (id, school_id, user_id, from_phone, type, body, media_path, context, timestamp, action_performed, action_status, is_internal)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const id = uuidv4();
        const timestamp = msg.timestamp;
        
        let finalBody = msg.source === 'system' ? `[SYSTEM BRIEFING] ${bodyStr}` : bodyStr;

        if (typeof finalBody === 'string') {
            finalBody = this.maskSensitiveData(finalBody);
        }

        return new Promise((resolve, reject) => {
            db.getDB().run(sql, [
                id, schoolId, userId || null, fromPhone, msg.type, finalBody, msg.mediaPath || null, context, timestamp, actionInfo?.action || null, actionInfo?.status || null, isInternal ? 1 : 0
            ], (err) => {
                if (err) {
                    logger.error({ err }, 'Failed to record message in history');
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Gets the last N messages for a user context.
     * Prioritizes userId for persistence across devices, falls back to fromPhone.
     */
    static async getSlidingWindow(fromPhone: string, limit: number = 10, userId?: string, schoolId?: string): Promise<ActionAwareMessage[]> {
        // --- SHARED DEVICE ISOLATION ---
        // If userId is present, strictly limit to that user's history within the school.
        // If userId is absent (unauthenticated), strictly limit to the "Guest" history (userId IS NULL) for that phone + school.
        // This prevents data leakage on shared African devices.
        const sql = userId 
            ? `SELECT * FROM (
                SELECT m.*, u.role 
                FROM messages m
                LEFT JOIN users u ON m.user_id = u.id
                WHERE m.user_id = ? AND m.school_id = ? AND m.is_internal = 0
                ORDER BY m.timestamp DESC
                LIMIT ?
              ) ORDER BY timestamp ASC`
            : `SELECT * FROM (
                SELECT m.*, u.role 
                FROM messages m
                LEFT JOIN users u ON m.user_id = u.id
                WHERE m.from_phone = ? AND m.school_id = ? AND m.user_id IS NULL AND m.is_internal = 0
                ORDER BY m.timestamp DESC
                LIMIT ?
              ) ORDER BY timestamp ASC`;
        // -------------------------------

        const param = userId || fromPhone;
        const queryParams = schoolId ? [param, schoolId, limit] : [param, limit];
        
        // If schoolId is missing, fallback to legacy behavior (unsafe for multi-tenancy) but log warning
        let finalSql = sql;
        let finalParams = [param, schoolId, limit];

        if (!schoolId) {
            logger.warn({ fromPhone, userId }, '⚠️ [HistoryManager] getSlidingWindow called WITHOUT schoolId - potential leakage risk');
            finalSql = userId 
                ? `SELECT * FROM (SELECT m.*, u.role FROM messages m LEFT JOIN users u ON m.user_id = u.id WHERE m.user_id = ? AND m.is_internal = 0 ORDER BY m.timestamp DESC LIMIT ?) ORDER BY timestamp ASC`
                : `SELECT * FROM (SELECT m.*, u.role FROM messages m LEFT JOIN users u ON m.user_id = u.id WHERE m.from_phone = ? AND m.user_id IS NULL AND m.is_internal = 0 ORDER BY m.timestamp DESC LIMIT ?) ORDER BY timestamp ASC`;
            finalParams = [param, limit];
        }

        return new Promise((resolve, reject) => {
            db.getDB().all(finalSql, finalParams, (err, rows: any[]) => {
                if (err) {
                    logger.error({ err, fromPhone }, 'Error fetching sliding window history');
                    reject(err);
                } else {
                    resolve(rows.map(r => {
                        // Determine speaker: If action_performed is present (even 'NONE'), it's the Agent.
                        // Incoming user messages have action_performed as NULL.
                        const isAgent = r.action_performed !== null;
                        const role = isAgent ? (r.context || 'AI') : (r.role || 'User');
                        
                        // Handle timestamp - could be epoch millis (BIGINT) or ISO string
                        let timestamp: string;
                        try {
                            const ts = r.timestamp;
                            if (!ts) {
                                timestamp = new Date().toISOString();
                            } else if (typeof ts === 'number' || (typeof ts === 'string' && /^\d+$/.test(ts))) {
                                // Epoch milliseconds
                                timestamp = new Date(Number(ts)).toISOString();
                            } else {
                                timestamp = new Date(ts).toISOString();
                            }
                        } catch {
                            timestamp = new Date().toISOString();
                        }
                        
                        return {
                            id: r.id,
                            timestamp,
                            sender_role: role,
                            content: r.body,
                            type: r.type,
                            context: r.context,
                            action_performed: r.action_performed,
                            action_status: r.action_status
                        };
                    }));
                }
            });
        });
    }

    /**
     * Checks the message count since the last snapshot.
     */
    static async getMessageCountSinceLastSnapshot(userId: string): Promise<number> {
        const lastSnapshotSql = `SELECT created_at FROM memory_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`;
        
        return new Promise((resolve, reject) => {
            db.getDB().get(lastSnapshotSql, [userId], (err, row: any) => {
                if (err) return reject(err);
                
                const lastTimestamp = row ? row.created_at : '1970-01-01 00:00:00';
                const countSql = `SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND created_at > ? AND is_internal = 0`;
                
                db.getDB().get(countSql, [userId, lastTimestamp], (err, countRow: any) => {
                    if (err) reject(err);
                    else resolve(countRow.count);
                });
            });
        });
    }
}
