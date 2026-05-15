@echo off
rem Windows counterpart to scripts/smoke/bridge -- invokes the locally-built
rem bridge from dist/index.js so smoke tests do not need a global npm install.
node "%~dp0..\..\dist\index.js" %*
