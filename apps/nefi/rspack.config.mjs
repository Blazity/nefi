// @ts-check

import { BannerPlugin } from '@rspack/core';
import { chmod } from 'fs/promises';
import * as path from 'path';

/** @type {import('@rspack/cli').Configuration} */
export default {
  entry: { main: "./src/start.ts" },
  
  plugins: [
    new BannerPlugin({
      banner: `#!/usr/bin/env node`,
      entryOnly: true,
      raw: true
    }),
    {
      name: 'chmod-plugin',
      apply(compiler) {
        compiler.hooks.afterEmit.tap('chmod-plugin', async (compilation) => {
          const outputPath = path.join(compilation.outputOptions.path, 'nefi.js');
          await chmod(outputPath, '755');
        });
      }
    }
  ],
  output: {
    clean: true, 
    filename: "nefi.js",
    module: true,
    chunkFormat: "module"
  },
  target: "node",
  experiments: {
    outputModule: true
  },
  resolve: {
    extensions: [".js", ".ts", ".json"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: [/node_modules/],
        loader: "builtin:swc-loader",
        options: {
          jsc: {
            parser: {
              syntax: "typescript",
              decorators: true,
              decoratorsBeforeExport: true
            },
            target: "es2022",
            transform: {
              legacyDecorator: true,
              decoratorMetadata: true
            }
          },
        },
        type: "javascript/auto",
      },
    ],
  },
};
