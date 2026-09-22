/** AUTH-BE-03 — verified identity from an external IdP (Clerk today; Skout JWT later). */
export type VerifiedIdentity = {
  provider: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
};

export type AuthVerifyContext = {
  clerkSecretKey: string;
  authorizedParties: string[];
};

export interface AuthProvider {
  readonly id: string;
  verify(token: string, ctx: AuthVerifyContext): Promise<VerifiedIdentity>;
}
