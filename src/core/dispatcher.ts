import { ParentAgent } from '../agents/pa';
import { SchoolAdminAgent } from '../agents/sa';
import { TeacherAgent } from '../agents/ta';
import { PrimaryTeacherAgent } from '../agents/primary-ta';
import { SchoolGroupAgent } from '../agents/ga';
import { RoutedMessage, AgentResponse } from './types';
import { logger } from '../utils/logger';
import { PAOutput } from '../agents/pa/types/schema';
import { TAOutput } from '../agents/ta/types/schema';
import { SetupTAOutput } from '../agents/ta/types/setup_schema';
import { SAOutput } from '../agents/sa/types/schema';
import { GAOutput } from '../agents/ga/types/schema';
import { HistoryManager } from './memory/history-manager';
import { MemoryOrchestrator } from './memory/orchestrator';
import { visionService } from '../ai/vision';
import { VisionClassifier } from '../ai/vision-classifier'; // ✅ Two-pass strategy Pass 1
import { db } from '../db';
import { EscalationServiceV2 } from '../services/escalation-v2';
import { EscalationAuditService } from '../services/escalation-audit';
import { EscalationResumptionHandler } from './escalation/resumption-handler';

export class AgentDispatcher {
    private pa: ParentAgent;
    private sa: SchoolAdminAgent;
    private ta: TeacherAgent;
    private primaryTA: PrimaryTeacherAgent;
    private ga: SchoolGroupAgent;

    constructor() {
        this.pa = new ParentAgent();
        this.sa = new SchoolAdminAgent();
        this.ta = new TeacherAgent();
        this.primaryTA = new PrimaryTeacherAgent();
        this.ga = new SchoolGroupAgent();
    }

