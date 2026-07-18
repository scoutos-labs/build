/**
 * Pre-auth landing surface. Managed-auth only: created by ensureSignedIn()
 * before the Gleam runtime exists, so this is plain DOM sharing styles.css
 * tokens — no framework, no cross-origin assets (COOP/COEP constraints).
 *
 * The shell covers the app area instantly so neither signed-in nor
 * signed-out visitors see an unstyled flash while Clerk loads. Only once
 * Clerk resolves signed-out does the shell expand into the full landing.
 *
 * The typed idea is written to sessionStorage under LANDING_PROMPT_KEY on
 * every keystroke (it must survive the OAuth full-page redirect) and is
 * consumed one-shot after boot in gleam-externals/projects.mjs.
 */

const LANDING_PROMPT_KEY = 'build.landing-prompt'

const BOLT_LOCKUP = `<svg viewBox="0 0 61 61" fill="none" aria-hidden="true"><rect width="61" height="61" rx="12" fill="#FABA00"/><path d="M28.6133 18.5759C29.2167 17.7689 30.5 18.1957 30.5 19.2033V33.5842H19.4821C18.6194 33.5842 18.1264 32.5999 18.643 31.909L28.6133 18.5759Z" fill="#fff"/><path d="M32.3868 41.8892C31.7834 42.6962 30.5 42.2694 30.5 41.2618V26.881H41.518C42.3807 26.881 42.8737 27.8652 42.357 28.5561L32.3868 41.8892Z" fill="#fff"/></svg>`

const EXAMPLE_IDEAS = [
  'A booking app for local yoga instructors',
  'A client portal for my design agency',
  'An inventory tracker with low-stock alerts',
]

function storeIdea(idea: string): void {
  try {
    if (idea.trim()) sessionStorage.setItem(LANDING_PROMPT_KEY, idea)
    else sessionStorage.removeItem(LANDING_PROMPT_KEY)
  } catch {
    /* storage unavailable — the idea just doesn't carry through */
  }
}

export interface LandingShell {
  /** Replace the plain shell with the full landing; returns the Clerk mount slot. */
  expandToLanding(): { signInSlot: HTMLElement }
  remove(): void
}

export function createLandingShell(): LandingShell {
  const shell = document.createElement('div')
  shell.id = 'landing'
  shell.className = 'landingShell'
  document.body.appendChild(shell)

  return {
    expandToLanding() {
      shell.innerHTML = `
        <header class="landingHeader">
          <span class="landingWordmark">${BOLT_LOCKUP}build</span>
          <span class="landingByline">by hyper</span>
        </header>
        <main class="landingMain">
          <section class="landingHero">
            <small class="landingEyebrow">BUILD ANYTHING</small>
            <h1 class="landingTitle">Create.<br>Connect.<br>Build.</h1>
            <p class="landingLede">Describe your app. hyper builds it in a live browser workspace — no cloud plumbing.</p>
            <ol class="landingSteps">
              <li><span>01</span> answer a few questions</li>
              <li><span>02</span> watch hyper build</li>
              <li><span>03</span> publish when it's ready</li>
            </ol>
          </section>
          <section class="landingPanel">
            <form class="landingPrompt">
              <label for="landingIdea">What do you want to build?</label>
              <textarea id="landingIdea" rows="3" placeholder="${EXAMPLE_IDEAS[0]}…"></textarea>
              <div class="landingChips" role="group" aria-label="Example ideas"></div>
              <p class="landingHint">Sign in and your idea starts the interview.</p>
            </form>
            <div class="landingSignIn">
              <div class="landingSignInSlot"></div>
            </div>
          </section>
        </main>`

      const textarea = shell.querySelector('#landingIdea') as HTMLTextAreaElement
      textarea.addEventListener('input', () => storeIdea(textarea.value))

      const chips = shell.querySelector('.landingChips') as HTMLElement
      for (const idea of EXAMPLE_IDEAS) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'landingChip'
        chip.textContent = idea
        chip.addEventListener('click', () => {
          textarea.value = idea
          storeIdea(idea)
          textarea.focus()
        })
        chips.appendChild(chip)
      }

      // Enter falls through to sign-in: the idea is already stored, and the
      // Clerk card is the only next step there is.
      shell.querySelector('.landingPrompt')!.addEventListener('submit', e => e.preventDefault())
      textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          const target = shell.querySelector('.landingSignIn') as HTMLElement
          target.scrollIntoView({ block: 'nearest' })
          ;(target.querySelector('input, button') as HTMLElement | null)?.focus()
        }
      })
      textarea.focus()

      return { signInSlot: shell.querySelector('.landingSignInSlot') as HTMLElement }
    },
    remove() {
      shell.remove()
    },
  }
}
