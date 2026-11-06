/** A run's files that can't be read, or a run that doesn't answer: refused `unreachable`. */
export class RunUnreachable extends Error {
  readonly code = "unreachable";
  constructor(message: string) {
    super(message);
    this.name = "RunUnreachable";
  }
}
