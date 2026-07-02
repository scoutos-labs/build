function gleamListToArray(list) {
  return typeof list?.toArray === 'function' ? list.toArray() : []
}

export async function exportStoryHtml(storyArg) {
  const story = {
    title: storyArg.title,
    origin: storyArg.origin,
    brand: storyArg.brand,
    chapters: gleamListToArray(storyArg.chapters).map(chapter => ({
      at: chapter.at,
      ask: chapter.ask,
      outcome: chapter.outcome,
      areas: gleamListToArray(chapter.areas),
    })),
    decisions: gleamListToArray(storyArg.decisions),
  }
  const { renderStoryHtml, storyFileName } = await import('../story-html')
  const html = renderStoryHtml(story)
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = storyFileName(story.title)
  anchor.click()
  URL.revokeObjectURL(url)
}
