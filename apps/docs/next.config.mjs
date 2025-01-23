import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: '/',
        destination: '/docs/usage',
        permanent: true, // Set to true for a 301 redirect
      },
    ];
  },
};

export default withMDX(config);
