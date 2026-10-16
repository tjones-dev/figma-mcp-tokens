// Things the tool can't express. With `strict` they fail the command together; without it
// the item is skipped and each issue becomes a warning.
export class Issues {
  readonly messages: string[] = [];

  constructor(readonly strict: boolean) {}

  add(message: string) {
    this.messages.push(message);
  }

  /** Throws if strict and anything was reported; otherwise returns the warnings. */
  settle(): string[] {
    if (this.strict && this.messages.length > 0) {
      throw new Error(
        [
          `${this.messages.length === 1 ? "1 problem" : `${this.messages.length} problems`}:`,
          ...this.messages.map((m) => `  - ${m}`),
          'Fix them in Figma, or set "strict": false in the config to skip them with a warning.',
        ].join("\n"),
      );
    }
    return this.messages;
  }
}
