export type PAActionType = 
    | 'NONE'
    | 'ESCALATE_PAYMENT' 
    | 'FETCH_LOCKED_RESULT' 
    | 'VERIFY_TEACHER_TOKEN'
    | 'VERIFY_PARENT_TOKEN'
    | 'SELECT_CHILD'
    | 'LIST_CHILDREN'
    | 'DELIVER_STUDENT_PDF'
    | 'REPORT_WORK_TO_ADMIN'
    | 'UPDATE_USER_NAME'
    | 'REQUEST_VOICE_CALL'
    | 'UNIFY_PARENT';

export interface PAOutput {
    agent: 'PA';
    reply_text: string;
    action_required: PAActionType;
    delivery_type?: 'text' | 'document' | 'voice';
    
    // Escalation Signal: When PA needs admin authority
    // Set required=true to pause conversation and request admin decision
    admin_escalation?: {
        required: boolean;  // Set true to trigger escalation
        type?: string;      // Category of escalation
        urgency?: 'low' | 'medium' | 'high';
        reason?: string;  // Why escalation is needed
        message_to_admin?: string;  // What PA is asking admin to decide
        requested_decision?: string;  // Type of decision (e.g., "approve|reject")
        allowed_actions?: string[];  // What actions admin can take
        context?: Record<string, any>;  // Relevant context data
    };
    action_payload?: {
        token?: string;
        parent_id?: string;
        // For ESCALATE_PAYMENT
        amount?: number;
        date?: string;
        sender?: string;
        imagePath?: string;
        transaction_id?: string;
        image_confidence?: number;
        
        // For Results
        student_id?: string;
        term_id?: string;
        pdf_path?: string;

        // For LIST_CHILDREN
        children?: Array<{ student_id: string; name: string; class_level: string }>;

        // For ESCALATE_TO_ADMIN
        escalation_payload?: {
            escalation_type?: string;
            priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
            reason?: string;
            original_message?: string;
            context?: any;
        };

        // Generic
        reason?: string;
        name?: string;

        // For UNIFY_PARENT (link parent to student - from PA conversation)
        unify_children?: Array<{
            student_name: string;
            class_level: string;
        }>;
    };
    confidence_score: number;
    session_active: boolean;
}