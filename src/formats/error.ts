/**
 * Base for every format reader's failure.
 *
 * The CLI and the MCP server catch this one type, so adding a format cannot
 * leave a new error class escaping as an uncaught stack trace.
 */
export class FormatError extends Error {
  constructor(
    public readonly file: string,
    message: string,
    public readonly line?: number,
  ) {
    super(line === undefined ? message : `${message} (line ${line})`);
  }
}

export function describeFormatError(err: FormatError): string {
  return `Cannot read ${err.file}\n  ${err.message}`;
}
