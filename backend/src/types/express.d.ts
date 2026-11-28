export type Role = 'borrower' | 'staff' | 'admin';
export type StaffTier = 'regular' | 'supervisor' | 'finance_manager';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  fullName: string;
  staffTier?: StaffTier | null;
}

declare global {
  namespace Express {
    interface Request {
      /** Authenticated principal, set by requireAuth. */
      user?: AuthUser;
      /** Correlation id echoed in responses and stored in the audit log. */
      requestId: string;
    }
  }
}

export {};
