import { vi } from 'vitest';

/** jsdom 25 exposes HTMLDialogElement but not its modal lifecycle methods. */
export function installDialogMethods() {
  const originalShowModal = HTMLDialogElement.prototype.showModal;
  const originalClose = HTMLDialogElement.prototype.close;
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  const close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });

  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    writable: true,
    value: showModal,
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    writable: true,
    value: close,
  });

  return {
    showModal,
    close,
    restore() {
      if (originalShowModal) {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
          configurable: true,
          writable: true,
          value: originalShowModal,
        });
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
      }
      if (originalClose) {
        Object.defineProperty(HTMLDialogElement.prototype, 'close', {
          configurable: true,
          writable: true,
          value: originalClose,
        });
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
      }
    },
  };
}
