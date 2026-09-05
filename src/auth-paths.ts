/** Node-free route constants shared by the Host and browser plugin halves. */

/** Fast local-only login state endpoint; never refreshes OAuth or queries quota. */
export const OPENAI_CODEX_AUTH_LOCAL_STATUS_PATH = '/plugins/dsh-openai-codex/auth/local-status'
/** Plugin-owned status endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_STATUS_PATH = '/plugins/dsh-openai-codex/auth/status'
/** Plugin-owned browser-login endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGIN_PATH = '/plugins/dsh-openai-codex/auth/login'
/** Plugin-owned device-code login endpoint for remote and headless hosts. */
export const OPENAI_CODEX_AUTH_DEVICE_LOGIN_PATH = '/plugins/dsh-openai-codex/auth/device-login'
/** Plugin-owned logout endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGOUT_PATH = '/plugins/dsh-openai-codex/auth/logout'
