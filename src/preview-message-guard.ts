const PREVIEW_IFRAME_SELECTOR = 'iframe[title="preview"]'

/**
 * The preview iframe runs untrusted AI-generated code, and any window can
 * postMessage to us. Only messages whose source is the preview iframe's
 * contentWindow may dispatch into the app.
 */
export function isTrustedPreviewMessage(
  event: Pick<MessageEvent, 'source'>,
  doc: Pick<Document, 'querySelector'> = document,
): boolean {
  const iframe = doc.querySelector(PREVIEW_IFRAME_SELECTOR) as HTMLIFrameElement | null
  return event.source !== null && iframe?.contentWindow != null && event.source === iframe.contentWindow
}
