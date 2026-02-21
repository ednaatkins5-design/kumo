/**
 * 🔐 ACTION HANDLER REGISTRY (Phase 4 Implementation)
 * 
 * Data-driven action handler lookup replaces 40+ hardcoded if statements
 * Each action maps to its handler function for consistent execution
 * 
 * Benefits:
 * - Single source of truth for handler logic
 * - New actions added without code changes to main agent
 * - Consistent error handling across all agents
 * - Easy to audit which actions are implemented
 */

import { logger } from '../utils/logger';
import { db } from '../db';
import crypto from 'crypto';
import { ActionAuthorizer, UserRole } from './action-authorization';
import { PhoneNormalizer } from '../utils/phone-normalizer';

export interface ActionHandlerContext {
    output: any;  // Agent output with action_required
    message: any; // RoutedMessage
    schoolId: string;
    context?: any; // Additional context (teacher_id, etc)
}

export interface ActionHandler {
    execute(ctx: ActionHandlerContext): Promise<any>;
}

/**
 * Handler implementations for each action
 * Extracted from hardcoded if statements in agents
 */

class LockResultsHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const { term_id, class_level } = output.action_payload || {};
        
        if (!term_id || !class_level) {
            output.reply_text = "I need the term ID and class level to lock results.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            const { db } = await import('../db');
            const { AuditTrailService } = await import('../services/audit');
            
            await new Promise<void>((resolve, reject) => {
                db.getDB().run(
                    `UPDATE term_results SET status = 'locked', locked_at = CURRENT_TIMESTAMP WHERE school_id = ? AND term_id = ? AND class_level = ?`,
                    [schoolId, term_id, class_level],
                    (err) => err ? reject(err) : resolve()
                );
            });

            await AuditTrailService.logAuditEvent({
                actor_phone: message.from,
                action: 'LOCK_RESULTS',
                target_resource: `term_results:${schoolId}:${term_id}:${class_level}`,
                details: { term_id, class_level, timestamp: new Date().toISOString() }
            });

            output.reply_text = `✓ Results locked for ${class_level} (Term ${term_id})\nParents can no longer view results.`;
            output.action_required = 'NONE';
        } catch (error) {
            logger.error({ error, term_id, class_level }, 'LOCK_RESULTS failed');
            output.reply_text = "I couldn't lock the results. Please verify the term and class level.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

class UnlockResultsHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const { term_id, class_level } = output.action_payload || {};
        
        if (!term_id || !class_level) {
            output.reply_text = "I need the term ID and class level to unlock results.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            const { db } = await import('../db');
            const { AuditTrailService } = await import('../services/audit');
            
            await new Promise<void>((resolve, reject) => {
                db.getDB().run(
                    `UPDATE term_results SET status = 'draft', locked_at = NULL WHERE school_id = ? AND term_id = ? AND class_level = ?`,
                    [schoolId, term_id, class_level],
                    (err) => err ? reject(err) : resolve()
                );
            });

            await AuditTrailService.logAuditEvent({
                actor_phone: message.from,
                action: 'UNLOCK_RESULTS',
                target_resource: `term_results:${schoolId}:${term_id}:${class_level}`,
                details: { term_id, class_level, timestamp: new Date().toISOString() }
            });

            output.reply_text = `✓ Results unlocked for ${class_level} (Term ${term_id})\nResults are now in draft mode.`;
            output.action_required = 'NONE';
        } catch (error) {
            logger.error({ error, term_id, class_level }, 'UNLOCK_RESULTS failed');
            output.reply_text = "I couldn't unlock the results. Please verify the term and class level.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

class ConfirmPaymentHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const transactionId = output.action_payload?.transaction_id;
        const reason = output.action_payload?.reason || 'Payment confirmed by admin';
        
        if (!transactionId) {
            output.reply_text = "I need the transaction ID to confirm.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            const { TransactionRepository } = await import('../db/repositories/transaction.repo');
            const { EscalationRepository } = await import('../db/repositories/escalation.repo');
            
            const escalationId = (output as any).escalation_payload?.escalation_id;
            
            await TransactionRepository.confirmTransaction(transactionId, message.from, reason);
            
            if (escalationId) {
                await EscalationRepository.recordAdminDecision(escalationId, {
                    admin_decision: 'APPROVE',
                    admin_instruction: `Payment confirmed by admin`,
                    resolved_by: message.from,
                    school_id: schoolId
                });
                logger.info({ escalationId, transactionId }, '✅ Payment linked to escalation');
            }

            output.reply_text = `✅ Payment confirmed and logged.`;
            output.action_required = 'NONE';
        } catch (error) {
            logger.error({ error, transactionId }, 'CONFIRM_PAYMENT failed');
            output.reply_text = "I couldn't confirm the payment.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

class ConfirmMarkSubmissionHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId, context } = ctx;
        const submissionId = output.action_payload?.submission_id;
        
        if (!submissionId) {
            output.reply_text = "I need the submission ID to confirm.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            const { db } = await import('../db');
            const { MarkSubmissionRepository } = await import('../db/repositories/mark-submission.repo');
            
            await MarkSubmissionRepository.confirmSubmission(submissionId, message.from);
            
            output.reply_text = `✅ Mark submission confirmed and ready for review.`;
            output.action_required = 'NONE';
        } catch (error) {
            logger.error({ error, submissionId }, 'CONFIRM_MARK_SUBMISSION failed');
            output.reply_text = "I couldn't confirm the marks.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

class ConfirmAmendmentHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const amendmentId = output.action_payload?.amendment_id;
        const reason = output.action_payload?.reason || 'Amendment confirmed by admin';
        
        if (!amendmentId) {
            output.reply_text = "I need the amendment ID to confirm.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            const { EscalationRepository } = await import('../db/repositories/escalation.repo');
            
            const escalationId = (output as any).escalation_payload?.escalation_id;
            
            if (escalationId) {
                await EscalationRepository.recordAdminDecision(escalationId, {
                    admin_decision: 'APPROVE',
                    admin_instruction: `Amendment confirmed by admin`,
                    resolved_by: message.from,
                    school_id: schoolId
                });
                logger.info({ escalationId, amendmentId }, '✅ Amendment linked to escalation');
            }

            output.reply_text = `✅ Amendment confirmed and logged.`;
            output.action_required = 'NONE';
        } catch (error) {
            logger.error({ error, amendmentId }, 'CONFIRM_AMENDMENT failed');
            output.reply_text = "I couldn't confirm the amendment.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

class ReleaseResultsHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const { term_id, class_level } = output.action_payload || {};
        
        if (!term_id || !class_level) {
            output.reply_text = "I need the term ID and class level to release results.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            const { db } = await import('../db');
            const { AuditTrailService } = await import('../services/audit');
            
            await new Promise<void>((resolve, reject) => {
                db.getDB().run(
                    `UPDATE term_results SET status = 'released', released_at = CURRENT_TIMESTAMP WHERE school_id = ? AND term_id = ? AND class_level = ?`,
                    [schoolId, term_id, class_level],
                    (err) => err ? reject(err) : resolve()
                );
            });

            await AuditTrailService.logAuditEvent({
                actor_phone: message.from,
                action: 'RELEASE_RESULTS',
                target_resource: `term_results:${schoolId}:${term_id}:${class_level}`,
                details: { term_id, class_level, timestamp: new Date().toISOString() }
            });

            output.reply_text = `✓ Results released for ${class_level} (Term ${term_id})\nParents can now view their children's results.`;
            output.action_required = 'NONE';
        } catch (error) {
            logger.error({ error, term_id, class_level }, 'RELEASE_RESULTS failed');
            output.reply_text = "I couldn't release the results. Please verify the term and class level.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

class DeliverStudentPDFHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const { student_id } = output.action_payload || {};
        
        if (!student_id) {
            output.reply_text = "I need to know which student's report to deliver.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            const { ReportService } = await import('../services/report-service');
            const { pdfGenerator } = await import('../services/pdf-generator');
            
            // Get released result for student
            const releasedData = await ReportService.getStudentReleasedResult(student_id, 'current');
            
            if (!releasedData) {
                output.reply_text = "The student's report is not yet available. Results may not have been released by the school.";
                output.action_required = 'NONE';
                return output;
            }

            // Get school info
            const schoolRow: any = await new Promise((resolve) => {
                db.getDB().get(`SELECT name, grading_config FROM schools WHERE id = ?`, [schoolId], (err, row) => resolve(row));
            });
            const gradingConfig = JSON.parse(schoolRow?.grading_config || '{}');

            // Generate PDF
            const pdfResult = await pdfGenerator.generatePDF({
                schoolId,
                schoolName: schoolRow?.name || 'Kumo Academy',
                templateType: 'student_report_card',
                templateData: {
                    ...releasedData,
                    pillars: gradingConfig.pillars || []
                },
                timestamp: Date.now(),
                generatedBy: 'Action Handler'
            });

            if (pdfResult.filePath) {
                output.reply_text = `📄 Here's ${output.action_payload?.student_name || 'your child'}'s report card! It shows an average of ${releasedData.average}% and a class position of ${releasedData.position}.`;
                output.action_payload = { ...output.action_payload, pdf_path: pdfResult.filePath };
            } else {
                output.reply_text = "I couldn't generate the report. Please try again.";
                output.action_required = 'NONE';
            }
        } catch (error) {
            logger.error({ error, student_id }, 'DELIVER_STUDENT_PDF failed');
            output.reply_text = "I couldn't generate the report. Please try again.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

class RegisterStudentHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const { name, class_level } = output.action_payload || {};
        
        if (!name || !class_level) {
            output.reply_text = "I need the student's name and class level.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            // Generate student ID
            const studentId = `${schoolId.substring(0, 8).toUpperCase()}-${class_level.toUpperCase().replace(' ', '')}-${Date.now().toString(36).toUpperCase()}`;
            
            // Insert student
            await new Promise<void>((resolve, reject) => {
                db.getDB().run(
                    `INSERT INTO students (student_id, school_id, name, class_level) VALUES (?, ?, ?, ?)`,
                    [studentId, schoolId, name, class_level],
                    (err) => err ? reject(err) : resolve()
                );
            });

            output.reply_text = `✅ ${name} has been registered in ${class_level}.`;
            output.action_required = 'NONE';
            
            logger.info({ studentId, name, class_level, schoolId }, 'Student registered');
        } catch (error) {
            logger.error({ error, name, class_level, schoolId }, 'REGISTER_STUDENT failed');
            output.reply_text = "I couldn't register the student. Please try again.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

class RevokeTeacherTokenHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const { phone, reason } = output.action_payload || {};
        
        if (!phone) {
            output.reply_text = "I need the teacher's phone number.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            const normalizedPhone = PhoneNormalizer.normalize(phone);
            
            // Find teacher
            const teacher: any = await new Promise((resolve) => {
                db.getDB().get(
                    `SELECT id FROM users WHERE phone = ? AND role = 'teacher' AND school_id = ?`,
                    [normalizedPhone, schoolId],
                    (err, row) => resolve(row)
                );
            });

            if (!teacher) {
                output.reply_text = `No teacher found with phone ${phone}.`;
                output.action_required = 'NONE';
                return output;
            }

            // Revoke all tokens for teacher
            await new Promise<void>((resolve, reject) => {
                db.getDB().run(
                    `DELETE FROM teacher_access_tokens WHERE teacher_id = ? AND school_id = ?`,
                    [teacher.id, schoolId],
                    (err) => err ? reject(err) : resolve()
                );
            });

            output.reply_text = `✅ Access revoked for ${phone}.`;
            output.action_required = 'NONE';
            
            logger.info({ phone: normalizedPhone, schoolId, reason }, 'Teacher token revoked');
        } catch (error) {
            logger.error({ error, phone, schoolId }, 'REVOKE_TEACHER_TOKEN failed');
            output.reply_text = "I couldn't revoke access. Please try again.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

class GetTeacherTokenHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const { name, phone, assigned_class } = output.action_payload || {};
        
        if (!name || !phone) {
            output.reply_text = "I need the teacher's name and phone number.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            const normalizedPhone = PhoneNormalizer.normalize(phone);
            
            // Check for existing teacher
            const existing: any = await new Promise((resolve) => {
                db.getDB().get(
                    `SELECT id FROM users WHERE phone = ? AND role = 'teacher' AND school_id = ?`,
                    [normalizedPhone, schoolId],
                    (err, row) => resolve(row)
                );
            });

            if (existing) {
                output.reply_text = `A teacher with phone ${normalizedPhone} is already registered.`;
                output.action_required = 'NONE';
                return output;
            }

            // Create teacher
            const teacherId = crypto.randomUUID();
            await new Promise<void>((resolve, reject) => {
                db.getDB().run(
                    `INSERT INTO users (id, phone, role, name, school_id, assigned_class, school_type) VALUES (?, ?, 'teacher', ?, ?, ?, ?)`,
                    [teacherId, normalizedPhone, name, schoolId, null, 'SECONDARY'],
                    (err) => err ? reject(err) : resolve()
                );
            });

            // Generate token
            const token = `TEA-KUMO-${crypto.randomUUID().split('-')[0].toUpperCase()}`;
            await new Promise<void>((resolve, reject) => {
                db.getDB().run(
                    `INSERT INTO teacher_access_tokens (token, teacher_id, school_id, expires_at) VALUES (?, ?, ?, datetime('now', '+1 year'))`,
                    [token, teacherId, schoolId],
                    (err) => err ? reject(err) : resolve()
                );
            });

            output.reply_text = `✅ Teacher registered!\n\nName: ${name}\nToken: ${token}\n\nShare this with the teacher.`;
            output.action_required = 'NONE';
            
            logger.info({ teacherId, name, phone: normalizedPhone, schoolId }, 'Teacher token generated');
        } catch (error) {
            logger.error({ error, name, phone, schoolId }, 'GET_TEACHER_TOKEN failed');
            output.reply_text = "I couldn't generate a token. Please try again.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

class EscalatePaymentHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const { amount, date, sender, imagePath, transaction_id } = output.action_payload || {};
        
        if (!amount) {
            output.reply_text = "I need to know the payment amount to escalate this.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            const { EscalationServiceV2 } = await import('../services/escalation-v2');
            
            // Create payment escalation
            const escalationId = await EscalationServiceV2.pauseForEscalation({
                origin_agent: 'PA',
                escalation_type: 'PAYMENT_CONFIRMATION',
                priority: 'MEDIUM',
                school_id: schoolId,
                from_phone: message.from,
                session_id: message.sessionId || `session-${Date.now()}`,
                pause_message_id: `MSG-${Date.now()}`,
                user_name: message.identity?.name || 'Parent',
                user_role: 'parent',
                reason: `Parent submitted payment receipt for ₦${amount}`,
                what_agent_needed: 'Verify payment receipt and confirm transaction',
                context: {
                    amount,
                    payment_date: date,
                    sender_name: sender,
                    transaction_id,
                    receipt_image_path: imagePath
                }
            });

            output.reply_text = `✅ Your payment receipt for ₦${amount} has been submitted to the school administrator for verification.\n\nYou'll receive confirmation once it's processed.`;
            output.action_required = 'NONE';
            
            logger.info({ escalationId, amount, schoolId }, 'Payment escalation created');
        } catch (error) {
            logger.error({ error, amount, schoolId }, 'ESCALATE_PAYMENT failed');
            output.reply_text = "I couldn't submit your payment receipt. Please try again or contact the school directly.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

class VerifyParentTokenHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const { token } = output.action_payload || {};
        
        if (!token) {
            output.reply_text = "I need the access token to verify your identity.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            const { ParentRepository } = await import('../db/repositories/parent.repo');
            
            const parentInfo = await ParentRepository.validateAccessToken(token.toUpperCase(), schoolId);
            
            if (!parentInfo) {
                output.reply_text = "❌ The access token you provided is invalid or has expired. Please check with your child's school for a valid token.";
                output.action_required = 'NONE';
                return output;
            }

            // Update parent's phone with the current session phone if not already linked
            await new Promise<void>((resolve, reject) => {
                db.getDB().run(
                    `UPDATE parent_registry SET parent_phone = ? WHERE parent_id = ? AND school_id = ?`,
                    [message.from, parentInfo.parentId, schoolId],
                    (err) => err ? reject(err) : resolve()
                );
            });

            const childrenList = parentInfo.studentIds.length > 0 
                ? parentInfo.studentIds.join(', ')
                : 'No children linked yet';

            output.reply_text = `✅ Access verified successfully!\n\nWelcome, ${parentInfo.parentName}!\n\nYour linked children: ${childrenList}\n\nYou can now ask about your child's results, attendance, or fees.`;
            output.action_payload = {
                ...output.action_payload,
                verified: true,
                parent_id: parentInfo.parentId,
                parent_name: parentInfo.parentName,
                children: parentInfo.studentIds
            };
            output.action_required = 'NONE';
            
            logger.info({ parentId: parentInfo.parentId, phone: message.from, schoolId }, 'Parent token verified');
        } catch (error) {
            logger.error({ error, token, schoolId }, 'VERIFY_PARENT_TOKEN failed');
            output.reply_text = "I couldn't verify your token. Please try again or contact the school.";
            output.action_required = 'NONE';
        }
        return output;
    }
}

/**
 * UNIFY_PARENT Handler - Link parent phone to existing student(s)
 * Used by both PA (when parent declares child) and SA
 */
class UnifyParentHandler implements ActionHandler {
    async execute(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        const children = output.action_payload?.unify_children || output.action_payload?.children || [];
        
        // Get parent phone - prefer from message (actual sender)
        const parentPhone = message.from;
        
        if (!children || !Array.isArray(children) || children.length === 0) {
            output.reply_text = "I need to know your child's name and class to link them. Please tell me, for example: 'My child is Musa in Primary 3'.";
            output.action_required = 'NONE';
            return output;
        }

        try {
            // Find or create parent record
            let parentRecord: any = await new Promise((resolve) => {
                db.getDB().get(
                    `SELECT parent_id, parent_name FROM parent_registry WHERE parent_phone = ? AND school_id = ? AND is_active = 1`,
                    [parentPhone, schoolId],
                    (err, row) => resolve(row)
                );
            });

            if (!parentRecord) {
                // Create parent record if doesn't exist
                const token = crypto.randomBytes(4).toString('hex').toUpperCase();
                const parentId = `parent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                
                await new Promise<void>((resolve, reject) => {
                    db.getDB().run(
                        `INSERT INTO parent_registry (parent_id, school_id, parent_phone, parent_name, parent_access_token, token_expires_at, is_active, created_at)
                         VALUES (?, ?, ?, 'Parent', ?, datetime('now', '+30 days'), 1, datetime('now'))`,
                        [parentId, schoolId, parentPhone, token],
                        (err) => err ? reject(err) : resolve()
                    );
                });

                parentRecord = { parent_id: parentId, parent_name: 'Parent' };
            }

            const linkedChildren = [];
            const failedChildren = [];

            for (const child of children) {
                const student_name = child.student_name || child.name;
                const class_level = child.class_level || child.class;

                if (!student_name || !class_level) {
                    failedChildren.push({ student_name, reason: "Missing name or class" });
                    continue;
                }

                // Find student by name and class
                const student: any = await new Promise((resolve) => {
                    db.getDB().get(
                        `SELECT student_id, name FROM students WHERE LOWER(name) LIKE LOWER(?) AND LOWER(class_level) = LOWER(?) AND school_id = ?`,
                        [`%${student_name}%`, class_level, schoolId],
                        (err, row) => resolve(row)
                    );
                });

                if (!student) {
                    failedChildren.push({ student_name, reason: "Student not found in this class" });
                    continue;
                }

                // Check if already linked
                const existingLink: any = await new Promise((resolve) => {
                    db.getDB().get(
                        `SELECT * FROM parent_children_mapping WHERE parent_id = ? AND student_id = ?`,
                        [parentRecord.parent_id, student.student_id],
                        (err, row) => resolve(row)
                    );
                });

                if (existingLink) {
                    linkedChildren.push({ student_name: student.name, status: 'already_linked' });
                    continue;
                }

                // Create mapping
                await new Promise<void>((resolve, reject) => {
                    db.getDB().run(
                        `INSERT INTO parent_children_mapping (parent_id, student_id, school_id, linked_at)
                         VALUES (?, ?, ?, datetime('now'))`,
                        [parentRecord.parent_id, student.student_id, schoolId],
                        (err) => err ? reject(err) : resolve()
                    );
                });

                linkedChildren.push({ student_name: student.name, status: 'linked' });
            }

            // Build response
            if (linkedChildren.length > 0) {
                const childNames = linkedChildren.map(c => c.student_name).join(', ');
                output.reply_text = `✅ *Link Complete!*\n\nYour child(ren) have been linked: ${childNames}\n\nYou can now check their results, attendance, and fees.`;
            } else if (failedChildren.length > 0) {
                const reasons = failedChildren.map(c => `${c.student_name}: ${c.reason}`).join(', ');
                output.reply_text = `I couldn't find some children: ${reasons}. Please check the names and classes.`;
            }
            
            output.action_payload = {
                success: true,
                linked_children: linkedChildren,
                failed_children: failedChildren
            };
            output.action_required = 'NONE';

            return output;

        } catch (error) {
            logger.error({ error }, 'UNIFY_PARENT failed');
            output.reply_text = "Sorry, I encountered an error while linking your child. Please try again.";
            output.action_required = 'NONE';
            return output;
        }
    }
}

/**
 * MAIN REGISTRY: Maps action names to handler instances
 */
export const ACTION_HANDLERS: Record<string, ActionHandler> = {
    // SA Actions
    'LOCK_RESULTS': new LockResultsHandler(),
    'UNLOCK_RESULTS': new UnlockResultsHandler(),
    'RELEASE_RESULTS': new ReleaseResultsHandler(),
    'CONFIRM_PAYMENT': new ConfirmPaymentHandler(),
    'CONFIRM_AMENDMENT': new ConfirmAmendmentHandler(),
    'CONFIRM_MARK_SUBMISSION': new ConfirmMarkSubmissionHandler(),
    'REGISTER_STUDENT': new RegisterStudentHandler(),
    'REVOKE_TEACHER_TOKEN': new RevokeTeacherTokenHandler(),
    'GET_TEACHER_TOKEN': new GetTeacherTokenHandler(),
    
    // PA Actions
    'DELIVER_STUDENT_PDF': new DeliverStudentPDFHandler(),
    'ESCALATE_PAYMENT': new EscalatePaymentHandler(),
    'VERIFY_PARENT_TOKEN': new VerifyParentTokenHandler(),
    'UNIFY_PARENT': new UnifyParentHandler(),
    
    // Add more handlers as needed
    // Phase 4 continues to migrate other handlers...
};

/**
 * Execute action using registry
 * Used by agents instead of hardcoded if statements
 * 
 * BEFORE:
 * if (output.action_required === 'LOCK_RESULTS') { ... }
 * else if (output.action_required === 'UNLOCK_RESULTS') { ... }
 * 
 * AFTER:
 * const handler = await ActionHandlerRegistry.getHandler(output.action_required);
 * return await handler.execute(ctx);
 */
export class ActionHandlerRegistry {
    static async getHandler(actionName: string): Promise<ActionHandler | null> {
        return ACTION_HANDLERS[actionName] || null;
    }

    static async executeAction(ctx: ActionHandlerContext): Promise<any> {
        const { output, message, schoolId } = ctx;
        
        const actionName = output.action_required;
        
        // Special case: VERIFY_PARENT_TOKEN and VERIFY_TEACHER_TOKEN don't require prior authorization
        // They are authentication actions that verify the user's identity
        // Special case: UNIFY_PARENT can be performed by newly added parents
        if (actionName !== 'VERIFY_PARENT_TOKEN' && actionName !== 'VERIFY_TEACHER_TOKEN' && actionName !== 'UNIFY_PARENT') {
            const userRole = (message.identity?.role || message.fromRole) as UserRole | null;
            const intentClear = output.intent_clear === true;
            const authorityAcknowledged = output.authority_acknowledged === true;
            
            const authResult = ActionAuthorizer.authorize(
                actionName,
                userRole,
                intentClear,
                authorityAcknowledged
            );
            
            if (!authResult.authorized) {
                logger.warn({ 
                    action: actionName, 
                    userRole, 
                    reason: authResult.reason,
                    from: message.from 
                }, 'Action authorization failed');
                
                output.reply_text = `I'm sorry, you're not authorized to perform this action. ${authResult.reason || ''}`;
                output.action_required = 'NONE';
                return output;
            }
        }
        
        // For UNIFY_PARENT, do a custom check - allow if parent exists in registry
        if (actionName === 'UNIFY_PARENT') {
            const { db } = await import('../db');
            const parentPhone = message.from;
            
            const parentRecord = await new Promise<any>((resolve) => {
                db.getDB().get(
                    `SELECT parent_id FROM parent_registry WHERE parent_phone = ? AND school_id = ? AND is_active = 1`,
                    [parentPhone, schoolId],
                    (err, row) => resolve(row)
                );
            });
            
            if (!parentRecord) {
                logger.warn({ action: actionName, parentPhone }, 'UNIFY_PARENT: Parent not in registry');
                output.reply_text = "I couldn't verify your parent account. Please contact the school to be added.";
                output.action_required = 'NONE';
                return output;
            }
        }
        
        const handler = await this.getHandler(actionName);
        
        if (!handler) {
            logger.warn({ action: ctx.output.action_required }, '❌ Action not found in registry');
            ctx.output.reply_text = `I don't know how to handle that action yet: ${ctx.output.action_required}`;
            ctx.output.action_required = 'NONE';
            return ctx.output;
        }

        return await handler.execute(ctx);
    }
}
