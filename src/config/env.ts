import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ override: true });

export const ENV = {
    // System
    DB_PATH: process.env.DB_PATH || path.join(process.cwd(), 'kumo.db'),
    DB_TYPE: process.env.DB_TYPE || 'sqlite', // 'sqlite' or 'postgres'
    DATABASE_URL: process.env.DATABASE_URL || '',
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
    SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET || 'kumo-uploads',
    WHATSAPP_NAME: process.env.WHATSAPP_NAME || 'KUMO_SCHOOL_SYSTEM',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',

    // --- GLOBAL MODEL IDS ---
    GROQ_MODEL: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    GEMINI_MODEL: 'gemini-2.5-flash',
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-pro-exp-02-05:free',
    
    GEMINI_MODEL_VISION: 'gemini-2.5-flash',
    GEMINI_MODEL_EMBEDDING: process.env.GEMINI_MODEL_EMBEDDING || 'text-embedding-004',
    GROQ_MODEL_AUDIO: process.env.GROQ_MODEL_AUDIO || 'whisper-large-v3',

    // --- VISION API KEYS (with fallback support) ---
    GEMINI_VISION_API_KEY: process.env.GEMINI_VISION_API_KEY || process.env.SA_GEMINI_API_KEY || '',
    GEMINI_VISION_API_KEY_2: process.env.GEMINI_VISION_API_KEY_2 || '',
    GEMINI_VISION_API_KEY_3: process.env.GEMINI_VISION_API_KEY_3 || '',

    // --- PA AGENT KEYS ---
    PA_GROQ_API_KEY: process.env.PA_GROQ_API_KEY || '',
    PA_GEMINI_API_KEY: process.env.PA_GEMINI_API_KEY || '',
    PA_OPENROUTER_API_KEY: process.env.PA_OPENROUTER_API_KEY || '',

    // --- TA AGENT KEYS ---
    TA_GROQ_API_KEY: process.env.TA_GROQ_API_KEY || '',
    TA_GEMINI_API_KEY: process.env.TA_GEMINI_API_KEY || '',
    TA_OPENROUTER_API_KEY: process.env.TA_OPENROUTER_API_KEY || '',

    // --- PRIMARY_TA AGENT KEYS ---
    PRIMARY_TA_GROQ_API_KEY: process.env.PRIMARY_TA_GROQ_API_KEY || process.env.TA_GROQ_API_KEY || '',
    PRIMARY_TA_GEMINI_API_KEY: process.env.PRIMARY_TA_GEMINI_API_KEY || process.env.TA_GEMINI_API_KEY || '',
    PRIMARY_TA_OPENROUTER_API_KEY: process.env.PRIMARY_TA_OPENROUTER_API_KEY || process.env.TA_OPENROUTER_API_KEY || '',

    // --- SA AGENT KEYS ---
    SA_GROQ_API_KEY: process.env.SA_GROQ_API_KEY || '',
    SA_GEMINI_API_KEY: process.env.SA_GEMINI_API_KEY || '',
    SA_OPENROUTER_API_KEY: process.env.SA_OPENROUTER_API_KEY || '',

    // --- GA AGENT KEYS ---
    GA_GROQ_API_KEY: process.env.GA_GROQ_API_KEY || '',
    GA_GEMINI_API_KEY: process.env.GA_GEMINI_API_KEY || '',
    GA_OPENROUTER_API_KEY: process.env.GA_OPENROUTER_API_KEY || '',

    // --- GROQ RETRY KEYS (For Rate Limit Mitigation) ---
    GROQ_RETRY_KEY_1: process.env.GROQ_RETRY_KEY_1 || '',
    GROQ_RETRY_KEY_2: process.env.GROQ_RETRY_KEY_2 || '',
    GROQ_RETRY_KEY_3: process.env.GROQ_RETRY_KEY_3 || '',
    GROQ_RETRY_KEY_4: process.env.GROQ_RETRY_KEY_4 || '',
    GROQ_RETRY_KEY_5: process.env.GROQ_RETRY_KEY_5 || '',

    // --- ELEVENLABS CONVERSATIONAL AI ---
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
        ELEVENLABS_AGENT_ID_PA: process.env.ELEVENLABS_AGENT_ID_PA || '',
        ELEVENLABS_AGENT_ID_ORDER: process.env.ELEVENLABS_AGENT_ID_ORDER || '',
        ELEVENLABS_WEBHOOK_SECRET: process.env.ELEVENLABS_WEBHOOK_SECRET || '',
    };
    