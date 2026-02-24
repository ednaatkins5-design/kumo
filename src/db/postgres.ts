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
        // Use Supabase Session Pooler for IPv4 compatibility (Render, Vercel, etc.)
        // Format: postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-1-eu-west-1.pooler.supabase.com:5432/postgres
        let poolerUrl = connectionString;
        
        // If using direct connection, switch to pooler
        if (connectionString.includes('.supabase.co:5432')) {
            poolerUrl = connectionString
                .replace('.supabase.co:5432', '.pooler.supabase.com:5432')
                .replace('postgres:', 'postgres.jkgupprtadmekxiqiqho:');
        }
        
        this.pool = new Pool({
            connectionString: poolerUrl,
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
