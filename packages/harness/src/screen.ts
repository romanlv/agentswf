/**
 * A pane screen and Herdr's own stderr both carry terminal control bytes. The content is not
 * secret, but a record holding raw escape sequences restyles every terminal that later prints it.
 */
export function readable(text: string): string {
  return (
    text
      .replace(ANSI_SEQUENCE, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  );
}

export const ANSI_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC
  /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;
