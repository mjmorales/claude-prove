import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ActiveProjectProvider } from "./lib/active-project";
import "./index.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ActiveProjectProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ActiveProjectProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
