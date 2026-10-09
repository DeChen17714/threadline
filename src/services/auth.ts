export interface AuthUser {
  readonly uid: string
  readonly email: string | null
  readonly label: string
}

export type AuthState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly user: AuthUser }
  | { readonly status: 'link-required'; readonly email: string; readonly user: AuthUser | null }
  | { readonly status: 'error'; readonly message: string }

export interface AuthPort {
  getSnapshot(): AuthState
  subscribe(notify: () => void): () => void
  signUpEmail(email: string, password: string): Promise<void>
  signInEmail(email: string, password: string): Promise<void>
  signOut(): Promise<void>
  signInGoogle(): Promise<void>
  authenticateGoogleLink(password: string): Promise<void>
  confirmGoogleLink(): Promise<void>
  cancelGoogleLink(): Promise<void>
  sendPasswordReset(email: string): Promise<void>
  verifyPasswordResetCode(code: string): Promise<string>
  confirmPasswordReset(code: string, newPassword: string): Promise<void>
  retry(): void
}
