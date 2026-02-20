import { BaseAgent } from '../base/agent';
import { RoutedMessage } from '../../core/types';
import { PAOutput, PAActionType } from './types/schema';
import { logger } from '../../utils/logger';
import { aiProvider } from '../../ai/provider';
import { PA_CONFIG } from '../../ai/config';
import { visionService } from '../../ai/vision';
import { audioService } from '../../ai/audio';
import { sessionService } from '../../services/session';
import { StudentRepository } from '../../db/repositories/student.repo';
import { AcademicRepository } from '../../db/repositories/academic.repo';
import { SetupRepository } from '../../db/repositories/setup.repo';
import { TransactionRepository } from '../../db/repositories/transaction.repo';
import { SessionRepository } from '../../db/repositories/session.repo';
import { AuditTrailService } from '../../services/audit';
import { ErrorRecoveryService } from '../../services/error-recovery';
import { ActionAuthorizer } from '../../core/action-authorization';
import { db } from '../../db';
import { messenger } from '../../services/messenger';
import { pdfGenerator } from '../../services/pdf-generator';
import { MemoryOrchestrator } from '../../core/memory/orchestrator';
import { VoiceOrchestrator } from '../../services/voice-orchestrator';
import { HistoryManager } from '../../core/memory/history-manager';

import { PromptEngine } from '../../core/prompt-engine';

interface ParentChild {
    studentId: string;
    name: string;
    classLevel: string;
}

export class ParentAgent extends BaseAgent {
    private static processingQueue: Map<string, Promise<any>> = new Map();

