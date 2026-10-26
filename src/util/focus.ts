import { Event } from './emitter';

/** Whether the editor window is focused; the refresh loop slows down while it is not. */
export interface FocusSource {
  readonly focused: boolean;
  readonly onDidChange: Event<boolean>;
}

export const ALWAYS_FOCUSED: FocusSource = {
  focused: true,
  onDidChange: () => ({ dispose() {} }),
};
