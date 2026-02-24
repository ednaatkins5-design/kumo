import { db } from '..';
import { logger } from '../../utils/logger';

export interface SetupState {
    school_id: string;
    current_step: string;
    completed_steps: string[];
    pending_steps: string[];
    is_active: boolean;
    config_draft: any;
}

export class SetupRepository {
    static async getSetupState(schoolId: string): Promise<SetupState | null> {
        const sql = `SELECT * FROM setup_state WHERE school_id = ?`;
        return new Promise((resolve, reject) => {
            db.getDB().get(sql, [schoolId], (err, row: any) => {
                if (err) reject(err);
                else if (!row) resolve(null);
                else resolve({
                    school_id: row.school_id,
                    current_step: row.current_step,
                    completed_steps: JSON.parse(row.completed_steps || '[]'),
                    pending_steps: JSON.parse(row.pending_steps || '[]'),
                    is_active: !!row.is_active,
                    config_draft: JSON.parse(row.config_draft || '{}')
                });
            });
        });
    }

    static async initSetup(schoolId: string, steps: string[]): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        const sql = `
            INSERT INTO setup_state (school_id, current_step, pending_steps, is_active, last_interaction, updated_at)
            VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT(school_id) DO UPDATE SET is_active = 1
        `;
        return new Promise((resolve, reject) => {
            db.getDB().run(sql, [schoolId, steps[0], JSON.stringify(steps), now, now], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    static async updateSetup(schoolId: string, data: Partial<SetupState>): Promise<void> {
        const updates: string[] = [];
        const params: any[] = [];

        if (data.current_step) {
            updates.push(`current_step = ?`);
            params.push(data.current_step);
        }
        if (data.completed_steps) {
            updates.push(`completed_steps = ?`);
            params.push(JSON.stringify(data.completed_steps));
        }
        if (data.config_draft) {
            updates.push(`config_draft = ?`);
            params.push(JSON.stringify(data.config_draft));
        }
        if (data.is_active !== undefined) {
            updates.push(`is_active = ?`);
            params.push(data.is_active ? 1 : 0);
        }

        const now = Math.floor(Date.now() / 1000);
        updates.push(`updated_at = ?`);
        params.push(now);
        updates.push(`last_interaction = ?`);
        params.push(now);

        const sql = `UPDATE setup_state SET ${updates.join(', ')} WHERE school_id = ?`;
        params.push(schoolId);

        return new Promise((resolve, reject) => {
            db.getDB().run(sql, params, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    static async isSchoolInSetup(schoolId: string): Promise<boolean> {
        if (!schoolId) return false;

        // 1. Check source of truth: schools table
        const status = await new Promise<string | null>((resolve) => {
            db.getDB().get(`SELECT setup_status FROM schools WHERE id = ?`, [schoolId], (err, row: any) => {
                resolve(row?.setup_status || null);
            });
        });

        if (status === 'OPERATIONAL') return false;
        if (status === 'PENDING_SETUP' || status === 'IN_PROGRESS' || status === 'TA_SETUP') return true;

        // 2. Fallback to specialized setup_state table
        const isActive = await new Promise<boolean>((resolve) => {
            db.getDB().get(`SELECT is_active FROM setup_state WHERE school_id = ?`, [schoolId], (err, row: any) => {
                resolve(row ? !!row.is_active : false);
            });
        });

        return isActive;
    }
}
