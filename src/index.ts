import { db } from './db';
import { logger } from './utils/logger';
import { whatsappManager } from './core/transport/multi-socket-manager';
import { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

let cleanupService: any = null;

async function gracefulShutdown(signal: string) {
    logger.info({ signal }, 'Received shutdown signal');
    try {
        if (cleanupService) {
            cleanupService.stop();
            logger.info('Cleanup service stopped');
        }
        // Disconnect all WhatsApp connections
        const activeConnections = whatsappManager.getActiveConnections();
        for (const schoolId of activeConnections) {
            await whatsappManager.disconnect(schoolId);
        }
        db.close();
        logger.info('Database connection closed');
        process.exit(0);
    } catch (error) {
        logger.error({ error, signal }, 'Error during shutdown');
        process.exit(1);
    }
}

process.on('uncaughtException', (error: Error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught Exception - Fatal Error');
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    logger.error({ reason, stack: reason?.stack }, 'Unhandled Promise Rejection');
});

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

async function main() {
    try {
        logger.info('Starting Kumo System...');

        await db.init();

        // Run WhatsApp connection migration
        try {
            await runWhatsAppMigration();
        } catch (migrationError) {
            logger.warn({ error: migrationError }, 'Migration warning (continuing...)');
        }

        // Check for existing schools
        const schools: any[] = await new Promise((resolve, reject) => {
            db.getDB().all('SELECT * FROM schools', (err, rows: any) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        if (schools.length === 0) {
            // No school configured - frontend will handle signup
            console.log('\n\n════════════════════════════════════════════════════════════');
            console.log(' NO SCHOOL CONFIGURED - WAITING FOR FRONTEND SIGNUP ');
            console.log('════════════════════════════════════════════════════════════');
            console.log('Start the frontend and sign up to create your school.\n');
        }

        // Show ALL schools in the database
        console.log('\n════════════════════════════════════════════════════════════');
        console.log(' REGISTERED SCHOOLS (' + schools.length + ')');
        console.log('════════════════════════════════════════════════════════════');
        
        for (const school of schools) {
            console.log(`\n📚 ${school.name}`);
            console.log(`   Admin Phone: ${school.admin_phone}`);
            console.log(`   School ID: ${school.id}`);
            console.log(`   WhatsApp Status: ${school.whatsapp_connection_status || 'disconnected'}`);
        }
        
        console.log('\n════════════════════════════════════════════════════════════');
        
        // Auto-reconnect to previously connected schools
        // Check both DB AND session files on disk
        const previouslyConnected = schools.filter(s => {
            const dbConnected = s.connected_whatsapp_jid && s.whatsapp_connection_status === 'connected';
            // Also check if session files exist on disk (same logic as multi-socket-manager)
            const authBaseDir = path.resolve('kumo_auth_info');
            const sessionPath = path.join(authBaseDir, s.id);
            let sessionExists = false;
            try {
                sessionExists = fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length > 0;
            } catch (e) {
                // Ignore errors
            }
            return dbConnected || sessionExists;
        });
        
        if (previouslyConnected.length > 0) {
            console.log(`\n🔄 Auto-reconnecting to ${previouslyConnected.length} previously connected school(s)...`);
            for (const school of previouslyConnected) {
                console.log(`   ↻ Attempting reconnect for: ${school.name} (${school.id})`);
                try {
                    await whatsappManager.connect(school.id);
                    console.log(`   ✅ Reconnect initiated for: ${school.name}`);
                } catch (err: any) {
                    console.log(`   ❌ Reconnect failed for ${school.name}: ${err.message}`);
                }
            }
        }
        
        console.log('\n👉 Backend ready! Each school can connect their own WhatsApp via the frontend.');
        
        // --- API SERVER ---
        const express = require('express');
        const cors = require('cors');
        const cookieParser = require('cookie-parser');
        const { webhookRouter } = require('./api/webhook-handler');
        const { whatsappRouter } = require('./api/routes/whatsapp');
        const { setupRouter } = require('./api/routes/setup');
        const { authRouter } = require('./api/routes/auth');
        const { dashboardRouter } = require('./api/routes/dashboard');
        const { supportRouter } = require('./api/routes/support');
        const { authenticateToken, requireAdmin } = require('./api/middleware/auth.middleware');

        const app = express();
        const isProduction = process.env.NODE_ENV === 'production';
        const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
            .split(',')
            .map(o => o.trim())
            .filter(o => o.length > 0);
        
        const corsOptions: cors.CorsOptions = {
            origin: function(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
                if (!origin) {
                    return callback(null, true);
                }
                
                if (allowedOrigins.length > 0) {
                    if (allowedOrigins.includes(origin)) {
                        return callback(null, true);
                    }
                    if (isProduction) {
                        return callback(new Error('Not allowed by CORS policy'), false);
                    }
                }
                
                if (!isProduction) {
                    if (origin.startsWith('http://localhost:') || 
                        origin.startsWith('http://127.0.0.1:') ||
                        origin.startsWith('http://192.168.') ||
                        origin.startsWith('http://10.') ||
                        origin.startsWith('http://172.') ||
                        origin.includes('cloudshell.dev') ||
                        origin.includes('ngrok-free.dev') ||
                        origin.includes('ngrok.io')) {
                        return callback(null, true);
                    }
                }
                
                logger.warn({ origin }, 'CORS BLOCKED - Origin not allowed');
                if (isProduction) {
                    return callback(new Error('Not allowed by CORS policy'), false);
                }
            },
            credentials: true
        };
        app.use(cors(corsOptions));
        app.use(express.json());
        app.use(cookieParser());

        // --- API Routes ---
        
        // 1. Public Routes (No Authentication)
        app.use('/api/webhooks', webhookRouter);
        app.use('/api/auth', authRouter);
        app.use('/api/support', supportRouter);

        // TEST ENDPOINT: Trigger SA Flow (No Auth - must be before authenticateToken)
        app.post('/api/test/trigger-sa', async (req: Request, res: Response) => {
            try {
                const { from, body, type = 'text', schoolId } = req.body;
                
                if (!from || !body) {
                    return res.status(400).json({ success: false, error: 'Missing from or body' });
                }

                logger.info({ from, body, type, schoolId }, '📱 [TEST] Simulating WhatsApp message');

                // Import and use the dispatcher
                const { AgentDispatcher } = await import('./core/dispatcher');
                const { v4: uuidv4 } = await import('uuid');
                
                // Use provided schoolId or default to test school
                const testSchoolId = schoolId || '5201a568-e8b3-4390-85d6-87476ba76e89';

                // Create a mock routed message
                const message = {
                    id: uuidv4(),
                    from: from,
                    to: 'school',
                    body: body,
                    type: type,
                    timestamp: Date.now(),
                    source: 'user' as const,
                    context: 'SA' as const,
                    schoolId: testSchoolId,
                    identity: {
                        userId: 'test-user-id',
                        phone: from,
                        role: 'admin' as const,
                        schoolId: testSchoolId,
                        name: 'Admin'
                    }
                };

                const dispatcher = new AgentDispatcher();
                const response = await dispatcher.dispatch(message);

                logger.info({ response: JSON.stringify(response) }, '📱 [TEST] SA Response');

                res.json({ success: true, response });
            } catch (error: any) {
                logger.error({ error: error?.message, stack: error?.stack }, '❌ [TEST] SA trigger failed');
                res.status(500).json({ success: false, error: error.message, stack: error?.stack });
            }
        });

        // Simple test endpoint that bypasses agent
        app.post('/api/test/simple', async (req: Request, res: Response) => {
            const { phone } = req.body;
            res.json({ success: true, message: `Hello ${phone}! This is a test.` });
        });

        // TEST ENDPOINT: Trigger TA Flow (Teacher Assistant)
        app.post('/api/test/trigger-ta', async (req: Request, res: Response) => {
            try {
                const { from, body, type = 'text' } = req.body;
                
                if (!from || !body) {
                    return res.status(400).json({ success: false, error: 'Missing from or body' });
                }

                logger.info({ from, body, type }, '📚 [TEST] Simulating TA WhatsApp message');

                // Import and use the dispatcher
                const { AgentDispatcher } = await import('./core/dispatcher');
                const { v4: uuidv4 } = await import('uuid');
                const { PhoneNormalizer } = await import('./utils/phone-normalizer');

                // Normalize the phone number
                const normalizedFrom = PhoneNormalizer.normalize(from);

                // Check if user is a teacher
                const teacher: any = await new Promise((resolve) => {
                    db.getDB().get(
                        `SELECT id, name, role, school_id, assigned_class FROM users WHERE phone = ? AND role = 'teacher'`,
                        [normalizedFrom],
                        (err, row) => resolve(row)
                    );
                });

                const schoolId = teacher?.school_id || '3876fd28-bfe7-4450-bc69-bad51d533330';

                // Create a mock routed message for TA
                const message = {
                    id: uuidv4(),
                    from: normalizedFrom,
                    to: 'school',
                    body: body,
                    type: type,
                    timestamp: Date.now(),
                    source: 'user' as const,
                    context: 'TA' as const,
                    schoolId: schoolId,
                    identity: teacher ? {
                        userId: teacher.id,
                        phone: normalizedFrom,
                        role: 'teacher' as const,
                        schoolId: teacher.school_id,
                        name: teacher.name,
                        assignedClass: teacher.assigned_class
                    } : undefined
                };

                const dispatcher = new AgentDispatcher();
                const response = await dispatcher.dispatch(message);

                logger.info({ response }, '📚 [TEST] TA Response');

                res.json({ success: true, response });
            } catch (error: any) {
                logger.error({ error: error?.message, stack: error?.stack }, '❌ [TEST] TA trigger failed');
                res.status(500).json({ success: false, error: error.message, stack: error?.stack });
            }
        });

        // TEST ENDPOINT: Trigger PA Flow (Parent Agent)
        app.post('/api/test/trigger-pa', async (req: Request, res: Response) => {
            try {
                const { from, body, type = 'text', identified = false } = req.body;
                
                if (!from || !body) {
                    return res.status(400).json({ success: false, error: 'Missing from or body' });
                }

                logger.info({ from, body, type, identified }, '👨‍👩‍👧 [TEST] Simulating PA WhatsApp message');

                // Import and use the dispatcher
                const { AgentDispatcher } = await import('./core/dispatcher');
                const { v4: uuidv4 } = await import('uuid');
                const { PhoneNormalizer } = await import('./utils/phone-normalizer');

                // Normalize the phone number
                const normalizedFrom = PhoneNormalizer.normalize(from);

                // Check if user is an identified parent
                // Parents added by admin are in parent_registry (NOT users table)
                let parent: any = null;
                if (identified) {
                    // First check parent_registry (where admin-added parents are)
                    parent = await new Promise<any>((resolve) => {
                        db.getDB().get(
                            `SELECT parent_id as id, parent_name as name, school_id FROM parent_registry WHERE parent_phone = ? AND is_active = 1`,
                            [normalizedFrom],
                            (err, row) => resolve(row)
                        );
                    });
                    // If not found, check users table (fallback for other parent types)
                    if (!parent) {
                        parent = await new Promise<any>((resolve) => {
                            db.getDB().get(
                                `SELECT id, name, role, school_id FROM users WHERE phone = ? AND role = 'parent'`,
                                [normalizedFrom],
                                (err, row) => resolve(row)
                            );
                        });
                    }
                }

                // Get test school
                const testSchoolId = '3876fd28-bfe7-4450-bc69-bad51d533330';

                // Create a mock routed message for PA
                const message = {
                    id: uuidv4(),
                    from: normalizedFrom,
                    to: 'school',
                    body: body,
                    type: type,
                    timestamp: Date.now(),
                    source: 'user' as const,
                    context: 'PA' as const,
                    schoolId: parent?.school_id || testSchoolId,
                    identity: parent ? {
                        userId: parent.id,
                        phone: normalizedFrom,
                        role: 'parent' as const,
                        schoolId: parent.school_id,
                        name: parent.name
                    } : undefined,
                    isIdentifiedParent: identified || !!parent
                };

                const dispatcher = new AgentDispatcher();
                const response = await dispatcher.dispatch(message);

                logger.info({ response }, '👨‍👩‍👧 [TEST] PA Response');

                res.json({ success: true, response });
            } catch (error: any) {
                logger.error({ error: error?.message, stack: error?.stack }, '❌ [TEST] PA trigger failed');
                res.status(500).json({ success: false, error: error.message, stack: error?.stack });
            }
        });

        // 2. Authentication Middleware (Applies to all routes below)
        app.use('/api', authenticateToken);

        // 3. Protected Routes
        app.use('/api/whatsapp', requireAdmin, whatsappRouter);
        app.use('/api/setup', requireAdmin, setupRouter);
        app.use('/api', dashboardRouter);

        // Health check (Now Protected)
        app.get('/api/health', (req: Request, res: Response) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                activeConnections: whatsappManager.getActiveConnections()
            });
        });

        // --- Static Files (Frontend) ---
        // Serve static files from frontend dist directory
        const frontendDistPath = path.join(__dirname, '../frontend/app/dist');
        if (fs.existsSync(frontendDistPath)) {
            app.use(express.static(frontendDistPath));
            
            // Serve index.html for all non-API routes (SPA fallback)
            app.use((req: Request, res: Response, next: NextFunction) => {
                if (!req.path.startsWith('/api')) {
                    res.sendFile(path.join(frontendDistPath, 'index.html'));
                } else {
                    next();
                }
            });
            
            logger.info('Serving frontend static files from: ' + frontendDistPath);
        } else {
            logger.warn('Frontend dist directory not found at: ' + frontendDistPath);
        }

        const PORT = process.env.PORT || 3000;
        const HOST = '0.0.0.0'; // Bind to all interfaces for mobile access
        
        app.listen(Number(PORT), HOST, () => {
            logger.info({ PORT, HOST }, '🚀 Kumo API Server running');
            // Get actual IP for display (useful for frontend connection)
            const os = require('os');
            const interfaces = os.networkInterfaces();
            let localIP = 'localhost';
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name]) {
                    if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('10.')) {
                        localIP = iface.address;
                        break;
                    }
                }
            }
            console.log(`\n📡 API Server: http://${localIP}:${PORT} (Accessible on network)`);
            console.log(`   Update your frontend .env: VITE_API_URL=http://${localIP}:${PORT}/api`);
            console.log(`📱 WhatsApp Connections managed at: /api/whatsapp/*`);
            console.log(`⚙️  School Setup API at: /api/setup/*`);
            console.log(`🔐 Auth API at: /api/auth/*`);
        });

        const { getFileCleanupService } = await import('./services/file-cleanup');
        cleanupService = getFileCleanupService();
        cleanupService.start();

        logger.info('Kumo System Running');

    } catch (error: any) {
        logger.error({ error: error?.message, stack: error?.stack }, 'Fatal error starting system');
        process.exit(1);
    }
}

