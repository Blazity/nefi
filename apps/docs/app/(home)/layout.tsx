import type { ReactNode } from 'react';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/app/layout.config';
import NefiLogo from "@/public/logo-no-bg-inverted.png";
import Image from "next/image";

export default function Layout({ children }: { children: ReactNode }) {
  return <HomeLayout {...baseOptions}
  nav={{
    ...baseOptions.nav,
    title: (
        <Image src={NefiLogo} alt="Nefi Logo" width={70} height={50} />
    )
  }}>{children}</HomeLayout>;
}
