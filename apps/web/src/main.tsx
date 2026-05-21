import React from 'react';
import ReactDOM from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import '@rainbow-me/rainbowkit/styles.css';
import './index.css';
import { wagmiConfig } from './lib/wagmi';
import { AuthProvider } from './lib/AuthContext';
import { App } from './App';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme()}>
          <AuthProvider>
            <App />
            <Toaster
              position="bottom-right"
              toastOptions={{
                style: {
                  background: 'rgb(15 23 42)', // slate-900
                  color: 'rgb(241 245 249)', // slate-100
                  border: '1px solid rgb(30 41 59)', // slate-800
                  fontSize: '0.875rem',
                },
                success: { iconTheme: { primary: 'rgb(52 211 153)', secondary: 'rgb(15 23 42)' } },
                error: { duration: 6000 },
              }}
            />
          </AuthProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
