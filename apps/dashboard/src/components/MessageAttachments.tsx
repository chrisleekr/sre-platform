import type { CredentialGetter } from '../lib/request-credentials';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import type { Attachment } from '../lib/types';

/** Image types the proxy serves inline; everything else (incl. SVG) is a download link only. */
const RENDERABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface AttachmentDeps {
  incidentId: string;
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
}

/** The authenticated proxy url for one file's bytes (Bearer auth is added by the fetching caller). */
function proxyUrl(deps: AttachmentDeps, fileId: string, download = false): string {
  const base = `${deps.apiBaseUrl}/incidents/${deps.incidentId}/attachments/${fileId}`;
  return download ? `${base}?download=1` : base;
}

/** Fetch bytes through the authed proxy and return an object URL, or null on failure. */
async function fetchBlobUrl(url: string, getCredentials: CredentialGetter): Promise<string | null> {
  try {
    const res = await authenticatedFetch(url, getCredentials);
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

/**
 * Lazily-loaded image. The `<img>` src is NOT set until the element scrolls
 * near the viewport (IntersectionObserver) — a long incident thread never fires a burst of image
 * fetches on mount. On intersect it fetches the bytes through the authenticated proxy (an `<img src>`
 * cannot carry a Bearer header), turns them into an object URL, and renders. Clicking zooms.
 */
export function LazyImage({
  attachment,
  deps,
  onZoom,
}: {
  attachment: Attachment;
  deps: AttachmentDeps;
  onZoom: (src: string) => void;
}) {
  const ref = useRef<HTMLImageElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || src) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        void fetchBlobUrl(proxyUrl(deps, attachment.fileId), deps.getCredentials).then((url) => {
          if (url) setSrc(url);
        });
      }
    });
    io.observe(el);
    return () => io.disconnect();
    // deps.getCredentials is stable (useCallback in the container); fileId keys the effect.
  }, [attachment.fileId, deps, src]);

  // Release the object URL when it changes / unmounts so blob memory is not leaked.
  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  return (
    <img
      ref={ref}
      src={src ?? undefined}
      alt={attachment.name}
      data-testid={`attachment-img-${attachment.fileId}`}
      onClick={() => src && onZoom(src)}
      className="max-h-40 cursor-zoom-in rounded border border-line"
    />
  );
}

/** One attachment row: a lazy image (or a download link for a non-image) plus its interpretation. */
export function AttachmentItem({
  attachment,
  deps,
  inverted = false,
  onZoom,
}: {
  attachment: Attachment;
  deps: AttachmentDeps;
  inverted?: boolean;
  onZoom: (src: string) => void;
}) {
  const isImage = RENDERABLE.has(attachment.mimetype);
  const mutedText = inverted ? 'text-on-strong-muted' : 'text-ink-muted';
  const linkText = inverted ? 'text-on-strong-link' : 'text-info';
  const download = useCallback(async () => {
    const url = await fetchBlobUrl(proxyUrl(deps, attachment.fileId, true), deps.getCredentials);
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = attachment.name;
    a.click();
    URL.revokeObjectURL(url);
  }, [attachment.fileId, attachment.name, deps]);

  return (
    <div className="mt-1 flex flex-col gap-1">
      {isImage ? (
        <LazyImage attachment={attachment} deps={deps} onZoom={onZoom} />
      ) : (
        <span className={`text-xs ${mutedText}`}>📎 {attachment.name}</span>
      )}
      {attachment.interpretation && (
        <p className={`text-xs italic ${mutedText}`}>{attachment.interpretation}</p>
      )}
      <button
        type="button"
        onClick={download}
        className={`self-start text-xs underline ${linkText}`}
      >
        Download
      </button>
    </div>
  );
}

/** All attachments tied to one hub message, rendered beneath it. */
export function MessageAttachments({
  attachments,
  deps,
  inverted = false,
  onZoom,
}: {
  attachments: Attachment[];
  deps: AttachmentDeps;
  inverted?: boolean;
  onZoom: (src: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="ml-4">
      {attachments.map((a) => (
        <AttachmentItem key={a.id} attachment={a} deps={deps} inverted={inverted} onZoom={onZoom} />
      ))}
    </div>
  );
}
