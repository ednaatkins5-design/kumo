/**
 * Multi-Socket WhatsApp Transport Manager
 * Handles multiple independent WhatsApp connections (one per school)
 */

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    WASocket,
    AnyMessageContent,
    downloadMediaMessage,
    proto,
    Browsers
} from 'baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { AgentDispatcher } from '../dispatcher';
import { MessageRouter } from '../router';
import { IncomingMessage, MessageType } from '../types';
import { writeFile } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { messenger, OutboundMessage } from '../../services/messenger';
import { whatsappSessionService } from '../../services/whatsapp-session';
import EventEmitter from 'events';

export interface QRCodeData {
    schoolId: string;
    qr: string;
    attempt: number;
    timestamp: number;
}

export interface ConnectionState {
    schoolId: string;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    botJid?: string;
    lastError?: string;
    connectedAt?: Date;
}

export class WhatsAppTransportManager extends EventEmitter {
    private static instance: WhatsAppTransportManager;
    private sockets: Map<string, WASocket> = new Map();
    
    // PER-SCHOOL DATA SILOS
    private perSchoolData: Map<string, {
        lidMap: Map<string, string>;
        processedMessages: Set<string>;
    }> = new Map();

    private qrAttempts: Map<string, number> = new Map();
    private pairingCodeAttempts: Map<string, number> = new Map();
    private qrEmitters: Map<string, EventEmitter> = new Map();
    private connectionStates: Map<string, ConnectionState> = new Map();
    
    // Store connection preferences for reconnect
    private connectionPreferences: Map<string, { mode: 'qr' | 'pairing' | 'reconnect'; phoneNumber?: string }> = new Map();
    
    // Cache pairing codes so they don't change on reconnect
    private pairingCodeCache: Map<string, { code: string; timestamp: number; phoneNumber: string }> = new Map();
    
    // Pairing code expiration: 2 minutes (120 seconds) to match WhatsApp's timeout
    private static readonly PAIRING_CODE_VALIDITY_MS = 2 * 60 * 1000; // 2 minutes
    
    // Lock to prevent race conditions during pairing code operations
    private pairingCodeLocks: Map<string, boolean> = new Map();
    
    // Expiration timers for pairing codes
    private pairingCodeExpirationTimers: Map<string, NodeJS.Timeout> = new Map();
    
    // Track if we're in the process of requesting a pairing code (to prevent socket deletion)
    private pairingCodeRequestInProgress: Map<string, boolean> = new Map();

    private constructor() {
        super();
        this.cleanupDeduplicationCache();
        
        messenger.registerHandler(async (msg: OutboundMessage) => {
            // 🛡️ MULTI-TENANCY ENFORCEMENT: schoolId is now mandatory
            const targetSchoolId = msg.schoolId;
            
            if (!targetSchoolId) {
                logger.error({ to: msg.to }, '❌ [TRANSPORT] CRITICAL: Outbound message missing schoolId. FAILING LOUDLY.');
                throw new Error(`Multi-tenancy violation: schoolId is mandatory for outbound messages to ${msg.to}`);
            }
            
            const sock = this.sockets.get(targetSchoolId);
            if (!sock) {
                logger.warn({ schoolId: targetSchoolId, to: msg.to }, '⚠️ [TRANSPORT] Socket not connected for this school');
                return;
            }

            try {
                const targetJid = msg.to.includes('@') ? msg.to : msg.to + '@s.whatsapp.net';
                await sock.sendPresenceUpdate('composing', targetJid);

                if (msg.type === 'text') {
                    await sock.sendMessage(targetJid, { text: msg.body });
                } else if (msg.type === 'document' && msg.documentPath) {
                    await sock.sendMessage(targetJid, {
                        document: { url: msg.documentPath },
                        mimetype: 'application/pdf',
                        fileName: path.basename(msg.documentPath),
                        caption: msg.documentCaption
                    });
                } else if (msg.type === 'image' && msg.imagePath) {
                    await sock.sendMessage(targetJid, {
                        image: { url: msg.imagePath },
                        caption: msg.imageCaption
                    });
                }

                logger.info({ schoolId: targetSchoolId, to: targetJid, type: msg.type }, '📤 [TRANSPORT] Outbound message delivered');
            } catch (err) {
                logger.error({ err, schoolId: targetSchoolId, to: msg.to }, '❌ [TRANSPORT] Failed to send outbound message');
            }
        });
    }

    private getSchoolData(schoolId: string) {
        if (!this.perSchoolData.has(schoolId)) {
            this.perSchoolData.set(schoolId, {
                lidMap: new Map(),
                processedMessages: new Set()
            });
        }
        return this.perSchoolData.get(schoolId)!;
    }

    public static getInstance(): WhatsAppTransportManager {
        if (!WhatsAppTransportManager.instance) {
            WhatsAppTransportManager.instance = new WhatsAppTransportManager();
        }
        return WhatsAppTransportManager.instance;
    }

    private cleanupDeduplicationCache(): void {
        setInterval(() => {
            for (const [schoolId, data] of this.perSchoolData.entries()) {
                if (data.processedMessages.size > 5000) {
                    data.processedMessages.clear();
                    logger.debug({ schoolId }, '🧹 Cleared message deduplication cache for school');
                }
            }
        }, 30 * 60 * 1000);
    }

    /**
     * Get or create QR event emitter for a school
     */
    public getQREmitter(schoolId: string): EventEmitter {
        if (!this.qrEmitters.has(schoolId)) {
            this.qrEmitters.set(schoolId, new EventEmitter());
        }
        return this.qrEmitters.get(schoolId)!;
    }

    /**
     * Emit QR code to frontend subscribers
     */
    private emitQR(schoolId: string, qr: string, attempt: number): void {
        const emitter = this.getQREmitter(schoolId);
        emitter.emit('qr', { schoolId, qr, attempt, timestamp: Date.now() } as QRCodeData);
        logger.info({ schoolId, attempt }, '📱 QR code emitted to subscribers');
    }

    /**
     * Get connection state for a school
     */
    public getConnectionState(schoolId: string): ConnectionState {
        if (!this.connectionStates.has(schoolId)) {
            this.connectionStates.set(schoolId, {
                schoolId,
                status: 'disconnected'
            });
        }
        return this.connectionStates.get(schoolId)!;
    }

