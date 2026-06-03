export type FileStatus = 'idle' | 'reviewing';

export interface FileState {
  status: FileStatus;
  /** null = file did not exist before (new file); '' = file existed but was empty; string = file content */
  baseline: string | null;
  /** Baseline exists in hunkwise git but is not safe to represent as text. */
  baselineIsBinary?: boolean;
  /** File is reviewable only at file level because line diff is unsafe or too expensive. */
  diffUnavailable?: boolean;
  diffUnavailableReason?: 'binary' | 'tooLarge' | 'unreadable' | 'largeDiff';
}
