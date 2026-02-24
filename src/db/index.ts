import fs from 'fs';
import path from 'path';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';
import Database, { Database as DatabaseClass } from './database';
import { DatabaseAdapter } from './postgres';

export class DatabaseManager {
    private static adapter: DatabaseAdapter;

    public static getInstance(): DatabaseAdapter {
        if (!DatabaseManager.adapter) {
            DatabaseManager.adapter = Database.getInstance();
        }
        return DatabaseManager.adapter;
    }

    public static async init(): Promise<void> {
        const adapter = DatabaseManager.getInstance();
        
        logger.info({ dbType: ENV.DB_TYPE }, 'Initializing database');

        await DatabaseManager.loadSchemas(adapter);
        
        if (ENV.DB_TYPE === 'sqlite') {
            await DatabaseManager.runAuthMigration(adapter);
        }
    }

    private static async loadSchemas(adapter: DatabaseAdapter): Promise<void> {
        const schemas = [
            { path: path.join(__dirname, 'schema.sql'), name: 'Base' },
            { path: path.join(__dirname, 'schema_phase3.sql'), name: 'Phase 3' },
            { path: path.join(__dirname, 'schema_phase4.sql'), name: 'Phase 4' },
            { path: path.join(__dirname, 'schema_amendments.sql'), name: 'Amendments' },
            { path: path.join(__dirname, 'schema_temporal.sql'), name: 'Temporal' },
            { path: path.join(__dirname, 'schema_setup.sql'), name: 'Setup' },
            { path: path.join(__dirname, 'schema_ta_setup.sql'), name: 'TA Setup' },
            { path: path.join(__dirname, 'schema_teacher_sessions.sql'), name: 'Teacher Sessions' },
            { path: path.join(__dirname, 'schema_memory.sql'), name: 'Memory' },
            { path: path.join(__dirname, 'schema_teacher_confirmation.sql'), name: 'Teacher Confirmation' },
            { path: path.join(__dirname, 'schema_student_marks_indexed.sql'), name: 'Student Marks Indexed' },
            { path: path.join(__dirname, 'schema_pdf_storage_marks.sql'), name: 'PDF Storage & Marks' },
            { path: path.join(__dirname, 'schema_sessions.sql'), name: 'Sessions' },
            { path: path.join(__dirname, 'schema_file_storage.sql'), name: 'File Storage' },
            { path: path.join(__dirname, 'schema_pdf_audit.sql'), name: 'PDF Audit Trail' },
            { path: path.join(__dirname, 'schema_escalation_system.sql'), name: 'Escalation System' },
            { path: path.join(__dirname, 'schema_escalation_audit.sql'), name: 'Escalation Audit Log' },
            { path: path.join(__dirname, 'schema_escalation_admin_decision.sql'), name: 'Escalation Admin Decision' },
            { path: path.join(__dirname, 'schema_harper_escalation_enhancements.sql'), name: 'Harper Escalation Enhancements' },
            { path: path.join(__dirname, 'schema_primary_secondary.sql'), name: 'Primary/Secondary Support' },
            { path: path.join(__dirname, 'schema_user_schooltype.sql'), name: 'User School Type' },
            { path: path.join(__dirname, 'schema_mark_submission_workflow.sql'), name: 'Mark Submission Workflow' },
            { path: path.join(__dirname, 'schema_parent_flow.sql'), name: 'Parent Flow' },
            { path: path.join(__dirname, 'schema_universe.sql'), name: 'School Universe Config' },
            { path: path.join(__dirname, 'schema_terminal_reports.sql'), name: 'Terminal Reports' },
            { path: path.join(__dirname, 'schema_cloud_storage.sql'), name: 'Cloud Storage' },
            { path: path.join(__dirname, 'schema_whatsapp_sessions.sql'), name: 'WhatsApp Sessions' },
            { path: path.join(__dirname, 'schema_fix_whatsapp.sql'), name: 'WhatsApp Fix' },
            { path: path.join(__dirname, 'schema_test.sql'), name: 'Test Schema' }
        ];

        for (const s of schemas) {
            logger.info({ path: s.path, name: s.name }, 'Checking schema file');
            if (!fs.existsSync(s.path)) {
                logger.warn({ path: s.path }, 'Schema file not found');
                continue;
            }
            
            const sql = fs.readFileSync(s.path, 'utf-8');
            const statements = sql.split(';').map(st => st.trim()).filter(st => st.length > 0);

            for (const statement of statements) {
                try {
                    await adapter.run(statement);
                } catch (err: any) {
                    if (err.message && (err.message.includes('duplicate column name') || 
                        err.message.includes('already exists') ||
                        err.message.includes('duplicate table name'))) {
                        // Silent skip for idempotent operations
                    } else {
                        logger.error({ err, schema: s.name, statement }, 'Failed to execute statement');
                    }
                }
            }
            logger.info({ schema: s.name }, 'Schema component processed');
        }
    }

