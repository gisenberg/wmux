#!/usr/bin/env node

process.env.NODE_ENV = "production";
const { build } = await import("vite");
await build();
