/** Plugin-owned OpenAI Codex account page inside the dsh Settings shell. */

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { OpenAICodexUsage } from "../usage.ts";
import type {
  ContextWindowPreferences,
  ImageToolPreferences,
  ModelCatalogEntry,
  ModelCatalogSettings,
  ResponseApiPreferences,
} from "../tool-policy.ts";
import type { OpenAICodexSettingsKey } from "./locales.ts";

const STATUS_PATH = "/plugins/dsh-openai-codex/auth/status";
const LOGIN_PATH = "/plugins/dsh-openai-codex/auth/login";
const LOGOUT_PATH = "/plugins/dsh-openai-codex/auth/logout";
const IMAGE_TOOLS_PATH = "/plugins/dsh-openai-codex/image-tools";
const RESPONSE_API_PATH = "/plugins/dsh-openai-codex/response-api";
const MODEL_CATALOG_PATH = "/plugins/dsh-openai-codex/models";
const CONTEXT_WINDOW_PATH = "/plugins/dsh-openai-codex/context-window";
const POLL_INTERVAL_MS = 1_000;
const USAGE_POLL_INTERVAL_MS = 60_000;

type AccountStatus =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signing-in" }
  | { status: "reauth-required"; message: string }
  | { status: "signed-in"; usage: OpenAICodexUsage; quotaError?: string }
  | { status: "remote-web-origin-not-trusted" }
  | { status: "error"; message: string };

interface LoginChallenge {
  url: string;
}

/** Dependencies injected by the browser plugin entry. */
export interface OpenAICodexSettingsInjected {
  /** Localized page copy. */
  t: (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => string;
}

/** Props delivered by the settings slot renderer. */
export type OpenAICodexSettingsProps = Partial<OpenAICodexSettingsInjected>;

const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 18,
  maxWidth: 720,
};
const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 20,
  lineHeight: "28px",
  fontWeight: 600,
  color: "var(--dsw-alias-label-primary)",
};
const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: "22px",
  color: "var(--dsw-alias-label-secondary)",
};
const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: "18px 20px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 12,
  background: "var(--dsw-alias-bg-module-platform)",
};
const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 12,
};
const statusStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  fontSize: 15,
  fontWeight: 500,
  color: "var(--dsw-alias-label-primary)",
};
const buttonStyle: CSSProperties = {
  boxSizing: "border-box",
  minHeight: 34,
  padding: "6px 14px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 18,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
  fontSize: 14,
  cursor: "pointer",
};
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--dsw-alias-button-primary-fill)",
  background: "var(--dsw-alias-button-primary-fill)",
  color: "var(--dsw-alias-label-primary-foreground)",
};
const errorStyle: CSSProperties = {
  ...bodyStyle,
  color: "var(--dsw-alias-state-error-primary)",
};
const quotaListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 18,
  paddingTop: 2,
};
const quotaGroupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const quotaTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: "20px",
  fontWeight: 600,
  color: "var(--dsw-alias-label-primary)",
};
const quotaLabelStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  fontSize: 13,
  lineHeight: "20px",
  color: "var(--dsw-alias-label-secondary)",
};
const progressTrackStyle: CSSProperties = {
  height: 8,
  overflow: "hidden",
  borderRadius: 999,
  background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))",
};
const toggleRowStyle: CSSProperties = {
  ...rowStyle,
  flexWrap: "nowrap",
  alignItems: "flex-start",
};
const toggleCopyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
};
const toggleTrackStyle: CSSProperties = {
  position: "relative",
  width: 40,
  height: 22,
  flex: "0 0 auto",
  marginTop: 1,
  padding: 0,
  border: 0,
  borderRadius: 999,
  cursor: "pointer",
  transition: "background 120ms ease",
};
const modelListStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 10,
};
const modelCardStyle: CSSProperties = {
  display: "flex",
  minWidth: 0,
  flexDirection: "column",
  gap: 12,
  padding: 12,
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 10,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
};
const modelCardHeaderStyle: CSSProperties = {
  display: "flex",
  minWidth: 0,
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
};
const modelMetadataStyle: CSSProperties = {
  display: "flex",
  minWidth: 0,
  flexDirection: "column",
  gap: 5,
};
const modelFieldStyle: CSSProperties = {
  display: "flex",
  minWidth: 0,
  alignItems: "baseline",
  gap: 5,
};
const modelFieldLabelStyle: CSSProperties = {
  color: "var(--dsw-alias-label-secondary)",
  fontSize: 11,
  lineHeight: "16px",
};
const modelNameStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: "20px",
  fontWeight: 600,
};
const modelIdStyle: CSSProperties = {
  overflowWrap: "anywhere",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  lineHeight: "18px",
  color: "var(--dsw-alias-label-secondary)",
};
const modelWindowStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: "18px",
  whiteSpace: "nowrap",
};
const modelEnableStyle: CSSProperties = {
  display: "flex",
  flex: "0 0 auto",
  alignItems: "center",
  gap: 7,
  cursor: "pointer",
};
const numberInputStyle: CSSProperties = {
  boxSizing: "border-box",
  width: 180,
  minHeight: 36,
  padding: "7px 10px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
  fontSize: 14,
};
const commandStyle: CSSProperties = {
  margin: 0,
  padding: "10px 12px",
  overflowX: "auto",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))",
  color: "var(--dsw-alias-label-primary)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
  lineHeight: "20px",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

function PreferenceToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange(value: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      style={{
        ...toggleTrackStyle,
        opacity: disabled ? 0.55 : 1,
        background: checked
          ? "var(--dsw-alias-button-primary-fill)"
          : "var(--dsw-alias-bg-layer-2, #c8ccd2)",
      }}
      onClick={() => {
        onChange(!checked);
      }}>
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--dsw-alias-label-primary-foreground)",
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.25)",
          transition: "left 120ms ease",
        }}
      />
    </button>
  );
}

function progressFillStyle(percent: number): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(100, percent))}%`,
    height: "100%",
    borderRadius: "inherit",
    background: "var(--dsw-alias-brand-primary, #1677ff)",
  };
}

function windowLabel(
  seconds: number,
  t: OpenAICodexSettingsInjected["t"]
): string {
  if (seconds === 5 * 60 * 60) return t("fiveHourLimit");
  if (seconds === 7 * 24 * 60 * 60) return t("weeklyLimit");
  const hours = seconds / (60 * 60);
  return Number.isInteger(hours)
    ? t("hourLimit", { count: hours })
    : t("usageWindow");
}

function formatPercent(percent: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    percent
  );
}

function contextWindowDraft(contextWindow: number | null): string {
  return contextWindow === null ? "" : String(contextWindow / 1_000);
}

function contextWindowTokens(draft: string): number | null | undefined {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return null;
  const match = /^(\d+)(?:\.(\d{1,3}))?$/u.exec(trimmed);
  if (match === null) return undefined;
  const tokens =
    Number(match[1]) * 1_000 + Number((match[2] ?? "").padEnd(3, "0"));
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function formatContextWindow(tokens: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(tokens / 1_000)}K`;
}

interface ModelCheckboxProps {
  model: ModelCatalogEntry;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  t: NonNullable<OpenAICodexSettingsProps["t"]>;
}

/** Self-contained model selector card with four explicit fields. */
function ModelCheckbox({
  model,
  checked,
  disabled,
  onChange,
  t,
}: ModelCheckboxProps) {
  const contextWindow = formatContextWindow(model.contextWindow);
  return (
    <div
      style={{ ...modelCardStyle, opacity: disabled ? 0.55 : 1 }}
      role="group"
      aria-label={model.name}>
      <div style={modelCardHeaderStyle}>
        <span style={modelFieldStyle}>
          <span style={modelFieldLabelStyle}>{t("modelFieldName")}</span>
          <span style={modelNameStyle}>{model.name}</span>
        </span>
        <span style={modelEnableStyle}>
          <span style={modelFieldLabelStyle}>{t("modelFieldEnabled")}</span>
          <PreferenceToggle
            checked={checked}
            disabled={disabled}
            label={t("modelEnableLabel", { name: model.name })}
            onChange={onChange}
          />
        </span>
      </div>
      <div style={modelMetadataStyle}>
        <span style={modelFieldStyle}>
          <span style={modelFieldLabelStyle}>{t("modelFieldId")}</span>
          <span style={modelIdStyle}>{model.id}</span>
        </span>
        <span style={modelFieldStyle}>
          <span style={modelFieldLabelStyle}>
            {t("modelFieldDefaultWindow")}
          </span>
          <span style={modelWindowStyle}>
            {t("modelContextWindowValue", { value: contextWindow })}
          </span>
        </span>
      </div>
    </div>
  );
}

