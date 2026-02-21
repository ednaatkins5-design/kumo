export type SAActionType = 
    | 'NONE'
    | 'MANAGE_STAFF'
    | 'MANAGE_PARENTS'
    | 'LOCK_RESULTS'
    | 'UNLOCK_RESULTS'
    | 'RELEASE_RESULTS'
    | 'CONFIRM_PAYMENT'
    | 'REJECT_PAYMENT'
    | 'GET_TEACHER_TOKEN'
    | 'REVOKE_TEACHER_TOKEN'
    | 'REGISTER_STUDENT'
    | 'PROPOSE_AMENDMENT'
    | 'CONFIRM_AMENDMENT'
    | 'CLOSE_ALL_ESCALATIONS'
    | 'CLOSE_ESCALATION'
    | 'APPROVE_MARK_SUBMISSION'
    | 'APPROVE_MARK_AMENDMENT'
    | 'DENY_MARK_AMENDMENT'
    | 'REQUEST_MARK_CORRECTION'
    | 'ENGAGE_PARENTS'
    | 'UNIFY_PARENT'
    | 'TRIGGER_PROACTIVE_ENGAGEMENT';

export interface SAOutput {
    agent: 'SA';
    reply_text: string;  // Primary response (backend uses this field)
    action_required: SAActionType;
    intent_clear: boolean;  // Escalation: Is admin's decision unambiguous? (gates side effects)
    authority_acknowledged: boolean;
    
    // Escalation Mode: How should origin agent resume?
    // - NOTIFY_OWNER: Just inform user of decision
    // - REASON_WITH_OWNER: Explain decision with context
    // - FINAL_DECISION: Authoritative (no discussion, user complies)
    mode?: 'NOTIFY_OWNER' | 'REASON_WITH_OWNER' | 'FINAL_DECISION';
    
    backend_actions?: Array<{
        action: string;
        payload?: Record<string, any>;
    }>;
    
    notify_origin_agent?: boolean;  // Signal to resume origin agent (PA/TA/GA)
    escalation_payload?: {
        escalation_id: string;
        admin_decision?: string;  // APPROVE | REJECT | MODIFY | REQUEST_INFO
        admin_instruction?: string;  // Clear instruction for origin agent
        context?: Record<string, any>;
    };
    action_payload?: {
        // For Student Registration
        student_name?: string;
        parent_name?: string;
        parent_phone?: string;
        class_level?: string;
        registration_data_confirmed?: boolean;
        announcement_content?: string;
        
        // For MANAGE_PARENTS (ADD/UPDATE/REMOVE parent)
        operation?: 'ADD' | 'UPDATE' | 'REMOVE';
        
        // For UNIFY_PARENT (link parent to existing student)
        children?: Array<{
            student_name: string;
            class_level: string;
        }>;
        
        // For LOCK/UNLOCK/SIGN/RELEASE
        name?: string;
        term_id?: string;
        student_id?: string;

        // For PAYMENT
        transaction_id?: string;
        decision?: 'approve' | 'reject';
        reason?: string;

        // For AMENDMENTS
        amendment_type?: 'GRADING' | 'TERMS' | 'FEES' | 'SUBJECTS' | 'TEACHERS';
        impact_scope?: 'FUTURE_ONLY' | 'CURRENT_TERM' | 'HISTORICAL';
        amendment_id?: string;
        proposal_summary?: string;
        raw_change_intent?: string; // The user's raw text describing the change for logging

        // For PROCESS_ESCALATION
        escalation_id?: string;
        admin_intent?: string;
        admin_decision?: 'APPROVED' | 'DENIED' | 'PENDING' | 'CONDITIONAL';
        
        // For GET_TEACHER_TOKEN (bulk fetch)
        class_levels?: string[];  // Array of class levels to fetch tokens for
        teacher_names?: string[];  // Array of teacher names to fetch tokens for

        // For APPROVE_MARK_SUBMISSION & REQUEST_MARK_CORRECTION
        workflow_id?: string;      // Mark submission workflow ID
        pdf_id?: string;           // PDF document ID
        admin_notes?: string;      // Admin's approval/rejection notes
        teacher_id?: string;       // Teacher who submitted marks
        subject?: string;          // Subject name
        correction_instructions?: string;  // Specific instructions for teacher
        flagged_rows?: number[];           // Row numbers with issues
        correction_reason?: string;        // Why correction is needed
        
        // For attendance escalation
        absentees?: Array<any>;  // Flexible structure - can be strings or objects with various property names  // Can also be just student names as strings
        
        // For DENY_MARK_AMENDMENT
        denial_reason?: string;  // Reason for denying the amendment request
    };
    confidence_score: number;
    session_active: boolean;
}