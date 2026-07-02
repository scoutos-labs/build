import { describe, expect, it } from 'vitest'
import { escapeHtml, renderStoryHtml, storyAccent, storyFileName, type StoryData } from './story-html'

const story: StoryData = {
  title: 'PawPlanner',
  origin: 'Build an app for: dog walkers\nTarget users: busy owners',
  brand: 'Name: PawPlanner\nPalette: #2f6f4e, #f4f1ea',
  chapters: [
    { at: 1719800000000, ask: 'make a scheduler', outcome: 'Built the weekly view', areas: ['screens & logic', 'look & feel'] },
    { at: 0, ask: 'add tags', outcome: 'Tags added', areas: [] },
  ],
  decisions: ['Chose a weekly calendar over a list'],
}

describe('renderStoryHtml', () => {
  it('renders a self-contained page with the story content', () => {
    const html = renderStoryHtml(story)
    expect(html).toContain('The story of PawPlanner')
    expect(html).toContain('make a scheduler')
    expect(html).toContain('Built the weekly view')
    expect(html).toContain('screens &amp; logic')
    expect(html).toContain('Chose a weekly calendar over a list')
    // brand accent tints the page
    expect(html).toContain('--accent: #2f6f4e')
  })

  it('references no external URLs so the file is safe to share and works offline', () => {
    const html = renderStoryHtml(story)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('@import')
  })

  it('escapes user and model content (XSS hard requirement)', () => {
    const hostile = renderStoryHtml({
      ...story,
      title: '<script>alert(1)</script>',
      origin: '<img src=x onerror=alert(1)>',
      chapters: [{ at: 0, ask: '"><script>alert(2)</script>', outcome: '<b onmouseover=x>hi</b>', areas: ['<i>'] }],
      decisions: ['<script>alert(3)</script>'],
      brand: '',
    })
    expect(hostile).not.toContain('<script>alert')
    expect(hostile).not.toContain('<img')
    expect(hostile).not.toContain('<b onmouseover')
    expect(hostile).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('renders an honest empty state for a story with no chapters', () => {
    const html = renderStoryHtml({ ...story, chapters: [], decisions: [], brand: '' })
    expect(html).toContain('No build steps yet')
    expect(html).toContain('--accent: #d97757')
  })
})

describe('story helpers', () => {
  it('escapes all five HTML special characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('extracts the first hex color from the brand section', () => {
    expect(storyAccent('Palette: #AABB01 and #ffffff')).toBe('#AABB01')
    expect(storyAccent('no colors here')).toBe('#d97757')
    // 3-digit shorthand and non-hex tokens are ignored
    expect(storyAccent('#fff #zzzzzz #12345 #123456')).toBe('#123456')
  })

  it('builds a safe download filename from the project name', () => {
    expect(storyFileName('PawPlanner')).toBe('pawplanner-story.html')
    expect(storyFileName('  My Café App! ')).toBe('my-caf-app-story.html')
    expect(storyFileName('***')).toBe('app-story.html')
  })
})
