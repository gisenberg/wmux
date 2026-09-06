export interface FilterableCommand {
  title: string;
  subtitle?: string;
  section: string;
  shortcut?: string;
  keywords?: string[];
  filters?: Partial<Record<"host" | "state" | "runtime", string[]>>;
}

export const filterCommands = <Command extends FilterableCommand>(commands: Command[], query: string): Command[] => {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return commands;
  return commands.filter((command) => {
    const haystack = [command.title, command.section, command.shortcut, ...(command.keywords ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return tokens.every((token) => {
      const match = /^(host|state|runtime):(.+)$/.exec(token);
      if (!match) return haystack.includes(token);
      const values = command.filters?.[match[1] as "host" | "state" | "runtime"];
      return Boolean(values?.some((value) => value.toLowerCase().includes(match[2])));
    });
  });
};
