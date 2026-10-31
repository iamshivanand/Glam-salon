import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/lib/providers';
import { Navbar } from '@/components/navbar';
import { AuthModal } from '@/components/auth-modal';

export const metadata: Metadata = { title: 'Glam Connect — Book beauty & spa', description: 'World-class salon booking on web + mobile.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <Navbar />
          <AuthModal />
          <main className="max-w-7xl mx-auto px-4 pb-24">{children}</main>
          <footer className="border-t border-line mt-16 py-8 text-sm text-center opacity-70">Glam Connect · live API mode — /api/v1</footer>
        </Providers>
      </body>
    </html>
  );
}
