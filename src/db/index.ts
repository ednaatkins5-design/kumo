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
        
        // Run auth migration for both SQLite and PostgreSQL
        await DatabaseManager.runAuthMigration(adapter);
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
            { path: path.join(__dirname, 'schema_fix_timestamps.sql'), name: 'Fix Timestamps' },
            { path: path.join(__dirname, 'schema_fix_foreign_keys.sql'), name: 'Fix Foreign Keys' },
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
                    // Silent skip for these common errors
                    if (err.message && (
                        err.message.includes('duplicate column name') || 
                        err.message.includes('already exists') ||
                        err.message.includes('duplicate table name') ||
                        err.message.includes('does not exist') // Table doesn't exist yet - will be created
                    )) {
                        // Silent skip
                    } else {
                        logger.error({ err, schema: s.name, statement: statement.substring(0, 50) }, 'Failed to execute statement');
                    }
                }
            }
            logger.info({ schema: s.name }, 'Schema component processed');
        }
    }

    private static async runAuthMigration(adapter: DatabaseAdapter): Promise<void> {
        const isPostgres = ENV.DB_TYPE === 'postgres';
        const serialType = isPostgres ? 'SERIAL' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
        const nowFunc = isPostgres ? 'CURRENT_TIMESTAMP' : "(strftime('%s', 'now'))";
        
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
        
        // Add missing columns to existing tables
        await addColumnSafe('users', 'password_hash', 'TEXT', 'password_hash');
        await addColumnSafe('users', 'email', 'TEXT', 'email');
        await addColumnSafe('users', 'is_active', 'INTEGER DEFAULT 1', 'is_active');
        await addColumnSafe('schools', 'whatsapp_number', 'TEXT', 'whatsapp_number');
        await addColumnSafe('schools', 'admin_name', 'TEXT', 'admin_name');
        await addColumnSafe('ta_setup_state', 'progress_percentage', 'INTEGER DEFAULT 0', 'progress_percentage');
        
        // Add WhatsApp columns to schools
        await addColumnSafe('schools', 'whatsapp_connection_status', 'TEXT DEFAULT \'disconnected\'', 'whatsapp_connection_status');
        await addColumnSafe('schools', 'connected_whatsapp_jid', 'TEXT', 'connected_whatsapp_jid');
        await addColumnSafe('schools', 'qr_refresh_count', 'INTEGER DEFAULT 0', 'qr_refresh_count');
        await addColumnSafe('schools', 'qr_refresh_locked_until', 'TIMESTAMP', 'qr_refresh_locked_until');
        await addColumnSafe('schools', 'last_connection_at', 'TIMESTAMP', 'last_connection_at');
        
        try {
            await adapter.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id ${serialType},
                user_id TEXT NOT NULL,
                token TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER DEFAULT ${nowFunc}
            )`);
        } catch (err) {
            logger.warn({ err }, 'password_reset_tokens table creation');
        }

        try {
            await adapter.run(`CREATE TABLE IF NOT EXISTS user_sessions (
                id ${serialType},
                user_id TEXT NOT NULL,
                school_id TEXT NOT NULL,
                token_jti TEXT NOT NULL UNIQUE,
                created_at INTEGER DEFAULT ${nowFunc},
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

        // Create setup_state table if not exists
        try {
            await adapter.run(`CREATE TABLE IF NOT EXISTS setup_state (
                school_id TEXT PRIMARY KEY,
                current_step TEXT NOT NULL,
                completed_steps TEXT DEFAULT '[]',
                pending_steps TEXT DEFAULT '[]',
                is_active INTEGER DEFAULT 1,
                config_draft TEXT DEFAULT '{}',
                last_interaction INTEGER,
                updated_at INTEGER
            )`);
            logger.info('setup_state table created');
        } catch (err: any) {
            if (!err.message?.includes('already exists')) {
                logger.warn({ err }, 'setup_state table creation');
            }
        }

        // Also try to create other critical tables that might be missing
        const criticalTables = [
            'ta_setup_state',
            'student_info',
            'class_student_mapping',
            'student_attendance_records',
            'student_broadsheet',
            'broadsheet_assignments'
        ];

        for (const table of criticalTables) {
            try {
                // Just try to select - if it fails, we don't care
                await adapter.get(`SELECT 1 FROM ${table} LIMIT 1`);
            } catch (err) {
                logger.info({ table }, 'Table may not exist yet - OK');
            }
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
