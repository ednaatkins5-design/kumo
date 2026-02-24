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
        // Pooler URL format: postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-1-eu-west-1.pooler.supabase.com:5432/postgres
        let poolerUrl = connectionString;
        
        // Transform direct URL to pooler URL
        // Direct: postgresql://postgres:PASSWORD@db.XXX.supabase.co:5432/postgres
        // Pooler: postgresql://postgres.XXX:PASSWORD@aws-1-eu-west-1.pooler.supabase.com:5432/postgres
        if (connectionString.includes('.supabase.co:5432')) {
            const match = connectionString.match(/postgresql:\/\/postgres:([^@]+)@db\.([^.]+)\.supabase\.co:5432\/postgres/);
            if (match) {
                const password = encodeURIComponent(decodeURIComponent(match[1]));
                const projectRef = match[2];
                poolerUrl = `postgresql://postgres.${projectRef}:${password}@aws-1-eu-west-1.pooler.supabase.com:5432/postgres`;
            }
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

    private convertPlaceholder(sql: string): string {
        let paramIndex = 1;
        return sql.replace(/\?/g, () => `$${paramIndex++}`);
    }

    async run(sql: string, params: any[] = []): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query(this.convertPlaceholder(sql), params);
        } finally {
            client.release();
        }
    }

    async get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
        const client = await this.pool.connect();
        try {
            const result = await client.query(this.convertPlaceholder(sql), params);
            return result.rows[0] as T | undefined;
        } finally {
            client.release();
        }
    }

    async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
        const client = await this.pool.connect();
        try {
            const result = await client.query(this.convertPlaceholder(sql), params);
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
