import './globals.css';
import 'toastify-js/src/toastify.css';
import type { Metadata } from 'next';
import { ContextProvider } from './context';
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: 'ISO+ Portal',
  description: 'Portal for ISO+ services and workspace management',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <ContextProvider>
            {children}
          </ContextProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}