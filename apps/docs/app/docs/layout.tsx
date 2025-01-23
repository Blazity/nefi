import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider';
import type { ReactNode } from 'react';
import { baseOptions } from '@/app/layout.config';

import NefiLogo from '@/public/logo-no-bg-inverted.png';
import Image from 'next/image';
import { source } from '@/lib/source';
import { XIcon } from '../icons/x';
import { GithubIcon } from '../icons/github';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider>
      <DocsLayout
        tree={source.pageTree}
        {...baseOptions}
        links={[
          {
            text: (
              <div className="flex flex-row items-center gap-1 justify-end">
                <Image src={NefiLogo} className="mb-0.5" alt="Nefi Logo" width={45} height={10} />
                <span>
                  <span className="sr-only">nefi </span>repository
                </span>
              </div>
            ),
            icon: <GithubIcon className="size-3" />,
            url: 'https://github.com/blazity/nefi',
            external: true,
          },
          {
            text: 'x.com/nefi_ai',
            url: 'https://x.com/nefi_ai',
            external: true,
            icon: <XIcon className="size-3" />,
          },
          {
            text: 'next-enterprise',
            url: 'https://github.com/blazity/next-enterprise',
            external: true,
            icon: <GithubIcon className="size-3" />,
          },
        ]}
        nav={{
          ...baseOptions.nav,
          title: (
            <div className="flex flex-col items-start gap-2">
              <Image src={NefiLogo} alt="Nefi Logo" width={100} height={100} />
              <span className="text-xs font-bold">Next.js Configuration AI Agent</span>
            </div>
          ),
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
