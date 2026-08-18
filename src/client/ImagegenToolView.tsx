/** Inline presentation for imagegen results in the conversation tool stream. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { OpenAICodexSettingsKey } from "./locales.ts";

export type ImageLoader = (attachment: ImageAttachmentRef) => Promise<string>;

type ImagegenToolViewProps = ToolCallViewProps & {
  loadImage: ImageLoader;
  t: (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => string;
};

const rootStyle: CSSProperties = { display: "flex", flexDirection: "column" };
const rowStyle: CSSProperties = {
  display: "flex",
  width: "100%",
  alignItems: "center",
  minHeight: 24,
  padding: 0,
  border: 0,
  background: "transparent",
  font: "inherit",
  fontSize: 14,
  lineHeight: "24px",
  textAlign: "left",
  cursor: "pointer",
};
const iconStyle: CSSProperties = {
  width: 16,
  flex: "0 0 16px",
  color: "var(--dsw-alias-label-secondary)",
  textAlign: "center",
  transition: "transform 100ms ease",
};
const titleStyle: CSSProperties = {
  marginLeft: 6,
  color: "var(--dsw-alias-label-primary)",
  whiteSpace: "nowrap",
};
const separatorStyle: CSSProperties = {
  width: 2,
  height: 2,
  flex: "0 0 2px",
  margin: "0 8px",
  borderRadius: 1,
  background: "var(--dsw-alias-label-caption)",
};
const summaryStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--dsw-alias-label-tertiary)",
};
const imageWrapStyle: CSSProperties = { margin: "6px 0 5px 22px" };
const ioCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  margin: "4px 0 4px 22px",
  overflow: "hidden",
  border: "1px solid var(--dsw-alias-border-l1)",
  borderRadius: 12,
  background: "var(--dsw-alias-markdown-code-block)",
};
const ioSectionStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content minmax(0, 1fr)",
  columnGap: 14,
  alignItems: "start",
  maxHeight: 180,
  padding: "12px 16px",
  overflow: "auto",
  font: "var(--dsw-font-markdown-code-block-small)",
};
const ioLabelStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  color: "var(--dsw-alias-label-caption)",
};
const ioTextStyle: CSSProperties = {
  minWidth: 0,
  margin: 0,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  color: "var(--dsw-alias-label-secondary)",
  font: "inherit",
};
const dividerStyle: CSSProperties = {
  height: 1,
  background: "var(--dsw-alias-border-l2)",
};
const savedRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  margin: "2px 0 4px 22px",
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: 12,
  lineHeight: "18px",
};
const savedButtonStyle: CSSProperties = {
  padding: 0,
  border: 0,
  background: "transparent",
  color: "var(--dsw-alias-label-secondary)",
  font: "inherit",
  textDecoration: "underline",
  textUnderlineOffset: 3,
  cursor: "pointer",
};
const inspectButtonStyle: CSSProperties = {
  alignSelf: "flex-start",
  margin: "2px 0 2px 22px",
  padding: "2px 8px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 999,
  background: "var(--dsw-alias-bg-base)",
  color: "var(--dsw-alias-label-secondary)",
  fontSize: 11,
  lineHeight: "16px",
  cursor: "pointer",
};
const imageButtonStyle: CSSProperties = {
  display: "block",
  padding: 0,
  overflow: "hidden",
  border: "1px solid var(--dsw-alias-border-l1)",
  borderRadius: 12,
  background: "var(--dsw-alias-bg-layer-1)",
  cursor: "zoom-in",
};
const imageStyle: CSSProperties = {
  display: "block",
  maxWidth: 240,
  maxHeight: 240,
  objectFit: "contain",
};
const placeholderStyle: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 180,
  height: 120,
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: 13,
};
const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 10000,
  display: "grid",
  placeItems: "center",
  padding: 32,
  background: "rgba(0, 0, 0, 0.78)",
};
const previewStyle: CSSProperties = {
  display: "block",
  maxWidth: "calc(100vw - 64px)",
  maxHeight: "calc(100vh - 64px)",
  objectFit: "contain",
};
const closeStyle: CSSProperties = {
  position: "fixed",
  top: 18,
  right: 18,
  width: 36,
  height: 36,
  border: 0,
  borderRadius: 18,
  background: "rgba(30, 30, 30, 0.75)",
  color: "white",
  fontSize: 24,
  lineHeight: "34px",
  cursor: "pointer",
};

function resultParts(block: ToolCallViewProps["block"]): {
  running: boolean;
  failed: boolean;
  image?: ImageAttachmentRef;
  path?: string;
  writeFailed: boolean;
  resultText: string;
} {
  if (!("kind" in block) || block.kind !== "tool-result")
    return { running: true, failed: false, writeFailed: false, resultText: "" };
  let image: ImageAttachmentRef | undefined;
  let text = "";
  for (const item of block.content) {
    if (item.type === "image" && image === undefined) image = item.attachment;
    else if (item.type === "text") text += item.text;
  }
  const path = text.match(
    /<output_path\s+operation="(?:create|update)">([^<]+)<\/output_path>/u
  )?.[1];
  return {
    running: false,
    failed: block.isError,
    ...(image === undefined ? {} : { image }),
    ...(path === undefined ? {} : { path }),
    writeFailed: text.includes("<output_error>"),
    resultText: text,
  };
}

function argsRaw(block: ToolCallViewProps["block"]): string {
  return "kind" in block ? (block.call?.argsRaw ?? "{}") : block.argsRaw;
}
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
function promptSummary(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "prompt" in value &&
      typeof value.prompt === "string"
    )
      return value.prompt;
  } catch {}
  return raw;
}
function resultOutput(result: ReturnType<typeof resultParts>): string {
  if (result.image === undefined) return result.resultText;
  return JSON.stringify(
    {
      attachment: result.image,
      ...(result.path === undefined ? {} : { outputPath: result.path }),
      ...(result.writeFailed ? { workspaceSave: "failed" } : {}),
    },
    null,
    2
  );
}

function GeneratedImage({
  attachment,
  load,
  t,
}: {
  attachment: ImageAttachmentRef;
  load: ImageLoader;
  t: ImagegenToolViewProps["t"];
}) {
  const [attempt, setAttempt] = useState(0);
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    setFailed(false);
    void load(attachment).then(
      (value) => {
        if (live) setSrc(value);
      },
      () => {
        if (live) setFailed(true);
      }
    );
    return () => {
      live = false;
    };
  }, [attachment, attempt, load]);
  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      opener.current?.focus();
    };
  }, [close, open]);
  const name = attachment.name ?? t("generatedImage");
  if (failed)
    return (
      <button
        type="button"
        style={{ ...imageButtonStyle, ...placeholderStyle, cursor: "pointer" }}
        onClick={() => {
          setAttempt((value) => value + 1);
        }}>
        {t("imageLoadFailed")}
      </button>
    );
  return (
    <>
      <button
        ref={opener}
        type="button"
        style={imageButtonStyle}
        title={t("imageOpen")}
        aria-label={t("imageOpenNamed", { name })}
        onClick={() => {
          if (src !== undefined) setOpen(true);
        }}>
        {src === undefined ? (
          <span style={placeholderStyle}>{t("imageLoading")}</span>
        ) : (
          <img src={src} alt={name} style={imageStyle} />
        )}
      </button>
      {open && src !== undefined
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t("imagePreview")}
              style={backdropStyle}
              onMouseDown={close}>
              <img
                src={src}
                alt={name}
                style={previewStyle}
                onMouseDown={(event: MouseEvent) => {
                  event.stopPropagation();
                }}
              />
              <button
                type="button"
                aria-label={t("imageClose")}
                style={closeStyle}
                onClick={close}>
                ×
              </button>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

/** A visible imagegen row: its generated attachment stays in the transcript and opens at original size. */
export function ImagegenToolView({
  block,
  toolName,
  openFile,
  inspect,
  loadImage,
  t,
}: ImagegenToolViewProps) {
  const [expanded, setExpanded] = useState(false);
  const result = resultParts(block);
  const input = argsRaw(block);
  const summary = promptSummary(input);
  const output = resultOutput(result);
  return (
    <div style={rootStyle} data-tool="imagegen">
      <button
        type="button"
        style={rowStyle}
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((value) => !value);
        }}>
        <span
          aria-hidden="true"
          style={{
            ...iconStyle,
            transform: expanded ? "rotate(90deg)" : undefined,
          }}>
          ›
        </span>
        <span style={titleStyle}>{t("toolCallTitle")}</span>
        <span aria-hidden="true" style={separatorStyle} />
        <span style={{ ...summaryStyle, flex: "0 0 auto", maxWidth: "28%" }}>
          {toolName}
        </span>
        <span aria-hidden="true" style={separatorStyle} />
        <span
          style={{
            ...summaryStyle,
            ...(result.failed
              ? { color: "var(--dsw-alias-state-error-primary)" }
              : {}),
          }}>
          {result.failed
            ? t("imageGenerationFailed")
            : result.running && summary === ""
              ? t("imageGenerating")
              : summary}
        </span>
      </button>
      {expanded ? (
        <>
          <div style={ioCardStyle}>
            <div style={ioSectionStyle}>
              <span style={ioLabelStyle}>IN</span>
              <pre style={ioTextStyle}>{prettyJson(input)}</pre>
            </div>
            {output !== "" ? (
              <>
                <span aria-hidden="true" style={dividerStyle} />
                <div style={ioSectionStyle}>
                  <span style={ioLabelStyle}>OUT</span>
                  <pre
                    style={{
                      ...ioTextStyle,
                      ...(result.failed
                        ? { color: "var(--dsw-alias-state-error-primary)" }
                        : {}),
                    }}>
                    {output}
                  </pre>
                </div>
              </>
            ) : null}
          </div>
          {inspect === undefined ? null : (
            <button type="button" style={inspectButtonStyle} onClick={inspect}>
              {t("inspectToolCall")}
            </button>
          )}
        </>
      ) : null}
      {result.image === undefined ? null : (
        <div style={imageWrapStyle}>
          <GeneratedImage attachment={result.image} load={loadImage} t={t} />
        </div>
      )}
      {result.path === undefined ? null : (
        <div style={savedRowStyle}>
          <span>{t("imageSavedAs")}</span>
          <button
            type="button"
            style={savedButtonStyle}
            title={result.path}
            onClick={() => {
              openFile(result.path!);
            }}>
            {result.path}
          </button>
        </div>
      )}
      {!result.running && result.path === undefined && result.writeFailed ? (
        <div style={savedRowStyle}>{t("imageGeneratedAttachmentOnly")}</div>
      ) : null}
    </div>
  );
}
