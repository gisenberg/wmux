export interface FilterableCommand {
  title: string;
  subtitle?: string;
  section: string;
  shortcut?: string;
  keywords?: string[];
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
    return tokens.every((token) => haystack.includes(token));
  });
};
