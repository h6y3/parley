export interface ParleyArgs {
  command: "serve" | "call" | "harness" | "doctor" | "help";
  to?: string;
  briefPath?: string;
  rest: string[];
}

function flag(rest: readonly string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
}

export function parseParleyArgs(argv: readonly string[]): ParleyArgs {
  const [command, ...rest] = argv;
  switch (command) {
    case "serve":
      return { command: "serve", rest };
    case "call":
      return { command: "call", to: flag(rest, "--to"), briefPath: flag(rest, "--brief"), rest };
    case "harness":
      return { command: "harness", rest };
    case "doctor":
      return { command: "doctor", rest };
    default:
      return { command: "help", rest };
  }
}