    /**
     * Update connection state in database and memory
     */
    private async updateConnectionState(
        schoolId: string,
        status: ConnectionState['status'],
        botJid?: string,
        error?: string
    ): Promise<void> {
        const state = this.getConnectionState(schoolId);
        state.status = status;
        if (botJid) state.botJid = botJid;
        if (error) state.lastError = error;
        if (status === 'connected') state.connectedAt = new Date();

        // Update database
        const updates: string[] = ['whatsapp_connection_status = ?'];
        const params: any[] = [status];

        if (botJid) {
            updates.push('connected_whatsapp_jid = ?');
            params.push(botJid);
        }
        if (status === 'connected') {
            updates.push('last_connection_at = CURRENT_TIMESTAMP');
        }
        // NOTE: last_error column doesn't exist in DB - commenting out to avoid errors
        // if (error) {
        //     updates.push('last_error = ?');
        //     params.push(error);
        // }

        params.push(schoolId);

        return new Promise((resolve) => {
            db.getDB().run(
                `UPDATE schools SET ${updates.join(', ')} WHERE id = ?`,
                params,
                (err) => {
                    if (err) {
                        logger.error({ err, schoolId }, 'Failed to update connection state');
                    }
                    resolve();
                }
            );
        });
    }

    /**
     * Get session directory for a school
     */
    private getSessionDir(schoolId: string): string {
        const authBaseDir = path.resolve('kumo_auth_info');
        if (!fs.existsSync(authBaseDir)) {
            fs.mkdirSync(authBaseDir, { recursive: true });
        }
        const sessionDir = path.join(authBaseDir, schoolId);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        return sessionDir;
    }

    /**
     * Get auth state from database for persistence across restarts
     */
    private async getDbAuthState(schoolId: string): Promise<{ state: any; saveCreds: () => Promise<void> }> {
        // Try to load session from database
        const sessionData = await whatsappSessionService.loadSession(schoolId);
        
        let creds = null;
        let keys = {};
        
        if (sessionData && sessionData.creds) {
            creds = sessionData.creds;
            keys = sessionData.keys || {};
            console.log(`[WhatsApp] 📂 Loaded session from database for school ${schoolId}`);
        } else {
            console.log(`[WhatsApp] 📂 No existing session in database for school ${schoolId}, starting fresh`);
        }
        
        // Create a simple in-memory key store that saves to database
        const keyStore = {
            get: async (type: string, ids: string[]) => {
                const keyMap: any = {};
                for (const id of ids) {
                    if (keys[type] && keys[type][id]) {
                        keyMap[id] = keys[type][id];
                    }
                }
                return keyMap;
            },
            set: async (type: string, map: any) => {
                keys[type] = { ...(keys[type] || {}), ...map };
                await this.saveAuthState(schoolId, creds, keys);
            },
            clear: async () => {
                keys = {};
            }
        };
        
        return {
            state: {
                creds: creds || {},
                keys: keyStore
            },
            saveCreds: async () => {
                await this.saveAuthState(schoolId, creds, keys);
            }
        };
    }

    /**
     * Save auth state to database
     */
    private async saveAuthState(schoolId: string, creds: any, keys: any): Promise<void> {
        try {
            await whatsappSessionService.saveSession(schoolId, { creds, keys, savedAt: new Date().toISOString() });
        } catch (err) {
            logger.error({ err, schoolId }, 'Failed to save auth state to database');
        }
    }

    /**
     * Check if QR refresh limit reached
     */
    private async checkQRRefreshLimit(schoolId: string): Promise<{ allowed: boolean; attempts: number; lockedUntil?: Date }> {
        return new Promise((resolve) => {
            db.getDB().get(
                `SELECT qr_refresh_count, qr_refresh_locked_until FROM schools WHERE id = ?`,
                [schoolId],
                (err, row: any) => {
                    if (err || !row) {
                        resolve({ allowed: true, attempts: 0 });
                        return;
                    }

                    // Handle both string and numeric (epoch seconds) formats
                    let lockedUntil: Date | undefined;
                    if (row.qr_refresh_locked_until) {
                        if (typeof row.qr_refresh_locked_until === 'number') {
                            // It's epoch seconds - convert to Date
                            lockedUntil = new Date(row.qr_refresh_locked_until * 1000);
                        } else {
                            lockedUntil = new Date(row.qr_refresh_locked_until);
                        }
                    }

                    if (lockedUntil && lockedUntil > new Date()) {
                        resolve({
                            allowed: false,
                            attempts: row.qr_refresh_count,
                            lockedUntil
                        });
                    } else {
                        resolve({ allowed: true, attempts: row.qr_refresh_count || 0 });
                    }
                }
            );
        });
    }

    /**
     * Increment QR refresh count
     */
    private async incrementQRCount(schoolId: string): Promise<void> {
        return new Promise((resolve) => {
            db.getDB().run(
                `UPDATE schools SET qr_refresh_count = qr_refresh_count + 1 WHERE id = ?`,
                [schoolId],
                (err) => {
                    if (err) {
                        logger.error({ err, schoolId }, 'Failed to increment QR count');
                    }
                    resolve();
                }
            );
        });
    }

    /**
     * Reset QR refresh count (on successful connection or manual reconnect)
     */
    public async resetQRCount(schoolId: string): Promise<void> {
        return new Promise((resolve) => {
            db.getDB().run(
                `UPDATE schools SET qr_refresh_count = 0, qr_refresh_locked_until = NULL WHERE id = ?`,
                [schoolId],
                (err) => {
                    if (err) {
                        logger.error({ err, schoolId }, 'Failed to reset QR count');
                    }
                    this.qrAttempts.set(schoolId, 0);
                    logger.info({ schoolId }, 'QR count reset');
                    resolve();
                }
            );
        });
    }

    /**
     * Save the WhatsApp phone number to school settings
     */
    public async saveWhatsAppNumber(schoolId: string, phoneNumber: string): Promise<void> {
        return new Promise((resolve) => {
            db.getDB().run(
                `UPDATE schools SET whatsapp_number = ? WHERE id = ?`,
                [phoneNumber, schoolId],
                (err) => {
                    if (err) {
                        logger.error({ err, schoolId, phoneNumber }, 'Failed to save WhatsApp number');
                    } else {
                        logger.info({ schoolId, phoneNumber }, 'WhatsApp number saved to school settings');
                    }
                    resolve();
                }
            );
        });
    }

