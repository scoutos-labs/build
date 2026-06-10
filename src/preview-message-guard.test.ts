/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { isTrustedPreviewMessage } from './preview-message-guard'

function mountPreviewIframe(): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.title = 'preview'
  document.body.appendChild(iframe)
  return iframe
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isTrustedPreviewMessage', () => {
  it('accepts a message whose source is the preview iframe contentWindow', () => {
    const iframe = mountPreviewIframe()
    expect(isTrustedPreviewMessage({ source: iframe.contentWindow })).toBe(true)
  })

  it('rejects a message sent from the page own window', () => {
    mountPreviewIframe()
    expect(isTrustedPreviewMessage({ source: window })).toBe(false)
  })

  it('rejects a message from a different iframe', () => {
    mountPreviewIframe()
    const attacker = document.createElement('iframe')
    attacker.title = 'attacker'
    document.body.appendChild(attacker)
    expect(isTrustedPreviewMessage({ source: attacker.contentWindow })).toBe(false)
  })

  it('rejects when the preview iframe is not mounted', () => {
    expect(isTrustedPreviewMessage({ source: window })).toBe(false)
  })

  it('rejects a null source', () => {
    mountPreviewIframe()
    expect(isTrustedPreviewMessage({ source: null })).toBe(false)
  })
})
