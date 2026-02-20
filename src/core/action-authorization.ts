/**
 * 🔐 ACTION AUTHORIZATION SYSTEM
 * 
 * Role-based access control for all backend actions
 * Every action handler MUST validate user role before execution
 * 
 * Roles:
 * - 'admin': School admin (SA agent)
 * - 'teacher': Secondary school teacher (TA agent)
 * - 'primary_teacher': Primary school teacher (PRIMARY_TA agent)
 * - 'parent': Parent of registered student (PA agent)
 * - 'student': Student (PA agent, can view own results)
 * - 'group_admin': Group moderator (GA agent)
 */

export type UserRole = 'admin' | 'teacher' | 'primary_teacher' | 'parent' | 'student' | 'group_admin';

export interface ActionSpec {
    action: string;
    agent: string;
    required_role: UserRole | UserRole[];
    description: string;
    conversational: boolean;
    requires_intent_clear?: boolean;  // For escalations
    requires_authority?: boolean;      // For escalations
}

/**
 * COMPREHENSIVE ACTION REGISTRY
 * All 79 actions mapped to required roles
 * This is the source of truth for what each action requires
 */
export const ACTION_REGISTRY: Record<string, ActionSpec> = {
    // ============================================================
    // PA (Parent Agent) Actions
    // ============================================================
    'NONE': {
        action: 'NONE',
        agent: 'PA',
        required_role: ['parent', 'student'],
        description: 'No action required',
        conversational: false
    },
    'ESCALATE_PAYMENT': {
        action: 'ESCALATE_PAYMENT',
        agent: 'PA',
        required_role: 'parent',
        description: 'Escalate payment to admin for verification',
        conversational: true
    },
    'FETCH_LOCKED_RESULT': {
        action: 'FETCH_LOCKED_RESULT',
        agent: 'PA',
        required_role: ['parent', 'student'],
        description: 'Retrieve locked academic results',
        conversational: true
    },
    'VERIFY_TEACHER_TOKEN': {
        action: 'VERIFY_TEACHER_TOKEN',
        agent: 'PA',
        required_role: ['parent', 'student'],
        description: 'Verify teacher access token',
        conversational: false
    },
    'VERIFY_PARENT_TOKEN': {
        action: 'VERIFY_PARENT_TOKEN',
        agent: 'PA',
        required_role: ['parent', 'student'],
        description: 'Verify parent access token',
        conversational: false
    },
    'SELECT_CHILD': {
        action: 'SELECT_CHILD',
        agent: 'PA',
        required_role: 'parent',
        description: 'Select which child to view results for',
        conversational: false
    },
    'LIST_CHILDREN': {
        action: 'LIST_CHILDREN',
        agent: 'PA',
        required_role: 'parent',
        description: 'List all registered children',
        conversational: true
    },
    'DELIVER_STUDENT_PDF': {
        action: 'DELIVER_STUDENT_PDF',
        agent: 'PA',
        required_role: ['parent', 'student'],
        description: 'Generate and deliver student report as PDF',
        conversational: true
    },

    // ============================================================
    // TA (Teacher Agent) Actions
    // ============================================================
    'CONFIRM_MARK_SUBMISSION': {
        action: 'CONFIRM_MARK_SUBMISSION',
        agent: 'TA',
        required_role: 'teacher',
        description: 'Confirm mark submission for class',
        conversational: true
    },
    'CONFIRM_ATTENDANCE_SUBMISSION': {
        action: 'CONFIRM_ATTENDANCE_SUBMISSION',
        agent: 'TA',
        required_role: 'teacher',
        description: 'Confirm attendance submission',
        conversational: true
    },
    'REQUEST_MARK_CORRECTION': {
        action: 'REQUEST_MARK_CORRECTION',
        agent: 'TA',
        required_role: 'teacher',
        description: 'Request mark correction from admin',
        conversational: true
    },
    'UPDATE_STUDENT_SCORE': {
        action: 'UPDATE_STUDENT_SCORE',
        agent: 'TA',
        required_role: 'teacher',
        description: 'Update individual student score',
        conversational: true
    },
    'RECALCULATE_CLASS_RESULTS': {
        action: 'RECALCULATE_CLASS_RESULTS',
        agent: 'TA',
        required_role: 'teacher',
        description: 'Recalculate class aggregate results',
        conversational: true
    },
    'GENERATE_DRAFT_BROADSHEET': {
        action: 'GENERATE_DRAFT_BROADSHEET',
        agent: 'TA',
        required_role: 'teacher',
        description: 'Generate draft mark sheet for review',
        conversational: true
    },
    'ANALYZE_CLASS_PERFORMANCE': {
        action: 'ANALYZE_CLASS_PERFORMANCE',
        agent: 'TA',
        required_role: 'teacher',
        description: 'Analyze class performance metrics',
        conversational: true
    },
    'ESCALATE_TO_ADMIN': {
        action: 'ESCALATE_TO_ADMIN',
        agent: 'TA',
        required_role: 'teacher',
        description: 'Request admin authority',
        conversational: true
    },

    // ============================================================
    // SA (School Admin) Actions
    // ============================================================
    'ACTIVATE_SCHOOL': {
        action: 'ACTIVATE_SCHOOL',
        agent: 'SA',
        required_role: 'admin',
        description: 'Activate school after setup completion',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'LOCK_RESULTS': {
        action: 'LOCK_RESULTS',
        agent: 'SA',
        required_role: 'admin',
        description: 'Lock academic results from parent view',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'UNLOCK_RESULTS': {
        action: 'UNLOCK_RESULTS',
        agent: 'SA',
        required_role: 'admin',
        description: 'Unlock previously locked results',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'RELEASE_RESULTS': {
        action: 'RELEASE_RESULTS',
        agent: 'SA',
        required_role: 'admin',
        description: 'Release results to parents',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'REVOKE_RELEASE': {
        action: 'REVOKE_RELEASE',
        agent: 'SA',
        required_role: 'admin',
        description: 'Revoke released results',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'VIEW_AUDIT_LOG': {
        action: 'VIEW_AUDIT_LOG',
        agent: 'SA',
        required_role: 'admin',
        description: 'View audit trail of actions',
        conversational: true
    },
    'OVERRIDE_LOCK': {
        action: 'OVERRIDE_LOCK',
        agent: 'SA',
        required_role: 'admin',
        description: 'Override result lock for emergency access',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'FINALIZE_AND_SIGN_RESULTS': {
        action: 'FINALIZE_AND_SIGN_RESULTS',
        agent: 'SA',
        required_role: 'admin',
        description: 'Finalize and digitally sign results',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'CONFIRM_PAYMENT': {
        action: 'CONFIRM_PAYMENT',
        agent: 'SA',
        required_role: 'admin',
        description: 'Confirm payment receipt',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'REJECT_PAYMENT': {
        action: 'REJECT_PAYMENT',
        agent: 'SA',
        required_role: 'admin',
        description: 'Reject/request resubmission of payment',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'GET_TEACHER_TOKEN': {
        action: 'GET_TEACHER_TOKEN',
        agent: 'SA',
        required_role: 'admin',
        description: 'Generate access token for teacher',
        conversational: true
    },
    'REVOKE_TEACHER_TOKEN': {
        action: 'REVOKE_TEACHER_TOKEN',
        agent: 'SA',
        required_role: 'admin',
        description: 'Revoke teacher access token',
        conversational: true
    },
    'REGISTER_STUDENT': {
        action: 'REGISTER_STUDENT',
        agent: 'SA',
        required_role: 'admin',
        description: 'Register new student in system',
        conversational: true
    },
    'MANAGE_STAFF': {
        action: 'MANAGE_STAFF',
        agent: 'SA',
        required_role: 'admin',
        description: 'Add or remove teachers and staff',
        conversational: true
    },
    'PROPOSE_AMENDMENT': {
        action: 'PROPOSE_AMENDMENT',
        agent: 'SA',
        required_role: 'admin',
        description: 'Propose amendment to student records',
        conversational: true
    },
    'CONFIRM_AMENDMENT': {
        action: 'CONFIRM_AMENDMENT',
        agent: 'SA',
        required_role: 'admin',
        description: 'Confirm and apply amendment',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'CLOSE_ALL_ESCALATIONS': {
        action: 'CLOSE_ALL_ESCALATIONS',
        agent: 'SA',
        required_role: 'admin',
        description: 'Close all pending escalations',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'APPROVE_MARK_SUBMISSION': {
        action: 'APPROVE_MARK_SUBMISSION',
        agent: 'SA',
        required_role: 'admin',
        description: 'Approve teacher mark submission',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'CLOSE_ESCALATION': {
        action: 'CLOSE_ESCALATION',
        agent: 'SA',
        required_role: 'admin',
        description: 'Close a specific pending escalation',
        conversational: true,
        requires_intent_clear: true,
        requires_authority: true
    },
    'FINALIZE_SETUP': {
        action: 'FINALIZE_SETUP',
        agent: 'SA',
        required_role: 'admin',
        description: 'Finalize school setup and confirm completion',
        conversational: true
    },

    // ============================================================
    // GA (Group Agent) Actions  
    // ============================================================
    'SEND_MESSAGE': {
        action: 'SEND_MESSAGE',
        agent: 'GA',
        required_role: ['group_admin', 'parent', 'teacher'],
        description: 'Send message to group',
        conversational: true
    },
    'DELETE_MESSAGE': {
        action: 'DELETE_MESSAGE',
        agent: 'GA',
        required_role: 'group_admin',
        description: 'Delete inappropriate message',
        conversational: false
    },
    'GREET_NEW_MEMBER': {
        action: 'GREET_NEW_MEMBER',
        agent: 'GA',
        required_role: ['group_admin', 'parent', 'teacher'],
        description: 'Greet new group member',
        conversational: true
    },
    'LOG_MODERATION': {
        action: 'LOG_MODERATION',
        agent: 'GA',
        required_role: 'group_admin',
        description: 'Log moderation action',
        conversational: false
    }
};

/**
 * Authorizer class for validating action permissions
 */
export class ActionAuthorizer {
    /**
     * Get action specification
     */
    static getActionSpec(action: string): ActionSpec | null {
        return ACTION_REGISTRY[action] || null;
    }

    /**
     * Get required role for action
     */
    static getRequiredRole(action: string): UserRole | UserRole[] | null {
        const spec = this.getActionSpec(action);
        return spec ? spec.required_role : null;
    }

    /**
     * Check if a role can perform an action
     */
    static canRolePerform(action: string, userRole: UserRole | null): boolean {
        if (!userRole || userRole === null) return false;

        const spec = this.getActionSpec(action);
        if (!spec) return false;

        if (Array.isArray(spec.required_role)) {
            return spec.required_role.includes(userRole);
        }
        return spec.required_role === userRole;
    }

    /**
     * Authorize an action for a user
     * 
     * @param action - Action to authorize
     * @param userRole - User's role
     * @param intent_clear - For escalations: is intent clear?
     * @param authority_acknowledged - For escalations: is authority acknowledged?
     * @returns { authorized: boolean, reason?: string }
     */
    static authorize(
        action: string,
        userRole: UserRole | null,
        intent_clear?: boolean,
        authority_acknowledged?: boolean
    ): { authorized: boolean; reason?: string } {
        // 1. Check if action exists
        const spec = this.getActionSpec(action);
        if (!spec) {
            return {
                authorized: false,
                reason: `Unknown action: ${action}`
            };
        }

        // 2. Check if user role is set
        if (!userRole) {
            return {
                authorized: false,
                reason: 'User role not identified'
            };
        }

        // 3. Check if role can perform action
        if (!this.canRolePerform(action, userRole)) {
            const required = Array.isArray(spec.required_role)
                ? spec.required_role.join(' or ')
                : spec.required_role;
            return {
                authorized: false,
                reason: `Role '${userRole}' cannot perform '${action}' (requires '${required}')`
            };
        }

        // 4. Check escalation requirements
        if (spec.requires_intent_clear && !intent_clear) {
            return {
                authorized: false,
                reason: `Action '${action}' requires clear intent from escalation`
            };
        }

        if (spec.requires_authority && !authority_acknowledged) {
            return {
                authorized: false,
                reason: `Action '${action}' requires authority acknowledgement`
            };
        }

        // All checks passed
        return { authorized: true };
    }
}

export default ActionAuthorizer;
