@echo off
rem Windows counterpart to scripts/smoke/bridge — invokes the locally-built
rem bridge from dist/index.js so smoke tests don't need a global npm install.
rem Set BRIDGE=...\scripts\smoke\bridge.cmd before running scripts/smoke/run-all.mjs.
node "%~dp0..\..\dist\index.js" %*
