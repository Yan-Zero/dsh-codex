/** Node-free route constants shared by the Host and browser plugin halves. */

/** Composer quota display preference endpoint. */
export const OPENAI_CODEX_COMPOSER_QUOTA_PATH = '/plugins/dsh-openai-codex/composer-quota'

/** Plugin-owned status endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_STATUS_PATH = '/plugins/dsh-openai-codex/auth/status'
/** Plugin-owned browser and device-code login endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGIN_PATH = '/plugins/dsh-openai-codex/auth/login'
/** Stop a pending OAuth attempt without deleting a stored credential. */
export const OPENAI_CODEX_AUTH_CANCEL_PATH = '/plugins/dsh-openai-codex/auth/cancel'
/** Plugin-owned logout endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGOUT_PATH = '/plugins/dsh-openai-codex/auth/logout'
