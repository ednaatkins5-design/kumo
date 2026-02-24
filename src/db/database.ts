import path from 'path';
import { logger } from '../utils/logger';
import { PostgreSQLAdapter } from './postgres';
import { SQLiteAdapter } from './sqlite';
import { ENV } from '../config/env';

export class Database {
    private static instance: any;

    public static getInstance(): any {
        if (!Database.instance) {
            Database.instance = Database.createAdapter();
        }
        return Database.instance;
    }

    private static createAdapter(): any {
        const dbType = ENV.DB_TYPE.toLowerCase();

        if (dbType === 'postgres') {
            if (!ENV.DATABASE_URL) {
                throw new Error('DATABASE_URL environment variable is required for PostgreSQL');
            }
            logger.info('Initializing PostgreSQL adapter');
            return new PostgreSQLAdapter(ENV.DATABASE_URL);
        } else {
            const dbPath = ENV.DB_PATH || path.join(process.cwd(), 'kumo.db');
            logger.info({ dbPath }, 'Initializing SQLite adapter');
            return new SQLiteAdapter(dbPath);
        }
    }

    public static async resetInstance(): Promise<void> {
        if (Database.instance) {
            await Database.instance.close();
            Database.instance = null;
        }
    }

    public static async reconnect(dbType: string, connectionString: string): Promise<any> {
        if (Database.instance) {
            await Database.instance.close();
        }

        if (dbType === 'postgres') {
            Database.instance = new PostgreSQLAdapter(connectionString);
        } else {
            Database.instance = new SQLiteAdapter(connectionString);
        }

        return Database.instance;
    }
}

export default Database;
