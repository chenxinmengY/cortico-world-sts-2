@echo off
rem Run: scriptsdump-state.cmd -Label combat
rem Uses Bypass so the script is not blocked by execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dump-state.ps1" %*
