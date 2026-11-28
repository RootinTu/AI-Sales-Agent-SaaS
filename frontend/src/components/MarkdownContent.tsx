import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router'
import remarkGfm from 'remark-gfm'
import './MarkdownContent.css'

export interface MarkdownCitation {
  documentId: string
  title: string
  pageNumber?: number | null
}

const CITATION_REGEX = /\[资料\s*([0-9]+(?:\s*[,，、]\s*[0-9]+)*)\]/g
const CODE_SEGMENT_REGEX = /(```[\s\S]*?```|`[^`\n]+`)/g

/**
 * 将正文中的 [资料 1] / [资料 1, 2] 转换为行内 #cite-N 链接，跳过代码块避免误伤代码文本。
 */
function injectInlineCitations(content: string, citations?: MarkdownCitation[]) {
  if (!citations || citations.length === 0 || !content.includes('资料')) return content
  return content
    .split(CODE_SEGMENT_REGEX)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      return segment.replace(CITATION_REGEX, (raw, nums: string) => {
        const indices = nums
          .split(/[,，、]/)
          .map((item) => Number.parseInt(item.trim(), 10))
          .filter((num) => Number.isFinite(num) && num >= 1 && num <= citations.length)
        if (!indices.length) return raw
        return indices.map((num) => `[资料 ${num}](#cite-${num})`).join('')
      })
    })
    .join('')
}

export function MarkdownContent({
  content,
  citations,
  onCitationClick,
}: {
  content: string
  citations?: MarkdownCitation[]
  onCitationClick?: (citation: MarkdownCitation, index: number) => void
}) {
  const renderedContent = injectInlineCitations(content, citations)
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            const citeMatch = href?.match(/^#cite-(\d+)$/)
            if (citeMatch && citations) {
              const citeIndex = Number.parseInt(citeMatch[1], 10)
              const citation = citations[citeIndex - 1]
              if (citation) {
                const tooltip = `${citation.title}${citation.pageNumber ? ` · 第 ${citation.pageNumber} 页` : ''}`
                if (onCitationClick) {
                  return (
                    <button
                      type="button"
                      className="markdown-citation-pill"
                      title={tooltip}
                      aria-label={`引用来源：${tooltip}`}
                      onClick={() => onCitationClick(citation, citeIndex - 1)}
                    >
                      <span>{citation.title}</span>
                    </button>
                  )
                }
                return (
                  <Link
                    className="markdown-citation-pill"
                    to={`/app/knowledge?document=${encodeURIComponent(citation.documentId)}`}
                    title={tooltip}
                    aria-label={`引用来源：${tooltip}`}
                  >
                    <span>{citation.title}</span>
                  </Link>
                )
              }
            }
            return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>
          },
          img: ({ src, alt, title }) => src ? <img src={src} alt={alt ?? ''} title={title} loading="lazy" referrerPolicy="no-referrer" /> : null,
          table: ({ children }) => <div className="markdown-table-scroll" role="region" aria-label="表格" tabIndex={0}><table>{children}</table></div>,
        }}
      >
        {renderedContent}
      </ReactMarkdown>
    </div>
  )
}