    private async getParentChildren(parentPhone: string, schoolId: string): Promise<ParentChild[]> {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT s.student_id, s.name, s.class_level
                FROM students s
                JOIN parent_children_mapping pcm ON s.student_id = pcm.student_id
                JOIN parent_registry pr ON pcm.parent_id = pr.parent_id
                WHERE pr.parent_phone = ? AND pr.school_id = ? AND pr.is_active = 1
                ORDER BY s.name ASC
            `;
            db.getDB().all(sql, [parentPhone, schoolId], (err, rows: any[]) => {
                if (err) {
                    logger.error({ err, parentPhone, schoolId }, 'Failed to get parent children');
                    reject(err);
                } else {
                    resolve((rows || []).map(r => ({
                        studentId: r.student_id,
                        name: r.name,
                        classLevel: r.class_level
                    })));
                }
            });
        });
    }

    private async getActiveTerm(schoolId: string): Promise<string> {
        return new Promise((resolve) => {
            db.getDB().get(`SELECT active_term FROM schools WHERE id = ?`, [schoolId], (err, row: any) => {
                if (err || !row?.active_term) {
                    resolve('current');
                } else {
                    resolve(row.active_term);
                }
            });
        });
    }

    private async getAvailableTerms(schoolId: string): Promise<Array<{ id: string; name: string }>> {
        return new Promise((resolve) => {
            db.getDB().all(
                `SELECT id, term_name FROM academic_terms WHERE school_id = ? ORDER BY start_date DESC`,
                [schoolId],
                (err, rows: any[]) => {
                    if (err || !rows || rows.length === 0) {
                        resolve([]);
                    } else {
                        resolve(rows.map(r => ({ id: r.id, name: r.term_name })));
                    }
                }
            );
        });
    }

    private extractTermFromMessage(messageBody: string): string | null {
        const lowerBody = messageBody.toLowerCase();

        const termPatterns = [
            /(?:last\s+)?term(?:'s)?\s*(?:results?|grades?|scores?|performance)?/i,
            /(?:first|second|third)\s+term(?:'s)?\s*(?:results?|grades?|scores?|performance)?/i,
            /(?:term\s+)?(?:1|2|3|first|second|third)/i,
        ];

        if (lowerBody.includes('last term') || lowerBody.includes("last term's")) {
            return 'last_term';
        }

        const firstTermMatch = lowerBody.match(/(?:first\s+term|term\s*1|1st\s+term)/i);
        if (firstTermMatch) {
            return 'first_term';
        }

        const secondTermMatch = lowerBody.match(/(?:second\s+term|term\s*2|2nd\s+term)/i);
        if (secondTermMatch) {
            return 'second_term';
        }

        const thirdTermMatch = lowerBody.match(/(?:third\s+term|term\s*3|3rd\s+term)/i);
        if (thirdTermMatch) {
            return 'third_term';
        }

        const yearMatch = lowerBody.match(/(?:first|second|third)\s+term\s+202[4-6]/i);
        if (yearMatch) {
            const termType = yearMatch[1].toLowerCase();
            return `${termType}_term_202${yearMatch[0].match(/202([4-6])/)?.[1] || '5'}`;
        }

        return null;
    }

    private async resolveTermId(requestedTerm: string | null, schoolId: string): Promise<string> {
        if (!requestedTerm || requestedTerm === 'current') {
            return this.getActiveTerm(schoolId);
        }

        if (requestedTerm === 'last_term') {
            const terms = await this.getAvailableTerms(schoolId);
            if (terms.length > 1) {
                return terms[1]?.id || terms[0]?.id;
            }
            return terms[0]?.id || 'current';
        }

        const terms = await this.getAvailableTerms(schoolId);
        const termNameMap: Record<string, string> = {
            'first_term': 'First Term',
            'second_term': 'Second Term',
            'third_term': 'Third Term',
        };

        const targetName = termNameMap[requestedTerm];
        if (targetName) {
            const matched = terms.find(t => t.name.toLowerCase().includes(targetName.toLowerCase()));
            if (matched) {
                return matched.id;
            }
        }

        return this.getActiveTerm(schoolId);
    }

    private async getParentUserRole(parentPhone: string, schoolId: string): Promise<string | null> {
        try {
            const activeSession = sessionService.getSession(parentPhone);
            if (activeSession && activeSession.role === 'parent') return 'parent';

            const parentRecord = await new Promise<any>((resolve) => {
                db.getDB().get(
                    `SELECT parent_id FROM parent_registry WHERE parent_phone = ? AND school_id = ? AND is_active = 1`,
                    [parentPhone, schoolId],
                    (err, row) => resolve(row)
                );
            });

            return parentRecord ? 'parent' : null;
        } catch (err) {
            return null;
        }
    }

    private async validateActionAuthorization(
        action: string,
        parentPhone: string,
        schoolId: string
    ): Promise<{ authorized: boolean; reason?: string }> {
        if (action === 'VERIFY_PARENT_TOKEN' || action === 'VERIFY_TEACHER_TOKEN') return { authorized: true };
        const userRole = await this.getParentUserRole(parentPhone, schoolId);
        if (!userRole) return { authorized: false, reason: 'User role not found' };
        return ActionAuthorizer.authorize(action, userRole as any);
    }

    async handle(message: RoutedMessage): Promise<PAOutput> {
        const phone = message.from;
        const existingPromise = ParentAgent.processingQueue.get(phone) || Promise.resolve();
        const newPromise = existingPromise.then(() => this.processSerialized(message))
            .catch(err => {
                logger.error({ err, phone }, 'Serialized processing failed');
                return { agent: 'PA' as const, reply_text: "Sorry, I hit a technical snag. Please try again.", action_required: 'NONE' as const, confidence_score: 0, session_active: false };
            });

        ParentAgent.processingQueue.set(phone, newPromise);
        newPromise.finally(() => {
            if (ParentAgent.processingQueue.get(phone) === newPromise) {
                ParentAgent.processingQueue.delete(phone);
            }
        });

        return newPromise;
    }

    private async processSerialized(message: RoutedMessage): Promise<PAOutput> { 
        logger.info({ msgId: message.id, from: message.from, isAuth: message.isTokenAuthenticated }, 'PA handling message (serialized)');
        const schoolId = (message as any).schoolId || message.identity?.schoolId;

        if (!schoolId) {
            return { 
                agent: 'PA',
                reply_text: "Welcome to KUMO! I need to know which school you're contacting. Please reply with your school's name.",
                action_required: 'NONE',
                confidence_score: 0.0,
                session_active: false
            };
        }

        // --- 🟢 IDENTITY RESOLUTION ---
        let isIdentifiedParent = message.identity?.role === 'parent'; 
        let parentChildren: any[] = [];
        let parentRecord: any = null;

        if (isIdentifiedParent) {
            parentRecord = { parent_id: message.identity?.userId, parent_name: message.identity?.name };
        } else {
            const registryCheck: any = await new Promise((resolve) => {
                db.getDB().get(
                    `SELECT parent_id, parent_name FROM parent_registry WHERE parent_phone = ? AND school_id = ? AND is_active = 1`,
                    [message.from, schoolId],
                    (err, row) => resolve(row)
                );
            });
            if (registryCheck) {
                parentRecord = registryCheck;
                isIdentifiedParent = true;
            }
        }

        if (isIdentifiedParent && parentRecord) {
            parentChildren = await this.getParentChildren(message.from, schoolId);
            let session = sessionService.getSession(message.from);
            if (!session) {
                await sessionService.createSession(parentRecord.parent_id, message.from, 'parent', 120, { schoolId });
                session = sessionService.getSession(message.from);
            }
            if (session && parentChildren.length === 1 && !session.context?.currently_viewing_child_id) {
                sessionService.updateContext(message.from, 'currently_viewing_child_id', parentChildren[0].studentId);
                sessionService.updateContext(message.from, 'currently_viewing_child_name', parentChildren[0].name);
            }
        }

        const session = sessionService.getSession(message.from);
        const bodyLower = message.body.toLowerCase();
        const hasAcademicIntent = bodyLower.includes('result') || bodyLower.includes('grade') || bodyLower.includes('score') || bodyLower.includes('how did') || bodyLower.includes('performance');

        // --- 🎯 DEEP-SEARCH STUDENT FOCUS ---
        let studentId = session?.context?.currently_viewing_child_id;
        let studentName = session?.context?.currently_viewing_child_name;
        let requestedTerm = session?.context?.requested_term || this.extractTermFromMessage(message.body);

        logger.debug({ 
            isIdentifiedParent, 
            hasAcademicIntent, 
            childCount: parentChildren.length,
            existingStudentId: studentId,
            requestedTerm
        }, '🔍 [PA] Attempting student identity resolution');

        if (isIdentifiedParent && !studentId) {
            // Find child mentioned in body
            const mentionedChild = parentChildren.find(c => bodyLower.includes(c.name.toLowerCase().split(' ')[0]));
            if (mentionedChild) {
                studentId = mentionedChild.studentId;
                studentName = mentionedChild.name;
                logger.debug({ studentId, studentName }, '🎯 [PA] Student resolved via name mention');
            } else if (parentChildren.length === 1) {
                studentId = parentChildren[0].studentId;
                studentName = parentChildren[0].name;
                logger.debug({ studentId, studentName }, '🎯 [PA] Student resolved via single-child fallback');
            }

            if (studentId) {
                sessionService.updateContext(message.from, 'currently_viewing_child_id', studentId);
                sessionService.updateContext(message.from, 'currently_viewing_child_name', studentName);
            }
        }

        // ✅ CONVERSATIONAL ACADEMIC MERGER (Authority Flow)
        if (isIdentifiedParent && hasAcademicIntent && studentId) {
            const { ReportService } = await import('../../services/report-service');
            const termId = await this.resolveTermId(requestedTerm, schoolId);
            const releasedData = await ReportService.getStudentReleasedResult(studentId, termId);

            if (releasedData) {
                logger.info({ studentId, termId }, '✅ [PA] Released result found - triggering single PDF generation');
                
                const schoolRow: any = await new Promise((resolve) => 
                    db.getDB().get(`SELECT name, grading_config FROM schools WHERE id = ?`, [schoolId], (err, row) => resolve(row))
                );
                const gradingConfig = JSON.parse(schoolRow?.grading_config || '{}');

                const termInfo = await new Promise<any>((resolve) =>
                    db.getDB().get(`SELECT term_name FROM academic_terms WHERE id = ?`, [termId], (err, row) => resolve(row))
                );

                const pdfResult = await pdfGenerator.generatePDF({
                    schoolId,
                    schoolName: schoolRow?.name || 'Kumo Academy',
                    templateType: 'student_report_card',
                    templateData: {
                        ...releasedData,
                        pillars: gradingConfig.pillars || [],
                        term_name: termInfo?.term_name || 'Current Term'
                    },
                    timestamp: Date.now(),
                    generatedBy: 'Parent Agent'
                });

                const termDisplayName = termInfo?.term_name || (requestedTerm === 'last_term' ? 'Last Term' : 'Current Term');

                return {
                    agent: 'PA',
                    reply_text: `I've retrieved ${studentName}'s ${termDisplayName} report card. It shows an average of ${releasedData.average}% and a class position of ${releasedData.position}. Attached is the full report!`,
                    action_required: 'NONE',
                    delivery_type: 'document',
                    action_payload: { pdf_path: pdfResult.filePath },
                    confidence_score: 1.0,
                    session_active: true
                };
            } else {
                const termInfo = await new Promise<any>((resolve) =>
                    db.getDB().get(`SELECT term_name FROM academic_terms WHERE id = ?`, [termId], (err, row) => resolve(row))
                );
                const termDisplayName = termInfo?.term_name || (requestedTerm === 'last_term' ? 'Last Term' : 'Current Term');
                
                logger.info({ studentId, termId }, '⚠️ [PA] Academic intent detected but results not yet RELEASED');
                return {
                    agent: 'PA',
                    reply_text: `I understand you're looking for ${studentName}'s ${termDisplayName} results. The school is currently finalizing the academic records. I'll notify you the moment the Principal releases them!`,
                    action_required: 'NONE',
                    confidence_score: 1.0,
                    session_active: true
                };
            }
        }

        // --- 🟢 GATEWAY: TOKEN DETECTION ---
        if (bodyLower.includes('pat-kumo-')) {
            const tokenMatch = message.body.match(/PAT-KUMO-[A-Z0-9-]+/i);
            if (tokenMatch) {
                // Send immediate acknowledgement
                const ackMessage = "Welcome! Thank you for sharing your access code. I'm verifying it now to keep your information secure.";
                await messenger.sendPush(schoolId, message.from, ackMessage);
                
                // Execute the verification action
                const { ActionHandlerRegistry } = await import('../../core/action-handler-registry');
                const tokenResponse = await ActionHandlerRegistry.executeAction({
                    output: {
                        action_required: 'VERIFY_PARENT_TOKEN',
                        action_payload: { token: tokenMatch[0] }
                    },
                    message,
                    schoolId
                });
                
                // Send the verification result
                if (tokenResponse.reply_text) {
                    await messenger.sendPush(schoolId, message.from, tokenResponse.reply_text);
                }
                
                return {
                    agent: 'PA',
                    reply_text: "",
                    action_required: 'NONE',
                    confidence_score: 1.0,
                    session_active: false
                };
            }
        }

        const isInSetup = await SetupRepository.isSchoolInSetup(schoolId);
        if (isInSetup) return { agent: 'PA', reply_text: "Our school is currently setting up its system. Please check back later.", action_required: 'NONE', confidence_score: 1.0, session_active: false };

        // --- 🟢 NORMAL CONVERSATION TURN ---
        const contextPrompt = message.body;
        
        const schoolRow: any = await new Promise((resolve) => db.getDB().get(`SELECT * FROM schools WHERE id = ?`, [schoolId], (err, row) => resolve(row)));
        const schoolType = schoolRow?.school_type || 'SECONDARY';

        const availableTerms = await this.getAvailableTerms(schoolId);
        const termOptions = availableTerms.length > 0 
            ? availableTerms.map(t => t.name).join(', ') 
            : 'Current Term';

        const systemPrompt = await PromptEngine.assemble({
            agent: 'pa',
            schoolId,
            dynamicVars: {
                session_active: !!session,
                identified_parent: isIdentifiedParent,
                children_list: parentChildren.map(c => `${c.name} (${c.classLevel})`).join(', '),
                linked_student_id: studentId || 'None',
                linked_student_name: studentName || 'None',
                parent_name: parentRecord?.parent_name || 'Parent',
                school_type: schoolType,
                user_phone: message.from,
                available_terms: termOptions
            }
        });

        const finalSystemPrompt = systemPrompt;

        try {
            const aiRes = await aiProvider.generateText(PA_CONFIG, contextPrompt, finalSystemPrompt);
            const parsed = JSON.parse(aiRes.text.replace(/```json/g, '').replace(/```/g, '').trim()) as PAOutput;

            // ✅ UNIVERSAL IMMEDIATE ACKNOWLEDGEMENT
            if (parsed.action_required !== 'NONE' && parsed.reply_text) {
                logger.info({ action: parsed.action_required }, '📣 [PA] Intent detected - sending immediate acknowledgement');
                await messenger.sendPush(schoolId, message.from, parsed.reply_text);
                parsed.reply_text = ""; // Clear to allow synthesis turn for outcome
            }

            if (parsed.action_required !== 'NONE') {
                const auth = await this.validateActionAuthorization(parsed.action_required, message.from, schoolId);
                if (!auth.authorized) {
                    parsed.reply_text = "For your child's safety, I need you to provide the PAT- token provided by the school before I can show this information.";
                    parsed.action_required = 'NONE';
                    return parsed;
                }

                // 🚀 USE ACTION HANDLER REGISTRY
                const { ActionHandlerRegistry } = await import('../../core/action-handler-registry');
                const result = await ActionHandlerRegistry.executeAction({
                    output: parsed,
                    message,
                    schoolId
                });

                // If the action produced a technical result, synthesize it
                if (result.action_payload?.success !== undefined || result.action_payload?.result_available) {
                    result.reply_text = await this.synthesizeActionResult(
                        parsed.action_required,
                        result.action_payload,
                        result.reply_text,
                        contextPrompt,
                        finalSystemPrompt,
                        PA_CONFIG
                    );
                    result.action_required = 'NONE';
                }
                
                return result;
            }

            return parsed;
        } catch (e) {
            return { agent: 'PA', reply_text: "I'm having trouble connecting. Please try again.", action_required: 'NONE', confidence_score: 0, session_active: !!session };
        }
    }

    private async handleImage(message: RoutedMessage, output: PAOutput, contextPrompt: string, systemPrompt: string): Promise<PAOutput> {
        try {
            // Check if this looks like a payment receipt
            if (message.mediaPath && message.mediaType) {
                const visionResult = await visionService.analyzeImage(
                    message.mediaPath,
                    undefined,
                    'payment'
                );

                if (visionResult.success && visionResult.data) {
                    const extractedData = visionResult.data;
                    const isPayment = visionResult.docType === 'PAYMENT_RECEIPT' || 
                                      (extractedData?.document_type === 'payment_receipt') ||
                                      (extractedData?.payment_type === 'school_fees');
                    
                    if (isPayment && extractedData?.amount) {
                        // Extract payment details from vision result
                        const amount = extractedData.amount || this.extractAmountFromText(extractedData?.explanation || '');
                        const transactionId = extractedData.transaction_reference || extractedData.transaction_id;
                        const sender = extractedData.sender_name || message.identity?.name || 'Parent';
                        const paymentDate = extractedData.transaction_date || extractedData.date || new Date().toISOString().split('T')[0];

                        if (!amount) {
                            return { 
                                agent: 'PA', 
                                reply_text: "I can see this is a payment receipt, but I couldn't read the amount clearly. Please tell me how much you paid (e.g., 'I paid ₦15,000').", 
                                action_required: 'NONE', 
                                confidence_score: 0.7, 
                                session_active: true 
                            };
                        }

                        // Escalate to admin for verification
                        return {
                            agent: 'PA',
                            reply_text: `📄 Payment Receipt Received\n\nAmount: ₦${amount}\nDate: ${paymentDate}\n\nI'll submit this to the school administrator for verification. You'll receive confirmation once it's processed.`,
                            action_required: 'ESCALATE_PAYMENT',
                            action_payload: {
                                amount: amount,
                                date: paymentDate,
                                sender: sender,
                                transaction_id: transactionId,
                                imagePath: message.mediaPath
                            },
                            confidence_score: 0.9,
                            session_active: true
                        };
                    }
                }
            }

            // Not a payment receipt - provide helpful response
            return { 
                agent: 'PA', 
                reply_text: "I've received your image. If this is a payment receipt, I couldn't recognize it clearly. Please ensure the image shows:\n\n• Amount paid\n• Transaction date\n• Sender name\n\nYou can also type the payment details directly.", 
                action_required: 'NONE', 
                confidence_score: 0.6, 
                session_active: true 
            };
        } catch (error) {
            logger.error({ error, phone: message.from }, 'Payment image processing failed');
            return { 
                agent: 'PA', 
                reply_text: "I'm having trouble processing your image. Please try again or type your payment details directly (e.g., 'I paid ₦15,000 school fees').", 
                action_required: 'NONE', 
                confidence_score: 0.5, 
                session_active: true 
            };
        }
    }

    private extractAmountFromText(text: string): number | null {
        // Look for currency patterns like ₦15000, N15000, 15000 NGN
        const patterns = [
            /[₦N]\s?(\d{1,6}(?:,\d{3})*)/i,
            /(\d{1,6}(?:,\d{3})*)\s?(?:naira|ngn)/i,
            /amount[\s:]+[₦N]?\s?(\d{1,6}(?:,\d{3})*)/i
        ];
        
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                return parseInt(match[1].replace(/,/g, ''), 10);
            }
        }
        return null;
    }
}