/** Format a provider-declared Unix-second reset in the user's local timezone. */
export function formatOpenAICodexResetAt(
  resetAt: number | undefined
): string | undefined {
  if (resetAt === undefined || !Number.isSafeInteger(resetAt) || resetAt <= 0)
    return undefined;
  const date = new Date(resetAt * 1_000);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function QuotaBar({
  label,
  percent,
  detail,
  t,
}: {
  label: string;
  percent: number;
  detail?: string;
  t: OpenAICodexSettingsInjected["t"];
}) {
  const display = formatPercent(percent);
  return (
    <div style={quotaGroupStyle}>
      <div style={quotaLabelStyle}>
        <span>{label}</span>
        <span>{t("percentRemaining", { percent: display })}</span>
      </div>
      <div
        style={progressTrackStyle}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={t("percentRemaining", { percent: display })}>
        <div style={progressFillStyle(percent)} />
      </div>
      {detail === undefined ? null : <p style={bodyStyle}>{detail}</p>}
    </div>
  );
}

function UsageLimits({
  usage,
  quotaError,
  t,
}: {
  usage: OpenAICodexUsage;
  quotaError?: string;
  t: OpenAICodexSettingsInjected["t"];
}) {
  const hasData =
    usage.rateLimits.length > 0 ||
    usage.credits !== undefined ||
    usage.individualLimit !== undefined;
  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t("usageLimits")}</h3>
      {usage.rateLimits.map((limit) => (
        <div key={limit.id} style={quotaGroupStyle}>
          <h4 style={quotaTitleStyle}>{limit.name ?? limit.id}</h4>
          {limit.windows.map((window) => (
            <QuotaBar
              key={window.windowSeconds}
              label={windowLabel(window.windowSeconds, t)}
              percent={window.remainingPercent}
              detail={t("resetAt", {
                time:
                  formatOpenAICodexResetAt(window.resetAt) ??
                  t("resetUnavailable"),
              })}
              t={t}
            />
          ))}
        </div>
      ))}
      {usage.individualLimit === undefined ? null : (
        <QuotaBar
          label={t("monthlyLimit")}
          percent={usage.individualLimit.remainingPercent}
          detail={t("exactRemaining", {
            remaining: usage.individualLimit.remaining,
            limit: usage.individualLimit.limit,
          })}
          t={t}
        />
      )}
      {usage.credits === undefined ? null : (
        <div style={quotaLabelStyle}>
          <span>{t("credits")}</span>
          <span>
            {usage.credits.unlimited
              ? t("unlimited")
              : usage.credits.balance === undefined
                ? t("available")
                : usage.credits.balance}
          </span>
        </div>
      )}
      {!hasData && quotaError === undefined ? (
        <p style={bodyStyle}>{t("quotaUnavailable")}</p>
      ) : null}
      {quotaError === undefined ? null : (
        <p style={errorStyle}>{t("quotaUnavailable")}</p>
      )}
    </div>
  );
}

function dotStyle(status: AccountStatus["status"]): CSSProperties {
  const color =
    status === "signed-in"
      ? "var(--dsw-alias-state-success-primary, #22a06b)"
      : status === "error" ||
          status === "reauth-required" ||
          status === "remote-web-origin-not-trusted"
        ? "var(--dsw-alias-state-error-primary, #d92d20)"
        : status === "signing-in" || status === "loading"
          ? "var(--dsw-alias-brand-primary, #1677ff)"
          : "var(--dsw-alias-label-dimmed, #9aa0a6)";
  return {
    width: 9,
    height: 9,
    borderRadius: "50%",
    flex: "0 0 auto",
    background: color,
  };
}

class AccountRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AccountRequestError";
  }
}

async function jsonRequest<T>(
  path: string,
  method = "GET",
  body?: unknown
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    credentials: "same-origin",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "string"
        ? value.error
        : `HTTP ${response.status}`;
    throw new AccountRequestError(message);
  }
  return value as T;
}

/** OpenAI Codex account status and OAuth actions. */
export function OpenAICodexSettings({ t }: OpenAICodexSettingsProps) {
  if (t === undefined)
    throw new Error("OpenAI Codex settings requires its translation function");
  const [status, setStatus] = useState<AccountStatus>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [imageTools, setImageTools] = useState<
    ImageToolPreferences | undefined
  >();
  const [imageToolsBusy, setImageToolsBusy] = useState(false);
  const [imageToolsError, setImageToolsError] = useState<string | undefined>();
  const [responseApi, setResponseApi] = useState<
    ResponseApiPreferences | undefined
  >();
  const [responseApiBusy, setResponseApiBusy] = useState(false);
  const [responseApiError, setResponseApiError] = useState<
    string | undefined
  >();
  const [modelCatalog, setModelCatalog] = useState<
    ModelCatalogSettings | undefined
  >();
  const [modelCatalogBusy, setModelCatalogBusy] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<
    string | undefined
  >();
  const [contextWindow, setContextWindow] = useState<
    ContextWindowPreferences | undefined
  >();
  const [contextWindowDraftValue, setContextWindowDraftValue] = useState("");
  const [contextWindowBusy, setContextWindowBusy] = useState(false);
  const [contextWindowError, setContextWindowError] = useState<
    string | undefined
  >();
  const trustedOriginCommand = `dsh plugin --profile web exec dsh-openai-codex trust-origin ${window.location.origin}`;

  const refresh = useCallback(async () => {
    try {
      setStatus(await jsonRequest<AccountStatus>(STATUS_PATH));
    } catch (error: unknown) {
      setStatus(
        error instanceof AccountRequestError &&
          error.code === "remote-web-origin-not-trusted"
          ? { status: "remote-web-origin-not-trusted" }
          : {
              status: "error",
              message:
                error instanceof Error ? error.message : t("requestFailed"),
            }
      );
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void jsonRequest<ImageToolPreferences>(IMAGE_TOOLS_PATH).then(
      (value) => {
        setImageTools(value);
        setImageToolsError(undefined);
      },
      () => {
        setImageToolsError(t("imageToolSettingsFailed"));
      }
    );
  }, [t]);
  useEffect(() => {
    void jsonRequest<ResponseApiPreferences>(RESPONSE_API_PATH).then(
      (value) => {
        setResponseApi(value);
        setResponseApiError(undefined);
      },
      () => {
        setResponseApiError(t("responseApiSettingsFailed"));
      }
    );
  }, [t]);
  useEffect(() => {
    void jsonRequest<ModelCatalogSettings>(MODEL_CATALOG_PATH).then(
      (value) => {
        setModelCatalog(value);
        setModelCatalogError(undefined);
      },
      () => {
        setModelCatalogError(t("modelCatalogSettingsFailed"));
      }
    );
  }, [t]);
  useEffect(() => {
    void jsonRequest<ContextWindowPreferences>(CONTEXT_WINDOW_PATH).then(
      (value) => {
        setContextWindow(value);
        setContextWindowDraftValue(contextWindowDraft(value.contextWindow));
        setContextWindowError(undefined);
      },
      () => {
        setContextWindowError(t("contextWindowSettingsFailed"));
      }
    );
  }, [t]);
  useEffect(() => {
    const interval =
      status.status === "signing-in"
        ? POLL_INTERVAL_MS
        : status.status === "signed-in"
          ? USAGE_POLL_INTERVAL_MS
          : undefined;
    if (interval === undefined) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, interval);
    return () => {
      window.clearInterval(timer);
    };
  }, [refresh, status.status]);

  const signIn = async (): Promise<void> => {
    const popup = window.open("about:blank", "_blank");
    if (popup !== null) popup.opener = null;
    setBusy(true);
    setStatus({ status: "signing-in" });
    try {
      const challenge = await jsonRequest<LoginChallenge>(LOGIN_PATH, "POST");
      if (popup === null) {
        setStatus({ status: "error", message: t("popupBlocked") });
        return;
      }
      popup.location.replace(challenge.url);
    } catch (error: unknown) {
      popup?.close();
      setStatus(
        error instanceof AccountRequestError &&
          error.code === "remote-web-origin-not-trusted"
          ? { status: "remote-web-origin-not-trusted" }
          : {
              status: "error",
              message:
                error instanceof Error ? error.message : t("requestFailed"),
            }
      );
    } finally {
      setBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    setBusy(true);
    try {
      await jsonRequest<{ ok: true }>(LOGOUT_PATH, "POST");
      setStatus({ status: "signed-out" });
    } catch (error: unknown) {
      setStatus({
        status: "error",
        message: error instanceof Error ? error.message : t("requestFailed"),
      });
    } finally {
      setBusy(false);
    }
  };

  const updateImageTool = async (
    patch: Partial<ImageToolPreferences>
  ): Promise<void> => {
    setImageToolsBusy(true);
    setImageToolsError(undefined);
    try {
      setImageTools(
        await jsonRequest<ImageToolPreferences>(IMAGE_TOOLS_PATH, "POST", patch)
      );
    } catch {
      setImageToolsError(t("imageToolSettingsFailed"));
    } finally {
      setImageToolsBusy(false);
    }
  };

  const updateResponseApi = async (
    patch: Partial<ResponseApiPreferences>
  ): Promise<void> => {
    setResponseApiBusy(true);
    setResponseApiError(undefined);
    try {
      setResponseApi(
        await jsonRequest<ResponseApiPreferences>(
          RESPONSE_API_PATH,
          "POST",
          patch
        )
      );
    } catch {
      setResponseApiError(t("responseApiSettingsFailed"));
    } finally {
      setResponseApiBusy(false);
    }
  };

  const updateVisibleModel = async (
    modelId: string,
    checked: boolean
  ): Promise<void> => {
    if (modelCatalog === undefined) return;
    const selected = new Set(modelCatalog.models);
    if (checked) selected.add(modelId);
    else selected.delete(modelId);
    const models = modelCatalog.availableModels
      .filter((model) => selected.has(model.id))
      .map((model) => model.id);
    setModelCatalogBusy(true);
    setModelCatalogError(undefined);
    try {
      setModelCatalog(
        await jsonRequest<ModelCatalogSettings>(MODEL_CATALOG_PATH, "POST", {
          models,
        })
      );
    } catch {
      setModelCatalogError(t("modelCatalogSettingsFailed"));
    } finally {
      setModelCatalogBusy(false);
    }
  };

  const updateContextWindow = async (): Promise<void> => {
    const parsed = contextWindowTokens(contextWindowDraftValue);
    if (parsed === undefined) {
      setContextWindowError(t("contextWindowInvalid"));
      return;
    }
    setContextWindowBusy(true);
    setContextWindowError(undefined);
    try {
      const saved = await jsonRequest<ContextWindowPreferences>(
        CONTEXT_WINDOW_PATH,
        "POST",
        { contextWindow: parsed }
      );
      setContextWindow(saved);
      setContextWindowDraftValue(contextWindowDraft(saved.contextWindow));
    } catch {
      setContextWindowError(t("contextWindowSettingsFailed"));
    } finally {
      setContextWindowBusy(false);
    }
  };

  const updateSparkContextWindowOverride = async (
    checked: boolean
  ): Promise<void> => {
    setContextWindowBusy(true);
    setContextWindowError(undefined);
    try {
      setContextWindow(
        await jsonRequest<ContextWindowPreferences>(
          CONTEXT_WINDOW_PATH,
          "POST",
          { overrideSparkContextWindow: checked }
        )
      );
    } catch {
      setContextWindowError(t("contextWindowSettingsFailed"));
    } finally {
      setContextWindowBusy(false);
    }
  };

  const copyTrustedOriginCommand = async (): Promise<void> => {
    setCopyFailed(false);
    try {
      if (navigator.clipboard?.writeText === undefined)
        throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(trustedOriginCommand);
      setCopied(true);
    } catch {
      setCopyFailed(true);
    }
  };

  const label =
    status.status === "signed-in"
      ? t("signedIn")
      : status.status === "loading"
        ? t("loadingAccount")
        : status.status === "signing-in"
          ? t("signingIn")
          : status.status === "reauth-required"
            ? t("reauthRequired")
            : status.status === "remote-web-origin-not-trusted"
              ? t("remoteOriginTitle")
              : status.status === "error"
                ? t("requestFailed")
                : t("signedOut");

  return (
    <section style={pageStyle} aria-labelledby="openai-codex-settings-title">
      <div>
        <h2 id="openai-codex-settings-title" style={titleStyle}>
          {t("title")}
        </h2>
        <p style={{ ...bodyStyle, marginTop: 6 }}>{t("intro")}</p>
      </div>
      <div style={cardStyle}>
        <div style={rowStyle}>
          <div style={statusStyle} role="status">
            <span aria-hidden="true" style={dotStyle(status.status)} />
            <span>{label}</span>
          </div>
          {status.status === "loading" ||
          status.status ===
            "remote-web-origin-not-trusted" ? null : status.status ===
            "signed-in" ? (
            <button
              type="button"
              style={buttonStyle}
              disabled={busy}
              onClick={() => {
                void signOut();
              }}>
              {busy ? t("working") : t("logout")}
            </button>
          ) : (
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy}
              onClick={() => {
                void signIn();
              }}>
              {busy
                ? t("working")
                : status.status === "error" ||
                    status.status === "reauth-required"
                  ? t("loginAgain")
                  : t("login")}
            </button>
          )}
        </div>
        {status.status === "error" || status.status === "reauth-required" ? (
          <p style={errorStyle}>{status.message}</p>
        ) : null}
        {status.status === "remote-web-origin-not-trusted" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={errorStyle}>{t("remoteOriginDescription")}</p>
            <p style={bodyStyle}>{t("remoteOriginCommandHelp")}</p>
            <code style={commandStyle}>{trustedOriginCommand}</code>
            <div style={rowStyle}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  void copyTrustedOriginCommand();
                }}>
                {copied ? t("remoteOriginCopied") : t("remoteOriginCopy")}
              </button>
              {copyFailed ? (
                <span style={errorStyle}>{t("remoteOriginCopyFailed")}</span>
              ) : null}
            </div>
          </div>
        ) : null}
        {status.status === "signed-in" ? (
          <UsageLimits
            usage={status.usage}
            {...(status.quotaError === undefined
              ? {}
              : { quotaError: status.quotaError })}
            t={t}
          />
        ) : null}
      </div>
      <div style={cardStyle}>
        <div>
          <h3 style={quotaTitleStyle}>{t("modelCatalog")}</h3>
          <p style={{ ...bodyStyle, marginTop: 5 }}>{t("modelCatalogIntro")}</p>
        </div>
        <div style={modelListStyle} role="group" aria-label={t("modelCatalog")}>
          {modelCatalog?.availableModels.map((model) => (
            <ModelCheckbox
              key={model.id}
              model={model}
              checked={modelCatalog.models.includes(model.id)}
              disabled={modelCatalogBusy}
              onChange={(checked) => {
                void updateVisibleModel(model.id, checked);
              }}
              t={t}
            />
          ))}
        </div>
        {modelCatalogError === undefined ? null : (
          <p style={errorStyle}>{modelCatalogError}</p>
        )}
      </div>
      <div style={cardStyle}>
        <div>
          <h3 style={quotaTitleStyle}>{t("contextWindow")}</h3>
          <p style={{ ...bodyStyle, marginTop: 5 }}>
            {t("contextWindowIntro")}
          </p>
        </div>
        <div style={{ ...rowStyle, justifyContent: "flex-start" }}>
          <label htmlFor="openai-codex-context-window" style={statusStyle}>
            {t("contextWindowInput")}
          </label>
          <input
            id="openai-codex-context-window"
            type="number"
            inputMode="decimal"
            min="0.001"
            step="0.001"
            placeholder={t("contextWindowPlaceholder")}
            value={contextWindowDraftValue}
            disabled={contextWindow === undefined || contextWindowBusy}
            style={numberInputStyle}
            onChange={(event) => {
              setContextWindowDraftValue(event.currentTarget.value);
            }}
          />
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={contextWindow === undefined || contextWindowBusy}
            onClick={() => {
              void updateContextWindow();
            }}>
            {contextWindowBusy ? t("working") : t("contextWindowSave")}
          </button>
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}>
            <span style={statusStyle}>{t("overrideSparkContextWindow")}</span>
            <span style={bodyStyle}>{t("overrideSparkContextWindowHint")}</span>
          </span>
          <PreferenceToggle
            label={t("overrideSparkContextWindow")}
            disabled={contextWindow === undefined || contextWindowBusy}
            checked={contextWindow?.overrideSparkContextWindow ?? false}
            onChange={(checked) => {
              void updateSparkContextWindowOverride(checked);
            }}
          />
        </div>
        <p style={bodyStyle}>{t("contextWindowHint")}</p>
        {contextWindowError === undefined ? null : (
          <p style={errorStyle}>{contextWindowError}</p>
        )}
      </div>
      <div style={cardStyle}>
        <div>
          <h3 style={quotaTitleStyle}>{t("imageTools")}</h3>
          <p style={{ ...bodyStyle, marginTop: 5 }}>{t("imageToolsIntro")}</p>
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}>
            <span style={statusStyle}>{t("modifyReadImage")}</span>
            <span style={bodyStyle}>{t("modifyReadImageHint")}</span>
          </span>
          <PreferenceToggle
            label={t("modifyReadImage")}
            disabled={imageTools === undefined || imageToolsBusy}
            checked={imageTools?.modifyReadImage ?? false}
            onChange={(checked) => {
              void updateImageTool({ modifyReadImage: checked });
            }}
          />
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}>
            <span style={statusStyle}>{t("shareImagegen")}</span>
            <span style={bodyStyle}>{t("shareImagegenHint")}</span>
          </span>
          <PreferenceToggle
            label={t("shareImagegen")}
            disabled={imageTools === undefined || imageToolsBusy}
            checked={imageTools?.shareImagegenWithOtherModels ?? false}
            onChange={(checked) => {
              void updateImageTool({ shareImagegenWithOtherModels: checked });
            }}
          />
        </div>
        {imageToolsError === undefined ? null : (
          <p style={errorStyle}>{imageToolsError}</p>
        )}
      </div>
      <div style={cardStyle}>
        <div>
          <h3 style={quotaTitleStyle}>{t("responseApi")}</h3>
          <p style={{ ...bodyStyle, marginTop: 5 }}>{t("responseApiIntro")}</p>
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}>
            <span style={statusStyle}>{t("webSocketContextReuse")}</span>
            <span style={bodyStyle}>{t("webSocketContextReuseHint")}</span>
          </span>
          <PreferenceToggle
            label={t("webSocketContextReuse")}
            disabled={responseApi === undefined || responseApiBusy}
            checked={responseApi?.useWebSocketContextReuse ?? false}
            onChange={(checked) => {
              void updateResponseApi({ useWebSocketContextReuse: checked });
            }}
          />
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}>
            <span style={statusStyle}>{t("nativeCompaction")}</span>
            <span style={bodyStyle}>{t("nativeCompactionHint")}</span>
          </span>
          <PreferenceToggle
            label={t("nativeCompaction")}
            disabled={responseApi === undefined || responseApiBusy}
            checked={responseApi?.useNativeCompaction ?? false}
            onChange={(checked) => {
              void updateResponseApi({ useNativeCompaction: checked });
            }}
          />
        </div>
        {responseApiError === undefined ? null : (
          <p style={errorStyle}>{responseApiError}</p>
        )}
      </div>
    </section>
  );
}
