import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type ConversationMarkdownProps = {
  children: string;
  idPrefix: string;
  inverted?: boolean;
};

export function ConversationMarkdown({
  children,
  idPrefix,
  inverted = false,
}: ConversationMarkdownProps) {
  const mutedBorder = 'border-line-strong';
  const subtleBackground = inverted ? 'bg-code-muted' : 'bg-surface-strong';
  const footnotePrefix = `conversation-${idPrefix.replace(/[^A-Za-z0-9_-]/g, '-')}-`;
  const footnoteLabelId = `${footnotePrefix}footnote-label`;

  return (
    <Markdown
      skipHtml
      disallowedElements={['img']}
      remarkPlugins={[remarkGfm]}
      remarkRehypeOptions={{ clobberPrefix: footnotePrefix }}
      components={{
        a: ({
          'aria-describedby': ariaDescribedBy,
          children: linkChildren,
          className,
          href,
          node: _node,
          ...linkProps
        }) => {
          const isFragment = href?.startsWith('#') ?? false;
          return (
            <a
              {...linkProps}
              href={href}
              aria-describedby={
                ariaDescribedBy === 'footnote-label' ? footnoteLabelId : ariaDescribedBy
              }
              target={isFragment ? undefined : '_blank'}
              rel={isFragment ? undefined : 'noopener noreferrer'}
              className={`${className ?? ''} font-semibold underline underline-offset-2 ${
                inverted
                  ? 'text-on-strong-link hover:text-on-strong-link'
                  : 'text-info hover:text-info'
              }`}
            >
              {linkChildren}
            </a>
          );
        },
        blockquote: ({ children: quoteChildren }) => (
          <blockquote className={`my-3 border-l-4 ${mutedBorder} pl-3 italic`}>
            {quoteChildren}
          </blockquote>
        ),
        code: ({ children: codeChildren, className }) => (
          <code
            className={`${className ?? ''} rounded ${subtleBackground} px-1 py-0.5 font-instrument text-[0.9em]`}
          >
            {codeChildren}
          </code>
        ),
        h1: ({ children: headingChildren }) => (
          <h3 className="mt-4 text-lg font-semibold first:mt-0">{headingChildren}</h3>
        ),
        h2: ({ children: headingChildren, className, id, node: _node, ...headingProps }) => (
          <h4
            {...headingProps}
            id={id === 'footnote-label' ? footnoteLabelId : id}
            className={`${className ?? ''} mt-4 text-base font-semibold first:mt-0`}
          >
            {headingChildren}
          </h4>
        ),
        h3: ({ children: headingChildren }) => (
          <h5 className="mt-3 font-semibold first:mt-0">{headingChildren}</h5>
        ),
        h4: ({ children: headingChildren }) => (
          <h6 className="mt-3 font-semibold first:mt-0">{headingChildren}</h6>
        ),
        h5: ({ children: headingChildren }) => (
          <h6 className="mt-3 font-semibold first:mt-0">{headingChildren}</h6>
        ),
        h6: ({ children: headingChildren }) => (
          <h6 className="mt-3 font-semibold first:mt-0">{headingChildren}</h6>
        ),
        ol: ({ children: listChildren, className, node: _node, ...listProps }) => (
          <ol {...listProps} className={`${className ?? ''} my-3 list-decimal space-y-1 pl-6`}>
            {listChildren}
          </ol>
        ),
        p: ({ children: paragraphChildren }) => (
          <p className="mt-3 whitespace-pre-wrap break-words first:mt-0">{paragraphChildren}</p>
        ),
        pre: ({ children: preChildren }) => (
          <pre
            className={`my-3 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg ${subtleBackground} p-3 text-xs [&>code]:bg-transparent [&>code]:p-0`}
          >
            {preChildren}
          </pre>
        ),
        table: ({ children: tableChildren }) => (
          <div className={`my-3 max-w-full overflow-x-auto rounded-lg border ${mutedBorder}`}>
            <table className="w-full border-collapse text-left text-xs">{tableChildren}</table>
          </div>
        ),
        td: ({ children: cellChildren, className, node: _node, ...cellProps }) => (
          <td
            {...cellProps}
            className={`${className ?? ''} border-t ${mutedBorder} px-3 py-2 align-top`}
          >
            {cellChildren}
          </td>
        ),
        th: ({ children: cellChildren, className, node: _node, ...cellProps }) => (
          <th
            {...cellProps}
            className={`${className ?? ''} ${subtleBackground} px-3 py-2 font-semibold`}
          >
            {cellChildren}
          </th>
        ),
        ul: ({ children: listChildren, className, node: _node, ...listProps }) => (
          <ul {...listProps} className={`${className ?? ''} my-3 list-disc space-y-1 pl-6`}>
            {listChildren}
          </ul>
        ),
      }}
    >
      {children}
    </Markdown>
  );
}
