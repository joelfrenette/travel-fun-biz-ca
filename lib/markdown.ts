// A small, dependency-free markdown-to-HTML renderer for blog posts. It covers the subset of
// CommonMark that travel-blog copy actually uses: headings, bold/italic, links, images, inline
// code, code fences, blockquotes, ordered/unordered lists, and paragraphs. No tables, no nested
// lists, no footnotes - if the content ever needs those, swap this for a real parser (marked,
// remark) rather than growing this by hand. Input is escaped first, so raw HTML in a post never
// executes; only the markdown syntax this file understands turns back into tags.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(text: string): string {
  let out = escapeHtml(text)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, alt, src, title) =>
    `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">`)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, label, href, title) =>
    `<a href="${href}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
  return out
}

export function renderMarkdown(markdown: string): string {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let i = 0
  let paragraph: string[] = []
  let listType: 'ul' | 'ol' | null = null

  function flushParagraph() {
    if (paragraph.length) {
      html.push(`<p>${inline(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  function closeList() {
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    if (/^```/.test(line)) {
      flushParagraph(); closeList()
      const fenceLang = line.replace(/^```/, '').trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++ }
      html.push(`<pre><code${fenceLang ? ` class="language-${fenceLang}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      i++
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushParagraph(); closeList()
      const level = heading[1].length
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph(); closeList()
      const quoteLines: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quoteLines.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      html.push(`<blockquote><p>${inline(quoteLines.join(' '))}</p></blockquote>`)
      continue
    }

    const ordered = line.match(/^\s*\d+\.\s+(.*)$/)
    const unordered = line.match(/^\s*[-*]\s+(.*)$/)
    if (ordered || unordered) {
      flushParagraph()
      const wantType = ordered ? 'ol' : 'ul'
      if (listType !== wantType) { closeList(); html.push(`<${wantType}>`); listType = wantType }
      html.push(`<li>${inline((ordered || unordered)![1])}</li>`)
      i++
      continue
    }
    closeList()

    if (line.trim() === '') {
      flushParagraph()
      i++
      continue
    }

    paragraph.push(line.trim())
    i++
  }
  flushParagraph()
  closeList()
  return html.join('\n')
}

/** Rough reading time in minutes, for a post's meta line. */
export function readingTimeMinutes(markdown: string): number {
  const words = (markdown || '').trim().split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.round(words / 200))
}

/** Plain-text snippet for a blog card or a fallback meta description: strips markdown syntax,
 * collapses whitespace, and cuts to length on a word boundary. */
export function excerptFromMarkdown(markdown: string, maxLength = 160): string {
  const plain = (markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= maxLength) return plain
  return plain.slice(0, maxLength).replace(/\s+\S*$/, '') + '…'
}