    /**
     * Lock QR generation after max attempts reached
     */
    private async lockQR(schoolId: string): Promise<void> {
        const lockDuration = 5 * 60 * 1000; // 5 minutes
        const lockedUntil = Math.floor((Date.now() + lockDuration) / 1000); // Epoch seconds for PostgreSQL

        return new Promise((resolve) => {
            db.getDB().run(
                `UPDATE schools SET qr_refresh_locked_until = ? WHERE id = ?`,
                [lockedUntil, schoolId],
                (err) => {
                    if (err) {
                        logger.error({ err, schoolId }, 'Failed to lock QR');
                    }
                    logger.warn({ schoolId, lockedUntil }, 'QR generation locked');
                    resolve();
                }
            );
        });
    }

    /**
     * Check if session is valid (user has completed pairing)
     * Priority: 1) Database (persistent), 2) Filesystem (temporary)
     */
    private async isSessionValid(schoolId: string): Promise<boolean> {
        // FIRST: Check database for persistent session
        try {
            const dbSession = await whatsappSessionService.loadSession(schoolId);
            if (dbSession && dbSession.creds && dbSession.creds.registered === true) {
                console.log(`[WhatsApp] 📂 Found valid session in database for ${schoolId}`);
                
                // Restore session to filesystem for Baileys
                const sessionDir = this.getSessionDir(schoolId);
                const credsPath = path.join(sessionDir, 'creds.json');
                
                // Ensure directory exists
                if (!fs.existsSync(sessionDir)) {
                    fs.mkdirSync(sessionDir, { recursive: true });
                }
                
                // Write creds to filesystem
                fs.writeFileSync(credsPath, JSON.stringify(dbSession.creds));
                
                // Also write keys if they exist
                if (dbSession.keys) {
                    const keysPath = path.join(sessionDir, 'keys');
                    if (!fs.existsSync(keysPath)) {
                        fs.mkdirSync(keysPath, { recursive: true });
                    }
                    for (const [keyId, keyData] of Object.entries(dbSession.keys)) {
                        fs.writeFileSync(path.join(keysPath, `${keyId}.json`), JSON.stringify(keyData));
                    }
                }
                
                console.log(`[WhatsApp] ✅ Session restored from database to filesystem`);
                return true;
            }
        } catch (err) {
            console.log(`[WhatsApp] ⚠️ Database session check failed:`, err);
        }
        
        // SECOND: Fallback to filesystem check
        const sessionDir = this.getSessionDir(schoolId);
        const credsPath = path.join(sessionDir, 'creds.json');
        
        if (!fs.existsSync(credsPath)) {
            return false;
        }
        
        try {
            const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
            // Session is valid only if user has completed pairing (registered: true)
            return creds.registered === true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Start WhatsApp connection for a specific school
     */
    public async connect(schoolId: string, phoneNumber?: string): Promise<void> {
        console.log(`\n[WhatsApp] 🔌 connect() for school: ${schoolId}, phone: ${phoneNumber || 'none'}`);
        
        let sessionDir = this.getSessionDir(schoolId);
        let isValidSession = await this.isSessionValid(schoolId);
        
        // 🔄 LEGACY SESSION RECOVERY: Check for 'primary_session' if schoolId session is empty
        if (!isValidSession) {
            const authBaseDir = path.resolve('kumo_auth_info');
            const primaryDir = path.join(authBaseDir, 'primary_session');
            
            if (fs.existsSync(primaryDir) && fs.existsSync(path.join(primaryDir, 'creds.json'))) {
                console.log(`[WhatsApp] 🔄 Legacy 'primary_session' found. Migrating to ${schoolId}...`);
                try {
                    const files = fs.readdirSync(primaryDir);
                    for (const file of files) {
                        fs.copyFileSync(path.join(primaryDir, file), path.join(sessionDir, file));
                    }
                    isValidSession = await this.isSessionValid(schoolId);
                    if (isValidSession) {
                        console.log(`[WhatsApp] ✅ Legacy session migrated successfully.`);
                    }
                } catch (migrationErr) {
                    console.error(`[WhatsApp] ❌ Legacy migration failed:`, migrationErr);
                }
            }
        }

        console.log(`[WhatsApp] 📁 Session valid: ${isValidSession}`);
        
        // Check if already connected
        const existingSocket = this.sockets.get(schoolId);
        if (existingSocket) {
            const state = this.connectionStates.get(schoolId);
            if (state?.status === 'connected') {
                console.log(`[WhatsApp] ✅ Already connected`);
                return;
            }
            // Clean up old socket
            this.sockets.delete(schoolId);
        }
        
        // Get school info
        const school: any = await new Promise((resolve) => {
            db.getDB().get(
                `SELECT id, name, admin_phone FROM schools WHERE id = ?`,
                [schoolId],
                (err, row) => resolve(row)
            );
        });
        
        if (!school) {
            throw new Error('School not found');
        }
        
        // Update state to connecting
        await this.updateConnectionState(schoolId, 'connecting');
        
        // Determine connection mode
        if (isValidSession) {
            // RESTORE: Valid session exists - just restore connection (like backup!)
            console.log(`[WhatsApp] 🔄 Restoring existing session...`);
            await this.createSocket(schoolId, school, sessionDir, null);
        } else if (phoneNumber) {
            // PAIRING: Fresh pairing with phone number
            console.log(`[WhatsApp] 🔐 Starting fresh pairing...`);
            // Clear any old session files
            await this.clearSessionDir(schoolId);
            await this.createSocket(schoolId, school, sessionDir, phoneNumber);
        } else {
            // QR: Fresh QR mode
            console.log(`[WhatsApp] 📱 Starting QR mode...`);
            await this.clearSessionDir(schoolId);
            await this.createSocket(schoolId, school, sessionDir, null);
        }
    }

    /**
     * Create WhatsApp socket with the given session
     * Uses hybrid approach: file-based + database backup
     */
    private async createSocket(schoolId: string, school: any, sessionDir: string, phoneNumber: string | null): Promise<void> {
        // First try to use file-based auth (current working method)
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        // Also try to backup/restore from database
        try {
            const dbSession = await whatsappSessionService.loadSession(schoolId);
            if (dbSession && dbSession.creds && !state.creds?.registered) {
                // DB has session but file doesn't - restore from DB
                console.log(`[WhatsApp] 🔄 Restoring session from database backup...`);
                // Write DB creds to files
                const credsPath = path.join(sessionDir, 'creds.json');
                fs.writeFileSync(credsPath, JSON.stringify(dbSession.creds));
                // Reload state
                const { state: restoredState } = await useMultiFileAuthState(sessionDir);
                Object.assign(state.creds, restoredState.creds);
            }
        } catch (e) {
            console.log(`[WhatsApp] ⚠️ DB restore skipped:`, e);
        }
        
        // Wrap saveCreds to also backup to database  
        const originalSaveCreds = saveCreds;
        let cachedKeys: any = {};
        
        // Track keys changes - wrap the original methods
        const originalKeysGet = state.keys.get.bind(state.keys);
        const originalKeysSet = state.keys.set.bind(state.keys);
        
        state.keys.get = async (type: string, ids: string[]) => {
            const keyMap: any = {};
            for (const id of ids) {
                if (cachedKeys[type] && cachedKeys[type][id]) {
                    keyMap[id] = cachedKeys[type][id];
                }
            }
            return keyMap;
        };
        state.keys.set = async (data: any) => {
            // Merge into cachedKeys
            for (const [type, map] of Object.entries(data)) {
                cachedKeys[type] = { ...(cachedKeys[type] || {}), ...(map as any) };
            }
            return originalKeysSet(data);
        };
        
        const wrappedSaveCreds = async () => {
            await originalSaveCreds();
            // Backup to database with full state (creds + keys)
            try {
                await whatsappSessionService.saveSession(schoolId, { 
                    creds: state.creds, 
                    keys: cachedKeys,
                    savedAt: new Date().toISOString() 
                });
            } catch (e) {
                console.log(`[WhatsApp] ⚠️ DB backup failed:`, e);
            }
        };
        
        const { version, isLatest } = await fetchLatestBaileysVersion();
        
        console.log(`[WhatsApp] 📦 Baileys version: ${version.join('.')}, isLatest: ${isLatest}`);
        
        // Browser config - required for pairing to work
        const browserConfig: [string, string, string] = ['Ubuntu', 'Chrome', '110.0.5563.147'];
        
        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }) as any,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }) as any),
            },
            generateHighQualityLinkPreview: true,
            keepAliveIntervalMs: 30000,
            browser: browserConfig,
            printQRInTerminal: !phoneNumber,
        });
        
        this.sockets.set(schoolId, sock);
        
        const isPairingMode = !!phoneNumber;
        
        // Track if we've requested pairing code (to avoid requesting multiple times)
        let pairingCodeRequested = false;
        
        // Connection update handler
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Handle QR code
            if (qr) {
                if (isPairingMode) {
                    // In pairing mode - just log, don't emit QR
                    console.log(`[WhatsApp] 📱 QR received in pairing mode (expected)`);
                } else {
                    // QR mode - emit to frontend
                    const attempt = (this.qrAttempts.get(schoolId) || 0) + 1;
                    this.qrAttempts.set(schoolId, attempt);
                    await this.incrementQRCount(schoolId);
                    await this.trackQRHistory(schoolId, qr, attempt);
                    this.emitQR(schoolId, qr, attempt);
                    console.log(`[WhatsApp] 📱 QR code emitted (attempt ${attempt})`);
                    
                    if (attempt >= 10) {
                        await this.lockQR(schoolId);
                        this.getQREmitter(schoolId).emit('locked', {
                            schoolId,
                            lockedUntil: new Date(Date.now() + 5 * 60 * 1000)
                        });
                    }
                }
            }
            
            // Handle connection open
            if (connection === 'open') {
                console.log(`[WhatsApp] ✅ Connection opened for ${schoolId}`);
                
                const botJid = sock.user?.id;
                await this.updateConnectionState(schoolId, 'connected', botJid);
                
                // Save to DB
                const botPhone = botJid?.split('@')[0];
                if (botPhone) {
                    await this.saveWhatsAppNumber(schoolId, botPhone);
                }
                
                // Emit connected event
                this.getQREmitter(schoolId).emit('connected', { 
                    schoolId, 
                    botJid: botJid?.split(':')[0] || botJid 
                });
                
                // Send welcome message
                if (school.admin_phone) {
                    this.sendAdminWelcomeMessage(schoolId, school.admin_phone).catch(err => {
                        logger.error({ err, schoolId }, 'Failed to send admin welcome message');
                    });
                }
            }
            
            // Handle connection close
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const errorMsg = lastDisconnect?.error?.message || 'Unknown';
                
                console.log(`[WhatsApp] 🚪 Connection closed: status=${statusCode}, error=${errorMsg}`);
                
                // TODO: Handle session conflict (440) - temporarily disabled for testing
                // if (statusCode === 440 || errorMsg.includes('Stream Errored')) {
                //     console.log(`[WhatsApp] 🔄 Session conflict detected - clearing session and will reconnect...`);
                //     this.sockets.delete(schoolId);
                //     await this.clearSessionDir(schoolId);
                //     try {
                //         await whatsappSessionService.deleteSession(schoolId);
                //     } catch (e) { }
                //     await this.updateConnectionState(schoolId, 'disconnected');
                //     setTimeout(() => {
                //         this.connect(schoolId).catch(err => {
                //             console.log(`[WhatsApp] ❌ Reconnect error: ${err.message}`);
                //         });
                //     }, 5000);
                //     return;
                // }
                
                // 🔄 SIMPLE RECONNECT: Just try to reconnect for ANY close except explicit logout
                // Let Baileys handle session management - don't clear anything
                const stopReconnecting = statusCode === DisconnectReason.loggedOut;
                
                if (!stopReconnecting) {
                    console.log(`[WhatsApp] 🔄 Connection lost - will reconnect automatically...`);
                    this.sockets.delete(schoolId);
                    await this.updateConnectionState(schoolId, 'connecting');
                    
                    // Simple reconnect with delay - let Baileys handle session files
                    setTimeout(() => {
                        console.log(`[WhatsApp] 🔄 Reconnecting now...`);
                        this.connect(schoolId).catch(err => {
                            console.log(`[WhatsApp] ❌ Reconnect error: ${err.message}`);
                            // Don't clear session - let user manually reconnect if needed
                        });
                    }, 5000);
                } else {
                    console.log(`[WhatsApp] 🔒 User logged out - stopped reconnecting`);
                    this.sockets.delete(schoolId);
                    await this.updateConnectionState(schoolId, 'disconnected');
                }
            }
        });
        
        // Credentials update - also track registration
        sock.ev.on('creds.update', async (creds) => {
            console.log(`[WhatsApp] 📝 Creds updated: registered=${creds?.registered}, me=${JSON.stringify(creds?.me)}`);
            
            // If device just got registered, trigger connection open
            if (creds?.registered && !sock.authState.creds.registered) {
                console.log(`[WhatsApp] ✅ Device registered! Triggering connection open...`);
                await this.updateConnectionState(schoolId, 'connected', sock.user?.id);
                
                const botJid = sock.user?.id;
                const botPhone = botJid?.split('@')[0];
                if (botPhone) {
                    await this.saveWhatsAppNumber(schoolId, botPhone);
                }
                
                this.getQREmitter(schoolId).emit('connected', { 
                    schoolId, 
                    botJid: botJid?.split(':')[0] || botJid 
                });
                
                // Send welcome message
                if (school.admin_phone) {
                    this.sendAdminWelcomeMessage(schoolId, school.admin_phone).catch(err => {
                        logger.error({ err, schoolId }, 'Failed to send admin welcome message');
                    });
                }
            }
            
            await saveCreds();
        });
        
        // LID resolution from contacts - also listen to history to build map early
        sock.ev.on('messaging-history.set', ({ contacts }) => {
            const data = this.getSchoolData(schoolId);
            for (const contact of contacts) {
                if (contact.id.endsWith('@lid') && (contact as any).phoneNumber) {
                    const lid = contact.id.split('@')[0];
                    const phone = (contact as any).phoneNumber;
                    data.lidMap.set(lid, phone);
                }
            }
        });
        
        sock.ev.on('contacts.upsert', (contacts) => {
            const data = this.getSchoolData(schoolId);
            for (const contact of contacts) {
                if (contact.id.endsWith('@lid') && (contact as any).phoneNumber) {
                    const lid = contact.id.split('@')[0];
                    const phone = (contact as any).phoneNumber;
                    data.lidMap.set(lid, phone);
                }
            }
        });
        
        // If pairing mode, request code after first QR
        if (isPairingMode && phoneNumber) {
            // Wait for socket to be ready
            setTimeout(async () => {
                try {
                    const formattedPhone = phoneNumber.replace(/\D/g, '');
                    console.log(`[WhatsApp] 🔐 Requesting pairing code for ${formattedPhone}...`);
                    
                    const code = await sock.requestPairingCode(formattedPhone);
                    console.log(`[WhatsApp] 🔐 Pairing code: ${code}`);
                    
                    this.getQREmitter(schoolId).emit('pairing-code', { 
                        schoolId, 
                        code: code,
                        phoneNumber: formattedPhone 
                    });
                } catch (error: any) {
                    console.log(`[WhatsApp] ❌ Pairing code error: ${error.message}`);
                    this.getQREmitter(schoolId).emit('pairing-error', { 
                        schoolId, 
                        error: error.message 
                    });
                }
            }, 2000);
        }
        
        // Group participants handler
        sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
            if (action === 'add' && sock) {
                const schoolRecord: any = await new Promise((resolve) => {
                    db.getDB().get(
                        `SELECT id, name FROM schools WHERE whatsapp_group_jid = ? OR whatsapp_group_jid = ?`,
                        [id, id.split('@')[0]],
                        (err, row) => resolve(row)
                    );
                });
                
                if (schoolRecord) {
                    for (const p of participants) {
                        const participantJid = typeof p === 'string' ? p : (p as any).id;
                        await this.handleNewGroupMember(schoolRecord.id, id, participantJid, sock);
                    }
                }
            }
        });
        
        // Message handler
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            
            const data = this.getSchoolData(schoolId);
            for (const msg of m.messages) {
                if (!msg.message || msg.key.fromMe) continue;
                
                const msgId = msg.key.id;
                if (msgId && data.processedMessages.has(msgId)) continue;
                if (msgId) data.processedMessages.add(msgId);
                
                try {
                    await this.handleIncomingMessage(schoolId, msg, sock);
                } catch (err) {
                    logger.error({ err, schoolId, msgId }, 'Error handling message');
                }
            }
        });
    }

    /**
     * Track QR generation in history
     */
    private async trackQRHistory(schoolId: string, qr: string, attempt: number): Promise<void> {
        return new Promise((resolve) => {
            db.getDB().run(
                `INSERT INTO whatsapp_qr_history (id, school_id, qr_data, connection_status) VALUES (?, ?, ?, ?)`,
                [uuidv4(), schoolId, qr.substring(0, 100), 'pending'],
                (err) => {
                    if (err) logger.error({ err, schoolId }, 'Failed to track QR history');
                    resolve();
                }
            );
        });
    }

    /**
     * Resolve LID to phone number
     */
    private async resolveLid(schoolId: string, lidJid: string): Promise<string> {
        const lid = lidJid.split('@')[0];
        const data = this.getSchoolData(schoolId);

        if (data.lidMap.has(lid)) {
            return data.lidMap.get(lid)! + '@s.whatsapp.net';
        }

        // Try reading from session file
        try {
            const sessionDir = this.getSessionDir(schoolId);
            const reverseMappingPath = path.join(sessionDir, `lid-mapping-${lid}_reverse.json`);
            if (fs.existsSync(reverseMappingPath)) {
                const phone = JSON.parse(fs.readFileSync(reverseMappingPath, 'utf-8'));
                if (phone) {
                    data.lidMap.set(lid, phone);
                    return phone + '@s.whatsapp.net';
                }
            }
        } catch (e) {
            logger.debug({ lid, error: e }, 'Failed to read LID mapping');
        }

        return lidJid;
    }

    /**
     * Handle new member joining group
     */
    private async handleNewGroupMember(schoolId: string, groupId: string, participantJid: string, sock: WASocket): Promise<void> {
        let name = 'Parent';
        if (participantJid.endsWith('@lid')) {
            const resolved = await this.resolveLid(schoolId, participantJid);
            const phone = resolved.split('@')[0];
            const user: any = await new Promise((resolve) => {
                db.getDB().get(
                    `SELECT name FROM users WHERE phone = ? AND school_id = ?`,
                    [phone, schoolId],
                    (err, row) => resolve(row)
                );
            });
            if (user?.name) name = user.name;
        }

        const msgId = `join-${Date.now()}-${uuidv4().substring(0, 8)}`;
        const incomingMsg: IncomingMessage = {
            id: msgId,
            from: groupId,
            to: sock.user?.id?.split('@')[0].split(':')[0],
            type: 'text',
            body: '[SYSTEM_EVENT] NEW_MEMBER_JOINED',
            timestamp: Date.now(),
            source: 'system',
            isGroup: true,
            participant: participantJid
        };

        (incomingMsg as any).task_type = 'NEW_MEMBER';
        (incomingMsg as any).new_member_name = name;

        const routedMsg = await MessageRouter.route(incomingMsg);
        await sock.sendPresenceUpdate('composing', groupId);

        const dispatcher = new AgentDispatcher();
        const response = await dispatcher.dispatch(routedMsg);

        if (response.body) {
            await sock.sendMessage(groupId, { text: response.body });
        }
    }

    /**
     * Handle incoming message
     */
    private async handleIncomingMessage(schoolId: string, msg: any, sock: WASocket): Promise<void> {
        const messageType = Object.keys(msg.message)[0];
        if (messageType === 'protocolMessage' || messageType === 'senderKeyDistributionMessage') {
            return;
        }

        let from = msg.key.remoteJid!;
        let participant = msg.key.participant || from;

        // Resolve LID
        if (from.endsWith('@lid')) {
            from = await this.resolveLid(schoolId, from);
        }
        if (participant.endsWith('@lid')) {
            participant = await this.resolveLid(schoolId, participant);
        }

        let body = '';
        let type: MessageType = 'text';
        let mediaPath: string | undefined;

        if (messageType === 'conversation') {
            body = msg.message.conversation || '';
        } else if (messageType === 'extendedTextMessage') {
            body = msg.message.extendedTextMessage?.text || '';
        } else if (messageType === 'imageMessage') {
            type = 'image';
            body = msg.message.imageMessage?.caption || '';
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const fileName = `media_${Date.now()}_${uuidv4()}.jpg`;
                const storagePath = path.resolve('storage', 'uploads');
                if (!fs.existsSync(storagePath)) fs.mkdirSync(storagePath, { recursive: true });
                mediaPath = path.join(storagePath, fileName);
                await writeFile(mediaPath, buffer);
                logger.info({ msgId: msg.key.id, mediaPath }, 'Image downloaded');
            } catch (mediaErr) {
                logger.error({ mediaErr, msgId: msg.key.id }, 'Failed to download media');
            }
        }

        const msgId = msg.key.id || uuidv4();
        const botJid = sock.user?.id;
        const cleanTo = botJid ? botJid.split('@')[0].split(':')[0] : undefined;

        const incomingMsg: IncomingMessage = {
            id: msgId,
            from,
            to: cleanTo,
            type,
            body,
            mediaPath,
            timestamp: (msg.messageTimestamp as number) * 1000 || Date.now(),
            source: 'user',
            isGroup: from.endsWith('@g.us'),
            participant: participant,
            originalMessageKey: msg.key
        };

        const routedMsg = await MessageRouter.route(incomingMsg);

        // Auto-link group JID
        if (routedMsg.isGroup && routedMsg.schoolId && routedMsg.isAdminMessage) {
            await this.updateSchoolGroupJid(routedMsg.schoolId, from);
        }

        const shouldShowTyping = !(routedMsg.context === 'GA' && routedMsg.isAdminMessage);
        if (shouldShowTyping) {
            await sock.sendPresenceUpdate('composing', from);
        }

        const dispatcher = new AgentDispatcher();
        const response = await dispatcher.dispatch(routedMsg);

        // Handle GA silence rule
        if (routedMsg.context === 'GA' && routedMsg.isAdminMessage) {
            response.body = '';
            if (response.actions) {
                response.actions = response.actions.filter(a => a.type !== 'SEND_MESSAGE');
            }
        }

        if (response.body || response.mediaPath || response.actions) {
            let finalBody = response.body || '';

            // Fail-safe: extract reply_text from JSON
            if (finalBody.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(finalBody);
                    if (parsed.reply_text) {
                        finalBody = parsed.reply_text;
                    }
                } catch (e) {}
            }

            const payload: AnyMessageContent = { text: finalBody };

            if (response.mediaPath) {
                if (response.mediaPath.endsWith('.pdf')) {
                    (payload as any).document = { url: response.mediaPath };
                    (payload as any).mimetype = 'application/pdf';
                    (payload as any).fileName = path.basename(response.mediaPath);
                } else if (response.mediaPath.match(/\.(jpg|jpeg|png)$/i)) {
                    (payload as any).image = { url: response.mediaPath };
                }
            }

            await sock.sendMessage(msg.key.remoteJid!, payload, { quoted: msg });
        }

        if (shouldShowTyping) {
            await sock.sendPresenceUpdate('paused', from);
        }
    }

    /**
     * Update school with group JID
     */
    private async updateSchoolGroupJid(schoolId: string, groupJid: string): Promise<void> {
        return new Promise((resolve) => {
            db.getDB().run(
                `UPDATE schools SET whatsapp_group_jid = ? WHERE id = ? AND whatsapp_group_jid IS NULL`,
                [groupJid, schoolId],
                (err) => {
                    if (err) logger.error({ err, schoolId, groupJid }, 'Failed to auto-link group JID');
                    else logger.info({ schoolId, groupJid }, 'Group JID auto-linked');
                    resolve();
                }
            );
        });
    }

    /**
     * Send admin welcome message
     */
    private async sendAdminWelcomeMessage(schoolId: string, adminPhone: string): Promise<void> {
        try {
            // Check if already sent
            const alreadySent: any = await new Promise((resolve) => {
                db.getDB().get(
                    `SELECT COUNT(*) as count FROM messages WHERE school_id = ? AND action_performed = 'ADMIN_WELCOME_SENT' AND timestamp > ?`,
                    [schoolId, Date.now() - 24 * 60 * 60 * 1000],
                    (err, row) => resolve(row)
                );
            });

            if ((alreadySent?.count || 0) > 0) {
                logger.info({ schoolId }, 'Welcome already sent recently');
                return;
            }

            const welcomeMessage = `🎉 *Welcome to KUMO!*

Hi! I'm your School Admin Assistant.

*Quick question: What should I call you?*

Once I know your name, I'll guide you through setting up your school - it's quick and easy!`;

            const adminJid = adminPhone.includes('@') ? adminPhone : adminPhone + '@s.whatsapp.net';

            const sock = this.sockets.get(schoolId);
            if (sock) {
                await sock.sendMessage(adminJid, { text: welcomeMessage });

                // Record welcome sent
                await new Promise<void>((resolve) => {
                    db.getDB().run(
                        `INSERT INTO messages (id, school_id, from_phone, type, body, timestamp, action_performed, context) VALUES (?, ?, ?, 'text', ?, ?, 'ADMIN_WELCOME_SENT', 'SYSTEM')`,
                        [`welcome-${Date.now()}`, schoolId, adminPhone, welcomeMessage, Date.now()],
                        (err) => { if (err) logger.warn({ err }); resolve(); }
                    );
                });

                logger.info({ schoolId, adminPhone }, 'Admin welcome message sent');
            }
        } catch (error) {
            logger.error({ error, schoolId }, 'Failed to send admin welcome');
        }
    }

    /**
     * Disconnect a specific school (WITHOUT logging out)
     * Just closes the connection - session remains valid for reconnection
     */
    public async disconnect(schoolId: string): Promise<void> {
        const sock = this.sockets.get(schoolId);
        if (sock) {
            try {
                // ✅ FIX: Don't call logout() - that invalidates the session!
                // Just close the websocket connection
                if (sock.ws) {
                    sock.ws.close();
                }
                
                logger.info({ schoolId }, 'Connection closed (session preserved)');
            } catch (e) {
                logger.debug({ schoolId, error: e }, 'Error during disconnect');
            }
            this.sockets.delete(schoolId);
            await this.updateConnectionState(schoolId, 'disconnected');
            
            // Clear connection preferences and attempts
            this.connectionPreferences.delete(schoolId);
            this.pairingCodeAttempts.set(schoolId, 0);
            this.qrAttempts.set(schoolId, 0);
            
            logger.info({ schoolId }, 'Disconnected gracefully (session intact)');
        }
    }

    /**
     * Check if a school is connected
     */
    public isConnected(schoolId: string): boolean {
        const state = this.getConnectionState(schoolId);
        return state.status === 'connected';
    }

    /**
     * Get all active connections
     */
    public getActiveConnections(): string[] {
        return Array.from(this.sockets.keys());
    }

    /**
     * Get pairing code status for a school
     * Returns: { hasCode: boolean, code?: string, expired: boolean, expiresAt?: number, timeRemainingMs?: number }
     */
    public getPairingCodeStatus(schoolId: string): { 
        hasCode: boolean; 
        code?: string; 
        expired: boolean; 
        expiresAt?: number; 
        timeRemainingMs?: number;
        phoneNumber?: string;
    } {
        const cached = this.pairingCodeCache.get(schoolId);
        
        if (!cached) {
            return { hasCode: false, expired: true };
        }
        
        const now = Date.now();
        const expiresAt = cached.timestamp + WhatsAppTransportManager.PAIRING_CODE_VALIDITY_MS;
        const timeRemainingMs = expiresAt - now;
        const expired = timeRemainingMs <= 0;
        
        return {
            hasCode: true,
            code: cached.code,
            expired,
            expiresAt,
            timeRemainingMs: Math.max(0, timeRemainingMs),
            phoneNumber: cached.phoneNumber
        };
    }

    /**
     * Request pairing code from WhatsApp
     * This is the internal implementation that handles the actual request
     */
    private async requestPairingCodeInternal(schoolId: string, sock: any, formattedPhone: string): Promise<void> {
        try {
            // CRITICAL: Check if device is already registered
            if (sock.authState.creds.registered) {
                console.log(`[WhatsApp] ✅ Device already registered, skipping pairing code request`);
                return;
            }
            
            // Validate phone number format (E.164 without +)
            const phoneRegex = /^\d{10,15}$/;
            if (!phoneRegex.test(formattedPhone)) {
                console.log(`[WhatsApp] ❌ Invalid phone number format: ${formattedPhone}`);
                console.log(`[WhatsApp] 📱 Phone must be 10-15 digits, E.164 format without + sign`);
                return;
            }
            
            // DEBUG: Log FULL auth state before request
            console.log(`[WhatsApp] 📊 Auth State BEFORE request:`);
            console.log(`[WhatsApp]   - registered: ${sock.authState.creds.registered}`);
            console.log(`[WhatsApp]   - has pairingEphemeralKeyPair: ${!!sock.authState.creds.pairingEphemeralKeyPair}`);
            console.log(`[WhatsApp]   - has noiseKey: ${!!sock.authState.creds.noiseKey}`);
            console.log(`[WhatsApp]   - me: ${JSON.stringify(sock.authState.creds.me)}`);
            console.log(`[WhatsApp]   - pairingCode: ${sock.authState.creds.pairingCode || 'undefined'}`);
            console.log(`[WhatsApp]   - phone format: ${formattedPhone} (${formattedPhone.length} digits)`);
            
            console.log(`[WhatsApp] 🔐 Requesting pairing code for ${formattedPhone}...`);
            console.log(`[WhatsApp] 📱 Device not registered, proceeding with pairing code request`);
            
            // Mark that we're requesting a pairing code
            this.pairingCodeRequestInProgress.set(schoolId, true);
            
            const code = await sock.requestPairingCode(formattedPhone);
            
            // Mark request as complete
            this.pairingCodeRequestInProgress.set(schoolId, false);
            
            // DEBUG: Log auth state AFTER request
            console.log(`[WhatsApp] 📊 Auth State AFTER request:`);
            console.log(`[WhatsApp]   - registered: ${sock.authState.creds.registered}`);
            console.log(`[WhatsApp]   - me: ${JSON.stringify(sock.authState.creds.me)}`);
            console.log(`[WhatsApp]   - pairingCode: ${sock.authState.creds.pairingCode || 'undefined'}`);
            console.log(`[WhatsApp]   - returned code: ${code}`);
            
            console.log(`[WhatsApp] 🔐 Pairing code generated: ${code}`);
            const timestamp = Date.now();
            
            // Cache the code
            this.pairingCodeCache.set(schoolId, {
                code,
                timestamp,
                phoneNumber: formattedPhone
            });
            
            // Clear any existing expiration timer
            if (this.pairingCodeExpirationTimers.has(schoolId)) {
                clearTimeout(this.pairingCodeExpirationTimers.get(schoolId)!);
            }
            
            // Set up expiration timer (2 minutes)
            const expirationTimer = setTimeout(() => {
                console.log(`[WhatsApp] ⏰ Pairing code expired for ${schoolId}`);
                this.getQREmitter(schoolId).emit('pairing-code-expired', {
                    schoolId,
                    code,
                    phoneNumber: formattedPhone,
                    expiredAt: Date.now()
                });
                // Don't delete cache here - let user decide to get new code
            }, WhatsAppTransportManager.PAIRING_CODE_VALIDITY_MS);
            
            this.pairingCodeExpirationTimers.set(schoolId, expirationTimer);
            
            this.getQREmitter(schoolId).emit('pairing-code', { 
                schoolId, 
                code: code,
                phoneNumber: formattedPhone,
                expiresAt: timestamp + WhatsAppTransportManager.PAIRING_CODE_VALIDITY_MS
            });
        } catch (error: any) {
            // Mark request as failed
            this.pairingCodeRequestInProgress.set(schoolId, false);
            console.log(`[WhatsApp] ❌ Failed to generate pairing code: ${error.message}`);
            
            // Emit error for frontend
            this.getQREmitter(schoolId).emit('pairing-error', { 
                schoolId, 
                error: error.message 
            });
            
            throw error;
        }
    }

    /**
     * Clear session directory for a school
     */
    private async clearSessionDir(schoolId: string): Promise<void> {
        const sessionDir = this.getSessionDir(schoolId);
        if (fs.existsSync(sessionDir)) {
            try {
                const files = fs.readdirSync(sessionDir);
                for (const file of files) {
                    const filePath = path.join(sessionDir, file);
                    if (fs.lstatSync(filePath).isDirectory()) {
                        fs.rmSync(filePath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(filePath);
                    }
                }
                logger.info({ schoolId }, '🧹 Cleared session directory for fresh pairing');
            } catch (err) {
                logger.warn({ err, schoolId }, 'Failed to clear session directory');
            }
        }
    }

    /**
     * Request a new pairing code (invalidates old one)
     * This is called when user clicks "Get New Code" button
     * Returns: { success: boolean, code?: string, error?: string }
     */
    public async requestNewPairingCode(schoolId: string, phoneNumber: string): Promise<{
        success: boolean;
        code?: string;
        error?: string;
        expiresAt?: number;
    }> {
        // Check if operation is already in progress (prevent race conditions)
        if (this.pairingCodeLocks.get(schoolId)) {
            return { success: false, error: 'Pairing code request already in progress. Please wait.' };
        }
        
        // Acquire lock
        this.pairingCodeLocks.set(schoolId, true);
        
        try {
            // Clear old pairing code cache and timer
            this.pairingCodeCache.delete(schoolId);
            if (this.pairingCodeExpirationTimers.has(schoolId)) {
                clearTimeout(this.pairingCodeExpirationTimers.get(schoolId)!);
                this.pairingCodeExpirationTimers.delete(schoolId);
            }
            
            // Clear any existing connection preferences to force fresh connection
            this.connectionPreferences.delete(schoolId);
            
            // Disconnect existing connection if any
            await this.disconnect(schoolId);
            
            // CRITICAL: Clear session directory to ensure fresh keys for the new pairing code
            // Stale keys often cause WhatsApp to reject pairing codes
            await this.clearSessionDir(schoolId);
            
            // Wait for disconnect to complete
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Start fresh connection with new pairing code
            console.log(`[WhatsApp] 🆕 Generating new pairing code for ${schoolId}...`);
            
            // Create a promise that resolves when we get the pairing code
            const codePromise = new Promise<{
                success: boolean;
                code?: string;
                error?: string;
                expiresAt?: number;
            }>((resolve) => {
                const qrEmitter = this.getQREmitter(schoolId);
                
                const onPairingCode = (data: { schoolId: string; code: string; phoneNumber: string }) => {
                    if (data.schoolId === schoolId) {
                        qrEmitter.removeListener('pairing-code', onPairingCode);
                        qrEmitter.removeListener('pairing-error', onPairingError);
                        resolve({
                            success: true,
                            code: data.code,
                            expiresAt: Date.now() + WhatsAppTransportManager.PAIRING_CODE_VALIDITY_MS
                        });
                    }
                };
                
                const onPairingError = (data: { schoolId: string; error: string }) => {
                    if (data.schoolId === schoolId) {
                        qrEmitter.removeListener('pairing-code', onPairingCode);
                        qrEmitter.removeListener('pairing-error', onPairingError);
                        resolve({ success: false, error: data.error });
                    }
                };
                
                // Set timeout
                const timeout = setTimeout(() => {
                    qrEmitter.removeListener('pairing-code', onPairingCode);
                    qrEmitter.removeListener('pairing-error', onPairingError);
                    resolve({ success: false, error: 'Timeout waiting for pairing code' });
                }, 30000); // 30 second timeout
                
                qrEmitter.on('pairing-code', onPairingCode);
                qrEmitter.on('pairing-error', onPairingError);
                
                // Cleanup timeout if resolved early
                const cleanup = () => clearTimeout(timeout);
                qrEmitter.once('pairing-code', cleanup);
                qrEmitter.once('pairing-error', cleanup);
            });
            
            // Start connection
            this.connect(schoolId, phoneNumber).catch(err => {
                console.log(`[WhatsApp] ❌ Connection error: ${err.message}`);
            });
            
            // Wait for pairing code
            const result = await codePromise;
            return result;
            
        } catch (error: any) {
            console.log(`[WhatsApp] ❌ Failed to generate pairing code: ${error.message}`);
            return { success: false, error: error.message };
        } finally {
            // Release lock
            this.pairingCodeLocks.set(schoolId, false);
        }
    }

    /**
     * Clear pairing code cache (called when code is entered successfully or manually expired)
     */
    public clearPairingCode(schoolId: string): void {
        console.log(`[WhatsApp] 🧹 Manually clearing pairing code for ${schoolId}`);
        this.pairingCodeCache.delete(schoolId);
        this.pairingCodeLocks.set(schoolId, false);
        
        // Clear expiration timer
        if (this.pairingCodeExpirationTimers.has(schoolId)) {
            clearTimeout(this.pairingCodeExpirationTimers.get(schoolId)!);
            this.pairingCodeExpirationTimers.delete(schoolId);
        }
    }

    /**
     * Get pairing code validity duration in milliseconds
     */
    public static getPairingCodeValidityMs(): number {
        return WhatsAppTransportManager.PAIRING_CODE_VALIDITY_MS;
    }
}

export const whatsappManager = WhatsAppTransportManager.getInstance();
