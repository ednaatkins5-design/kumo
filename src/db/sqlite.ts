import sqlite3 from 'sqlite3';
import { logger } from '../utils/logger';

export interface DatabaseAdapter {
    run(sql: string, params?: any[]): Promise<void>;
    get<T = any>(sql: string, params?: any[]): Promise<T | undefined>;
    all<T = any>(sql: string, params?: any[]): Promise<T[]>;
    exec(sql: string): Promise<void>;
    close(): Promise<void>;
}

export class SQLiteAdapter implements DatabaseAdapter {
    private db: sqlite3.Database;
    private dbPath: string;

    constructor(dbPath: string) {
        this.dbPath = dbPath;
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                logger.error({ err }, 'Could not connect to SQLite database');
                process.exit(1);
            } else {
                logger.info({ dbPath }, 'Connected to SQLite database');
            }
        });

        this.db.run('PRAGMA foreign_keys = ON');
    }

    async run(sql: string, params: any[] = []): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row as T | undefined);
            });
        });
    }

    async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows as T[]);
            });
        });
    }

    async exec(sql: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.exec(sql, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async close(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}
