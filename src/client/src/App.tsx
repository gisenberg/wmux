import { AppStoreProvider } from "./app-store";
import { AppShell } from "./AppShell";

export function App() {
  return (
    <AppStoreProvider>
      <AppShell />
    </AppStoreProvider>
  );
}
