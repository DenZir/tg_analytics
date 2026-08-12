module.exports = {
  apps: [
    {
      name: "tg-analytics",
      script: "./node_modules/tsx/dist/cli.mjs",
      args: "src/index.ts",
      env: {
        NODE_ENV: "development",
        PORT: 3000,
      },
    },
  ],
};
