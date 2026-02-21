import { BaseAgent } from '../base/agent';
import { RoutedMessage } from '../../core/types';
import { SAOutput, SAActionType } from './types/schema';
import { SetupSAOutput, SetupActionType } from './types/setup_schema';
import { logger } from '../../utils/logger';
import { EscalationServiceV2 } from '../../services/escalation-v2';
import { SA_TA_CONFIG } from '../../ai/config';
import { aiProvider } from '../../ai/provider';
import { AdminRepository } from '../../db/repositories/admin.repo';
import { TransactionRepository } from '../../db/repositories/transaction.repo';
import { SetupRepository } from '../../db/repositories/setup.repo';
import { ParentRepository } from '../../db/repositories/parent.repo';
import { EscalationRepository } from '../../db/repositories/escalation.repo';
import { PromptEngine } from '../../core/prompt-engine';
import { MemoryOrchestrator } from '../../core/memory/orchestrator';
import { HistoryManager } from '../../core/memory/history-manager';
import { AuditTrailService } from '../../services/audit';
import { ErrorRecoveryService } from '../../services/error-recovery';
import { RobustJsonParser } from '../../core/robust-json-parser';
import { DataValidator } from '../../utils/data-validator';
import { PhoneNormalizer } from '../../utils/phone-normalizer';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db';
import { messenger } from '../../services/messenger';
import { visionService } from '../../ai/vision';
import { ActionAuthorizer } from '../../core/action-authorization';
import { ReportService } from '../../services/report-service';
import { AcademicRepository } from '../../db/repositories/academic.repo';
import fs from 'fs';
import path from 'path';

import { CONSTANTS, ValidSchoolType } from '../../config/constants';
import { getUniverseTemplate } from '../../config/universe-templates';
import { detectCountryFromPhone } from '../../utils/country-detection';

const SETUP_VALIDATOR = {
    isValidSchoolType(value: any): value is ValidSchoolType {
        return typeof value === 'string' && 
               CONSTANTS.SETUP.VALID_SCHOOL_TYPES.includes(value as ValidSchoolType);
    },

    validateSchoolType(schoolType: any): { valid: boolean; normalized?: ValidSchoolType; error?: string } {
        if (!schoolType) {
            return { 
                valid: false, 
                error: 'school_type is required and must be one of: PRIMARY, SECONDARY, BOTH' 
            };
        }
        
        const normalized = schoolType.toString().toUpperCase().trim() as ValidSchoolType;
        
        if (!this.isValidSchoolType(normalized)) {
            return { 
                valid: false, 
                error: `Invalid school_type: "${schoolType}". Must be one of: ${CONSTANTS.SETUP.VALID_SCHOOL_TYPES.join(', ')}` 
            };
        }
        
        return { valid: true, normalized };
    },

    validateSetupPayload(payload: any): { valid: boolean; error?: string; warnings?: string[] } {
        const warnings: string[] = [];
        
        if (!payload) {
            return { valid: false, error: 'Setup payload is empty' };
        }
        
        if (payload.school_info) {
            const schoolTypeValidation = this.validateSchoolType(payload.school_type);
            
            if (!schoolTypeValidation.valid) {
                return { 
                    valid: false, 
                    error: `SETUP_SCHOOL validation failed: ${schoolTypeValidation.error}. school_type MUST be explicitly provided, no defaults allowed.` 
                };
            }
            
            if (!payload.school_type) {
                warnings.push('school_type defaulted to SECONDARY - this is now an error condition');
            }
        }
        
        return { valid: true, warnings };
    },

    generateTeacherToken(): string {
        return `${CONSTANTS.TEACHER.TOKEN_PREFIX}${uuidv4().split('-')[0].toUpperCase()}`;
    },

    normalizePhone(phone: string | number | undefined, countryCode?: string): string | null {
        if (!phone) return null;
        return PhoneNormalizer.normalize(phone.toString());
    }
};

export class SchoolAdminAgent extends BaseAgent {
    /**
     * 🔐 PHASE 1: ROLE-BASED ACCESS CONTROL
     * Resolve admin's role and verify authorization for action
     */
    private async getAdminRole(adminPhone: string, schoolId: string): Promise<string | null> {
        try {
            // Check if this phone matches the school admin phone in DB
            // For now, assume this SA agent is run as admin (context already verified by dispatcher)
            return 'admin';
        } catch (err) {
            logger.error({ err, adminPhone, schoolId }, '⚠️ Could not resolve admin role');
            return null;
        }
    }

    /**
     * 🔐 Validate action authorization
     * Returns { authorized: boolean, reason?: string }
     */
    private async validateActionAuthorization(
        action: string,
        adminPhone: string,
        schoolId: string,
        output: SAOutput
    ): Promise<{ authorized: boolean; reason?: string }> {
        // SA only responds to 'NONE' if it doesn't have admin role
        const adminRole = await this.getAdminRole(adminPhone, schoolId);
        
        if (!adminRole) {
            logger.error({ 
                action, 
                adminPhone, 
                schoolId 
            }, '🔴 SECURITY: Non-admin attempted action');
            return {
                authorized: false,
                reason: 'Admin role not found for this user'
            };
        }

        // Use ActionAuthorizer to check if admin can perform this action
        const auth = ActionAuthorizer.authorize(
            action,
            adminRole as any,
            output.intent_clear,
            output.authority_acknowledged
        );

        if (!auth.authorized) {
            logger.error({
                action,
                adminPhone,
                adminRole,
                reason: auth.reason
            }, '🔴 SECURITY: Authorization failed for action');
        }

        return auth;
    }

    async handle(message: RoutedMessage): Promise<any> {
        logger.info({ msgId: message.id, from: message.from }, 'SA handling message');
        
        const schoolId = message.identity?.schoolId;
        if (!schoolId) {
            logger.error({ msgId: message.id }, '❌ SA: schoolId missing from message identity - cannot process');
            return { agent: 'SA', reply_text: 'Error: School context not established', action_required: 'NONE' };
        }

        // ✅ ROUTE TO SETUP IF NOT OPERATIONAL
        const isInSetup = await SetupRepository.isSchoolInSetup(schoolId);
        if (isInSetup && message.from !== 'ESCALATION_SYSTEM') {
            logger.info({ schoolId }, '🧙 [SA] School in SETUP mode - routing to handleSetup');
            return await this.handleSetup(message, schoolId);
        }
        
        // ⚠️ CHECK IF THIS IS A NEW ESCALATION NOTIFICATION (from dispatcher)
        // vs an actual ADMIN RESPONSE to an escalation
        const isNewEscalationNotification = (message as any).isEscalationNotification === true || 
                                           message.from === 'ESCALATION_SYSTEM';
        
        if (isNewEscalationNotification) {
            logger.info({ msgId: message.id }, '🔔 SA received ESCALATION notification');
            try {
                const adminInfo = await this.getSchoolAdminInfo(schoolId);
                const adminPhone = adminInfo?.phone;
                const adminId = adminInfo?.id;
                
                // Construct standard payload for generator
                let payload: any = message.body;
                
                // If body is a string (from dispatcher's NEW_ESCALATION path), parse details
                if (typeof message.body === 'string') {
                    const escalationIdMatch = message.body.match(/\[Escalation ID:\s*([^\]]+)\]/);
                    const priorityMatch = message.body.match(/Priority:\s*([^\n]+)/);
                    const reasonMatch = message.body.match(/Reason:\s*([^\n]+)/);
                    const whatNeededMatch = message.body.match(/What Agent Needed:\s*([^\n]+)/);
                    const originAgentMatch = message.body.match(/Origin Agent:\s*([^\n]+)/);
                    const userNameMatch = message.body.match(/User Name:\s*([^\n]+)/) || message.body.match(/From:\s*([^\n]+)/);

                    payload = {
                        escalation_id: escalationIdMatch ? escalationIdMatch[1].trim() : `ESC-${Date.now()}`,
                        priority: priorityMatch ? priorityMatch[1].trim() : 'MEDIUM',
                        reason: reasonMatch ? reasonMatch[1].trim() : 'No reason provided',
                        what_agent_needed: whatNeededMatch ? whatNeededMatch[1].trim() : 'Action needed',
                        origin_agent: originAgentMatch ? originAgentMatch[1].trim() : 'Agent',
                        user_name: userNameMatch ? userNameMatch[1].trim() : 'Staff',
                        school_id: schoolId,
                        conversation_summary: message.body
                    };
                }

                const notificationText = await this.generateEscalationNotification(payload);
                
                if (!adminPhone) {
                    logger.error({ schoolId }, '🔴 No admin phone configured - cannot send escalation notification');
                    return {
                        agent: 'SA',
                        reply_text: '❌ **Critical Configuration Error**: School admin phone is not configured. Your escalation cannot be sent until this is fixed.',
                        action_required: 'NONE'
                    };
                }

                // Send conversational text to admin
                await messenger.sendPush(schoolId, adminPhone, notificationText);

                // ✅ NEW: Handle PDF Delivery to Admin if present in context
                const pdfPath = payload.context?.pdf_path || payload.pdf_path;
                if (pdfPath && fs.existsSync(pdfPath)) {
                    logger.info({ adminPhone, pdfPath }, '📎 Sending escalation attachment to admin');
                    await messenger.sendDocument(schoolId, adminPhone, pdfPath, `📎 Attachment for Review: ${payload.reason || 'Escalation Document'}`);
                }
                
                                // ✅ RECORD IN MEMORY: Ensure SA sees this notification in history when Admin replies
                                const { HistoryManager } = await import('../../core/memory/history-manager');
                                await HistoryManager.recordMessage(
                                    schoolId,
                                    adminId, // FIXED: Pass adminId instead of undefined
                                    adminPhone!,
                                    'SA',
                                    {
                                        type: 'text',
                                        body: `[SYSTEM ALERT] ${notificationText}`,
                                        timestamp: Date.now(),
                                        source: 'system'
                                    },
                                    {
                                        action: 'NOTIFY_ADMIN',
                                        status: 'COMPLETED'
                                    }
                                );
                                
                return {
                    agent: 'SA',
                    reply_text: 'Escalation notified to admin.',
                    action_required: 'NONE',
                    intent_clear: true,
                    authority_acknowledged: true
                };
            } catch (error) {
                logger.error({ error }, '❌ Failed to handle escalation notification');
                return { agent: 'SA', reply_text: 'Error forwarding escalation', action_required: 'NONE' };
            }
        }

        
        // 🔄 CHECK IF THERE'S A PENDING ESCALATION FOR THIS SCHOOL
        // (not by searching message, but by checking DB for active escalations)
        let pendingEscalation = null;
        try {
            const escalations = await EscalationServiceV2.getPendingEscalations(schoolId);
            if (escalations && escalations.length > 0) {
                // Get the most recent pending escalation
                pendingEscalation = escalations[0];
                logger.info({ 
                    escalationId: pendingEscalation.id, 
                    adminPhone: message.from 
                }, '🔔 [SA] Admin message received while escalation is PENDING');
            }
        } catch (checkError) {
            logger.debug({ checkError: (checkError as any).message }, 'Could not check for pending escalations');
        }
        
        // If there's a pending escalation, pass it as context to normal SA flow
        // SA's prompt will handle intent tracking without special analysis
        if (pendingEscalation) {
            logger.info({ 
                escalationId: pendingEscalation.id,
                originAgent: pendingEscalation.origin_agent,
                type: pendingEscalation.escalation_type || pendingEscalation.type
            }, '📋 [SA] Pending escalation context found');
        }
        
        // ========================================================================
        // NORMAL SA FLOW - Single conversational response pattern
        // ========================================================================
        
        const output: SAOutput = {
            agent: 'SA',
            reply_text: "",
            action_required: 'NONE',
            intent_clear: false,
            authority_acknowledged: false,
            confidence_score: 0,
            session_active: true
        };

        // Use the already enriched body from the dispatcher
        const contextPrompt = message.body;
        
        logger.info({ msgId: message.id, from: message.from, schoolId }, 
            '🧠 [SA] Starting message processing');
        
        // Check if there are pending escalations - if yes, don't load escalation prompt (normal flow handles it)
        const pendingEscalations = await EscalationServiceV2.getPendingEscalations(schoolId);
        const hasPendingEscalations = pendingEscalations && pendingEscalations.length > 0;

        // Build escalation context for prompt injection
        let escalationContext = '';
        if (hasPendingEscalations && pendingEscalations.length > 0) {
            logger.info({ pendingCount: pendingEscalations.length }, 
                '🔔 [SA] Pending escalations found - injecting into prompt');
            
            escalationContext = '\n\n## ACTIVE ESCALATIONS (AWAITING YOUR DECISION)\n\n';
            pendingEscalations.forEach((esc, idx) => {
                const contextData = typeof esc.context === 'string' ? JSON.parse(esc.context || '{}') : (esc.context || {});
                escalationContext += `### ESCALATION ${idx + 1}:\n`;
                escalationContext += `- **ID**: ${esc.id}\n`;
                escalationContext += `- **FROM**: ${esc.origin_agent} Agent\n`;
                escalationContext += `- **TYPE**: ${esc.escalation_type || 'General'}\n`;
                escalationContext += `- **PRIORITY**: ${esc.priority || 'MEDIUM'}\n`;
                escalationContext += `- **REASON**: ${esc.reason || esc.what_agent_needed || 'No details provided'}\n`;
                if (contextData.pdf_path) {
                    escalationContext += `- **PDF ATTACHED**: YES (Review document provided)\n`;
                }
                if (contextData.class_level) {
                    escalationContext += `- **CLASS**: ${contextData.class_level}\n`;
                }
                if (contextData.subject) {
                    escalationContext += `- **SUBJECT**: ${contextData.subject}\n`;
                }
                // Add specific instructions for absence escalations
                if (esc.escalation_type === 'ATTENDANCE_ABSENCE') {
                    escalationContext += `- **ALLOWED ACTIONS**: ENGAGE_PARENTS, IGNORE_FOR_NOW\n`;
                    // Include the absentees list so LLM knows which students
                    const absentees = contextData.absentees;
                    if (absentees && Array.isArray(absentees) && absentees.length > 0) {
                        const absenteeNames = absentees.map((s: any) => s.student_name || s.name || 'Unknown').join(', ');
                        escalationContext += `- **ABSENT STUDENTS**: ${absenteeNames}\n`;
                        escalationContext += `- **ABSENTEE DATA** (use in action_payload): ${JSON.stringify(absentees.map((s: any) => ({ name: s.student_name || s.name })))}\n`;
                    }
                    if (contextData.class_level) {
                        escalationContext += `- **CLASS**: ${contextData.class_level}\n`;
                    }
                    if (contextData.marked_date) {
                        escalationContext += `- **DATE**: ${contextData.marked_date}\n`;
                    }
                }
                escalationContext += '\n';
            });
            escalationContext += '\n**CRITICAL**: When responding to these escalations:\n';
            escalationContext += '1. Reference the exact ESCALATION ID in your response\n';
            // Add absence-specific guidance
            escalationContext += '2. For ATTENDANCE_ABSENCE: If admin says "Yes", "contact parents", "engage parents" → set action_required: "ENGAGE_PARENTS" with absentees in payload\n';
            escalationContext += '3. Include escalation_payload with escalation_id, admin_decision, and admin_instruction\n\n';
        }

        // Fetch admin name for personalization
        let adminName = 'Admin';
        try {
            const adminUser: any = await new Promise((resolve) => {
                db.getDB().get(
                    `SELECT name FROM users WHERE school_id = ? AND role = 'admin' LIMIT 1`,
                    [schoolId],
                    (err, row) => resolve(row)
                );
            });
            if (adminUser?.name && adminUser.name !== 'System Admin') {
                adminName = adminUser.name;
            }
        } catch (error) {
            // Use default
        }

        const systemPrompt = await PromptEngine.assemble({
            agent: 'sa',
            schoolId,
            dynamicVars: {
                escalation_context: escalationContext,
                has_escalations: hasPendingEscalations ? 'YES' : 'NO',
                escalation_count: pendingEscalations?.length || 0,
                admin_name: adminName
            }
        });

        let systemActionResult: any = null;

