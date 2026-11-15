export type Role = 'borrower' | 'staff' | 'auditor';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  fullName: string;
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
