import { Pool } from 'pg';
import { logger } from '../utils/logger';

export interface DatabaseAdapter {
    run(sql: string, params?: any[]): Promise<void>;
    get<T = any>(sql: string, params?: any[]): Promise<T | undefined>;
    all<T = any>(sql: string, params?: any[]): Promise<T[]>;
    exec(sql: string): Promise<void>;
    close(): Promise<void>;
}

export class PostgreSQLAdapter implements DatabaseAdapter {
    private pool: Pool;

    constructor(connectionString: string) {
        this.pool = new Pool({
            connectionString,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
            ssl: {
                rejectUnauthorized: false
            }
        });

        this.pool.on('error', (err) => {
            logger.error({ err }, 'Unexpected error on idle client');
        });
    }

    async run(sql: string, params: any[] = []): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query(sql, params);
        } finally {
            client.release();
        }
    }

    async get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
        const client = await this.pool.connect();
        try {
            const result = await client.query(sql, params);
            return result.rows[0] as T | undefined;
        } finally {
            client.release();
        }
    }

    async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
        const client = await this.pool.connect();
        try {
            const result = await client.query(sql, params);
            return result.rows as T[];
        } finally {
            client.release();
        }
    }

    async exec(sql: string): Promise<void> {
        const client = await this.pool.connect();
        try {
            const statements = sql.split(';').filter(stmt => stmt.trim());
            for (const stmt of statements) {
                if (stmt.trim()) {
                    await client.query(stmt);
                }
            }
        } finally {
            client.release();
        }
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    getPool(): Pool {
        return this.pool;
    }
}