        try {
            logger.debug({ modelConfig: 'SA_TA_CONFIG' }, 
                '🤖 [SA] Calling Groq API');
            
            const aiRes = await aiProvider.generateText(SA_TA_CONFIG, contextPrompt, systemPrompt);
            
            logger.debug({ rawResponse: aiRes.text }, 
                '📨 [SA] LLM response received (FULL JSON)');
            
            // Use robust JSON parser with multiple fallback strategies
            const parseResult = RobustJsonParser.parse<SAOutput>(aiRes.text, 'SA_AGENT');
            
            if (!parseResult.success) {
                logger.error({ error: parseResult.error, rawText: aiRes.text.substring(0, 500) }, 
                    '❌ [SA] JSON parse error');
                output.reply_text = "I understood your request but had trouble formatting the response. Please try again.";
                return output;
            }

            const parsed = parseResult.data as SAOutput;
            if (parseResult.fallbackUsed) {
                logger.debug({ fallbackUsed: parseResult.fallbackUsed }, 
                    '⚠️ [SA] JSON parsed with fallback');
            }

            output.reply_text = parsed.reply_text;
            output.action_required = parsed.action_required;
            output.intent_clear = parsed.intent_clear;
            output.authority_acknowledged = parsed.authority_acknowledged;
            // Accept both `action_payload` and `escalation_payload` from LLM output for compatibility
            // Assign payloads using any to avoid strict type conflicts between action payload types
            (output as any).action_payload = parsed.action_payload || {};

            // Only set escalation_payload if LLM output provides it, or if closing a pending escalation
            if (parsed.escalation_payload) {
                (output as any).escalation_payload = parsed.escalation_payload;
            } else if (pendingEscalation && parsed.intent_clear && parsed.authority_acknowledged) {
                logger.info({ escalationId: pendingEscalation.id }, 
                    '🔔 [SA] Escalation closure detected - preparing escalation_payload');
                (output as any).escalation_payload = {
                    escalation_id: pendingEscalation.id,
                    admin_decision: (parsed as any).admin_decision || 'APPROVE',
                    admin_instruction: (parsed as any).admin_instruction || output.reply_text || 'Admin has reviewed your request',
                    source: 'sa_closure'
                };
                logger.info({ payload: (output as any).escalation_payload }, 
                    '✅ [SA] escalation_payload prepared for dispatcher');
            }

            // 🧠 GOD MODE INFERENCE: Force action if closing mark approval escalation
            // Aggressive inference: if plain text says "approv..." and we have a pending submission escalation, DO IT.
            const plainText = (output.reply_text || '').toLowerCase();
            const isPlainApprove = /approv|finaliz|confirm|ok|yes|correct|process|release/i.test(plainText);

            if (pendingEscalation?.escalation_type === 'MARK_SUBMISSION_APPROVAL' && 
                (isPlainApprove || (output as any).escalation_payload?.admin_decision === 'APPROVE') && 
                output.action_required === 'NONE') {
                
                logger.info({ escalationId: pendingEscalation.id, match: isPlainApprove }, '🧬 [GOD_MODE] Aggressively inferring APPROVE_MARK_SUBMISSION from context');
                output.action_required = 'APPROVE_MARK_SUBMISSION';
                output.intent_clear = true;
                output.authority_acknowledged = true;
            }

            // ✅ NEW: GOD MODE Inference for Individual Mark Amendments
            // Aggressive override: If we have a MARK_AMENDMENT pending, and the response is approval, FORCE it.
            const isAmendmentAction = output.action_required === 'NONE' || 
                                     output.action_required === 'CONFIRM_AMENDMENT' || 
                                     output.action_required === 'PROPOSE_AMENDMENT' ||
                                     output.action_required === 'CLOSE_ESCALATION' || // LLM sometimes tries to just close it
                                     output.action_required === 'APPROVE_MARK_SUBMISSION'; // Hallucination protection
            
            const escType = pendingEscalation?.escalation_type || pendingEscalation?.type;
            if (escType === 'MARK_AMENDMENT' && 
                (isPlainApprove || (output as any).escalation_payload?.admin_decision === 'APPROVE') && 
                isAmendmentAction) {
                
                logger.info({ escalationId: pendingEscalation.id }, '🧬 [GOD_MODE] Aggressively inferring APPROVE_MARK_AMENDMENT from context (Typo/Hallucination Protected)');
                output.action_required = 'APPROVE_MARK_AMENDMENT';
                output.intent_clear = true;
                output.authority_acknowledged = true;
            }

            // ✅ NEW: Aggressive inference for Class Result Release
            if (pendingEscalation?.escalation_type === 'CLASS_RESULT_RELEASE' && 
                (isPlainApprove || (output as any).escalation_payload?.admin_decision === 'APPROVE') && 
                output.action_required === 'NONE') {
                
                logger.info({ escalationId: pendingEscalation.id }, '🧬 [GOD_MODE] Aggressively inferring RELEASE_RESULTS from context');
                output.action_required = 'RELEASE_RESULTS';
                output.intent_clear = true;
                output.authority_acknowledged = true;
            }

            // ✅ NEW: Aggressive inference for ATTENDANCE_ABSENCE - Engage Parents
            // Fallback: If LLM doesn't output ENGAGE_PARENTS, check for explicit approval keywords
            const bodyLower = message.body.toLowerCase();
            const isAbsenceEscalation = pendingEscalation?.escalation_type === 'ATTENDANCE_ABSENCE';
            const wantsEngageParents = bodyLower.includes('yes') || 
                                        bodyLower.includes('engage') || 
                                        bodyLower.includes('contact parents') ||
                                        bodyLower.includes('do it') ||
                                        bodyLower.includes('go ahead') ||
                                        bodyLower.includes('please do');
            
            if (isAbsenceEscalation && wantsEngageParents && output.action_required === 'NONE') {
                // Extract absentees from escalation context
                const escContext = typeof pendingEscalation.context === 'string' 
                    ? JSON.parse(pendingEscalation.context || '{}') 
                    : (pendingEscalation.context || {});
                
                const absentees = escContext.absentees || [];
                
                if (absentees.length > 0) {
                    logger.info({ escalationId: pendingEscalation.id, absentees }, '🧬 [GOD_MODE] Aggressively inferring ENGAGE_PARENTS from context (LLM fallback)');
                    output.action_required = 'ENGAGE_PARENTS';
                    output.intent_clear = true;
                    output.authority_acknowledged = true;
                    output.action_payload = {
                        absentees: absentees.map((s: any) => ({ name: s.student_name || s.name })),
                        reason: 'Student absence - contacting parent'
                    };
                }
            }

            // For ATTENDANCE_ABSENCE - let LLM decide based on escalation context

            // 🛡️ GOD MODE SAFETY RAIL: Force real IDs from escalation context to prevent LLM hallucinations
            if (pendingEscalation && (output.action_required === 'APPROVE_MARK_SUBMISSION' || 
                                     output.action_required === 'APPROVE_MARK_AMENDMENT' ||
                                     output.action_required === 'RELEASE_RESULTS' || 
                                     (output as any).escalation_payload)) {
                const escContext = typeof pendingEscalation.context === 'string' ? JSON.parse(pendingEscalation.context) : pendingEscalation.context;
                
                // 1. Force real escalation_id
                if (!(output as any).escalation_payload) {
                    (output as any).escalation_payload = { 
                        admin_decision: 'APPROVE', 
                        admin_instruction: output.reply_text || 'Approved.' 
                    };
                }
                (output as any).escalation_payload.escalation_id = pendingEscalation.id;
                (output as any).escalation_payload.admin_decision = (output as any).escalation_payload.admin_decision || 'APPROVE';

                // 2. Force real context for actions
                if (output.action_required === 'APPROVE_MARK_SUBMISSION' && escContext?.workflow_id) {
                    logger.info({ old: output.action_payload?.workflow_id, new: escContext.workflow_id }, '🛡️ [GOD_MODE] Correcting workflow_id hallucination');
                    (output as any).action_payload = {
                        ...(output.action_payload || {}),
                        workflow_id: escContext.workflow_id,
                        subject: output.action_payload?.subject || escContext.subject,
                        class_level: output.action_payload?.class_level || escContext.class_level
                    };
                }

                if (output.action_required === 'APPROVE_MARK_AMENDMENT' && (escContext?.student_id || escContext?.student_name)) {
                    logger.info({ student: escContext.student_name }, '🛡️ [GOD_MODE] Forcing context for Mark Amendment');
                    (output as any).action_payload = {
                        ...(output.action_payload || {}),
                        student_id: escContext.student_id,
                        student_name: escContext.student_name,
                        subject: escContext.subject,
                        term_id: escContext.term_id,
                        component: escContext.component,
                        new_score: escContext.new_score,
                        teacher_id: escContext.teacher_id,
                        class_level: escContext.class_level
                    };
                }

                if (output.action_required === 'RELEASE_RESULTS' && escContext?.class_level) {
                    (output as any).action_payload = {
                        ...(output.action_payload || {}),
                        class_level: escContext.class_level,
                        term_id: escContext.term_id || 'current'
                    };
                }
            }
            output.confidence_score = parsed.confidence_score;

            // 🔍 CRITICAL LOGGING: What is SA deciding?
            logger.info({ 
                action: output.action_required,
                intentClear: output.intent_clear,
                authorityAck: output.authority_acknowledged,
                confidence: output.confidence_score,
                payloadKeys: output.action_payload ? Object.keys(output.action_payload) : [],
                replyLength: output.reply_text.length
            }, '✅ [SA OUTPUT] Decision logged - check action + intent + authority');

            if (output.action_required !== 'NONE' && (!output.intent_clear || !output.authority_acknowledged)) {
                 logger.warn({ action: output.action_required, intentClear: output.intent_clear, authorityAck: output.authority_acknowledged }, 
                    '⚠️ [SA] Action without clear intent/authority - allowing LLM to handle clarification');
                 
                 // If LLM already provided a natural reply_text asking for confirmation, use it
                 if (output.reply_text && output.reply_text.length > 10) {
                     logger.info('✅ [SA] Using LLM natural clarification message');
                 } else {
                     output.reply_text = "I understand you'd like to proceed with this. Just to be 100% sure, do I have your explicit authority to execute this now?";
                 }
                 
                 output.action_required = 'NONE';
                 return output;
            }

            // ✅ PROGRESS FEEDBACK: Send the initial "Understood" message immediately if an action is about to happen
            // This prevents the user from waiting 30 seconds in silence
            if (output.action_required !== 'NONE' && output.reply_text) {
                logger.info({ action: output.action_required }, '📣 [SA] Sending initial acknowledgement to Admin');
                await messenger.sendPush(schoolId, message.from, output.reply_text);
                
                // Clear reply_text so the final synthesis turn can generate the FINAL success/failure message
                // This prevents duplicate responses.
                output.reply_text = "";
            }

            // 🔐 PHASE 1: MASTER AUTHORIZATION CHECK
            // Validate that admin user can perform the requested action
            const originalAction = output.action_required;
            if (output.action_required !== 'NONE') {
                const authResult = await this.validateActionAuthorization(
                    output.action_required,
                    message.from,
                    schoolId,
                    output
                );

                if (!authResult.authorized) {
                    logger.error({
                        action: output.action_required,
                        adminPhone: message.from,
                        reason: authResult.reason
                    }, '🔴 ACTION BLOCKED: Authorization failed');
                    
                    output.reply_text = `🔒 I cannot perform this action: ${authResult.reason || 'Insufficient permissions'}`;
                    output.action_required = 'NONE';
                    return output;
                }

                logger.info({
                    action: output.action_required,
                    adminPhone: message.from
                }, '✅ [SA] Authorization granted - proceeding with action');
            }

            // 🚀 NEW: SUPPORT MULTIPLE BACKEND ACTIONS
            const actionsToProcess = [];
            if (output.action_required !== 'NONE') {
                // ⚠️ CRITICAL: If action requires payload but payload is empty, log warning and skip
                const requiresPayload = ['MANAGE_STAFF', 'REGISTER_STUDENT', 'UPDATE_CONFIG', 'LOCK_RESULTS', 'RELEASE_RESULTS'].includes(output.action_required);
                if (requiresPayload && (!output.action_payload || Object.keys(output.action_payload).length === 0)) {
                    logger.error({ action: output.action_required, payload: output.action_payload }, '🔴 ACTION SKIPPED: Action requires payload but none provided');
                    output.reply_text = "I understood you want to add a teacher, but I need the teacher's name and phone number. Please provide both.";
                    output.action_required = 'NONE';
                } else {
                    actionsToProcess.push({ action: output.action_required, payload: output.action_payload });
                }
            }
            if (parsed.backend_actions && Array.isArray(parsed.backend_actions)) {
                for (const action of parsed.backend_actions) {
                    // Avoid duplicating the primary action
                    if (action.action !== output.action_required) {
                        actionsToProcess.push(action);
                    }
                }
            }

            for (const task of actionsToProcess) {
                const currentAction = task.action;
                const currentPayload = task.payload || {};
                const payload = currentPayload as any;

                logger.info({ currentAction, payload }, '🛠️ Processing SA Action');

                if (currentAction === 'REGISTER_TEACHER' || (currentAction === 'MANAGE_STAFF' && payload.action === 'ADD')) {
                    logger.info({ currentAction, payload }, '🛠️ Processing TEACHER REGISTRATION action');
                    
                    // Check if payload has required fields
                    if (!payload.name || !payload.phone) {
                        logger.error({ payload, action: currentAction }, '🔴 TEACHER REGISTRATION FAILED: Missing name or phone in payload');
                        output.reply_text = "I need the teacher's name and phone number to register them. Please provide both.";
                        output.action_required = 'NONE';
                        continue;
                    }

                    try {
                        // Execute teacher registration
                        const regResult = await this.executeTeacherRegistration(schoolId, payload);
                        if (regResult.success) {
                            if (!systemActionResult) systemActionResult = { results: [] };
                            if (!Array.isArray(systemActionResult.results)) systemActionResult.results = [];
                            systemActionResult.results.push({ type: 'TEACHER_REGISTRATION', ...regResult });
                        } else {
                            const errorResult = { success: false, error: regResult.error };
                            output.reply_text = await this.synthesizeActionResult('REGISTER_TEACHER_FAILED', errorResult, "Registration failed.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                            output.action_required = 'NONE';
                            return output;
                        }
                    } catch (error: any) {
                        logger.error({ error, payload }, 'REGISTER_TEACHER failed');
                        output.reply_text = "Failed to register teacher. Please try again.";
                        output.action_required = 'NONE';
                        return output;
                    }
                }

                if (currentAction === 'RELEASE_RESULTS') {
                    const classLevel = payload?.class_level;
                    const termId = payload?.term_id || 'current';

                    if (!classLevel) {
                        output.reply_text = "I need to know which class level you want to release results for.";
                        output.action_required = 'NONE';
                        continue;
                    }

                    try {
                        // 1. Mark all confirmed marks for this class as RELEASED
                        await new Promise<void>((resolve, reject) => {
                            db.getDB().run(
                                `UPDATE student_marks_indexed SET status = 'RELEASED' 
                                 WHERE school_id = ? AND class_level = ? AND term_id = ? AND confirmed_by_teacher = 1`,
                                [schoolId, classLevel, termId],
                                (err) => err ? reject(err) : resolve()
                            );
                        });

                        // 2. Trigger Batch Report Generation
                        const reportResult = await ReportService.generateBatchReports({
                            schoolId,
                            classLevel,
                            termId,
                            generateRemarks: true,
                            generatedBy: message.identity?.name || 'Admin'
                        });

                        // 3. Query all parents of students in this class
                        const parents = await this.getParentsForClass(schoolId, classLevel);
                        
                        // 4. Send proactive notifications to all parents
                        let notificationResult = { sent: 0, failed: 0, errors: [] as string[] };
                        if (parents.length > 0) {
                            logger.info({ classLevel, parentCount: parents.length }, '📢 Sending results notifications to parents');
                            notificationResult = await this.notifyParentsOfReleasedResults(parents, classLevel, schoolId);
                        }

                        systemActionResult = {
                            success: true,
                            action: 'RELEASE_RESULTS',
                            class_level: classLevel,
                            student_count: reportResult?.studentCount || 0,
                            pdf_path: reportResult?.filePath,
                            notifications: {
                                parents_notified: parents.length,
                                messages_sent: notificationResult.sent,
                                messages_failed: notificationResult.failed
                            }
                        };

                        logger.info({ 
                            classLevel, 
                            studentCount: systemActionResult.student_count,
                            parentsNotified: parents.length,
                            notificationsSent: notificationResult.sent
                        }, '✅ [AUTHORITY] Results RELEASED, Batch Reports generated, and Parents notified');
                    } catch (error) {
                        logger.error({ error, classLevel }, '❌ Failed to release results');
                        systemActionResult = { success: false, error: 'Database update or PDF generation failed' };
                    }
                }

                if (currentAction === 'APPROVE_MARK_AMENDMENT') {
                    const { student_id, student_name, subject, term_id, component, new_score, teacher_id, class_level } = payload;
                    
                    if (!student_id || !subject || new_score === undefined) {
                        systemActionResult = { success: false, error: 'Missing critical data for mark amendment' };
                    } else {
                        try {
                            // 1. Patch the official record
                            await AcademicRepository.updateMark(
                                student_id,
                                subject,
                                term_id || 'current',
                                component || 'exam',
                                Number(new_score),
                                schoolId,
                                teacher_id || 'admin_override',
                                student_name || 'Student',
                                class_level || 'Unknown'
                            );

                            // 2. Audit log
                            await AuditTrailService.logAuditEvent({
                                actor_phone: message.from,
                                action: 'APPROVE_MARK_AMENDMENT',
                                target_resource: `mark:${student_id}:${subject}`,
                                details: { student_name, subject, new_score, component }
                            });

                            // 3. Proactively generate new broadsheet for admin's peace of mind
                            const broadsheet = await ReportService.generateBroadsheet({
                                schoolId,
                                classLevel: class_level,
                                termId: term_id || 'current',
                                generatedBy: 'System (Post-Amendment)'
                            });

                            // 4. Notify teacher of approval
                            let teacherPhone = payload.teacher_phone;
                            if (!teacherPhone && pendingEscalation) {
                                teacherPhone = pendingEscalation.from_phone;
                            }
                            if (teacherPhone) {
                                const approvalMsg = `✅ *Amendment Approved*\n\nYour amendment request for *${student_name}* (${subject}) has been approved by the admin.\n\nChanged score to: *${new_score}*`;
                                await messenger.sendPush(schoolId, teacherPhone, approvalMsg);
                                logger.info({ teacherPhone, student_id, subject }, '📱 Teacher notified of amendment approval');
                            }

                            systemActionResult = { 
                                success: true, 
                                amended: true, 
                                student_name, 
                                subject, 
                                new_score,
                                pdf_path: broadsheet?.filePath 
                            };

                            // Deliver updated broadsheet to Admin immediately
                            if (broadsheet?.filePath) {
                                await messenger.sendDocument(schoolId, message.from, broadsheet.filePath, `📊 Updated Broadsheet for ${class_level} (After Amendment)`);
                            }

                        } catch (error) {
                            logger.error({ error, student_id }, 'APPROVE_MARK_AMENDMENT failed');
                            systemActionResult = { success: false, error: 'Database update failed' };
                        }
                    }
                }

                if (currentAction === 'DENY_MARK_AMENDMENT') {
                    const { student_id, student_name, subject, term_id, component, teacher_id, class_level, denial_reason } = payload;
                    
                    try {
                        // 1. Audit log for denial
                        await AuditTrailService.logAuditEvent({
                            actor_phone: message.from,
                            action: 'DENY_MARK_AMENDMENT',
                            target_resource: `mark:${student_id}:${subject}`,
                            details: { student_name, subject, component, denial_reason }
                        });

                        // 2. Notify teacher of denial
                        let teacherPhone = payload.teacher_phone;
                        if (!teacherPhone && pendingEscalation) {
                            teacherPhone = pendingEscalation.from_phone;
                        }
                        if (teacherPhone) {
                            const denialMsg = `❌ *Amendment Denied*\n\nYour amendment request for *${student_name}* (${subject}) has been denied by the admin.\n\n${denial_reason ? `Reason: ${denial_reason}\n\n` : ''}Please contact the admin if you have questions.`;
                            await messenger.sendPush(schoolId, teacherPhone, denialMsg);
                            logger.info({ teacherPhone, student_id, subject }, '📱 Teacher notified of amendment denial');
                        }

                        systemActionResult = { 
                            success: true, 
                            denied: true, 
                            student_name, 
                            subject, 
                            denial_reason
                        };

                    } catch (error) {
                        logger.error({ error, student_id }, 'DENY_MARK_AMENDMENT failed');
                        systemActionResult = { success: false, error: 'Denial processing failed' };
                    }
                }

                if (currentAction === 'REGISTER_STUDENT' && payload.registration_data_confirmed) {
                    const regResult = await this.executeStudentRegistration(schoolId, currentPayload, output);
                    if (regResult.success) {
                        if (!systemActionResult) systemActionResult = { results: [] };
                        if (!Array.isArray(systemActionResult.results)) systemActionResult.results = [];
                        systemActionResult.results.push({ type: 'STUDENT_REGISTRATION', ...regResult });
                    } else {
                        const errorResult = { success: false, error: regResult.error };
                        output.reply_text = await this.synthesizeActionResult('REGISTER_STUDENT_FAILED', errorResult, "Registration failed.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                        output.action_required = 'NONE';
                        return output;
                    }
                }

                if (currentAction === 'REGISTER_TEACHER' || (currentAction === 'MANAGE_STAFF' && payload.action === 'ADD')) {
                    logger.info({ currentAction, payload }, '🛠️ Processing TEACHER REGISTRATION action');
                    
                    // Check if payload has required fields
                    if (!payload.name || !payload.phone) {
                        logger.error({ payload, action: currentAction }, '🔴 TEACHER REGISTRATION FAILED: Missing name or phone in payload');
                        output.reply_text = "I need the teacher's name and phone number to register them. Please provide both.";
                        output.action_required = 'NONE';
                        continue;
                    }
                    
                    const regResult = await this.executeTeacherRegistration(schoolId, payload);
                    if (regResult.success) {
                        if (!systemActionResult) systemActionResult = { results: [] };
                        if (!Array.isArray(systemActionResult.results)) systemActionResult.results = [];
                        systemActionResult.results.push({ type: 'TEACHER_REGISTRATION', ...regResult });
                    } else {
                        const errorResult = { success: false, error: regResult.error };
                        output.reply_text = await this.synthesizeActionResult('REGISTER_TEACHER_FAILED', errorResult, "Registration failed.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                        output.action_required = 'NONE';
                        return output;
                    }
                }

                if (currentAction === 'MANAGE_STAFF' && payload.action === 'REMOVE') {
                    try {
                        const { name, phone } = payload;
                        await new Promise<void>((resolve, reject) => {
                            db.getDB().run(
                                `DELETE FROM users WHERE school_id = ? AND (name = ? OR phone = ?) AND role = 'teacher'`,
                                [schoolId, name, phone],
                                (err) => err ? reject(err) : resolve()
                            );
                        });
                        if (!systemActionResult) systemActionResult = { results: [] };
                        if (!Array.isArray(systemActionResult.results)) systemActionResult.results = [];
                        systemActionResult.results.push({ type: 'STAFF_REMOVAL', success: true, name });
                    } catch (error) {
                        logger.error({ error, payload }, 'MANAGE_STAFF:REMOVE failed');
                    }
                }

                if (currentAction === 'UPDATE_CONFIG') {
                    const { category, value, details } = payload;
                    try {
                        if (category === 'FEES') {
                            await new Promise<void>((resolve, reject) => {
                                db.getDB().run(
                                    `UPDATE schools SET fees_config = ? WHERE id = ?`,
                                    [JSON.stringify(payload), schoolId],
                                    (err) => err ? reject(err) : resolve()
                                );
                            });
                        } else if (category === 'GRADING') {
                            await new Promise<void>((resolve, reject) => {
                                db.getDB().run(
                                    `UPDATE schools SET grading_config = ? WHERE id = ?`,
                                    [JSON.stringify(payload), schoolId],
                                    (err) => err ? reject(err) : resolve()
                                );
                            });
                        }
                        if (!systemActionResult) systemActionResult = { results: [] };
                        if (!Array.isArray(systemActionResult.results)) systemActionResult.results = [];
                        systemActionResult.results.push({ type: 'CONFIG_UPDATE', success: true, category });
                    } catch (error) {
                        logger.error({ error, payload }, 'UPDATE_CONFIG failed');
                    }
                }

                if (currentAction === 'LOCK_RESULTS') {
                    const termId = payload.term_id;
                    const classLevel = payload.name;
                    if (!termId || !classLevel) {
                        const errorResult = { success: false, error: 'Missing term_id or class_level', required: ['term_id', 'class_level'] };
                        output.reply_text = await this.synthesizeActionResult('LOCK_RESULTS_ERROR', errorResult, "I need more info.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                        output.action_required = 'NONE';
                        return output;
                    }
                    try {
                        await AdminRepository.lockTermResultsWithAudit(schoolId, termId, classLevel, message.from);
                        if (!systemActionResult) systemActionResult = {};
                        systemActionResult.lock_status = { success: true, locked: true, termId, classLevel };
                    } catch (error) {
                        const errorResult = { success: false, error: 'Database error' };
                        output.reply_text = await this.synthesizeActionResult('LOCK_RESULTS_FAILED', errorResult, "System error.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                        output.action_required = 'NONE';
                        return output;
                    }
                }

                // ... other actions can be converted to this loop pattern as needed
                // For now, let's just make sure student/teacher both work
            }

            // Fallback for actions not yet in the loop (to maintain compatibility)
            if (output.action_required === 'UNLOCK_RESULTS' && !systemActionResult?.results) {
                // Keep existing UNLOCK_RESULTS logic...
            }

            if (output.action_required === 'UNLOCK_RESULTS') {
                const termId = output.action_payload?.term_id;
                const classLevel = output.action_payload?.name;
                const reason = output.action_payload?.reason || 'No reason provided';
                
                if (!termId || !classLevel) {
                    const errorResult = { success: false, error: 'Missing term_id or class_level', required: ['term_id', 'class_level'] };
                    output.reply_text = await this.synthesizeActionResult('UNLOCK_RESULTS_ERROR', errorResult, "I need more info.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                    output.action_required = 'NONE';
                    return output;
                }

                try {
                    await AdminRepository.unlockTermResultsWithAudit(schoolId, termId, classLevel, message.from, reason);
                    systemActionResult = { success: true, unlocked: true, termId, classLevel };
                    output.action_required = 'NONE';
                } catch (error) {
                    logger.error({ error, termId, classLevel }, 'UNLOCK_RESULTS failed');
                    const errorResult = { success: false, error: 'Database error while unlocking results' };
                    output.reply_text = await this.synthesizeActionResult('UNLOCK_RESULTS_FAILED', errorResult, "System error.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                    output.action_required = 'NONE';
                }
            }

            if (output.action_required === 'CONFIRM_PAYMENT') {
                const transactionId = output.action_payload?.transaction_id;
                const reason = output.action_payload?.reason || 'Payment confirmed by admin';
                
                if (!transactionId) {
                    const errorResult = { success: false, error: 'Missing transaction_id', required: ['transaction_id'] };
                    output.reply_text = await this.synthesizeActionResult('CONFIRM_PAYMENT_ERROR', errorResult, "I need the transaction ID.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                    output.action_required = 'NONE';
                    return output;
                }

                try {
                    // 🔐 PHASE 2 FIX: Link payment to escalation if this is from escalation context
                    const escalationId = (output as any).escalation_payload?.escalation_id;
                    
                    // Confirm transaction
                    await TransactionRepository.confirmTransaction(transactionId, message.from, reason);
                    
                    // 🔐 PHASE 2: Record escalation decision if this payment is from an escalation
                    if (escalationId) {
                        await EscalationRepository.recordAdminDecision(escalationId, {
                            admin_decision: 'APPROVE',
                            admin_instruction: `Payment confirmed by admin`,
                            resolved_by: message.from,
                            school_id: schoolId
                        });
                        logger.info({ escalationId, transactionId }, '✅ [PHASE 2] Payment linked to escalation');
                    }
                    
                    // Get transaction details to notify parent
                    const transaction = await TransactionRepository.getTransaction(transactionId);
                    
                    if (transaction) {
                        // Notify parent of confirmation
                        const confirmationMsg = `✅ *Payment Confirmed*\n\nYour payment of *₦${transaction.amount}* for ${transaction.studentId} has been confirmed by the school admin.\n\nThank you for your prompt payment.`;
                        await messenger.sendPush(schoolId, transaction.payerPhone, confirmationMsg);

                        // 🧠 MEMORY: Record in parent history
                        await HistoryManager.recordMessage(schoolId, transaction.studentId, transaction.payerPhone, 'PA',
                            { type: 'text', body: `[PAYMENT CONFIRMED] ₦${transaction.amount} for ${transaction.studentId}`, timestamp: Date.now(), source: 'system' },
                            { action: 'CONFIRM_PAYMENT', status: 'COMPLETED' }
                        );
                    }

                    systemActionResult = { success: true, confirmed: true, amount: transaction?.amount, student_id: transaction?.studentId };
                    output.action_required = 'NONE';
                } catch (error) {
                    logger.error({ error, transactionId }, 'CONFIRM_PAYMENT failed');
                    const errorResult = { success: false, error: 'Database error while confirming payment' };
                    output.reply_text = await this.synthesizeActionResult('CONFIRM_PAYMENT_FAILED', errorResult, "System error.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                    output.action_required = 'NONE';
                }
            } else if (output.action_required === 'REJECT_PAYMENT') {
                const transactionId = output.action_payload?.transaction_id;
                const reason = output.action_payload?.reason || 'Payment rejected by admin';
                
                if (!transactionId) {
                    const errorResult = { success: false, error: 'Missing transaction_id', required: ['transaction_id'] };
                    output.reply_text = await this.synthesizeActionResult('REJECT_PAYMENT_ERROR', errorResult, "I need the transaction ID.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                    output.action_required = 'NONE';
                    return output;
                }

                try {
                    // 🔐 PHASE 2 FIX: Link payment rejection to escalation if applicable
                    const escalationId = (output as any).escalation_payload?.escalation_id;
                    
                    // Reject transaction
                    await TransactionRepository.rejectTransaction(transactionId, message.from, reason);
                    
                    // 🔐 PHASE 2: Record escalation decision
                    if (escalationId) {
                        await EscalationRepository.recordAdminDecision(escalationId, {
                            admin_decision: 'REJECT',
                            admin_instruction: `Payment rejected. Reason: ${reason}`,
                            resolved_by: message.from,
                            school_id: schoolId
                        });
                        logger.info({ escalationId, transactionId }, '✅ [PHASE 2] Payment rejection linked to escalation');
                    }
                    
                    // Get transaction details to notify parent
                    const transaction = await TransactionRepository.getTransaction(transactionId);
                    
                    if (transaction) {
                        // Notify parent of rejection
                        const rejectionMsg = `❌ *Payment Rejected*\n\nYour payment of *₦${transaction.amount}* for ${transaction.studentId} could not be confirmed.\n\nReason: ${reason}\n\nPlease contact the school office for clarification.`;
                        await messenger.sendPush(schoolId, transaction.payerPhone, rejectionMsg);

                        // 🧠 MEMORY: Record in parent history
                        await HistoryManager.recordMessage(schoolId, transaction.studentId, transaction.payerPhone, 'PA',
                            { type: 'text', body: `[PAYMENT REJECTED] ₦${transaction.amount} for ${transaction.studentId}. Reason: ${reason}`, timestamp: Date.now(), source: 'system' },
                            { action: 'REJECT_PAYMENT', status: 'COMPLETED' }
                        );
                    }

                    systemActionResult = { success: true, rejected: true, reason, amount: transaction?.amount, student_id: transaction?.studentId };
                    output.action_required = 'NONE';
                } catch (error) {
                    logger.error({ error, transactionId }, 'REJECT_PAYMENT failed');
                    const errorResult = { success: false, error: 'Database error while rejecting payment' };
                    output.reply_text = await this.synthesizeActionResult('REJECT_PAYMENT_FAILED', errorResult, "System error.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                    output.action_required = 'NONE';
                }
            }

            if (output.action_required === 'GET_TEACHER_TOKEN') {
                // Support both single and bulk fetch
                const classLevel = output.action_payload?.class_level;
                const teacherName = output.action_payload?.name;
                const classLevels = output.action_payload?.class_levels || [];
                const teacherNames = output.action_payload?.teacher_names || [];
                
                // Build list of queries from single or array inputs
                let queries: string[] = [];
                if (classLevels.length > 0) {
                    queries = classLevels;
                } else if (teacherNames.length > 0) {
                    queries = teacherNames;
                } else if (classLevel) {
                    queries = [classLevel];
                } else if (teacherName) {
                    queries = [teacherName];
                }
                
                if (queries.length === 0) {
                    output.reply_text = `I need either class level(s) (e.g., "Primary 3") or teacher name(s) to fetch token(s). Please specify.`;
                    output.action_required = 'NONE';
                    return output;
                }
                
                try {
                    // Fetch tokens for all queries
                    const tokens: any[] = [];
                    for (const query of queries) {
                        const sql = `
                            SELECT t.token, u.name, u.assigned_class 
                            FROM teacher_access_tokens t
                            JOIN users u ON t.teacher_id = u.id
                            WHERE (u.assigned_class = ? OR u.name LIKE ? OR u.assigned_class LIKE ?) AND t.is_revoked = 0
                            LIMIT 1
                        `;
                        const row: any = await new Promise((resolve) => {
                            db.getDB().get(sql, [query, `%${query}%`, `%${query}%`], (err, row) => resolve(row));
                        });
                        
                        if (row) {
                            tokens.push(row);
                        }
                    }
                    
                    if (tokens.length === 0) {
                        output.reply_text = `I couldn't find active tokens for those queries.`;
                    }

                    // Audit log the token fetch
                    await AuditTrailService.logAuditEvent({
                        actor_phone: message.from,
                        action: 'GET_TEACHER_TOKEN',
                        target_resource: `teacher:${queries.join(',')}`,
                        details: { queries, tokens_retrieved: tokens.length }
                    });

                    systemActionResult = { 
                        success: tokens.length > 0, 
                        tokens_found: tokens.length, 
                        teachers: tokens.map(t => ({ name: t.name, class: t.assigned_class, token: t.token })) 
                    };
                    output.action_required = 'NONE';
                    
                } catch (error) {
                    logger.error({ error, queries }, 'GET_TEACHER_TOKEN failed');
                    output.reply_text = "I couldn't retrieve the tokens. Please try again with valid teacher names or classes.";
                    output.action_required = 'NONE';
                }
            }

            if (output.action_required === 'REVOKE_TEACHER_TOKEN') {
                // Priority: use class_level if provided, else use name
                const classLevel = output.action_payload?.class_level;
                const teacherName = output.action_payload?.name;
                
                let query = classLevel || teacherName;
                if (!query) {
                    output.reply_text = `I need either a class (e.g., "Primary 3") or teacher name to revoke the token. What's the class or teacher name?`;
                    output.action_required = 'NONE';
                    return output;
                }
                
                try {
                    await new Promise((resolve, reject) => {
                        db.getDB().run(
                            `UPDATE teacher_access_tokens SET is_revoked = 1 WHERE teacher_id IN (SELECT id FROM users WHERE assigned_class = ? OR name LIKE ?)`,
                            [query, `%${query}%`],
                            (err) => err ? reject(err) : resolve(null)
                        );
                    });
                    
                    // Audit log the token revocation
                    await AuditTrailService.logAuditEvent({
                        actor_phone: message.from,
                        action: 'REVOKE_TOKEN',
                        target_resource: `teacher:${query}`,
                        details: { teacher_query: query, used_field: classLevel ? 'class_level' : 'name' }
                    });
                    
                    systemActionResult = { success: true, revoked: true, target: query };
                    output.action_required = 'NONE';
                } catch (error) {
                    logger.error({ error, query }, 'REVOKE_TEACHER_TOKEN failed');
                    output.reply_text = "I couldn't revoke the token. Please verify the teacher name or class exists in the system.";
                    output.action_required = 'NONE';
                }
            }

            // NEW: RELEASE_RESULTS is handled in the actionsToProcess loop above.
            if (output.action_required as any === 'RELEASE_RESULTS_LEGACY') {
                // ... legacy code removed ...
            }

            // PROPOSE_AMENDMENT handler
            if (output.action_required === 'PROPOSE_AMENDMENT') {
                if (!output.intent_clear || !output.authority_acknowledged) {
                    output.reply_text = "Amendment proposals require explicit confirmation of authority and clear intent. Please confirm you understand the scope and impact.";
                    output.action_required = 'NONE';
                    return output;
                }

                const { amendment_type, impact_scope, raw_change_intent, proposal_summary } = output.action_payload || {};
                
                if (!amendment_type || !impact_scope) {
                    output.reply_text = "I need to know the amendment type (GRADING, TERMS, FEES, SUBJECTS, TEACHERS) and scope (FUTURE_ONLY, CURRENT_TERM, HISTORICAL).";
                    output.action_required = 'NONE';
                    return output;
                }

                try {
                    const amendmentId = uuidv4();
                    await new Promise<void>((resolve, reject) => {
                        db.getDB().run(
                            `INSERT INTO amendment_requests (id, school_id, requested_by, amendment_type, payload, impact_scope, status)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [amendmentId, schoolId, message.from, amendment_type, JSON.stringify({
                                summary: proposal_summary,
                                raw_intent: raw_change_intent,
                                timestamp: new Date().toISOString()
                            }), impact_scope, 'AWAITING_CONFIRMATION'],
                            (err) => err ? reject(err) : resolve()
                        );
                    });

                    // Audit log the proposal
                    await AuditTrailService.logAuditEvent({
                        actor_phone: message.from,
                        action: 'PROPOSE_AMENDMENT',
                        target_resource: `amendment:${amendmentId}`,
                        details: { type: amendment_type, scope: impact_scope, intent: raw_change_intent }
                    });

                    systemActionResult = { success: true, proposed: true, amendment_id: amendmentId, type: amendment_type, scope: impact_scope };
                    output.action_required = 'NONE';
                } catch (error) {
                    logger.error({ error, amendment_type, impact_scope }, 'PROPOSE_AMENDMENT failed');
                    output.reply_text = "I couldn't create the amendment proposal. Please try again with clearer details.";
                    output.action_required = 'NONE';
                }
            }

            // CONFIRM_AMENDMENT handler
            if (output.action_required === 'CONFIRM_AMENDMENT') {
                if (!output.intent_clear || !output.authority_acknowledged) {
                    output.reply_text = "Confirming an amendment requires explicit authorization. Please confirm you have the authority to make this change permanent.";
                    output.action_required = 'NONE';
                    return output;
                }

                const { amendment_id } = output.action_payload || {};
                if (!amendment_id) {
                    output.reply_text = "I need the amendment ID to confirm. Please provide the ID from the proposal.";
                    output.action_required = 'NONE';
                    return output;
                }

                try {
                    // Check amendment exists and is in correct status
                    const amendment: any = await new Promise((resolve, reject) => {
                        db.getDB().get(
                            `SELECT * FROM amendment_requests WHERE id = ? AND school_id = ?`,
                            [amendment_id, schoolId],
                            (err, row) => err ? reject(err) : resolve(row)
                        );
                    });

                    if (!amendment) {
                        output.reply_text = `Amendment ${amendment_id.substring(0, 8)} not found.`;
                        output.action_required = 'NONE';
                        return output;
                    }

                    if (amendment.status !== 'AWAITING_CONFIRMATION' && amendment.status !== 'DRAFT') {
                        output.reply_text = `Amendment is in "${amendment.status}" status and cannot be confirmed. You can only confirm proposals awaiting confirmation.`;
                        output.action_required = 'NONE';
                        return output;
                    }

                    // 🔐 PHASE 2 FIX: Link amendment to escalation if this is from escalation context
                    const escalationId = (output as any).escalation_payload?.escalation_id;

                    // Update amendment status to APPROVED
                    await new Promise<void>((resolve, reject) => {
                        db.getDB().run(
                            `UPDATE amendment_requests SET status = 'APPROVED' WHERE id = ?`,
                            [amendment_id],
                            (err) => err ? reject(err) : resolve()
                        );
                    });

                    // 🔐 PHASE 2: Record escalation decision if this amendment is from an escalation
                    if (escalationId) {
                        await EscalationRepository.recordAdminDecision(escalationId, {
                            admin_decision: 'APPROVE',
                            admin_instruction: `Amendment (${amendment.amendment_type}) confirmed and applied`,
                            resolved_by: message.from,
                            school_id: schoolId
                        });
                        logger.info({ escalationId, amendment_id }, '✅ [PHASE 2] Amendment linked to escalation');
                    }

                    // Log confirmation in audit trail
                    await AuditTrailService.logAuditEvent({
                        actor_phone: message.from,
                        action: 'CONFIRM_AMENDMENT',
                        target_resource: `amendment:${amendment_id}`,
                        details: { previous_status: amendment.status, new_status: 'APPROVED', escalation_linked: !!escalationId }
                    });

                    // Log to amendment audit log
                    await new Promise<void>((resolve, reject) => {
                        db.getDB().run(
                            `INSERT INTO amendment_audit_log (amendment_id, action_taken, actor_role, notes)
                             VALUES (?, ?, ?, ?)`,
                            [amendment_id, 'CONFIRMED', 'SA', `Confirmed by ${message.from}${escalationId ? ' (from escalation)' : ''}`],
                            (err) => err ? reject(err) : resolve()
                        );
                    });

                    systemActionResult = { success: true, confirmed: true, type: amendment.amendment_type, scope: amendment.impact_scope };
                    output.action_required = 'NONE';
                } catch (error) {
                    logger.error({ error, amendment_id }, 'CONFIRM_AMENDMENT failed');
                    output.reply_text = "I couldn't confirm the amendment. Please verify the amendment ID and try again.";
                    output.action_required = 'NONE';
                }
            }

            // CLOSE_ALL_ESCALATIONS handler - bulk close all pending escalations
            if (output.action_required === 'CLOSE_ALL_ESCALATIONS') {
                if (!output.intent_clear || !output.authority_acknowledged) {
                    output.reply_text = "Closing all pending escalations is a sensitive action. Please confirm explicitly that you have the authority and understand this will resolve all pending escalations immediately.";
                    output.action_required = 'NONE';
                    return output;
                }

                try {
                    // Get all pending escalations for this school
                    const pendingEscalations: any[] = await new Promise((resolve, reject) => {
                        db.getDB().all(
                            `SELECT id, origin_agent, reason, created_at FROM escalations WHERE school_id = ? AND status IN ('PAUSED', 'AWAITING_CLARIFICATION')`,
                            [schoolId],
                            (err, rows) => err ? reject(err) : resolve(rows || [])
                        );
                    });

                    if (pendingEscalations.length === 0) {
                        output.reply_text = "There are no pending escalations to close. All escalations are resolved.";
                        output.action_required = 'NONE';
                        return output;
                    }

                    // Get admin decision and instruction
                    const adminDecision = (output.escalation_payload?.admin_decision || 'APPROVE').toUpperCase();
                    const adminInstruction = output.escalation_payload?.admin_instruction || output.reply_text || 'All pending escalations have been reviewed and resolved by admin. Please resume normal operations.';

                    // Close all escalations
                    const closedIds: string[] = [];
                    for (const escalation of pendingEscalations) {
                        try {
                            // Use repository to persist admin decision
                            await EscalationRepository.recordAdminDecision(escalation.id, {
                                admin_decision: adminDecision,
                                admin_instruction: adminInstruction,
                                resolved_by: message.from,
                                school_id: schoolId
                            });

                            // Record escalation resolution to conversation memory
                            const { HistoryManager } = await import('../../core/memory/history-manager');
                            await HistoryManager.recordMessage(
                                schoolId,
                                undefined,  // no specific user
                                'SA_SYSTEM',
                                'SA',
                                {
                                    type: 'escalation_decision',
                                    body: `[ESCALATION RESOLVED]\nID: ${escalation.id}\nAdmin Decision: ${adminDecision}\nInstruction: ${adminInstruction}`,
                                    timestamp: Date.now(),
                                    source: 'system'
                                },
                                {
                                    action: 'ESCALATION_RESOLVED',
                                    status: 'COMPLETED'
                                }
                            );

                            // Log the closure in audit trail
                            const { EscalationAuditService } = await import('../../services/escalation-audit');
                            await EscalationAuditService.logEscalationResolved(escalation.id, schoolId);

                            closedIds.push(escalation.id);
                            logger.info({ escalationId: escalation.id, adminDecision }, '✅ Escalation closed via CLOSE_ALL_ESCALATIONS');
                        } catch (closeError) {
                            logger.error({ escalationId: escalation.id, closeError }, '❌ Failed to close individual escalation in bulk operation');
                        }
                    }

                    // Audit log the bulk closure
                    await AuditTrailService.logAuditEvent({
                        actor_phone: message.from,
                        action: 'CLOSE_ALL_ESCALATIONS',
                        target_resource: `escalations:bulk:${schoolId}`,
                        details: { closed_count: closedIds.length, escalation_ids: closedIds, decision: adminDecision }
                    });

                    systemActionResult = { success: true, closed_count: closedIds.length, decision: adminDecision };
                    output.action_required = 'NONE';
                } catch (error) {
                    logger.error({ error, schoolId }, 'CLOSE_ALL_ESCALATIONS failed');
                    output.reply_text = "I couldn't close all escalations. Please check the system and try again.";
                    output.action_required = 'NONE';
                }
            }

            // APPROVE_MARK_SUBMISSION handler
            if (output.action_required === 'APPROVE_MARK_SUBMISSION') {
                let workflowId = output.action_payload?.workflow_id;
                let pdfId = output.action_payload?.pdf_id;
                const adminNotes = output.action_payload?.admin_notes || 'Marks approved by admin';
                const teacherId = output.action_payload?.teacher_id;

                // ✅ INTELLIGENT MATCHING: If IDs missing, try to find by subject/class OR pending escalation
                if (!workflowId) {
                    const subject = output.action_payload?.subject;
                    const classLevel = output.action_payload?.class_level || output.action_payload?.name;
                    
                    if (subject || classLevel) {
                        logger.info({ subject, classLevel }, '🔍 [SA] Attempting intelligent workflow resolution');
                        const latestWorkflow: any = await new Promise((resolve) => {
                            db.getDB().get(
                                `SELECT id FROM mark_submission_workflow 
                                 WHERE school_id = ? AND (subject LIKE ? OR class_level LIKE ?)
                                 ORDER BY (CASE WHEN current_status = 'SUBMITTED' THEN 1 ELSE 2 END), submitted_at DESC LIMIT 1`,
                                [schoolId, `%${subject}%`, `%${classLevel}%`],
                                (err, row) => resolve(row)
                            );
                        });
                        if (latestWorkflow) {
                            workflowId = latestWorkflow.id;
                            logger.info({ workflowId }, '✅ [SA] Resolved workflowId via fuzzy match');
                        }
                    } else {
                        // 🧠 E2E ROBUSTNESS: Check if there's a PENDING escalation for mark submission
                        const pendingEscalation: any = await new Promise((resolve) => {
                            db.getDB().get(
                                `SELECT context FROM escalations 
                                 WHERE school_id = ? AND type = 'MARK_SUBMISSION_APPROVAL' AND status = 'PENDING'
                                 LIMIT 1`,
                                [schoolId],
                                (err, row) => resolve(row)
                            );
                        });
                        if (pendingEscalation) {
                            const context = JSON.parse(pendingEscalation.context || '{}');
                            workflowId = context.workflow_id;
                            logger.info({ workflowId }, '✅ [SA] Resolved workflowId via pending escalation context');
                        }
                    }
                }

                if (!pdfId && workflowId) {
                    const latestPdf: any = await new Promise((resolve) => {
                        db.getDB().get(
                            `SELECT id FROM pdf_documents WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1`,
                            [workflowId],
                            (err, row) => resolve(row)
                        );
                    });
                    if (latestPdf) pdfId = latestPdf.id;
                }

                try {
                    // 1. Update mark submission workflow status
                    await new Promise<void>((resolve, reject) => {
                        db.getDB().run(
                            `UPDATE mark_submission_workflow 
                             SET current_status = 'HUMAN_APPROVED',
                                 admin_decision = 'APPROVE',
                                 admin_decision_notes = ?,
                                 admin_decision_at = CURRENT_TIMESTAMP,
                                 admin_phone = ?
                             WHERE id = ?`,
                            [adminNotes, message.from, workflowId],
                            (err) => err ? reject(err) : resolve()
                        );
                    });

                    // 2. Update PDF document status
                    await new Promise<void>((resolve, reject) => {
                        db.getDB().run(
                            `UPDATE pdf_documents 
                             SET status = 'ADMIN_APPROVED',
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = ?`,
                            [pdfId],
                            (err) => err ? reject(err) : resolve()
                        );
                    });

                    // 3. Log the interaction
                    await AuditTrailService.logAuditEvent({
                        actor_phone: message.from,
                        action: 'APPROVE_MARK_SUBMISSION',
                        target_resource: `mark_submission:${workflowId}`,
                        details: {
                            workflow_id: workflowId,
                            pdf_id: pdfId,
                            teacher_id: teacherId,
                            admin_notes: adminNotes,
                            timestamp: new Date().toISOString()
                        }
                    });

                    // 4. Get workflow details to notify teacher
                    const workflow: any = await new Promise((resolve) => {
                        db.getDB().get(
                            `SELECT teacher_phone, subject, class_level, student_count, term_id, escalation_id FROM mark_submission_workflow WHERE id = ?`,
                            [workflowId],
                            (err, row) => resolve(row)
                        );
                    });

                    // 5. Notify teacher of approval (if phone available)
                    if (workflow?.teacher_phone) {
                        const confirmMsg = `✅ *Mark Sheet Approved*\n\n${workflow.subject} (${workflow.class_level}) - ${workflow.student_count} students\n\nYour mark sheet has been approved by the school admin and is now finalized.`;
                        
                        // 🧠 GOD MODE: Proactively generate the full report cards now that this subject is approved
                        logger.info({ classLevel: workflow.class_level }, '🧬 [GOD_MODE] Proactively generating terminal reports');
                        
                                                try {
                        
                                                    const reportBatch = await ReportService.generateBatchReports({
                        
                                                        schoolId,
                        
                                                        classLevel: workflow.class_level,
                        
                                                        termId: workflow.term_id || 'current',
                        
                                                        workflowId: workflowId, // Link to this workflow
                        
                                                        generateRemarks: true,
                        
                                                        generatedBy: 'Kumo Academic Orchestrator'
                        
                                                    });
                        
                        
                        
                                                    if (reportBatch) {
                        
                                                        // A. Deliver to Admin immediately (keeps them in the loop)
                        
                                                        await messenger.sendDocument(schoolId, message.from, reportBatch.filePath, `📄 Final Terminal Reports: ${workflow.class_level}`);
                        
                                                        
                        
                                                        // B. Inject into escalation context for unified delivery via Resumption Handler
                        
                                                        // This ensures the Teacher gets a single, cohesive resumption turn.
                        
                                                        if (!(output as any).escalation_payload) {
                        
                                                            (output as any).escalation_payload = {
                        
                                                                escalation_id: (message as any).escalation_id || workflow.escalation_id,
                        
                                                                admin_decision: 'APPROVE',
                        
                                                                admin_instruction: output.reply_text || 'Marks approved.'
                        
                                                            };
                        
                                                        }
                        
                                                        
                        
                                                        (output as any).escalation_payload.admin_instruction += `\n\nI have also proactively generated and signed the final terminal reports for ${workflow.class_level} with intelligent remarks. Please deliver PDF: ${reportBatch.filePath}`;
                        
                                                        (output as any).escalation_payload.pdf_path = reportBatch.filePath;
                        
                        

                            

                                                            // 🧠 MEMORY: Record the proactive act in teacher history

                                                            await HistoryManager.recordMessage(schoolId, teacherId, workflow.teacher_phone, 'TA',

                                                                { type: 'text', body: `[PROACTIVE REPORT GENERATION] Full reports generated for ${workflow.class_level}`, timestamp: Date.now(), source: 'system' },

                                                                { action: 'GENERATE_PDF', status: 'COMPLETED' }

                                                            );

                                                        }

                             else {
                                await messenger.sendPush(schoolId, workflow.teacher_phone, `${confirmMsg}\n\nResults will be released to parents shortly. Thank you for your timely submission.`);
                            }
                        } catch (reportErr) {
                            logger.error({ reportErr }, '❌ Failed to generate proactive reports during approval');
                            await messenger.sendPush(schoolId, workflow.teacher_phone, `${confirmMsg}\n\nResults will be released to parents shortly. Thank you for your timely submission.`);
                        }
                    }

                    logger.info({
                        workflowId,
                        pdfId,
                        teacherId,
                        actor: message.from
                    }, '✅ Mark submission approved by SA');

                    systemActionResult = { success: true, approved: true, subject: workflow?.subject, classLevel: workflow?.class_level };
                    output.action_required = 'NONE';
                } catch (error) {
                    logger.error({ error, workflowId, pdfId }, 'APPROVE_MARK_SUBMISSION failed');
                    const errorResult = { success: false, error: 'Database error while approving marks' };
                    output.reply_text = await this.synthesizeActionResult('APPROVE_MARK_FAILED', errorResult, "System error.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                    output.action_required = 'NONE';
                }
            }

            // REQUEST_MARK_CORRECTION handler
            if (output.action_required === 'REQUEST_MARK_CORRECTION') {
                const workflowId = output.action_payload?.workflow_id;
                const pdfId = output.action_payload?.pdf_id;
                const correctionReason = output.action_payload?.correction_reason || 'Please review and correct submitted marks';
                const correctionInstructions = output.action_payload?.correction_instructions || correctionReason;
                const flaggedRows = output.action_payload?.flagged_rows || [];
                const teacherId = output.action_payload?.teacher_id;

                if (!workflowId || !pdfId) {
                    const errorResult = { success: false, error: 'Missing workflow or PDF ID' };
                    output.reply_text = await this.synthesizeActionResult('MARK_CORRECTION_ERROR', errorResult, "I need more info.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                    output.action_required = 'NONE';
                    return output;
                }

                try {
                    // 1. Update mark submission workflow status
                    await new Promise<void>((resolve, reject) => {
                        db.getDB().run(
                            `UPDATE mark_submission_workflow 
                             SET current_status = 'AWAITING_CORRECTION',
                                 admin_decision = 'REQUEST_CORRECTION',
                                 admin_decision_notes = ?,
                                 admin_decision_at = CURRENT_TIMESTAMP,
                                 admin_phone = ?
                             WHERE id = ?`,
                            [correctionReason, message.from, workflowId],
                            (err) => err ? reject(err) : resolve()
                        );
                    });

                    // 2. Update PDF document status
                    await new Promise<void>((resolve, reject) => {
                        db.getDB().run(
                            `UPDATE pdf_documents 
                             SET status = 'RETURNED_FOR_CORRECTION',
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = ?`,
                            [pdfId],
                            (err) => err ? reject(err) : resolve()
                        );
                    });

                    // 3. Log the interaction
                    await AuditTrailService.logAuditEvent({
                        actor_phone: message.from,
                        action: 'REQUEST_MARK_CORRECTION',
                        target_resource: `mark_submission:${workflowId}`,
                        details: {
                            workflow_id: workflowId,
                            pdf_id: pdfId,
                            teacher_id: teacherId,
                            correction_reason: correctionReason,
                            flagged_rows: flaggedRows,
                            timestamp: new Date().toISOString()
                        }
                    });

                    // 4. Get workflow details to notify teacher
                    const workflow: any = await new Promise((resolve) => {
                        db.getDB().get(
                            `SELECT teacher_phone, subject, class_level, student_count FROM mark_submission_workflow WHERE id = ?`,
                            [workflowId],
                            (err, row) => resolve(row)
                        );
                    });

                    // 5. Notify teacher with specific correction instructions
                    if (workflow?.teacher_phone) {
                        let rowsNote = '';
                        if (flaggedRows && flaggedRows.length > 0) {
                            rowsNote = `\nFlagged rows: ${flaggedRows.join(', ')}`;
                        }
                        const correctionMsg = `⚠️ *Mark Sheet Requires Correction*\n\n${workflow.subject} (${workflow.class_level})\n\n${correctionInstructions}${rowsNote}\n\nPlease correct and resubmit your mark sheet. Your TA will help coordinate this.`;
                        await messenger.sendPush(schoolId, workflow.teacher_phone, correctionMsg);

                        // 🧠 MEMORY: Record in teacher history
                        await HistoryManager.recordMessage(schoolId, teacherId, workflow.teacher_phone, 'TA',
                            { type: 'text', body: `[MARK CORRECTION REQUESTED] ${workflow.subject} (${workflow.class_level}). Reason: ${correctionReason}`, timestamp: Date.now(), source: 'system' },
                            { action: 'REQUEST_MARK_CORRECTION', status: 'COMPLETED' }
                        );
                    }

                    logger.info({
                        workflowId,
                        pdfId,
                        teacherId,
                        actor: message.from,
                        flaggedRows
                    }, '🔄 Mark correction requested by SA');

                    systemActionResult = { success: true, requested_correction: true, reason: correctionReason, subject: workflow?.subject };
                    output.action_required = 'NONE';
                } catch (error) {
                    logger.error({ error, workflowId, pdfId }, 'REQUEST_MARK_CORRECTION failed');
                    const errorResult = { success: false, error: 'Database error while requesting correction' };
                    output.reply_text = await this.synthesizeActionResult('MARK_CORRECTION_FAILED', errorResult, "System error.", contextPrompt, systemPrompt, SA_TA_CONFIG);
                    output.action_required = 'NONE';
                }
            }

            // ✅ NEW: ENGAGE_PARENTS handler (Absence Checkups)
            if (output.action_required === 'ENGAGE_PARENTS' || (output.action_required as string) === 'ENGAGE_PARENT_ON_ABSENCE') {
                // Check if admin explicitly confirmed (e.g., said "yes", "confirm", "do it")
                const bodyLower = message.body.toLowerCase();
                const explicitlyConfirmed = bodyLower.includes('yes') || bodyLower.includes('confirm') || bodyLower.includes('do it') || bodyLower.includes('go ahead') || bodyLower.includes('please do');
                
                if (!output.intent_clear && !explicitlyConfirmed) {
                    output.reply_text = "Engaging parents proactively requires explicit confirmation. Please confirm you want me to contact the parents regarding student attendance.";
                    output.action_required = 'NONE';
                    return output;
                }

                // Get absentees from ESCALATION CONTEXT (authoritative source) - NOT from LLM output (may hallucinate)
                const escContext = pendingEscalation?.context ? 
                    (typeof pendingEscalation.context === 'string' ? JSON.parse(pendingEscalation.context) : pendingEscalation.context) 
                    : {};
                
                // Use absentees from escalation context - this is the authoritative source
                let absentees = escContext.absentees || [];
                
                // DEBUG: Log what we're using
                logger.info({ 
                    hasEscalation: !!pendingEscalation, 
                    escContextAbsentees: escContext.absentees,
                    llmOutputAbsentees: output.action_payload?.absentees,
                    usingAbsentees: absentees 
                }, '🔍 [ENGAGE_PARENTS] Absentees source');
                
                // If no absentees in escalation context, fall back to LLM output (with validation)
                if (absentees.length === 0) {
                    absentees = output.action_payload?.absentees || 
                               (output.action_payload?.student_name ? [{ name: output.action_payload.student_name }] : []);
                }
                
                const reason = output.action_payload?.reason || 'Student has been absent.';
                
                if (absentees.length === 0) {
                    output.reply_text = "I need a list of students to contact. Which parents should I reach out to?";
                    output.action_required = 'NONE';
                    return output;
                }

                try {
                    const { AgentBridgeService } = await import('../../services/proactive-engagement');
                    
                    const results = [];
                    for (const student of absentees) {
                        // Handle both string names and student objects
                        const studentName = typeof student === 'string' ? student : (student.name || student.student_name || 'Unknown');
                        
                        // Build proper instruction for PA - NOT the admin's reply text
                        const paInstruction = `The school admin has asked you to contact the parent of ${studentName} who was marked absent. Express concern about the absence and ask if there's anything the school can do to help.`;
                        
                        const res = await AgentBridgeService.engageParentOnAbsence(
                            schoolId,
                            studentName,
                            reason,
                            message.from,
                            paInstruction
                        );
                        results.push({ 
                            name: studentName, 
                            success: res.success, 
                            summary: res.summary,
                            feedback: res.agentFeedback // Capture specific reason for failure
                        });
                    }

                    const successCount = results.filter(r => r.success).length;
                    
                    // ✅ FIX: Replace hallucinated reply with actual results before synthesis
                    // The LLM's original reply_text may contain hallucinated student names
                    // Use the actual results instead
                    const successfullyEngaged = results.filter(r => r.success).map(r => r.name);
                    const failedStudents = results.filter(r => !r.success).map(r => ({ name: r.name, reason: r.feedback }));
                    
                    if (successfullyEngaged.length > 0) {
                        output.reply_text = `Parent engagement completed. Successfully contacted: ${successfullyEngaged.join(', ')}.`;
                    } else if (failedStudents.length > 0) {
                        output.reply_text = `Parent engagement attempted but failed for: ${failedStudents.map(f => f.name).join(', ')}. Reasons: ${failedStudents.map(f => f.reason).join('; ')}`;
                    }
                    
                    // ✅ SMARTER SYNTHESIS: Provide the specific feedback to the LLM
                    if (successCount === 0 && results.length > 0) {
                        // If all failed, let the synthesis turn explain why using the feedback
                        systemActionResult = { 
                            success: false, 
                            error: 'PROACTIVE_ENGAGEMENT_FAILED',
                            details: results.map(r => ({ name: r.name, issue: r.feedback }))
                        };
                    } else {
                        // Keep LLM's original response or synthesize success
                        logger.info({ successCount }, '✅ Parent engagement successful - keeping LLM response');
                        systemActionResult = { 
                            success: true, 
                            engagement_count: successCount, 
                            absentees: results.filter(r => r.success).map(r => r.name),
                            issues: results.filter(r => !r.success).map(r => ({ name: r.name, issue: r.feedback }))
                        };
                    }
                    
                    output.action_required = 'NONE';

                    // Audit log
                    await AuditTrailService.logAuditEvent({
                        actor_phone: message.from,
                        action: 'TRIGGER_PROACTIVE_ENGAGEMENT',
                        target_resource: `students:bulk:${schoolId}`,
                        details: { absentees, reason, success_count: successCount }
                    });

                } catch (error) {
                    logger.error({ error, absentees }, 'ENGAGE_PARENTS failed');
                    output.reply_text = "I encountered an error while trying to reach the parents. Please try again.";
                    output.action_required = 'NONE';
                }
            }

            // CANCEL_AMENDMENT handler

            // 🧠 SYNTHESIS TURN: Wrap backend result in human-like response
            if (systemActionResult) {
                output.reply_text = await this.synthesizeActionResult(
                    originalAction,
                    systemActionResult,
                    output.reply_text,
                    contextPrompt,
                    systemPrompt,
                    SA_TA_CONFIG
                );
                output.action_required = 'NONE';
            }

        } catch (error) {
            logger.error({ error }, 'SA Intent Parse Failed');
            output.reply_text = "I'm having trouble processing that request. Please be more explicit.";
        }

        return output;
    }

    private async executeTeacherRegistration(schoolId: string, payload: any): Promise<any> {
        const { name, phone, assigned_class, school_type } = payload;
        const targetClass = assigned_class || payload.class; // ✅ Robustness Fix
        
        if (!name || !phone) {
            return { success: false, error: "Teacher name and phone number are required." };
        }

        // Normalize phone
        const normalizedPhone = PhoneNormalizer.normalize(phone.toString());

        try {
            // Check for existing teacher
            const existing: any = await new Promise((resolve) => {
                db.getDB().get(
                    `SELECT id FROM users WHERE phone = ? AND role = 'teacher' AND school_id = ?`,
                    [normalizedPhone, schoolId],
                    (err, row) => resolve(row)
                );
            });

            if (existing) {
                return { success: false, error: `A teacher with phone ${normalizedPhone} is already registered.` };
            }

            const teacherId = uuidv4();
            const token = SETUP_VALIDATOR.generateTeacherToken();
            
            // ✅ FETCH SCHOOL TYPE IF MISSING IN PAYLOAD
            let teacherSchoolType = school_type;
            if (!teacherSchoolType) {
                const schoolData: any = await new Promise((resolve) => {
                    db.getDB().get(`SELECT school_type FROM schools WHERE id = ?`, [schoolId], (err, row) => resolve(row));
                });
                if (schoolData?.school_type) {
                    teacherSchoolType = schoolData.school_type;
                    logger.warn({ 
                        schoolId, 
                        teacherSchoolType, 
                        source: 'school_lookup' 
                    }, '⚠️ [TEACHER] school_type inherited from school config (fallback)');
                } else {
                    teacherSchoolType = 'SECONDARY';
                    logger.error({ 
                        schoolId 
                    }, '🔴 [TEACHER] CRITICAL: No school_type available, defaulting to SECONDARY');
                }
            }

            await new Promise<void>((resolve, reject) => {
                db.getDB().run(
                    `INSERT INTO users (id, phone, role, name, school_id, assigned_class, school_type) VALUES (?, ?, 'teacher', ?, ?, ?, ?)`,
                    [teacherId, normalizedPhone, name, schoolId, null, teacherSchoolType],
                    (err) => err ? reject(err) : resolve()
                );
            });

            await new Promise<void>((resolve, reject) => {
                db.getDB().run(
                    `INSERT INTO teacher_access_tokens (token, teacher_id, school_id, expires_at) VALUES (?, ?, ?, datetime('now', '+1 year'))`,
                    [token, teacherId, schoolId],
                    (err) => err ? reject(err) : resolve()
                );
            });

            // Initialize TA setup
            const { TASetupRepository } = require('../../db/repositories/ta-setup.repo');
            await TASetupRepository.initSetup(teacherId, schoolId, 'Unknown');

            const welcome = `Welcome ${name}! 🎉 You've been registered as a teacher for this school.

Your Access Token is: *${token}*

📝 NEXT STEP: Please reply with your class and subjects. For example:
- "Primary 4 Mathematics"
- "JSS 2 Physics, Chemistry, Biology"

This will allow you to start entering marks and managing students.`;

            await messenger.sendPush(schoolId, normalizedPhone, welcome);

            return { success: true, name, token, phone: normalizedPhone };
        } catch (error) {
            logger.error({ error }, 'Teacher registration failed');
            return { success: false, error: "Database error during teacher registration." };
        }
    }

            private async executeStudentRegistration(schoolId: string, payload: any, output: SAOutput): Promise<any> {
                // ✅ Robustness Fix: Handle nested student object (LLM often nests it)
                const studentData = payload.student || (Array.isArray(payload.students) ? payload.students[0] : payload);
                
                const { student_name, parent_name, parent_phone, class_level } = studentData;
                const targetClass = class_level || studentData.class || payload.class; // ✅ Robustness Fix
        
                // VALIDATION: Phone number
                const phoneValidation = DataValidator.validatePhoneNumber(parent_phone);            if (!phoneValidation.valid) {
                return { success: false, error: phoneValidation.error };
            }
    
            // VALIDATION: School name
            const schoolValidation = DataValidator.validateSchoolName(student_name);
            if (!schoolValidation.valid) {
                return { success: false, error: schoolValidation.error };
            }
    
            // VALIDATION: Class level
            const classValidation = DataValidator.validateClassLevel(targetClass);
            if (!classValidation.valid) {
                return { success: false, error: classValidation.error };
            }
    
            try {
                const normalizedPhone = phoneValidation.normalized!;
    
                // DEDUPLICATION: Check for existing student with same details
                const existingStudent: any = await new Promise((resolve) => {
                    db.getDB().get(
                        `SELECT student_id FROM students WHERE name = ? AND class_level = ? AND school_id = ? LIMIT 1`,
                        [student_name, classValidation.normalized, schoolId],
                        (err, row) => resolve(row)
                    );
                });
    
                if (existingStudent) {
                    return { success: false, error: `A student named "${student_name}" is already registered in ${classValidation.normalized}.` };
                }
    
                // 1. Generate Student ID first (needed for parent registration)
                const studentId = DataValidator.generateStudentId(student_name, classValidation.normalized || targetClass, normalizedPhone);
    
                // 2. FIX 1.2: Use ParentRepository to register parent with deduplication
                // This consolidates all parent registration logic in one place
                const parentRegistration = await ParentRepository.registerParent(
                    schoolId,
                    normalizedPhone,
                    parent_name,
                    studentId
                );
    
                if (!parentRegistration) {
                    return { success: false, error: "Failed to register parent." };
                }
    
                const parentId = parentRegistration.parentId;
                let patToken = parentRegistration.token;
                logger.info({ parentId, student_name, token: patToken?.substring(0, 12) + '...' }, 'Parent registered via ParentRepository');
    
                // Note: ParentRepository.registerParent() already:
                // - Created parent_registry record (with token)
                // - Linked to parent_children_mapping
                // - Linked to student_guardians
                // So we skip those steps and move to student registration
    
                // 3. Register Student with deterministic ID
                await new Promise<void>((resolve, reject) => {
                    db.getDB().run(
                        `INSERT INTO students (student_id, school_id, name, class_level, parent_access_code) VALUES (?, ?, ?, ?, ?)`,
                        [studentId, schoolId, student_name, classValidation.normalized || targetClass, studentId],
                        (err) => err ? reject(err) : resolve()
                    );
                });
            // 4. StudentGuardians and parent_children_mapping already created by ParentRepository
            // No need to duplicate those operations

            // OLD CODE REMOVED - ParentRepository now handles:
            // - Creating parent_registry
            // - Linking to parent_children_mapping
            // - Linking to student_guardians

            // Token is already generated by ParentRepository.registerParent()
            // Use that token directly (it's in patToken variable already from registration)
            if (!patToken) {
                return { success: false, error: "Token generation failed." };
            }

            logger.info({ parentId, tokenPreview: patToken.substring(0, 12) + '...' }, '✅ Parent token ready from registration');

            // 4. Automated Parent Welcome & Group Integration
            const school: any = await new Promise((resolve) => {
                db.getDB().get(`SELECT name, whatsapp_group_link FROM schools WHERE id = ?`, [schoolId], (err, row) => resolve(row));
            });

            logger.info({ schoolId, foundSchool: !!school, groupLink: school?.whatsapp_group_link }, 'Retrieved school for group integration');

            const welcomeMsg = `Welcome to *${school?.name || 'Kumo Academy'}*! 🌟
            
Your child, *${student_name}*, has been successfully registered. As a parent, you now have access to our digital Parent Agent (PA). You can message this line anytime to check results, track fees, or ask questions about school policies.

*Term Results Token*: ${patToken} (Use this if messaging from a non-registered number).`;

            // ✅ FIX 3: Store parent welcome message in memory as their first PA conversation message
            // BUT mask the token for the LLM so it doesn't get exposed if parent loses token
            const maskedWelcomeMsg = welcomeMsg.replace(patToken, '[TOKEN_MASKED]');
            try {
                const MemoryOrchestrator = require('../../core/memory/orchestrator').MemoryOrchestrator;
                await MemoryOrchestrator.storeMessage(
                    schoolId,
                    'PARENT_ONBOARDING',
                    parent_phone,
                    'assistant',
                    maskedWelcomeMsg,  // Store MASKED version for LLM context
                    'PA',
                    'STUDENT_REGISTRATION_WELCOME'
                );
                logger.info({ parentPhone: parent_phone, studentName: student_name }, 'Parent welcome message stored in memory (token masked)');
            } catch (memErr) {
                logger.warn({ error: memErr, phone: parent_phone }, 'Failed to store parent welcome in memory, continuing anyway');
            }

            // Send FULL message (with token) to parent via WhatsApp
            await messenger.sendPush(schoolId, parent_phone, welcomeMsg);

            if (school?.whatsapp_group_link) {
                await messenger.addToGroup(schoolId, parent_phone, school.whatsapp_group_link);
            }

            return { success: true, student_name, token: patToken, parent_notified: true };

        } catch (error) {
            logger.error({ error }, 'Student registration failed');
            return { success: false, error: "Database error" };
        }
    }

        private async handleSetup(message: RoutedMessage, schoolId: string): Promise<any> {
            logger.info({ schoolId, messageFrom: message.from, messageType: message.type }, '🧙 [SA] Routing to SETUP HANDLER');
            
            let state = await SetupRepository.getSetupState(schoolId);
            
            // 🛡️ AUTO-INITIALIZE FALLBACK: If state missing but status is IN_PROGRESS, fix it immediately
            if (!state) {
                logger.warn({ schoolId }, '⚠️ [SA SETUP] No setup_state found but school is in setup mode - initializing now');
                const sequence = [
                    'CONFIRM_SCHOOL_IDENTITY',
                    'SCHOOL_PROFILE_SETUP',
                    'ACADEMIC_TERM_CONFIG',
                    'GRADING_CONFIG',
                    'FEES_ACCESS_CONTROL',
                    'TEACHER_REGISTRATION',
                    'READINESS_CONFIRMATION',
                    'OPERATIONAL'
                ];
                await SetupRepository.initSetup(schoolId, sequence);
                state = await SetupRepository.getSetupState(schoolId);
            }
    
            if (!state) {
                logger.error({ schoolId }, '❌ [SA SETUP] Failed to initialize setup state');
                return {
                    agent: 'SA_SETUP',
                    reply_text: '❌ Setup state not initialized. Please reconnect and try again.',
                    action_required: 'NONE'
                };
            }        
        logger.info({ 
            schoolId, 
            currentStep: state.current_step,
            completedSteps: state.completed_steps,
            pendingSteps: state.pending_steps,
            isActive: state.is_active,
            draftKeys: Object.keys(state.config_draft || {})
        }, '✅ [SA SETUP] Setup state loaded from repository');
        
        // ✅ Load config_draft (accumulated setup data in memory)
        let configDraft = state?.config_draft || {};
        
        logger.info({ schoolId, currentStep: state?.current_step, draftKeys: Object.keys(configDraft) }, 
            '🔄 [SA SETUP] Loaded config_draft from repository');
        
        // ✅ VISION PROCESSING: Pass 2 - Deep Extraction
        let extractedData: any = null;
        let extractionConfidence = 0;
        let visionExplanation = '';
        
        if (message.type === 'image' && message.mediaPath) {
            try {
                logger.info({ schoolId }, '🔍 [SA SETUP] Pass 2: Performing Deep Extraction');
                
                // Determine which specialized prompt to use based on Pass 1 classification
                const classification = message.extractionData?.classification;
                let specializedPrompt = undefined;
                let docTypeHint = 'SCHOOL_REGISTRATION';

                if (classification === 'SCHOOL_DOCUMENT') {
                    specializedPrompt = visionService.getSpecializedPrompt('school-doc-vision');
                    docTypeHint = 'SCHOOL_REGISTRATION';
                } else if (message.extractionData?.suggestedAgent === 'SA') {
                    specializedPrompt = visionService.getSpecializedPrompt('school-doc-vision');
                    docTypeHint = 'SCHOOL_REGISTRATION';
                }
                
                // Perform deep extraction
                const visionResult = await visionService.analyzeImage(message.mediaPath, specializedPrompt, docTypeHint);
                
                if (visionResult.success || visionResult.data) {
                    extractedData = visionResult.data;
                    extractionConfidence = visionResult.confidence;

                    // 🚨🚨🚨 CRITICAL: Log raw vision result
                    logger.info({
                        schoolId,
                        visionSuccess: visionResult.success,
                        visionConfidence: visionResult.confidence,
                        visionDocType: visionResult.docType,
                        hasData: !!visionResult.data,
                        rawKeys: visionResult.data ? Object.keys(visionResult.data) : [],
                        rawData: JSON.stringify(visionResult.data, null, 2)
                    }, '🔍🔍🔍 [SA SETUP] RAW VISION RESULT');
                    
                    // Build human-readable explanation of what was extracted
                    if (extractedData.doc_type === 'TEACHER_LIST' && extractedData.teachers?.length) {
                        visionExplanation = `I found ${extractedData.teachers.length} teachers: ${extractedData.teachers.map((t: any) => `${t.name}`).join(', ')}`;
                    } else if (extractedData.doc_type === 'FEE_STRUCTURE' && extractedData.fees?.length) {
                        visionExplanation = `I found fees: ${extractedData.fees.map((f: any) => `${f.item}: ${f.amount}`).join(', ')}`;
                    } else if (extractedData.doc_type === 'SCHOOL_REGISTRATION' || (extractedData as any).school_name) {
                        const parts = [];
                        // Basic info
                        if ((extractedData as any).school_name) parts.push(`School: ${(extractedData as any).school_name}`);
                        if ((extractedData as any).address) parts.push(`Address: ${(extractedData as any).address}`);
                        if ((extractedData as any).phone) parts.push(`Phone: ${(extractedData as any).phone}`);

                        // 🚨 CRITICAL: Include ALL extracted data in explanation
                        if ((extractedData as any).terms?.length) {
                            const termInfo = (extractedData as any).terms.map((t: any) => `${t.term_name} (${t.start_date} to ${t.end_date})`).join(', ');
                            parts.push(`Terms: ${termInfo}`);
                        }
                        if ((extractedData as any).grading_scale || (extractedData as any).ca_percentage) {
                            parts.push(`Grading: CA ${(extractedData as any).ca_percentage}%, Exam ${(extractedData as any).exam_percentage}%, Scale: ${(extractedData as any).grading_scale}`);
                        }
                        if ((extractedData as any).tuition || (extractedData as any).fees?.length) {
                            const feeInfo = (extractedData as any).fees?.map((f: any) => `${f.item}: ${f.amount}`).join(', ');
                            parts.push(`Fees: Tuition ${(extractedData as any).tuition} ${(extractedData as any).currency}${feeInfo ? ', ' + feeInfo : ''}`);
                        }

                        visionExplanation = `I extracted: ${parts.join(' | ')}`;
                    } else {
                        visionExplanation = `I extracted some details from the document: ${extractedData.extraction_notes || 'Document data'}`;
                    }
                    
                    logger.info({ schoolId, confidence: extractionConfidence, doc_type: (extractedData as any).doc_type || 'unknown' },
                        '✅ Deep vision extraction successful');

                    // 🚨 CRITICAL: Log what was actually extracted
                    logger.info({
                        schoolId,
                        extractedKeys: Object.keys(extractedData || {}),
                        hasName: !!(extractedData as any).name || !!(extractedData as any).school_name,
                        hasAddress: !!(extractedData as any).address,
                        hasPhone: !!(extractedData as any).phone,
                        hasTerms: !!(extractedData as any)?.terms?.length,
                        termCount: (extractedData as any)?.terms?.length || 0,
                        hasGrading: !!(extractedData as any)?.grading_scale || !!(extractedData as any)?.ca_percentage,
                        hasFees: !!(extractedData as any)?.tuition || !!(extractedData as any)?.additional_fees,
                        hasTeachers: !!(extractedData as any)?.teachers?.length,
                        teacherCount: (extractedData as any)?.teachers?.length || 0,
                        fullExtractedData: JSON.stringify(extractedData, null, 2)
                    }, '🔍 [SA SETUP] VISION EXTRACTION DETAIL');
                } else {
                    logger.warn({ schoolId, error: visionResult.error }, '⚠️ Deep extraction failed');
                    visionExplanation = 'I saw the image but couldn\'t read the details clearly.';
                }
            } catch (visionError) {
                logger.error({ visionError, schoolId }, 'Vision processing error during setup');
                visionExplanation = 'I had trouble reading the image. Can you type the information instead?';
            }
        }

        // ✅ Build enriched context for LLM with accumulated data
        let userPrompt = message.body;
        let contextInfo = '';

        if (extractedData) {
            contextInfo += `[IMAGE EXTRACTED]\nConfidence: ${Math.round(extractionConfidence * 100)}%\n${visionExplanation}\n\n`;
        }

        // Add accumulated data context
        if (Object.keys(configDraft).length > 0) {
            contextInfo += `[ACCUMULATED DATA]\n${JSON.stringify(configDraft, null, 2)}\n\n`;
        }

        // 🚨🚨🚨 CRITICAL INSTRUCTION TO LLM 🚨🚨🚨
        if (extractedData) {
            contextInfo += `

╔══════════════════════════════════════════════════════════════╗
║ 🚨 CRITICAL: COPY FROM [IMAGE EXTRACTED], NOT [ACCUMULATED] ║
║                                                              ║
║ [IMAGE EXTRACTED] has FRESH data from the document.          ║
║ [ACCUMULATED DATA] has OLD data with empty arrays.            ║
║                                                              ║
║ YOU MUST copy terms, grading, fees from [IMAGE EXTRACTED]    ║
║ into your JSON payload. DO NOT copy empty arrays!           ║
║                                                              ║
║ If terms exist in [IMAGE EXTRACTED] → include in             ║
║ "academic_config.terms"                                       ║
║ If grading exists in [IMAGE EXTRACTED] → include in          ║
║ "grading_config"                                             ║
║ If fees exist in [IMAGE EXTRACTED] → include in              ║
║ "fees_config"                                                ║
╚══════════════════════════════════════════════════════════════╝

`;
        }

        userPrompt = contextInfo + userPrompt;

        // 🚨 CRITICAL: Log the full prompt sent to LLM
        logger.info({
            schoolId,
            userPromptLength: userPrompt.length,
            userPromptPreview: userPrompt.substring(0, 500),
            hasExtractedData: !!extractedData,
            extractedDataPreview: extractedData ? JSON.stringify(extractedData, null, 2).substring(0, 500) : 'none'
        }, '🔍 [SA SETUP] PROMPT SENT TO LLM');

        // Fetch admin name from DB if not in configDraft
        let adminName = configDraft?.admin_name;
        if (!adminName || adminName === 'System Admin') {
            try {
                const adminUser: any = await new Promise((resolve) => {
                    db.getDB().get(
                        `SELECT name FROM users WHERE school_id = ? AND role = 'admin' LIMIT 1`,
                        [schoolId],
                        (err, row) => resolve(row)
                    );
                });
                adminName = adminUser?.name || 'there';
            } catch (error) {
                adminName = 'there';
            }
        }

        const systemPrompt = await PromptEngine.assemble({
            agent: 'sa_setup',
            schoolId,
            dynamicVars: {
                school_name: configDraft?.name || "the school",
                admin_name: adminName,
                current_step: state?.current_step || 'CONFIRM_SCHOOL_IDENTITY',
                completed_steps: state?.completed_steps?.join(', ') || 'None',
                progress_percentage: state?.completed_steps?.length ? Math.round((state.completed_steps.length / 7) * 100) : 0,
                config_draft_summary: JSON.stringify(configDraft, null, 2),
                has_vision_data: extractedData ? 'true' : 'false',
                extraction_confidence: extractionConfidence.toString()
            }
        });

        try {
            const aiRes = await aiProvider.generateText(SA_TA_CONFIG, userPrompt, systemPrompt);
            let jsonText = aiRes.text.trim();
            
            if (jsonText.startsWith('##')) {
                logger.error({ schoolId, rawResponse: jsonText.substring(0, 150) }, 'LLM returned markdown instead of JSON');
                throw new Error('LLM did not return valid JSON');
            }
            
            if (!jsonText.startsWith('{')) {
                logger.info({ schoolId, rawResponse: jsonText.substring(0, 200) }, 'LLM response not pure JSON, extracting...');
                const jsonMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/) || jsonText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    jsonText = jsonMatch[1] || jsonMatch[0];
                } else {
                    throw new Error('Could not extract JSON from LLM response');
                }
            }
            
            const cleaned = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
            
            // Better JSON parsing with error recovery
            let parsed: SetupSAOutput;
            try {
                parsed = JSON.parse(cleaned) as SetupSAOutput;
            } catch (parseError: any) {
                logger.error({ schoolId, error: parseError.message, jsonSnippet: cleaned.substring(0, 500) }, 
                    '❌ [SA SETUP] JSON parse failed, attempting recovery...');
                
                // Try to fix common JSON issues
                let fixed = cleaned
                    .replace(/,\s*}/g, '}')  // Remove trailing commas
                    .replace(/,\s*]/g, ']')  // Remove trailing commas in arrays
                    .replace(/'/g, '"')      // Replace single quotes with double quotes
                    .replace(/(\w+):/g, '"$1":')  // Quote unquoted keys
                    .replace(/\n/g, ' ')     // Remove newlines
                    .replace(/\s+/g, ' ');   // Collapse whitespace
                
                try {
                    parsed = JSON.parse(fixed) as SetupSAOutput;
                    logger.info({ schoolId }, '✅ [SA SETUP] JSON recovered successfully');
                } catch (retryError: any) {
                    logger.error({ schoolId, error: retryError.message, failedJson: cleaned }, 
                        '❌ [SA SETUP] JSON recovery failed');
                    throw new Error(`Failed to parse LLM response as JSON: ${parseError.message}`);
                }
            }

            // 🚨 CRITICAL: Log LLM response detail
            logger.info({
                schoolId,
                action: parsed.action,
                stepCompleted: parsed.setup_status?.step_completed,
                hasInternalPayload: !!parsed.internal_payload,
                internalPayloadKeys: parsed.internal_payload ? Object.keys(parsed.internal_payload) : [],
                replyTextPreview: (parsed.reply_text || '').substring(0, 200),
                fullLLMResponse: JSON.stringify(parsed, null, 2)
            }, '🔍 [SA SETUP] LLM FULL RESPONSE');

            logger.info({ schoolId, action: parsed.action, stepCompleted: parsed.setup_status?.step_completed },
                '✅ [SA SETUP] LLM response parsed');

            // ═══════════════════════════════════════════════════════════════
            // STEP 1: ACCUMULATE extracted data into config_draft
            // ═══════════════════════════════════════════════════════════════
            if (extractedData) {
                logger.info({ schoolId }, '🔄 Merging vision-extracted data into config_draft');

                // Vision service returns docType from parsed.doc_type or documentType
                const docType = (extractedData as any).doc_type ||
                               (extractedData as any).documentType ||
                               'UNKNOWN';

                // Map vision extraction to config_draft fields (extractedData is flattened - extracted_data)
                if (docType === 'SCHOOL_DOCUMENT' || docType === 'SCHOOL_REGISTRATION' || docType === 'general') {
                    // School basic info - handle both 'name' and 'school_name'
                    if ((extractedData as any).name || (extractedData as any).school_name) {
                        configDraft.name = (extractedData as any).name || (extractedData as any).school_name;
                    }
                    if ((extractedData as any).address) configDraft.address = (extractedData as any).address;
                    if ((extractedData as any).phone) configDraft.phone = (extractedData as any).phone;
                    if ((extractedData as any).registration_number) configDraft.registration_number = (extractedData as any).registration_number;

                    // Academic terms - try multiple field names
                    if ((extractedData as any).terms && Array.isArray((extractedData as any).terms)) {
                        configDraft.terms = (extractedData as any).terms;
                    }
                    if ((extractedData as any).term_dates && Array.isArray((extractedData as any).term_dates)) {
                        configDraft.terms = (extractedData as any).term_dates;
                    }

                    // Grading config - try multiple field names
                    if ((extractedData as any).grading_scale || (extractedData as any).scale) {
                        configDraft.grading_scale = (extractedData as any).grading_scale || (extractedData as any).scale;
                    }
                    if (typeof (extractedData as any).ca_percentage === 'number') {
                        configDraft.ca_percentage = (extractedData as any).ca_percentage;
                    }
                    if (typeof (extractedData as any).exam_percentage === 'number') {
                        configDraft.exam_percentage = (extractedData as any).exam_percentage;
                    }
                    if ((extractedData as any).grading_policy || (extractedData as any).grading) {
                        configDraft.grading_notes = (extractedData as any).grading_policy || (extractedData as any).grading;
                    }

                    // Fees config - try multiple field names
                    if (typeof (extractedData as any).tuition === 'number' || typeof (extractedData as any).tuition === 'string') {
                        configDraft.tuition = parseFloat((extractedData as any).tuition);
                    }
                    if ((extractedData as any).currency) configDraft.currency = (extractedData as any).currency;
                    if ((extractedData as any).additional_fees && typeof (extractedData as any).additional_fees === 'object') {
                        configDraft.additional_fees = (extractedData as any).additional_fees;
                    }
                    if ((extractedData as any).fees && Array.isArray((extractedData as any).fees)) {
                        // Convert fees array to object
                        const feesObj: Record<string, number> = {};
                        ((extractedData as any).fees as Array<any>).forEach((f) => {
                            if (f.item && f.amount) feesObj[f.item] = parseFloat(f.amount);
                        });
                        if (Object.keys(feesObj).length > 0) {
                            configDraft.additional_fees = feesObj;
                        }
                    }
                }

                // Handle teacher list documents
                const isTeacherDoc = docType === 'TEACHER_LIST' ||
                                    (Array.isArray((extractedData as any).teachers) && (extractedData as any).teachers.length > 0);
                if (isTeacherDoc && (extractedData as any).teachers?.length) {
                    configDraft.teachers = (extractedData as any).teachers;
                }

                // Handle fee structure documents
                if ((extractedData as any).doc_type === 'FEE_STRUCTURE') {
                    if ((extractedData as any).tuition) configDraft.tuition = (extractedData as any).tuition;
                    if ((extractedData as any).additional_fees) configDraft.additional_fees = (extractedData as any).additional_fees;
                    if ((extractedData as any).currency) configDraft.currency = (extractedData as any).currency;
                }

                // Handle grading scale documents
                if ((extractedData as any).doc_type === 'GRADING_SCALE') {
                    if ((extractedData as any).continuous_assessment_percentage) configDraft.ca_percentage = (extractedData as any).continuous_assessment_percentage;
                    if ((extractedData as any).exam_percentage) configDraft.exam_percentage = (extractedData as any).exam_percentage;
                    if ((extractedData as any).scale) configDraft.grading_scale = (extractedData as any).scale;
                }

                // Handle academic calendar documents
                if ((extractedData as any).doc_type === 'ACADEMIC_CALENDAR' && (extractedData as any).terms?.length) {
                    configDraft.terms = (extractedData as any).terms;
                }

                // 🚨 CRITICAL: Log what was extracted vs what LLM returned
                logger.info({
                    schoolId,
                    visionExtractedTerms: (extractedData as any)?.terms?.length || 0,
                    visionExtractedGrading: !!(extractedData as any)?.grading_scale || !!(extractedData as any)?.ca_percentage,
                    visionExtractedFees: !!(extractedData as any)?.tuition || !!(extractedData as any)?.additional_fees,
                    llmReturnedTerms: parsed.internal_payload?.academic_config?.terms?.length || 0,
                    llmReturnedGrading: !!parsed.internal_payload?.grading_config,
                    llmReturnedFees: !!parsed.internal_payload?.fees_config,
                    configDraftAfterMerge: JSON.stringify(configDraft, null, 2)
                }, '🔍 [SA SETUP] DATA EXTRACTION COMPARISON');

                // Save merged config_draft
                await SetupRepository.updateSetup(schoolId, { config_draft: configDraft });
                logger.info({ schoolId, updatedFields: Object.keys(configDraft) }, '💾 config_draft saved with merged vision data');

                // ═══════════════════════════════════════════════════════════════
                // 🚀 FAST-FORWARD: Auto-advance multiple steps when comprehensive data extracted
                // ═══════════════════════════════════════════════════════════════
                const stepsToAutoAdvance: string[] = [];

                // Check STEP 1 data (SCHOOL_IDENTITY) - name, address, phone
                if (configDraft.name && configDraft.address && configDraft.phone) {
                    if (!state?.completed_steps?.includes('CONFIRM_SCHOOL_IDENTITY')) {
                        stepsToAutoAdvance.push('CONFIRM_SCHOOL_IDENTITY');
                    }
                }

                // Check STEP 3 data (SCHOOL_PROFILE_SETUP) - often same as STEP 1
                if (configDraft.address || configDraft.phone) {
                    if (!state?.completed_steps?.includes('SCHOOL_PROFILE_SETUP')) {
                        stepsToAutoAdvance.push('SCHOOL_PROFILE_SETUP');
                    }
                }

                // Check STEP 4 data (ACADEMIC_TERMS) - terms array
                if (configDraft.terms && configDraft.terms.length > 0) {
                    if (!state?.completed_steps?.includes('ACADEMIC_TERM_CONFIG')) {
                        stepsToAutoAdvance.push('ACADEMIC_TERM_CONFIG');
                    }
                }

                // Check STEP 5 data (GRADING) - ca_percentage, exam_percentage, or grading_scale
                if (configDraft.ca_percentage !== undefined ||
                    configDraft.exam_percentage !== undefined ||
                    configDraft.grading_scale) {
                    if (!state?.completed_steps?.includes('GRADING_CONFIG')) {
                        stepsToAutoAdvance.push('GRADING_CONFIG');
                    }
                }

                // Check STEP 6 data (FEES) - tuition, additional_fees, currency
                if (configDraft.tuition || configDraft.additional_fees) {
                    if (!state?.completed_steps?.includes('FEES_ACCESS_CONTROL')) {
                        stepsToAutoAdvance.push('FEES_ACCESS_CONTROL');
                    }
                }

                // Check STEP 7 data (TEACHERS) - teachers array
                if (configDraft.teachers && configDraft.teachers.length > 0) {
                    if (!state?.completed_steps?.includes('TEACHER_ONBOARDING')) {
                        stepsToAutoAdvance.push('TEACHER_ONBOARDING');
                    }
                }

                // Auto-advance all detected steps
                if (stepsToAutoAdvance.length > 0) {
                    logger.info({ schoolId, stepsToAutoAdvance }, '🚀 [SA SETUP] Fast-forward: Auto-advancing multiple steps from vision extraction');

                    const currentCompleted = state?.completed_steps || [];
                    const allCompleted = [...new Set([...currentCompleted, ...stepsToAutoAdvance])];

                    // Find the next uncompleted step
                    const allSteps = [
                        'CONFIRM_SCHOOL_IDENTITY',
                        'SCHOOL_STRUCTURE_SETUP',
                        'SUBJECT_REQUISITION',
                        'ACADEMIC_TERM_CONFIG',
                        'GRADING_CONFIG',
                        'FEES_ACCESS_CONTROL',
                        'TEACHER_ONBOARDING',
                        'READINESS_CONFIRMATION'
                    ];

                    // Determine next step after all auto-completed ones
                    let nextStepIndex = 0;
                    for (const step of allSteps) {
                        if (!allCompleted.includes(step)) {
                            break;
                        }
                        nextStepIndex++;
                    }
                    const nextStep = allSteps[nextStepIndex] || 'READINESS_CONFIRMATION';

                    await SetupRepository.updateSetup(schoolId, {
                        completed_steps: allCompleted,
                        current_step: nextStep
                    });

                    logger.info({ schoolId, autoCompleted: stepsToAutoAdvance, newCurrentStep: nextStep }, '✅ [SA SETUP] Fast-forward complete');
                }
            }
            
            // ═══════════════════════════════════════════════════════════════
            // STEP 2: Merge parsed internal_payload into config_draft
            // ═══════════════════════════════════════════════════════════════
            if (parsed.internal_payload && typeof parsed.internal_payload === 'object') {
                const beforeMerge = JSON.stringify(configDraft, null, 2);
                configDraft = { ...configDraft, ...parsed.internal_payload };
                await SetupRepository.updateSetup(schoolId, { config_draft: configDraft });

                logger.info({
                    schoolId,
                    payloadKeys: Object.keys(parsed.internal_payload),
                    payload: parsed.internal_payload,
                    beforeMerge: beforeMerge.substring(0, 500),
                    afterMerge: JSON.stringify(configDraft, null, 2).substring(0, 500)
                }, '🔄 Merged internal_payload into config_draft');

                // ✅ PROACTIVE COMMIT: Immediately persist structural info (school_type, name)
                const payload = parsed.internal_payload as any;
                if (payload.school_type || payload.school_info) {
                    const sType = payload.school_type || configDraft.school_type;
                    const sInfo = payload.school_info || configDraft.school_info || {};
                    
                    if (sType || sInfo.name) {
                        logger.info({ schoolId, sType, sName: sInfo.name }, '💾 [SA SETUP] Proactively persisting structural school data');
                        await new Promise<void>((resolve) => {
                            db.getDB().run(
                                `UPDATE schools SET school_type = COALESCE(?, school_type), name = COALESCE(?, name) WHERE id = ?`,
                                [sType || null, sInfo.name || null, schoolId],
                                () => resolve()
                            );
                        });
                    }
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 3: Handle step advancement
            // ═══════════════════════════════════════════════════════════════
            const sequence = [
                'CONFIRM_SCHOOL_IDENTITY',
                'SCHOOL_STRUCTURE_SETUP',
                'SUBJECT_REQUISITION',
                'ACADEMIC_TERM_CONFIG',
                'GRADING_CONFIG',
                'FEES_ACCESS_CONTROL',
                'TEACHER_ONBOARDING',
                'READINESS_CONFIRMATION'
            ];
            
            if (parsed.setup_status?.step_completed) {
                // 🚀 FAST-FORWARD: Check if configDraft has data for multiple steps
                let stepsToComplete: string[] = [state?.current_step || 'CONFIRM_SCHOOL_IDENTITY'];

                if (configDraft.name && configDraft.address && configDraft.phone) {
                    if (!state?.completed_steps?.includes('CONFIRM_SCHOOL_IDENTITY')) {
                        stepsToComplete.push('CONFIRM_SCHOOL_IDENTITY');
                    }
                }

                if (configDraft.terms?.length > 0) {
                    if (!state?.completed_steps?.includes('ACADEMIC_TERM_CONFIG')) {
                        stepsToComplete.push('ACADEMIC_TERM_CONFIG');
                    }
                }

                if (configDraft.ca_percentage !== undefined || configDraft.grading_scale) {
                    if (!state?.completed_steps?.includes('GRADING_CONFIG')) {
                        stepsToComplete.push('GRADING_CONFIG');
                    }
                }

                if (configDraft.tuition || configDraft.additional_fees) {
                    if (!state?.completed_steps?.includes('FEES_ACCESS_CONTROL')) {
                        stepsToComplete.push('FEES_ACCESS_CONTROL');
                    }
                }

                if (configDraft.teachers?.length > 0) {
                    if (!state?.completed_steps?.includes('TEACHER_ONBOARDING')) {
                        stepsToComplete.push('TEACHER_ONBOARDING');
                    }
                }

                const uniqueSteps = [...new Set(stepsToComplete)];
                const currentCompleted = state?.completed_steps || [];
                const allCompleted = [...new Set([...currentCompleted, ...uniqueSteps])];

                let nextStepIndex = 0;
                for (const step of sequence) {
                    if (!allCompleted.includes(step)) {
                        break;
                    }
                    nextStepIndex++;
                }
                const nextStep = sequence[nextStepIndex] || 'READINESS_CONFIRMATION';

                await SetupRepository.updateSetup(schoolId, {
                    completed_steps: allCompleted,
                    current_step: nextStep
                });

                logger.info({ schoolId, completed: uniqueSteps, next: nextStep }, '📍 Setup step(s) completed and advanced');
            }

            // ═══════════════════════════════════════════════════════════════
            // 🚀 NEW: Handle SET_ADMIN_NAME action
            // ═══════════════════════════════════════════════════════════════
            if (parsed.action === 'SET_ADMIN_NAME') {
                const adminName = parsed.internal_payload?.admin_name;
                if (adminName && adminName.trim()) {
                    try {
                        // Update the admin user record with the real name
                        await new Promise<void>((resolve) => {
                            db.getDB().run(
                                `UPDATE users SET name = ? WHERE school_id = ? AND role = 'admin'`,
                                [adminName.trim(), schoolId],
                                (err) => {
                                    if (err) {
                                        logger.error({ err, adminName }, '❌ [SA SETUP] Failed to update admin name');
                                    } else {
                                        logger.info({ adminName }, '✅ [SA SETUP] Admin name updated from "System Admin"');
                                    }
                                    resolve();
                                }
                            );
                        });

                        // Also update schools.admin_name if column exists
                        await new Promise<void>((resolve) => {
                            db.getDB().run(
                                `UPDATE schools SET admin_name = ? WHERE id = ?`,
                                [adminName.trim(), schoolId],
                                (err) => {
                                    if (err) {
                                        logger.debug({ err }, '⚠️ [SA SETUP] schools.admin_name column may not exist');
                                    } else {
                                        logger.debug({ adminName }, '💾 [SA SETUP] admin_name saved to schools table');
                                    }
                                    resolve();
                                }
                            );
                        });

                        // Store in config_draft for prompt injection
                        configDraft.admin_name = adminName.trim();
                        await SetupRepository.updateSetup(schoolId, { config_draft: configDraft });
                    } catch (error) {
                        logger.error({ error }, '❌ [SA SETUP] Error handling SET_ADMIN_NAME');
                    }
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 4: Handle Teacher Management (REMOVE/REPLACE)
            // ═══════════════════════════════════════════════════════════════════════
            if (parsed.action === 'REMOVE_TEACHER') {
                const teacherPhone = parsed.internal_payload?.teacher_phone;
                if (teacherPhone && configDraft.teachers) {
                    configDraft.teachers = configDraft.teachers.filter((t: any) => t.phone !== teacherPhone);
                    await SetupRepository.updateSetup(schoolId, { config_draft: configDraft });
                    logger.info({ schoolId, teacherPhone }, '❌ Teacher removed from config_draft');
                }
            }

            if (parsed.action === 'REPLACE_TEACHER') {
                const { old_phone, new_teacher } = parsed.internal_payload;
                if (old_phone && new_teacher && configDraft.teachers) {
                    const index = configDraft.teachers.findIndex((t: any) => t.phone === old_phone);
                    if (index !== -1) {
                        configDraft.teachers[index] = new_teacher;
                        await SetupRepository.updateSetup(schoolId, { config_draft: configDraft });
                        logger.info({ schoolId, oldPhone: old_phone, newTeacher: new_teacher.name }, 
                            '🔄 Teacher replaced in config_draft');
                    }
                }
            }

            // ✅ INTERMEDIATE ACTION COMMIT: Allow registering teachers/students DURING setup
            if ((parsed.action as string) === 'REGISTER_TEACHER') {
                logger.info({ schoolId }, '💾 [SA SETUP] Intercepted REGISTER_TEACHER during setup');
                await this.executeTeacherRegistration(schoolId, parsed.internal_payload);
            }

            if ((parsed.action as string) === 'REGISTER_STUDENT') {
                logger.info({ schoolId }, '💾 [SA SETUP] Intercepted REGISTER_STUDENT during setup');
                await this.executeStudentRegistration(schoolId, parsed.internal_payload, parsed as any);
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 5: Handle SETUP_SCHOOL or READINESS_CONFIRMATION action (Final Registration)
            // ═══════════════════════════════════════════════════════════════
            // @ts-ignore - Type narrowing issue with union types
            if (parsed.action === 'SETUP_SCHOOL' || parsed.action === 'READINESS_CONFIRMATION' || parsed.setup_status?.current_step === 'COMPLETE') {
                logger.info({ schoolId, payload: JSON.stringify(parsed.internal_payload) }, 
                    '🚀 [SETUP_SCHOOL] Processing unified school setup');
                
                // ✅ Merge with config_draft to ensure school_type and other prefilled data is available
                const payload = { ...configDraft, ...parsed.internal_payload };
                
                // ① Validate school_type is explicitly provided (no defaults allowed)
                const schoolTypeValidation = SETUP_VALIDATOR.validateSchoolType(payload.school_type);
                if (!schoolTypeValidation.valid) {
                    logger.error({ schoolId, school_type: payload.school_type }, 
                        '🔴 [SETUP_SCHOOL] REJECTED: school_type is required and must be one of PRIMARY, SECONDARY, BOTH');
                    return {
                        success: false,
                        error: `Setup validation failed: ${schoolTypeValidation.error}. school_type MUST be explicitly provided.`,
                        action_required: 'SETUP_SCHOOL'
                    };
                }
                
                const schoolType = schoolTypeValidation.normalized!;
                logger.info({ schoolId, schoolType }, '🏫 [SETUP_SCHOOL] school_type validated');
                
                // ① Create school with unified data and school_type
                if (payload.school_info) {
                    
                    // Try to resolve group JID from group link if provided
                    let groupJid: string | null = null;
                    if (payload.school_info.whatsapp_group_link) {
                        // Extract group code from invite link (https://chat.whatsapp.com/XYZABC)
                        const linkMatch = payload.school_info.whatsapp_group_link.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
                        if (linkMatch && linkMatch[1]) {
                            const groupCode = linkMatch[1];
                            logger.info({ schoolId, groupCode }, '🔍 Group invite code extracted from link');
                            
                            // ✅ TRIGGER JOIN GROUP ACTION
                            parsed.backend_actions = parsed.backend_actions || [];
                            parsed.backend_actions.push({
                                action: 'JOIN_GROUP',
                                payload: { 
                                    group_link: payload.school_info.whatsapp_group_link, 
                                    group_code: groupCode,
                                    school_name: payload.school_info.name
                                }
                            });
                        }
                    }
                    
                    // 🧠 INTELLIGENT: Standardize subject names for consistency
                    // Get subjects from either format (universe_config or school_structure)
                    let subjectsUniverse = payload.universe_config?.subjects_universe || 
                                          payload.school_structure?.subjects || [];
                    if (subjectsUniverse.length > 0) {
                        const { nameStandardizer } = await import('../../services/name-standardization.service');
                        const standardizedSubjects = nameStandardizer.standardizeSubjects(subjectsUniverse);
                        subjectsUniverse = standardizedSubjects.map(s => s.name);
                        
                        logger.info({
                            schoolId,
                            originalSubjects: payload.universe_config?.subjects_universe || payload.school_structure?.subjects,
                            standardizedSubjects: subjectsUniverse
                        }, '🧠 Standardized subject names for school universe');
                    }
                    
                    // Get classes from either format
                    const classesToSave = payload.universe_config?.classes_universe || 
                                         payload.school_structure?.classes || [];
                    
                    await new Promise<void>((resolve, reject) => {
                        db.getDB().run(
                            `UPDATE schools SET name = ?, config_json = ?, whatsapp_group_link = ?, whatsapp_group_jid = ?, school_type = ?, classes_json = ?, subjects_json = ? WHERE id = ?`,
                            [
                                payload.school_info.name,
                                JSON.stringify({
                                    address: payload.school_info.address,
                                    phone: payload.school_info.phone,
                                    registration_number: payload.school_info.registration_number
                                }),
                                payload.school_info.whatsapp_group_link || null,
                                groupJid || null,
                                schoolType,
                                JSON.stringify(classesToSave),
                                JSON.stringify(subjectsUniverse),
                                schoolId
                            ],
                            (err) => {
                                if (err) {
                                    logger.error({ err, schoolId }, 'Failed to update school info');
                                    reject(err);
                                } else {
                                    logger.info({ 
                                        schoolId, 
                                        groupLink: payload.school_info.whatsapp_group_link,
                                        classesCount: classesToSave.length,
                                        subjectsCount: subjectsUniverse.length
                                    }, '✅ School info updated with universe config');
                                    resolve();
                                }
                            }
                        );
                    });
                }
                
                // ② Configure academic terms
                // Handle both formats: terms array OR current_term + additional_terms
                // Also check configDraft as fallback (terms may be stored there during intermediate steps)
                let termsToInsert: any[] = [];
                
                // Try payload.academic_config first (new format)
                if (payload.academic_config?.terms?.length) {
                    // Old format: terms array
                    termsToInsert = payload.academic_config.terms;
                    logger.info({ schoolId, termCount: termsToInsert.length, source: 'payload.academic_config.terms' }, '📅 [SETUP_SCHOOL] Found terms in payload.academic_config.terms');
                } else if (payload.academic_config?.current_term) {
                    // New LLM format: current_term + additional_terms
                    termsToInsert.push(payload.academic_config.current_term);
                    if (payload.academic_config.additional_terms?.length) {
                        termsToInsert.push(...payload.academic_config.additional_terms);
                    }
                    logger.info({ schoolId, termCount: termsToInsert.length, source: 'payload.academic_config.current_term' }, '📅 [SETUP_SCHOOL] Found terms in payload.academic_config.current_term');
                }
                // Fallback: Check configDraft.terms (where terms are stored during intermediate steps)
                else if (configDraft.terms?.length > 0) {
                    termsToInsert = configDraft.terms;
                    logger.info({ schoolId, termCount: termsToInsert.length, source: 'configDraft.terms' }, '📅 [SETUP_SCHOOL] Found terms in configDraft.terms (fallback)');
                }
                // Final fallback: Check configDraft.academic_config.terms
                else if (configDraft.academic_config?.terms?.length > 0) {
                    termsToInsert = configDraft.academic_config.terms;
                    logger.info({ schoolId, termCount: termsToInsert.length, source: 'configDraft.academic_config.terms' }, '📅 [SETUP_SCHOOL] Found terms in configDraft.academic_config.terms (fallback)');
                }
                
                if (termsToInsert.length > 0) {
                    logger.info({ schoolId, termCount: termsToInsert.length }, 
                        '📅 [SETUP_SCHOOL] Creating academic terms');
                    
                    for (const term of termsToInsert) {
                        const termId = uuidv4();
                        // ✅ FIX: Provide default dates to prevent DB crash if LLM returns null
                        const startDate = term.start_date || new Date().toISOString().split('T')[0];
                        const endDate = term.end_date || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

                        await new Promise<void>((resolve, reject) => {
                            db.getDB().run(
                                `INSERT INTO academic_terms (id, school_id, term_name, start_date, end_date) VALUES (?, ?, ?, ?, ?)`,
                                [termId, schoolId, term.term_name, startDate, endDate],
                                (err) => {
                                    if (err) {
                                        logger.error({ err, termId }, 'Failed to insert term');
                                        reject(err);
                                    } else {
                                        logger.info({ termId, term: term.term_name }, '✅ Term created');
                                        resolve();
                                    }
                                }
                            );
                        });
                    }
                    
                    // Set active term
                    const activeTerm = payload.academic_config.active_term || 
                                      payload.academic_config.current_term?.term_name;
                    if (activeTerm) {
                        await new Promise(r => {
                            db.getDB().run(
                                `UPDATE schools SET active_term = ? WHERE id = ?`,
                                [activeTerm, schoolId],
                                () => r(null)
                            );
                        });
                        logger.info({ schoolId, activeTerm }, '✅ Active term set');
                    }
                } else {
                    logger.warn({ schoolId, academicConfig: payload.academic_config },
                        '⚠️ [SETUP_SCHOOL] No terms found in academic_config');
                }
                
                // ③ Configure grading with intelligent name standardization
                let gradingConfig = payload.grading_config || payload.grading;
                if (gradingConfig) {
                    // 🧠 INTELLIGENT: Standardize pillar names for reports
                    const { nameStandardizer } = await import('../../services/name-standardization.service');
                    
                    if (gradingConfig.pillars && Array.isArray(gradingConfig.pillars)) {
                        const standardizedPillars = nameStandardizer.standardizePillars(
                            gradingConfig.pillars.map((p: any) => ({
                                name: p.name,
                                max_score: p.max_score
                            }))
                        );
                        
                        // Preserve any additional pillar properties while updating names
                        gradingConfig.pillars = gradingConfig.pillars.map((pillar: any, index: number) => ({
                            ...pillar,
                            id: standardizedPillars[index]?.id || pillar.id || `pillar_${index}`,
                            name: standardizedPillars[index]?.name || pillar.name,
                            full_name: standardizedPillars[index]?.full_name || pillar.name
                        }));
                        
                        logger.info({ 
                            schoolId, 
                            originalPillars: gradingConfig.pillars.map((p: any) => p.full_name || p.name),
                            standardizedPillars: gradingConfig.pillars.map((p: any) => p.name)
                        }, '🧠 Standardized grading pillar names for reports');
                    }
                    
                    await new Promise(r => {
                        db.getDB().run(
                            `UPDATE schools SET grading_config = ? WHERE id = ?`,
                            [JSON.stringify(gradingConfig), schoolId],
                            () => r(null)
                        );
                    });
                    logger.info({ schoolId }, '✅ Grading config saved with standardized names');
                }
                
                // ④ Configure fees
                if (payload.fees_config) {
                    await new Promise(r => {
                        db.getDB().run(
                            `UPDATE schools SET fees_config = ? WHERE id = ?`,
                            [JSON.stringify(payload.fees_config), schoolId],
                            () => r(null)
                        );
                    });
                    logger.info({ schoolId }, '✅ Fees config saved');
                }
                
                // ⑤ Register teachers
                const addedTeachers: any[] = [];
                const teacherList = payload.teacher_assignments || payload.teachers; // ✅ Robustness Fix
                
                if (teacherList?.length) {
                    for (const teacher of teacherList) {
                        const name = teacher.name;
                        // Normalize phone using configurable country code
                        const phone = SETUP_VALIDATOR.normalizePhone(teacher.phone, CONSTANTS.PHONE.DEFAULT_COUNTRY_CODE);
                        const assigned_class = teacher.assigned_class || teacher.class;
                        
                        // ✅ FIX: Skip assignments with missing phone numbers
                        if (!phone) {
                            logger.warn({ schoolId, teacherName: name, assigned_class }, '⚠️ Skipping teacher assignment with missing phone');
                            continue;
                        }

                        logger.info({ schoolId, teacherName: name, phone, assigned_class }, '📱 [TEACHER] Creating teacher with normalized phone');
                        
                        // Check for existing teacher
                        const existingTeacher: any = await new Promise((resolve) => {
                            db.getDB().get(
                                `SELECT id, phone FROM users WHERE phone = ? AND role = 'teacher' AND school_id = ?`,
                                [phone, schoolId],
                                (err, row) => resolve(row)
                            );
                        });

                        if (existingTeacher) {
                            logger.warn({ schoolId, phone, existingPhone: existingTeacher.phone }, '⚠️ Teacher already exists, skipping');
                            addedTeachers.push({ teacherId: existingTeacher.id, phone, name, assigned_class });
                            continue;
                        }

                        const teacherId = uuidv4();
                        const token = SETUP_VALIDATOR.generateTeacherToken();
                        
                        // Fetch school type if not in payload
                        const schoolData: any = await new Promise((resolve) => {
                            db.getDB().get(`SELECT school_type FROM schools WHERE id = ?`, [schoolId], (err, row) => resolve(row));
                        });

                        // ✅ SURGICAL FIX: Inherit school_type from the main school config if not in teacher payload
                        let teacherSchoolType = teacher.school_type || payload.school_type;
                        if (!teacherSchoolType) {
                            if (schoolData?.school_type) {
                                teacherSchoolType = schoolData.school_type;
                                logger.warn({ 
                                    teacherId, 
                                    teacherSchoolType, 
                                    source: 'school_lookup',
                                    fallback: true 
                                }, '⚠️ [TEACHER] school_type inherited from school config (fallback)');
                            } else {
                                teacherSchoolType = 'SECONDARY';
                                logger.error({ 
                                    teacherId,
                                    schoolId 
                                }, '🔴 [TEACHER] CRITICAL: No school_type available during SETUP_SCHOOL, defaulting to SECONDARY');
                            }
                        }
                        logger.info({ teacherId, teacherSchoolType, schoolType: schoolData?.school_type }, '👨‍🏫 [TEACHER] school_type assigned to teacher');
                        
                        // Insert teacher with normalized phone and school_type
                        await new Promise<void>((resolve, reject) => {
                            db.getDB().run(
                                `INSERT INTO users (id, phone, role, name, school_id, assigned_class, school_type) VALUES (?, ?, 'teacher', ?, ?, NULL, ?)`,
                                [teacherId, phone, name, schoolId, teacherSchoolType],
                                function(err) {
                                    if (err) {
                                        logger.error({ err, teacherId, phone, name }, '❌ Failed to insert teacher');
                                        reject(err);
                                    } else {
                                        logger.info({ teacherId, phone, name, schoolId, school_type: teacherSchoolType }, '✅ Teacher created in DB with school_type (Light Registration)');
                                        resolve();
                                    }
                                }
                            );
                        });
                        
                        // Insert token
                        await new Promise<void>((resolve, reject) => {
                            db.getDB().run(
                                `INSERT INTO teacher_access_tokens (token, teacher_id, school_id, expires_at) VALUES (?, ?, ?, datetime('now', '+1 year'))`,
                                [token, teacherId, schoolId],
                                function(err) {
                                    if (err) {
                                        logger.error({ err, token }, 'Failed to insert token');
                                        reject(err);
                                    } else {
                                        logger.info({ token }, '✅ Token created');
                                        resolve();
                                    }
                                }
                            );
                        });
                        
                        const welcome = `Welcome ${name}! You've been registered for ${payload.school_info?.name || 'Kumo School'}. 

We'll complete your profile setup shortly. Your Access Token is: *${token}*`;
                        
                        try {
                            await messenger.sendPush(schoolId, phone, welcome);
                            logger.info({ phone, name, token }, '✅ Teacher welcome sent');
                            addedTeachers.push({ teacherId: existingTeacher?.id || teacherId, phone, name, token });
                        } catch (err) {
                            logger.error({ err, phone }, '❌ Failed to send teacher welcome');
                            addedTeachers.push({ teacherId: existingTeacher?.id || teacherId, phone, name, token }); // Still add even if message fails
                        }
                    }
                }
                
                // ⑥ Initialize TA setup for new teachers
                if (addedTeachers.length > 0) {
                    const { TASetupRepository } = require('../../db/repositories/ta-setup.repo');
                    for (const teacher of addedTeachers) {
                        try {
                            // Light TA setup init - class will be handled during teacher's own setup turn
                            await TASetupRepository.initSetup(teacher.teacherId, schoolId, 'Unknown');
                            logger.info({ teacherId: teacher.teacherId }, '🚀 TA setup initialized (Light)');
                        } catch (err) {
                            logger.error({ err }, '❌ TA setup init failed');
                        }
                    }
                }
                
                // ⑦ Populate subjects table for frontend compatibility
                // Handle both old format (universe_config) and new LLM format (school_structure)
                const classesUniverse = payload.universe_config?.classes_universe || 
                                       payload.school_structure?.classes || [];
                const subjectsUniverse = payload.universe_config?.subjects_universe || 
                                        payload.school_structure?.subjects || [];
                
                if (classesUniverse.length > 0 && subjectsUniverse.length > 0) {
                    logger.info({ schoolId, classesCount: classesUniverse.length, subjectsCount: subjectsUniverse.length }, 
                        '📚 [SETUP_SCHOOL] Populating subjects table for frontend');
                    
                    // Clear existing subjects for this school to avoid duplicates
                    await new Promise<void>((resolve) => {
                        db.getDB().run(`DELETE FROM subjects WHERE school_id = ?`, [schoolId], () => resolve());
                    });
                    
                    // Insert subjects for each class combination
                    for (const cls of classesUniverse) {
                        for (const subj of subjectsUniverse) {
                            const subjectId = uuidv4();
                            await new Promise<void>((resolve, reject) => {
                                db.getDB().run(
                                    `INSERT INTO subjects (id, school_id, name, class_level, is_core, code)
                                     VALUES (?, ?, ?, ?, ?, ?)`,
                                    [
                                        subjectId,
                                        schoolId,
                                        subj,
                                        cls,
                                        1,
                                        subj.substring(0, 3).toUpperCase()
                                    ],
                                    (err) => {
                                        if (err) {
                                            logger.error({ err, subjectId, schoolId, subject: subj, class: cls }, 
                                                '❌ Failed to insert subject');
                                            reject(err);
                                        } else {
                                            resolve();
                                        }
                                    }
                                );
                            });
                        }
                    }
                    
                    logger.info({ schoolId, totalSubjects: classesUniverse.length * subjectsUniverse.length }, 
                        '✅ [SETUP_SCHOOL] Subjects table populated successfully');
                } else {
                    logger.warn({ schoolId, classesCount: classesUniverse.length, subjectsCount: subjectsUniverse.length },
                        '⚠️ [SETUP_SCHOOL] Cannot populate subjects table - missing classes or subjects');
                }
                
                // ⑧ Mark setup as complete
                await SetupRepository.updateSetup(schoolId, { is_active: false });
                await new Promise(r => {
                    db.getDB().run(
                        `UPDATE schools SET setup_status = 'OPERATIONAL' WHERE id = ?`,
                        [schoolId],
                        () => r(null)
                    );
                });
                
                logger.info({ schoolId }, '🎉 [SETUP_SCHOOL] School setup completed and operational');
            }

            return parsed;

        } catch (error) {
            logger.error({
                error: error instanceof Error ? {
                    message: error.message,
                    stack: error.stack,
                    name: error.name
                } : error,
                schoolId,
                currentStep: state?.current_step
            }, '❌ SA Setup Logic Failed');
            
            return {
                reply_text: "Oga, I had a small glitch processing that. Can you please try again or show me the paper clearly?",
                action: 'NO_ACTION',
                internal_payload: {},
                setup_status: {
                    current_step: state?.current_step || 'CONFIRM_SCHOOL_IDENTITY',
                    progress_percentage: state?.completed_steps?.length ? Math.round((state.completed_steps.length / 7) * 100) : 0,
                    step_completed: false
                }
            };
        }
    }

    /**
     * GENERATE ESCALATION NOTIFICATION
     * Uses LLM to craft intelligent, conversational summary for admin (Text Only)
     */
    async generateEscalationNotification(payload: any): Promise<string> {
        const escalationId = payload.escalation_id || `ESC-${Date.now()}`;
        
        logger.info({ escalationId, type: payload.escalation_type, from: payload.user_name }, 
            '🔔 [SA ESCALATION] Starting notification synthesis');
        
        // Build context message showing what the escalation is about
        const escalationContext = `
ESCALATION DETAILS:
- ID: ${escalationId}
- Type: ${payload.escalation_type}
- From: ${payload.user_name} (${payload.user_role})
- Issue: ${payload.reason}
- Request: ${payload.what_agent_needed}
- Priority: ${payload.priority || 'MEDIUM'}

CONVERSATION SUMMARY:
${payload.conversation_summary || 'No previous context available'}
`;

        try {
            logger.debug({ escalationId }, '[SA ESCALATION] Sending context to LLM for conversational alert');
            
            const notificationPrompt = `You are the School Admin Agent (SA). 
An escalation has come in that needs the admin's decision.

Your task: Write a SHORT, CONVERSATIONAL WhatsApp message to alert the admin. 
- Acknowledge the issue clearly.
- Briefly state what decision is needed.
- Ask ONE clear question the admin should answer.
- DO NOT use JSON. DO NOT use formal business letter style.
- Tone: Professional but helpful "thinking partner".

Example: "Just got flagged: JSS 2 Math marks are ready for approval. Should I finalize them now or would you like to review the broadsheet first?"`;

            const aiRes = await aiProvider.generateText(SA_TA_CONFIG, escalationContext, notificationPrompt);
            let notification = aiRes.text.trim();
            
            // Clean up any lingering JSON or quotes
            notification = notification.replace(/^["']|["']$/g, '').replace(/```json|```/g, '').trim();
            
            if (notification.startsWith('{')) {
                try {
                    const parsed = JSON.parse(notification);
                    notification = parsed.reply_text || parsed.message || notification;
                } catch (e) { /* ignore */ }
            }

            // Ensure escalation ID is in the message for admin's response tracking
            if (!notification.includes(escalationId)) {
                notification += `\n\n[Escalation ID: ${escalationId}]`;
            }
            
            logger.info({ 
                escalationId, 
                message: notification
            }, '✅ [SA ESCALATION] LLM synthesized notification - ABOUT TO SEND TO ADMIN');
            
            return notification;
        } catch (error) {
            logger.error({ error, escalationId }, 'Failed to generate escalation notification with LLM');
            // Fallback: simple formatted message
            const fallback = `🚨 **ESCALATION ALERT**
From: ${payload.user_name} (${payload.user_role})
Issue: ${payload.escalation_type}
Reason: ${payload.reason}

The ${payload.origin_agent} agent needs your decision on: ${payload.what_agent_needed}

Please review and reply with your decision (APPROVED/DENIED/CLARIFY).

[Escalation ID: ${escalationId}]`;
            
            logger.warn({ escalationId, fallbackMessage: fallback }, 
                '[SA ESCALATION] Using fallback message due to LLM error');
            
            return fallback;
        }
    }

    /**
     * Get the admin phone number for a school
     * Handles both real school IDs and group JIDs
     */
    /**
     * Helper to get school admin info (phone and id)
     */
    private async getSchoolAdminInfo(schoolId: string): Promise<{ phone: string, id: string } | null> {
        return new Promise((resolve) => {
            const sql = `
                SELECT id, phone
                FROM users 
                WHERE school_id = ? AND role = 'admin'
                LIMIT 1
            `;
            db.getDB().get(sql, [schoolId], (err: any, row: any) => {
                if (err || !row) {
                    resolve(null);
                } else {
                    resolve({ phone: row.phone, id: row.id });
                }
            });
        });
    }

    private async getSchoolAdminPhone(schoolId: string): Promise<string | null> {
        const info = await this.getSchoolAdminInfo(schoolId);
        return info?.phone || null;
    }

    /**
     * Query all parents with their children for a specific class
     * Returns unique parent records with their children in that class
     */
    private async getParentsForClass(schoolId: string, classLevel: string): Promise<Array<{
        parentPhone: string;
        parentName: string;
        children: Array<{ studentId: string; studentName: string }>;
    }>> {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT DISTINCT 
                    pr.parent_phone,
                    pr.parent_name,
                    s.student_id,
                    s.name as student_name
                FROM parent_registry pr
                JOIN parent_children_mapping pcm ON pr.parent_id = pcm.parent_id
                JOIN students s ON pcm.student_id = s.student_id
                WHERE pr.school_id = ?
                    AND s.class_level = ?
                    AND pr.is_active = 1
                ORDER BY pr.parent_phone, s.name
            `;
            db.getDB().all(sql, [schoolId, classLevel], (err, rows: any[]) => {
                if (err) {
                    logger.error({ err, schoolId, classLevel }, 'Failed to query parents for class');
                    reject(err);
                    return;
                }

                // Group children by parent
                const parentMap = new Map<string, {
                    parentPhone: string;
                    parentName: string;
                    children: Array<{ studentId: string; studentName: string }>;
                }>();

                for (const row of rows || []) {
                    const phone = row.parent_phone;
                    if (!parentMap.has(phone)) {
                        parentMap.set(phone, {
                            parentPhone: phone,
                            parentName: row.parent_name,
                            children: []
                        });
                    }
                    parentMap.get(phone)!.children.push({
                        studentId: row.student_id,
                        studentName: row.student_name
                    });
                }

                resolve(Array.from(parentMap.values()));
            });
        });
    }

    /**
     * Send batch notifications to parents with rate limiting
     * @param parents - List of parents with their children
     * @param classLevel - The class level for results being released
     * @returns Summary of notifications sent/failed
     */
    private async notifyParentsOfReleasedResults(
        parents: Array<{
            parentPhone: string;
            parentName: string;
            children: Array<{ studentId: string; studentName: string }>;
        }>,
        classLevel: string,
        schoolId: string
    ): Promise<{ sent: number; failed: number; errors: string[] }> {
        const results = { sent: 0, failed: 0, errors: [] as string[] };
        
        // Rate limiting: process in batches with delay between batches
        const BATCH_SIZE = 20;
        const BATCH_DELAY_MS = 1000; // 1 second between batches
        
        for (let i = 0; i < parents.length; i += BATCH_SIZE) {
            const batch = parents.slice(i, i + BATCH_SIZE);
            
            // Process batch in parallel
            const batchPromises = batch.map(async (parent) => {
                try {
                    // Build notification message with all children's names
                    const childNames = parent.children.map(c => c.studentName).join(', ');
                    const message = this.buildResultsNotificationMessage(classLevel, childNames);
                    
                    await messenger.sendPush(schoolId, parent.parentPhone, message);
                    
                    // Record in parent history
                    await HistoryManager.recordMessage(
                        schoolId,
                        parent.children[0]?.studentId,
                        parent.parentPhone,
                        'SA',
                        {
                            type: 'text',
                            body: `[RESULTS RELEASED] ${classLevel} results notification sent`,
                            timestamp: Date.now(),
                            source: 'system'
                        },
                        {
                            action: 'RELEASE_RESULTS_NOTIFICATION',
                            status: 'COMPLETED'
                        }
                    );
                    
                    return { success: true, phone: parent.parentPhone };
                } catch (error) {
                    const errorMsg = `Failed to notify ${parent.parentPhone}: ${error instanceof Error ? error.message : 'Unknown error'}`;
                    logger.error({ error, parentPhone: parent.parentPhone }, 'Failed to send results notification');
                    return { success: false, phone: parent.parentPhone, error: errorMsg };
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            
            for (const result of batchResults) {
                if (result.success) {
                    results.sent++;
                } else {
                    results.failed++;
                    if ((result as any).error) {
                        results.errors.push((result as any).error);
                    }
                }
            }
            
            // Add delay between batches to avoid rate limiting
            if (i + BATCH_SIZE < parents.length) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
            }
        }
        
        logger.info({ 
            classLevel, 
            totalParents: parents.length, 
            sent: results.sent, 
            failed: results.failed 
        }, '✅ Parent notifications completed');
        
        return results;
    }

    /**
     * Build notification message template for released results
     * Template: "Results for [Class] are now available! Reply 'RESULTS' to view [Child Name]'s report card."
     */
    private buildResultsNotificationMessage(classLevel: string, childNames: string): string {
        return `📢 *Results Available*\n\nResults for *${classLevel}* are now available!\n\nReply 'RESULTS' to view ${childNames}'s report card.`;
    }

    /**
     * Send personalized setup welcome message
     * Called when WhatsApp connection is established for a new school
     */
    static async sendSetupWelcome(schoolId: string): Promise<void> {
        logger.info({ schoolId }, '🎉 [SA] Preparing setup welcome message');
        
        try {
            // 1. Check if welcome already sent
            const state = await SetupRepository.getSetupState(schoolId);
            if (state?.config_draft?.welcome_sent) {
                logger.info({ schoolId }, 'Welcome already sent, skipping');
                return;
            }

            // 2. Get school info
            const school: any = await new Promise((resolve) => {
                db.getDB().get(
                    `SELECT id, name, admin_phone, school_type FROM schools WHERE id = ?`,
                    [schoolId],
                    (err, row) => resolve(row)
                );
            });

            if (!school || !school.admin_phone) {
                logger.error({ schoolId }, '❌ [SA] No school or admin phone found');
                return;
            }

            // 3. Detect country and get universe template
            const country = detectCountryFromPhone(school.admin_phone);
            const schoolType = school.school_type || 'SECONDARY';
            const templateObj = getUniverseTemplate(schoolType, country);
            const template = templateObj as { classes: string[]; subjects: string[] };

            // 4. Populate config_draft
            const configDraft = {
                name: school.name,
                school_type: schoolType,
                country: country,
                classes: template.classes,
                subjects: template.subjects,
                welcome_sent: true
            };
            
            await SetupRepository.updateSetup(schoolId, { config_draft: configDraft });
            logger.info({ schoolId, schoolType, country, classesCount: template.classes.length }, 
                '📋 [SA] config_draft populated with prefilled universe');

            // 5. Generate personalized welcome message
            const countryInfo = country !== 'Nigeria' ? ` in ${country}` : '';
            const classList = template.classes.join(', ');
            const subjectList = template.subjects.slice(0, 6).join(', ');
            const moreSubjects = template.subjects.length > 6 ? `, and ${template.subjects.length - 6} more` : '';

            const welcomeMessage = `🎉 *Welcome to KUMO, ${school.name}!*

${schoolType === 'PRIMARY' ? '🏫' : schoolType === 'SECONDARY' ? '🎓' : '🏫🎓'} I see you registered as a *${schoolType}* school${countryInfo}.

📚 *I've prepared a suggested setup:*
*Classes*: ${classList}

📖 *Subjects*: ${subjectList}${moreSubjects}

*What should I call you?*

Once I know your name, we can review this setup together - just say yes to keep it, or tell me what to change!`;

            // 6. Send welcome message
            const adminJid = school.admin_phone.includes('@') 
                ? school.admin_phone 
                : school.admin_phone + '@s.whatsapp.net';

            await messenger.sendPush(schoolId, adminJid, welcomeMessage);
            logger.info({ schoolId, adminPhone: school.admin_phone }, '✅ [SA] Welcome message sent');

            // 7. Record in history (so LLM remembers this was sent)
            await HistoryManager.recordMessage(
                schoolId,
                undefined,
                school.admin_phone,
                'SA',
                { type: 'text', body: welcomeMessage, timestamp: Date.now(), source: 'system' },
                { action: 'SETUP_WELCOME', status: 'SENT' }
            );
            logger.info({ schoolId }, '✅ [SA] Welcome recorded in history');

        } catch (error) {
            logger.error({ error, schoolId }, '❌ [SA] Failed to send setup welcome');
        }
    }
}

export { SETUP_VALIDATOR };

