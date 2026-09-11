import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const SetupDialogSlots = createContext<{
  navigation: HTMLElement | null;
  actions: HTMLElement | null;
  body: HTMLElement | null;
} | null>(null);

/** Keeps the current step's actions outside the scrolling dialog content. */
export function SetupActions({ children }: { children: ReactNode }) {
  const slots = useContext(SetupDialogSlots);
  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-3 [&_button]:min-h-11">
      {children}
    </div>
  );
  return slots ? (slots.actions ? createPortal(actions, slots.actions) : null) : actions;
}
