// @vitest-environment jsdom
// the dashboard lazy-loads attachment images (no src until the element is
// observed intersecting), renders the vision interpretation, and offers a download.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { AttachmentItem } from '../MessageAttachments';
import type { Attachment } from '../../lib/types';

const imageAttachment = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'a1',
  fileId: 'F123',
  name: 'graph.png',
  mimetype: 'image/png',
  permalink: null,
  interpretation: 'a latency graph spiking at 10:02',
  messageId: 'm1',
  ...over,
});

const deps = {
  incidentId: 'i1',
  apiBaseUrl: 'https://api.test',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'tok' }),
};

// Capture each IntersectionObserver so a test can drive the intersection manually.
let observers: { cb: IntersectionObserverCallback; elements: Element[] }[] = [];

beforeEach(() => {
  observers = [];
  class FakeIO {
    cb: IntersectionObserverCallback;
    elements: Element[] = [];
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
      observers.push(this);
    }
    observe(el: Element) {
      this.elements.push(el);
    }
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeIO as unknown as typeof IntersectionObserver);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, blob: async () => new Blob(['bytes']) })),
  );
  // jsdom has no object-URL support.
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fire the captured observer's callback as if the element scrolled into view. */
function intersect(): void {
  for (const o of observers) {
    o.cb(
      o.elements.map((el) => ({ isIntersecting: true, target: el }) as IntersectionObserverEntry),
      o as unknown as IntersectionObserver,
    );
  }
}

describe('AttachmentItem (lazy image)', () => {
  test('does not set the image src until the element intersects the viewport', async () => {
    render(<AttachmentItem attachment={imageAttachment()} deps={deps} onZoom={() => {}} />);
    const img = screen.getByTestId('attachment-img-F123') as HTMLImageElement;
    // Before intersection: no src, and no bytes fetched.
    expect(img.getAttribute('src')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    // Now it scrolls into view: bytes are fetched and the blob url is set.
    intersect();
    await waitFor(() => expect(img.getAttribute('src')).toBe('blob:fake'));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.test/incidents/i1/attachments/F123');
  });

  test('clicking the loaded image zooms with the blob src', async () => {
    const onZoom = vi.fn();
    render(<AttachmentItem attachment={imageAttachment()} deps={deps} onZoom={onZoom} />);
    const img = screen.getByTestId('attachment-img-F123') as HTMLImageElement;
    intersect();
    await waitFor(() => expect(img.getAttribute('src')).toBe('blob:fake'));
    fireEvent.click(img);
    expect(onZoom).toHaveBeenCalledWith('blob:fake');
  });

  test('clicking Download fetches the proxy url with ?download=1', async () => {
    // Stub the anchor click: jsdom logs an unhandled "navigation not implemented" on a real a.click().
    const clickStub = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<AttachmentItem attachment={imageAttachment()} deps={deps} onZoom={() => {}} />);
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const [url] = calls[calls.length - 1]!;
    expect(url).toBe('https://api.test/incidents/i1/attachments/F123?download=1');
    await waitFor(() => expect(clickStub).toHaveBeenCalled());
  });

  test('renders the vision interpretation and a download control', () => {
    render(<AttachmentItem attachment={imageAttachment()} deps={deps} onZoom={() => {}} />);
    expect(screen.getByText('a latency graph spiking at 10:02')).toBeDefined();
    expect(screen.getByText('Download')).toBeDefined();
  });

  test('a non-image renders a download link only, no lazy image', () => {
    render(
      <AttachmentItem
        attachment={imageAttachment({
          fileId: 'F9',
          name: 'notes.pdf',
          mimetype: 'application/pdf',
        })}
        deps={deps}
        onZoom={() => {}}
      />,
    );
    expect(screen.queryByTestId('attachment-img-F9')).toBeNull();
    expect(screen.getByText('Download')).toBeDefined();
    expect(screen.getByText(/notes\.pdf/)).toBeDefined();
  });
});
