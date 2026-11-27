import "@fontsource-variable/ibm-plex-sans";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installClientErrorReporting } from "./api/client";
import { AppRouter } from "./app/router";
import { I18nProvider } from "./i18n";
import "./styles/tokens.css";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

installClientErrorReporting();

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false }, mutations: { retry: false } },
});

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AppRouter />
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
