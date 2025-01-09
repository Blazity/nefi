// @ts-check

/** @type {import('@rspack/cli').Configuration} */
export default {
  entry: { main: "./src/start.ts" },
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
            },
            target: "es2022"
          },
        },
        type: "javascript/auto",
      },
    ],
  },
};