async function runWhatsAppMigration(): Promise<void> {
    // Skip this migration for PostgreSQL - schema is loaded via schema_whatsapp_qr_history.sql
    const { ENV } = await import('./config/env');
    if (ENV.DB_TYPE === 'postgres') {
        logger.info('Skipping WhatsApp migration for PostgreSQL');
        return;
    }
    
    return new Promise((resolve, reject) => {
        const dbRef = db.getDB();

        // Add columns one by one, handling existing columns
        const columnsToAdd = [
            { name: 'whatsapp_connection_status', type: 'TEXT DEFAULT "disconnected"' },
            { name: 'qr_refresh_count', type: 'INTEGER DEFAULT 0' },
            { name: 'qr_refresh_locked_until', type: 'DATETIME' },
            { name: 'last_connection_at', type: 'DATETIME' }
        ];

        let pending = columnsToAdd.length;

        for (const col of columnsToAdd) {
            dbRef.run(`ALTER TABLE schools ADD COLUMN ${col.name} ${col.type}`, (err) => {
                // Ignore "duplicate column name" errors
                if (err && !err.message.includes('duplicate column name')) {
                    logger.warn({ error: err, column: col.name }, 'Could not add column');
                }
                pending--;
                if (pending === 0) {
                    createQRHistoryTable(dbRef).then(resolve).catch(reject);
                }
            });
        }

        if (columnsToAdd.length === 0) {
            resolve();
        }
    });
}

async function createQRHistoryTable(dbRef: any): Promise<void> {
    return new Promise((resolve, reject) => {
        dbRef.serialize(() => {
            dbRef.run(`
                CREATE TABLE IF NOT EXISTS whatsapp_qr_history (
                    id TEXT PRIMARY KEY,
                    school_id TEXT NOT NULL,
                    qr_generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    connection_status TEXT DEFAULT 'pending',
                    qr_data TEXT,
                    FOREIGN KEY (school_id) REFERENCES schools(id))
            `, (err: Error | null) => {
                if (err) {
                    logger.warn({ error: err }, 'Could not create QR history table');
                }
            });

            dbRef.run(`CREATE INDEX IF NOT EXISTS idx_schools_connection_status ON schools(whatsapp_connection_status)`, () => {});
            dbRef.run(`CREATE INDEX IF NOT EXISTS idx_schools_admin_phone ON schools(admin_phone)`, () => {});
            dbRef.run(`CREATE INDEX IF NOT EXISTS idx_qr_history_school ON whatsapp_qr_history(school_id, qr_generated_at DESC)`, () => {});

            resolve();
        });
    });
}

main();