    async dispatch(message: RoutedMessage): Promise<AgentResponse> {
        const schoolId = message.schoolId || message.identity?.schoolId;
        if (!schoolId) {
            logger.error({ msgId: message.id }, '❌ DISPATCHER: schoolId missing from message context');
            return { to: message.from, body: 'Error: School context not established' };
        }
        const userId = message.identity?.userId;

        // 0. ✅ TWO-PASS VISION STRATEGY - PASS 1: Quick Classification
        // This replaces the old monolithic "universal vision analysis"
        // Pass 1 (here): Fast classification of document type
        // Pass 2 (in agent): Deep extraction using agent-specific prompt
        if (message.type === 'image' && message.mediaPath) {
            try {
                logger.info({ context: message.context }, '🔍 [DISPATCHER] PASS 1: Vision Classification triggered');
                
                // PASS 1: Classify the image
                const classificationResult = await VisionClassifier.classifyImage(message.mediaPath);
                
                // Store classification in message for agent context
                message.imageExplanation = classificationResult.explanation;
                message.extractionData = {
                    classification: classificationResult.classification,
                    confidence: classificationResult.confidence,
                    suggestedAgent: classificationResult.suggestedAgent,
                    passPhase: 'CLASSIFICATION' // Mark as Pass 1 result
                };
                
                logger.info({ 
                    classification: classificationResult.classification,
                    confidence: classificationResult.confidence,
                    suggestedAgent: classificationResult.suggestedAgent
                }, '✅ [DISPATCHER] PASS 1: Classification complete - PASS 2 will be in agent');
                
                // NOTE: PASS 2 (Deep Extraction) happens in the agent's handle() method
                // Each agent (PA, TA, SA) receives the classified image and raw path
                // and performs deep extraction using their specialized prompt
                
            } catch (error) {
                logger.error({ error }, '❌ [DISPATCHER] PASS 1: Classification failed - continuing without classification');
                // Continue without classification - agent will handle as generic image
            }
        }

        // 1. Record Incoming Message (Includes image context in history)
        const extractionStr = message.extractionData ? JSON.stringify(message.extractionData) : '';
        const truncatedExtraction = extractionStr.length > 500 ? extractionStr.substring(0, 500) + '... [truncated]' : extractionStr;
        
        const recordedBody = message.type === 'image' && message.imageExplanation 
            ? `[IMAGE_RECEIVED] Analysis: ${message.imageExplanation}${truncatedExtraction ? ` | Data: ${truncatedExtraction}` : ''}${message.body ? ` | User Caption: ${message.body}` : ''}`
            : message.body;

        await HistoryManager.recordMessage(schoolId, userId, message.from, message.context, {
            type: message.type,
            body: recordedBody,
            mediaPath: message.mediaPath,
            timestamp: message.timestamp,
            source: (message as any).source
        });

        // 2. Enrich Input with Memory Context
        const enrichedBody = await MemoryOrchestrator.getFullContext(
            schoolId,
            userId,
            message.from,
            recordedBody
        );

        const enrichedMessage = { ...message, body: enrichedBody };

        let output: PAOutput | TAOutput | SAOutput | GAOutput | SetupTAOutput;
        // flag to indicate we've handled an SA resolution (prevent creating new escalations from SA output)
        let handledAsResolution = false;

        switch (message.context) {
            case 'PA':
                output = await this.pa.handle(enrichedMessage);
                break;
            case 'SA':
                output = await this.sa.handle(enrichedMessage);
                break;
            case 'TA':
                // ✅ Route to correct TA based on school type and teacher's school_type
                const school = await new Promise<any>((resolve) => {
                    db.getDB().get(`SELECT school_type FROM schools WHERE id = ?`, [schoolId], (err, row) => {
                        resolve(row);
                    });
                });

                // ✅ SCHOOL_TYPE VALIDATION - Critical for correct routing
                if (school?.school_type === undefined || school?.school_type === null) {
                    logger.error({
                        schoolId,
                        schoolType: school?.school_type
                    }, '❌ [DISPATCHER] CRITICAL: school_type is undefined/null - routing may be incorrect');

                    // Fallback: Try to determine school type from teacher's record
                    const teacherPhone = message.from;
                    const teacher = await new Promise<any>((resolve) => {
                        db.getDB().get(
                            `SELECT school_type FROM users WHERE phone = ? AND school_id = ? AND role = 'teacher'`,
                            [teacherPhone, schoolId],
                            (err, row) => {
                                resolve(row);
                            }
                        );
                    });

                    if (teacher?.school_type) {
                        logger.warn({
                            schoolId,
                            teacherPhone,
                            fallbackSchoolType: teacher.school_type
                        }, '⚠️ [DISPATCHER] Falling back to teacher.school_type for routing');
                        school.school_type = teacher.school_type;
                    }
                }

                let usesPrimaryTA = false;
                const routingDecision: { schoolType: any; usesPrimaryTA: boolean; source: string; teacherType?: string } = { 
                    schoolType: school?.school_type, 
                    usesPrimaryTA, 
                    source: 'school' 
                };

                // ✅ Explicit routing decision logging
                if (school?.school_type === 'BOTH') {
                    const teacherPhone = message.from;
                    const teacher = await new Promise<any>((resolve) => {
                        db.getDB().get(
                            `SELECT school_type FROM users WHERE phone = ? AND school_id = ? AND role = 'teacher'`,
                            [teacherPhone, schoolId],
                            (err, row) => {
                                resolve(row);
                            }
                        );
                    });
                    usesPrimaryTA = teacher?.school_type === 'PRIMARY';
                    routingDecision.usesPrimaryTA = usesPrimaryTA;
                    routingDecision.source = 'teacher';
                    routingDecision.teacherType = teacher?.school_type || 'UNKNOWN';
                    logger.info({
                        schoolId,
                        teacherPhone,
                        teacherType: teacher?.school_type || 'UNKNOWN',
                        routing: usesPrimaryTA ? 'PRIMARY_TA' : 'TA'
                    }, '🔀 BOTH School - Routing by teacher.school_type');
                } else if (school?.school_type === 'PRIMARY') {
                    usesPrimaryTA = true;
                    routingDecision.usesPrimaryTA = true;
                    logger.info({ schoolId, agentType: 'PRIMARY_TA' }, '✅ PRIMARY School - Routing to PrimaryTeacherAgent');
                } else if (school?.school_type === 'SECONDARY' || school?.school_type === 'TA') {
                    usesPrimaryTA = false;
                    routingDecision.usesPrimaryTA = false;
                    logger.info({ schoolId, agentType: 'TA' }, '✅ SECONDARY School - Routing to TeacherAgent');
                } else {
                    // Fallback for unknown/undefined school_type - default to TA (secondary)
                    usesPrimaryTA = false;
                    routingDecision.usesPrimaryTA = false;
                    routingDecision.source = 'fallback';
                    logger.warn({
                        schoolId,
                        originalSchoolType: school?.school_type,
                        agentType: 'TA'
                    }, '⚠️ [DISPATCHER] Unknown school_type - defaulting to TeacherAgent (secondary)');
                }

                logger.debug({ routingDecision }, '📍 [DISPATCHER] TA routing decision');
                
                output = usesPrimaryTA 
                    ? await this.primaryTA.handle(enrichedMessage)
                    : await this.ta.handle(enrichedMessage);
                break;
            case 'GA':
                output = await this.ga.handle(enrichedMessage);
                break;
            default:
                logger.warn({ context: message.context }, 'Unknown context, defaulting to PA');
                output = await this.pa.handle(enrichedMessage);
        }

        // ========================================================================
        // 2.5 PROACTIVE ENGAGEMENT FEEDBACK LOOP
        // ========================================================================
        // If PA responded to a proactive checkup (parent was contacted about absence),
        // relay the parent's response back to SA
        if (message.context === 'PA' && (output as any).reply_text) {
            try {
                // Check if there's a recent proactive engagement for this parent
                const parentPhone = message.from;
                const recentProactive = await new Promise<any>((resolve) => {
                    db.getDB().get(
                        `SELECT id, school_id FROM messages 
                         WHERE from_phone = ? AND context = 'PA' 
                         AND body LIKE '%PROACTIVE CHECKUP%'
                         ORDER BY timestamp DESC LIMIT 1`,
                        [parentPhone],
                        (err, row) => resolve(row)
                    );
                });

                if (recentProactive) {
                    logger.info({ parentPhone }, '🔄 [DISPATCHER] Parent responded to proactive checkup - relaying to SA');
                    
                    // Import and call relay
                    const { AgentBridgeService } = await import('../services/proactive-engagement');
                    await AgentBridgeService.relayAgentReport(
                        schoolId,
                        'PA',
                        `Parent ${parentPhone} responded to proactive absence checkup: ${message.body}`,
                        enrichedMessage
                    );
                }
            } catch (err) {
                logger.error({ err }, '❌ [DISPATCHER] Failed to relay proactive engagement feedback');
            }
        }

        // 3. Record Outgoing Response
        await HistoryManager.recordMessage(schoolId, userId, message.from, message.context, {
            type: 'text',
            body: output.reply_text,
            timestamp: Date.now()
        }, {
            action: (output as any).action || (output as any).action_required || 'NONE',
            status: 'COMPLETED'
        });

        // ========================================================================
        // 3.7 POST-ESCALATION INSTRUCTION INJECTION (SA -> Origin Agent Resumption)
        // ========================================================================
        // When SA agent returns with intent_clear === true,
        // delegate escalation resolution to the dedicated ResumptionHandler service
        if ((output as any).intent_clear === true && (output as any).escalation_payload?.admin_instruction) {
            // Extract all the complex logic into a dedicated service
            // This keeps the dispatcher clean and the resumption logic testable
            await EscalationResumptionHandler.handleResolution(
                output,
                message,
                schoolId,
                {
                    pa: this.pa,
                    ta: this.ta,
                    ga: this.ga
                }
            );
        }

        // ========================================================================
        // 4. Return Response to User
        // ========================================================================

        // 3.5 ADMIN ESCALATION DETECTION
        // ========================================================================
        // Detect when origin agent (PA/TA/GA) needs admin authority
        // This is the canonical escalation pattern in KUMO
        // ========================================================================
        const adminEscalationRequired = 
            (output as any).admin_escalation?.required === true &&
            (message.context === 'PA' || message.context === 'TA' || message.context === 'GA');
        
        if (adminEscalationRequired) {
            logger.info(
                { 
                    context: message.context, 
                    urgency: (output as any).admin_escalation?.urgency,
                    reason: (output as any).admin_escalation?.reason
                },
                '⏸️  [DISPATCHER] Admin escalation detected - pausing agent and engaging authority'
            );
            
            try {
                // Extract escalation details from admin_escalation field
                const escalationPayload = (output as any).admin_escalation || {};
                
                // Check if escalation was already created by the agent (robustness check)
                let escalationId = escalationPayload.escalation_id;
                
                if (escalationId) {
                    logger.info({ escalationId }, '✅ [DISPATCHER] Using pre-created escalation from agent');
                } else {
                    // Resolve schoolId if it's a group JID (same logic as below)
                    let resolvedSchoolId = schoolId;
                    
                    if (schoolId && (schoolId.includes('@g.us') || /^\d+$/.test(schoolId))) {
                        logger.warn({ schoolId }, '⚠️ [DISPATCHER] SchoolId appears to be a group JID, attempting resolution');
                        
                        const jidVariants = [
                            schoolId,
                            schoolId.replace('@g.us', ''),
                            `${schoolId}@g.us`
                        ];
                        
                        const uniqueVariants = Array.from(new Set(jidVariants));
                        
                        let schoolRow = null;
                        for (let i = 0; i < uniqueVariants.length; i++) {
                            const variant = uniqueVariants[i];
                            
                            schoolRow = await new Promise<any>((resolve) => {
                                db.getDB().get(
                                    `SELECT id, name, admin_phone FROM schools WHERE whatsapp_group_jid = ?`,
                                    [variant],
                                    (err: any, row: any) => {
                                        resolve(err ? null : row);
                                    }
                                );
                            });
                            
                            if (schoolRow?.id) {
                                logger.info({ 
                                    originalJid: schoolId, 
                                    resolvedSchoolId: schoolRow.id,
                                    schoolName: schoolRow.name
                                }, '✅ [DISPATCHER] Resolved group JID to school ID');
                                resolvedSchoolId = schoolRow.id;
                                break;
                            }
                        }
                    } else {
                        logger.debug({ schoolId }, '✅ [DISPATCHER] SchoolId is UUID, no JID resolution needed');
                    }
                    
                    // Create escalation record (asynchronous, non-blocking)
                    // Include class-scoped context if provided by agent
                    escalationId = await EscalationServiceV2.pauseForEscalation({
                    origin_agent: message.context as 'PA' | 'TA' | 'GA',
                    escalation_type: escalationPayload.type || `${message.context}_ADMIN_ESCALATION`,
                    priority: (escalationPayload.urgency || 'MEDIUM').toUpperCase() as any,
                    school_id: resolvedSchoolId,
                    from_phone: message.from,
                    session_id: (message as any).session_id || `session-${Date.now()}`,
                    pause_message_id: `MSG-${Date.now()}`,
                    user_name: (message as any).user_name,
                    user_role: (message as any).user_role,
                    reason: escalationPayload.reason || 'Requires admin authority',
                    what_agent_needed: escalationPayload.message_to_admin || 
                        `${message.context} agent needs admin decision: ${output.reply_text}`,
                    context: {
                        requested_decision: escalationPayload.requested_decision,
                        allowed_actions: escalationPayload.allowed_actions,
                        escalation_context: escalationPayload.context,
                        // Class-scoped context (if provided by TA/PA handlers)
                        class_level: escalationPayload.class_level,
                        subject: escalationPayload.subject,
                        term_id: escalationPayload.term_id,
                        escalation_subtype: escalationPayload.escalation_subtype,
                        associated_pdf_path: escalationPayload.associated_pdf_path,
                        requires_pdf_review: escalationPayload.requires_pdf_review
                    },
                    conversation_summary: (await HistoryManager.getSlidingWindow(message.from, 10, undefined, resolvedSchoolId))
                        .map((m: any) => `${m.context || 'UNKNOWN'}: ${m.body || m.reply_text || ''}`)
                        .join('\n')
                });
                
                logger.info({ escalationId, origin: message.context }, '✅ [DISPATCHER] Admin escalation created');
                }
                
                // Async notification to SA (non-blocking) - runs for both pre-created and new escalations
                setImmediate(async () => {
                    try {
                        // Load escalation details to provide full context to SA
                        const { escalation } = await EscalationServiceV2.getEscalationForAuthority(
                            escalationId,
                            [],
                            schoolId
                        );
                        
                        if (escalation) {
                            logger.info({ 
                                escalationId, 
                                escalationType: escalation.escalation_type,
                                priority: escalation.priority,
                                reason: escalation.reason
                            }, '📋 [DISPATCHER] Escalation loaded, preparing notification for SA');
                            
                            // Build comprehensive context message for SA
                            const contextMessage = `
[Escalation ID: ${escalationId}]
Origin Agent: ${escalation.origin_agent}
Priority: ${escalation.priority}
Reason: ${escalation.reason}
What Agent Needed: ${escalation.what_agent_needed}
User Role: ${escalation.user_role || 'Unknown'}

CONVERSATION CONTEXT:
${escalation.conversation_summary || 'No context available'}

REQUEST DETAILS:
${JSON.stringify(escalation.context, null, 2)}
`;
                            
                            // Route to SA with full escalation context
                            // ⚠️ IMPORTANT: Mark as NEW_ESCALATION so SA knows to NOTIFY ADMIN, not process as response
                            const adminSystemMsg = {
                                ...message,
                                context: 'SA',
                                body: contextMessage,
                                identity: {
                                    ...message.identity,
                                    schoolId: schoolId
                                },
                                // ⚠️ Flag to distinguish from admin response
                                isEscalationNotification: true,
                                escalationType: 'NEW_ESCALATION'
                            };
                            
                            await this.sa.handle(adminSystemMsg as any);
                            logger.info({ escalationId }, '✅ [DISPATCHER] Escalation notification sent to SA for admin alerting');
                        } else {
                            logger.warn({ escalationId }, '⚠️ [DISPATCHER] Could not load escalation context for SA');
                        }
                    } catch (notifyErr) {
                        logger.error({ notifyErr, escalationId }, '❌ [DISPATCHER] Failed to notify SA asynchronously');
                    }
                });
                
            } catch (harperErr) {
                logger.error({ harperErr }, '❌ [DISPATCHER] Harper escalation handling failed');
                // Continue with customer response regardless
            }
        } else if ((output as any).admin_escalation?.required === true) {
            // Warn if admin_escalation flag is set but wasn't processed (context mismatch)
            logger.warn(
                { 
                    context: message.context,
                    hasEscalationFlag: true,
                    reason: (output as any).admin_escalation?.reason
                },
                '⚠️ [DISPATCHER] Admin escalation flag present but not processed - context may not be PA/TA/GA'
            );
        }
        
        // ========================================================================
        // LEGACY ESCALATION DETECTION (Backwards Compatibility)
        // ========================================================================
        // Detect if agent needs to escalate (explicit or implicit)
        // Do NOT create new escalations for messages originating from SA (admin agent).
        // SA messages are expected to be authority responses or notifications and
        // should not trigger the pause-and-escalate flow again.
        const needsEscalation = 
            message.context !== 'SA' && (
                (output as any).action_required === 'ESCALATE_TO_ADMIN' ||
                (output as any).needs_authority === true ||
                (output as any).escalation_payload !== undefined
            );
        
        if (needsEscalation && message.context !== 'SA') {
            logger.info(
                { context: message.context, escalationType: (output as any).escalation_payload?.escalation_type },
                '⏸️  [DISPATCHER] Escalation needed - pausing agent and engaging authority'
            );
            
            try {
                // Resolve schoolId if it's a group JID
                let resolvedSchoolId = schoolId;
                logger.debug({ schoolId, isGroupJid: schoolId && (schoolId.includes('@g.us') || /^\d+$/.test(schoolId)) }, 
                    '🔍 [DISPATCHER] Checking if schoolId is a group JID that needs resolution');
                
                if (schoolId && (schoolId.includes('@g.us') || /^\d+$/.test(schoolId))) {
                    logger.warn({ schoolId }, '⚠️ [DISPATCHER] SchoolId appears to be a group JID, attempting resolution');
                    
                    // This might be a group JID - normalize format and look it up
                    // Try multiple variants of the JID format
                    const jidVariants = [
                        schoolId,
                        schoolId.replace('@g.us', ''), // Remove suffix if present
                        `${schoolId}@g.us` // Add suffix if not present
                    ];
                    
                    const uniqueVariants = Array.from(new Set(jidVariants));
                    logger.debug({ jidVariants: uniqueVariants }, '🔍 [DISPATCHER] Generated JID variants for lookup');
                    
                    let schoolRow = null;
                    for (let i = 0; i < uniqueVariants.length; i++) {
                        const variant = uniqueVariants[i];
                        logger.debug({ variant, index: i + 1, total: uniqueVariants.length }, 
                            `🔍 [DISPATCHER] Trying variant ${i + 1}/${uniqueVariants.length}`);
                        
                        schoolRow = await new Promise<any>((resolve) => {
                            db.getDB().get(
                                `SELECT id, name, admin_phone FROM schools WHERE whatsapp_group_jid = ?`,
                                [variant],
                                (err: any, row: any) => {
                                    if (err) {
                                        logger.error({ err, variant }, `❌ [DISPATCHER] Error querying for variant "${variant}"`);
                                        resolve(null);
                                    } else {
                                        resolve(row);
                                    }
                                }
                            );
                        });
                        
                        if (schoolRow && schoolRow.id) {
                            logger.info({ 
                                originalJid: schoolId, 
                                matchedVariant: variant, 
                                resolvedSchoolId: schoolRow.id,
                                schoolName: schoolRow.name,
                                adminPhone: schoolRow.admin_phone
                            }, '✅ [DISPATCHER] Resolved group JID to real school ID');
                            resolvedSchoolId = schoolRow.id;
                            break; // Found match
                        } else {
                            logger.debug({ variant }, `❌ [DISPATCHER] No match for variant "${variant}"`);
                        }
                    }
                    
                    if (!schoolRow) {
                        logger.error({ groupJid: schoolId, triedVariants: uniqueVariants }, 
                            '❌ [DISPATCHER] Could not resolve group JID to school using any variant - escalation may fail');
                    }
                } else {
                    logger.debug({ schoolId }, '✅ [DISPATCHER] SchoolId is already a UUID, no JID resolution needed');
                }
                
                // Get the message ID of the response we just recorded
                const responseMessage = await new Promise<any>((resolve) => {
                    (db as any).getDB().get(
                        `SELECT id FROM messages WHERE from_phone = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT 1`,
                        [message.from, Date.now() - 1000],
                        (err: any, row: any) => resolve(row)
                    );
                });
                
                const pauseMessageId = responseMessage?.id || `MSG-${Date.now()}`;
                
                // Extract escalation context
                const escalationPayload = (output as any).escalation_payload || {
                    escalation_type: `${message.context}_ESCALATION`,
                    priority: 'HIGH'
                };
                
                // Get recent conversation history for authority agent to see full context
                const conversationHistory = await HistoryManager.getSlidingWindow(message.from, 15, undefined, resolvedSchoolId);
                const conversationSummary = conversationHistory
                    .map((m: any) => `${m.context || 'UNKNOWN'}: ${m.body || m.reply_text || ''}`)
                    .join('\n');
                
                // PAUSE: Create escalation record with resolved school ID
                const escalationId = await EscalationServiceV2.pauseForEscalation({
                    origin_agent: message.context as 'PA' | 'TA' | 'GA',
                    escalation_type: escalationPayload.escalation_type,
                    priority: escalationPayload.priority || 'MEDIUM',
                    school_id: resolvedSchoolId,
                    from_phone: message.from,
                    session_id: (message as any).session_id || `session-${Date.now()}`,
                    pause_message_id: pauseMessageId,
                    user_name: (message as any).user_name,
                    user_role: (message as any).user_role,
                    reason: escalationPayload.reason || 'Requires admin authority',
                    what_agent_needed: escalationPayload.what_agent_needed || 
                        `${message.context} agent needs admin decision on: ${output.reply_text}`,
                    context: escalationPayload.context || {},
                    conversation_summary: conversationSummary
                });
                
                logger.info(
                    { escalationId, origin: message.context },
                    '✅ [DISPATCHER] Escalation created - agent paused, awaiting authority'
                );
                
                // Notify SA (System Event)
                // This triggers the SA to generate the notification and send it to the admin
                const adminSystemMsg = {
                    ...message,
                    from: 'ESCALATION_SYSTEM',
                    context: 'SA',
                    body: { ...escalationPayload, escalation_id: escalationId }, // Pass full payload
                    identity: {
                        ...message.identity,
                        schoolId: resolvedSchoolId // Use the resolved school ID, not the group JID
                    }
                };
                
                await this.sa.handle(adminSystemMsg as any);
                
            } catch (err) {
                logger.error({ err }, '❌ [DISPATCHER] Escalation handling failed');
                // Still return response to user even if escalation setup fails
            }
        } else if (needsEscalation && message.context === 'SA') {
            logger.warn({ context: message.context }, '⚠️ [DISPATCHER] Skipping escalation creation for SA-originated output');
            // SA should not create new escalation records; if SA intends to record an authority decision
            // it should go through the resolution flow (intent_clear) handled elsewhere.
        }

        // 4. Group Specific Logic (Delete message if abusive)
        const actions: any[] = [];
        if (message.context === 'GA' && (output as any).action_required === 'DELETE_MESSAGE') {
            actions.push({ type: 'DELETE_MESSAGE', payload: { messageId: message.id, remoteJid: message.from } });
        }

        return {
            to: message.from,
            body: output.reply_text,
            actions: actions.length > 0 ? actions : undefined,
            delivery_type: (output as any).delivery_type || 'text'
        };
    }
}