    private static async runAuthMigration(adapter: DatabaseAdapter): Promise<void> {
        const addColumnSafe = async (table: string, column: string, definition: string, desc: string) => {
            try {
                await adapter.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
                logger.info(`${desc} column added`);
            } catch (err: any) {
                if (err.message && (err.message.includes('duplicate column name') || err.message.includes('already exists'))) {
                    logger.info(`${desc} column already exists`);
                } else {
                    logger.warn({ err, table, column }, `Failed to add ${desc} column`);
                }
            }
        };
        
        await addColumnSafe('users', 'password_hash', 'TEXT', 'password_hash');
        await addColumnSafe('users', 'email', 'TEXT', 'email');
        await addColumnSafe('users', 'is_active', 'INTEGER DEFAULT 1', 'is_active');
        await addColumnSafe('schools', 'whatsapp_number', 'TEXT', 'whatsapp_number');
        await addColumnSafe('schools', 'admin_name', 'TEXT', 'admin_name');
        await addColumnSafe('ta_setup_state', 'progress_percentage', 'INTEGER DEFAULT 0', 'progress_percentage');
        
        try {
            await adapter.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                token TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s', 'now'))
            )`);
        } catch (err) {
            logger.warn({ err }, 'password_reset_tokens table creation');
        }

        try {
            await adapter.run(`CREATE TABLE IF NOT EXISTS user_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                school_id TEXT NOT NULL,
                token_jti TEXT NOT NULL UNIQUE,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                expires_at INTEGER NOT NULL,
                is_revoked INTEGER DEFAULT 0
            )`);
        } catch (err) {
            logger.warn({ err }, 'user_sessions table creation');
        }

        try {
            await adapter.run(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`);
        } catch (err) {
            logger.warn({ err }, 'idx_users_phone index');
        }
    }

    public static async close(): Promise<void> {
        const adapter = DatabaseManager.getInstance();
        await adapter.close();
    }
}

// Export for backward compatibility
export const db = {
    getInstance: () => DatabaseManager.getInstance(),
    init: () => DatabaseManager.init(),
    close: () => DatabaseManager.close(),
    getDB: (): any => {
        const adapter = DatabaseManager.getInstance();
        // Return a wrapper that mimics SQLite database for backward compatibility
        // Old code uses: db.getDB().run(sql, params, callback) or db.getDB().run(sql, callback)
        return {
            run: (sql: string, params: any, callback: any) => {
                if (typeof params === 'function') {
                    callback = params;
                    params = [];
                }
                if (!callback) {
                    callback = () => {};
                }
                adapter.run(sql, params).then(() => callback()).catch(callback);
            },
            get: (sql: string, params: any, callback: any) => {
                if (typeof params === 'function') {
                    callback = params;
                    params = [];
                }
                if (!callback) {
                    callback = () => {};
                }
                adapter.get(sql, params).then(row => callback(null, row)).catch(callback);
            },
            all: (sql: string, params: any, callback: any) => {
                if (typeof params === 'function') {
                    callback = params;
                    params = [];
                }
                if (!callback) {
                    callback = () => {};
                }
                adapter.all(sql, params).then(rows => callback(null, rows)).catch(callback);
            },
            serialize: (callback?: () => void) => {
                if (callback) callback();
            }
        };
    }
};

export default DatabaseManager;
