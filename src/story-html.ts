// Renders the Build Story as a single self-contained HTML file: inline CSS,
// system fonts only, zero external URLs, so sharing the file leaks nothing
// beyond what the user chooses to share. All user/model content is escaped.

export type StoryChapter = {
  at: number
  ask: string
  outcome: string
  areas: string[]
}

export type StoryData = {
  title: string
  origin: string
  brand: string
  chapters: StoryChapter[]
  decisions: string[]
}

const FALLBACK_ACCENT = '#d97757'

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** First hex color mentioned in the Brand section tints the story — each
 * story carries the visual identity of the app it describes. */
export function storyAccent(brand: string): string {
  const match = brand.match(/#([0-9a-fA-F]{6})\b/)
  return match ? `#${match[1]}` : FALLBACK_ACCENT
}

export function storyFileName(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
  return `${slug}-story.html`
}

function formatDate(at: number): string {
  if (!at) return ''
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function paragraphs(text: string): string {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `<p>${escapeHtml(line)}</p>`)
    .join('\n')
}

function chapterHtml(chapter: StoryChapter, index: number): string {
  const date = formatDate(chapter.at)
  const chips = chapter.areas.map(area => `<span class="chip">${escapeHtml(area)}</span>`).join('')
  return `<article class="chapter">
  <div class="chapterRule"><span class="chapterNumber">${index + 1}</span>${date ? `<time>${escapeHtml(date)}</time>` : ''}</div>
  <blockquote class="ask">&ldquo;${escapeHtml(chapter.ask)}&rdquo;</blockquote>
  <div class="outcome">${paragraphs(chapter.outcome)}</div>
  ${chips ? `<div class="chips">${chips}</div>` : ''}
</article>`
}

export function renderStoryHtml(story: StoryData): string {
  const accent = storyAccent(story.brand)
  const title = escapeHtml(story.title)
  const chapters = story.chapters.map(chapterHtml).join('\n')
  const decisions = story.decisions.length
    ? `<section class="decisions">
  <h2>Decisions along the way</h2>
  <ul>${story.decisions.map(decision => `<li>${escapeHtml(decision)}</li>`).join('')}</ul>
</section>`
    : ''
  const brand = story.brand
    ? `<section class="brandNotes">
  <h2>The brand</h2>
  ${paragraphs(story.brand)}
</section>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The story of ${title}</title>
<style>
  :root { --accent: ${accent}; --ink: #1f2430; --muted: #6b7180; --paper: #fbfaf7; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--paper); color: var(--ink);
    font-family: Charter, 'Iowan Old Style', 'Palatino Linotype', Georgia, serif;
    line-height: 1.65; font-size: 1.06rem;
  }
  .page { max-width: 40rem; margin: 0 auto; padding: 4rem 1.4rem 5rem; }
  .kicker {
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: .78rem;
    letter-spacing: .18em; text-transform: uppercase; color: var(--accent); font-weight: 700;
  }
  h1 { font-size: clamp(2rem, 6vw, 3rem); line-height: 1.12; margin: .4rem 0 1rem; letter-spacing: -.015em; }
  h2 {
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: .82rem;
    letter-spacing: .14em; text-transform: uppercase; color: var(--muted);
    margin: 3rem 0 1rem; font-weight: 700;
  }
  .origin p { margin: .5rem 0; }
  .origin { border-left: 3px solid var(--accent); padding-left: 1.1rem; margin: 2rem 0 0; }
  .chapter { margin-top: 2.6rem; }
  .chapterRule { display: flex; align-items: baseline; gap: .75rem; border-top: 1px solid #e4e1d8; padding-top: 1.1rem; }
  .chapterNumber {
    font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 800;
    color: var(--accent); font-size: .95rem;
  }
  .chapterRule time { font-family: ui-sans-serif, system-ui, sans-serif; font-size: .8rem; color: var(--muted); }
  .ask { margin: .8rem 0 .6rem; font-style: italic; font-size: 1.15rem; }
  .outcome p { margin: .45rem 0; }
  .chips { margin-top: .7rem; display: flex; flex-wrap: wrap; gap: .4rem; }
  .chip {
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: .72rem; font-weight: 600;
    color: var(--ink); background: color-mix(in srgb, var(--accent) 12%, white);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, white);
    border-radius: 999px; padding: .14rem .6rem;
  }
  .decisions ul { padding-left: 1.1rem; }
  .decisions li { margin: .4rem 0; }
  .empty { color: var(--muted); font-style: italic; margin-top: 2rem; }
  footer {
    margin-top: 4rem; padding-top: 1rem; border-top: 1px solid #e4e1d8;
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: .78rem; color: var(--muted);
  }
  @media print { body { background: white; } .page { padding-top: 1rem; } }
</style>
</head>
<body>
<main class="page">
  <p class="kicker">A build story</p>
  <h1>${title}</h1>
  <section class="origin">${paragraphs(story.origin)}</section>
  <h2>How it took shape</h2>
  ${chapters || '<p class="empty">No build steps yet &mdash; the story starts with the first ask.</p>'}
  ${decisions}
  ${brand}
  <footer>Written from the real build record &mdash; every chapter is something that actually happened.</footer>
</main>
</body>
</html>
`
}
