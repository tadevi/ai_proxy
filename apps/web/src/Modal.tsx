import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Accessible modal wrapper.
 *
 * - Traps focus inside the dialog while open.
 * - Closes on Escape key.
 * - Closes on backdrop click (mousedown outside the dialog panel).
 * - Wires aria-labelledby to the first <h2> inside via the provided titleId.
 * - Restores focus to the element that was active when the modal opened.
 *
 * Usage:
 *   <Modal titleId="my-title" onClose={close}>
 *     <h2 id="my-title">Title</h2>
 *     ...
 *   </Modal>
 *
 * Or use the useModalId() helper to generate a stable id:
 *   const titleId = useModalId();
 *   <Modal titleId={titleId} onClose={close}>
 *     <h2 id={titleId}>Title</h2>
 *   </Modal>
 */
export function useModalId() {
  return useId();
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  titleId,
  onClose,
  children,
  maxWidth = 'max-w-lg',
}: {
  titleId: string;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: string;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<Element | null>(null);

  // Remember the element that had focus so we can restore it on close.
  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    return () => {
      (returnFocusRef.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  // Auto-focus first focusable element inside the panel.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, []);

  // Escape closes.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      // Focus trap: Tab / Shift+Tab cycles within panel.
      if (e.key === 'Tab') {
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      ref={backdropRef}
      role="dialog"
      aria-labelledby={titleId}
    >
      <div className={`card w-full ${maxWidth}`} ref={panelRef}>
        {children}
      </div>
    </div>
  );
}
